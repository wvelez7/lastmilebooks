import type { PickupRequest } from "@shared/schema";

const NOTIFY_TO_LIST = (
  process.env.EMAIL_TO ||
  process.env.NOTIFY_EMAIL ||
  "haylee@lastmilebooks.com,thelastmilebooks@gmail.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FROM =
  process.env.EMAIL_FROM ||
  process.env.NOTIFY_FROM ||
  "Last Mile Books <pickups@lastmilebooks.com>";

/**
 * Send email notifications when a new pickup request comes in.
 *
 * Two emails are sent:
 *   1. Owner notification -> internal recipients (Haylee + Gmail backup)
 *   2. Customer confirmation -> the person who submitted the form
 *
 * Two transports are supported:
 *   1. RESEND_API_KEY  -> uses Resend REST API (https://resend.com)
 *   2. SENDGRID_API_KEY -> uses SendGrid REST API
 *
 * If neither key is set we just log to the console — the request is still
 * stored in the database so nothing is lost.
 */
export async function sendPickupRequestEmail(
  req: PickupRequest
): Promise<{ ok: boolean; status: string }> {
  const ownerSubject = `New donation pickup request — ${req.fullName} (${req.city})`;
  const ownerText = renderOwnerText(req);
  const ownerHtml = renderOwnerHtml(req);

  const customerSubject = `We got your pickup request — Last Mile Books`;
  const customerText = renderCustomerText(req);
  const customerHtml = renderCustomerHtml(req);

  if (process.env.RESEND_API_KEY) {
    const ownerRes = await sendWithResend(
      NOTIFY_TO_LIST,
      ownerSubject,
      ownerText,
      ownerHtml
    );
    // Send customer confirmation (best-effort; owner notification is primary)
    if (req.email) {
      await sendWithResend(
        [req.email],
        customerSubject,
        customerText,
        customerHtml
      ).catch((e) =>
        console.error("[email] Customer confirmation exception:", e)
      );
    }
    return ownerRes;
  }
  if (process.env.SENDGRID_API_KEY) {
    const ownerRes = await sendWithSendGrid(
      NOTIFY_TO_LIST,
      ownerSubject,
      ownerText,
      ownerHtml
    );
    if (req.email) {
      await sendWithSendGrid(
        [req.email],
        customerSubject,
        customerText,
        customerHtml
      ).catch((e) =>
        console.error("[email] Customer confirmation exception:", e)
      );
    }
    return ownerRes;
  }

  console.log("[email] No mail provider configured. Logging request:");
  console.log(ownerText);
  return { ok: false, status: "no_provider_configured" };
}

function renderOwnerText(r: PickupRequest): string {
  return [
    `New donation pickup request from the Last Mile Books website.`,
    ``,
    `Name:     ${r.fullName}`,
    `Email:    ${r.email}`,
    `Phone:    ${r.phone}`,
    `Address:  ${r.pickupAddress}`,
    `City:     ${r.city}`,
    `Boxes:    ${r.numberOfBoxes}`,
    `Date:     ${r.preferredDate}`,
    `Notes:    ${r.notes || "(none)"}`,
    ``,
    `Submitted: ${r.createdAt}`,
  ].join("\n");
}

function renderOwnerHtml(r: PickupRequest): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#5C6359;font-family:Arial,sans-serif;font-size:13px;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#1F2A22;font-family:Arial,sans-serif;font-size:14px;">${escapeHtml(value)}</td></tr>`;
  return `
  <div style="font-family:Arial,sans-serif;background:#F5F1E8;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #DCD5C2;border-radius:8px;overflow:hidden;">
      <div style="background:#2E5D3A;color:#ffffff;padding:20px 24px;">
        <div style="font-size:11px;letter-spacing:3px;font-weight:bold;color:#D8A84A;">LAST MILE BOOKS</div>
        <div style="font-size:20px;font-weight:bold;margin-top:6px;">New pickup request</div>
      </div>
      <div style="padding:20px 24px;">
        <table style="border-collapse:collapse;width:100%;">
          ${row("Name", r.fullName)}
          ${row("Email", r.email)}
          ${row("Phone", r.phone)}
          ${row("Address", r.pickupAddress)}
          ${row("City", r.city)}
          ${row("Boxes", r.numberOfBoxes)}
          ${row("Preferred date", r.preferredDate)}
          ${row("Notes", r.notes || "(none)")}
        </table>
      </div>
      <div style="padding:12px 24px;background:#FBF8F0;color:#5C6359;font-size:12px;border-top:1px solid #DCD5C2;">
        Submitted ${r.createdAt}
      </div>
    </div>
  </div>`;
}

function renderCustomerText(r: PickupRequest): string {
  return [
    `Hi ${r.fullName},`,
    ``,
    `Thanks for scheduling a book pickup with Last Mile Books. We got your request and one of us will reach out within 24 hours to confirm your pickup window.`,
    ``,
    `Here's what you submitted:`,
    `  Pickup address: ${r.pickupAddress}`,
    `  City:           ${r.city}`,
    `  Estimated boxes: ${r.numberOfBoxes}`,
    `  Preferred date: ${r.preferredDate}`,
    ``,
    `On the day of pickup, please leave your books on the porch or at the top of your driveway. We'll send a confirmation email that day with your pickup window.`,
    ``,
    `Questions? Just reply to this email or call (951) 249-3215.`,
    ``,
    `Thanks,`,
    `Last Mile Books`,
    `lastmilebooks.com`,
  ].join("\n");
}

function renderCustomerHtml(r: PickupRequest): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#5C6359;font-family:Arial,sans-serif;font-size:13px;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#1F2A22;font-family:Arial,sans-serif;font-size:14px;">${escapeHtml(value)}</td></tr>`;
  return `
  <div style="font-family:Arial,sans-serif;background:#F5F1E8;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #DCD5C2;border-radius:8px;overflow:hidden;">
      <div style="background:#2E5D3A;color:#ffffff;padding:20px 24px;">
        <div style="font-size:11px;letter-spacing:3px;font-weight:bold;color:#D8A84A;">LAST MILE BOOKS</div>
        <div style="font-size:20px;font-weight:bold;margin-top:6px;">We got your pickup request</div>
      </div>
      <div style="padding:20px 24px;color:#1F2A22;font-size:14px;line-height:1.55;">
        <p style="margin:0 0 14px 0;">Hi ${escapeHtml(r.fullName)},</p>
        <p style="margin:0 0 14px 0;">Thanks for scheduling a book pickup with Last Mile Books. We got your request and one of us will reach out within 24 hours to confirm your pickup window.</p>
        <p style="margin:0 0 8px 0;color:#5C6359;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Your request</p>
        <table style="border-collapse:collapse;width:100%;margin:0 0 18px 0;">
          ${row("Pickup address", r.pickupAddress)}
          ${row("City", r.city)}
          ${row("Estimated boxes", String(r.numberOfBoxes))}
          ${row("Preferred date", r.preferredDate)}
        </table>
        <div style="background:#FBF8F0;border-left:3px solid #D8A84A;padding:14px 16px;margin:0 0 18px 0;border-radius:0 6px 6px 0;">
          <div style="font-weight:bold;margin-bottom:6px;">On the day of pickup</div>
          <div>Please leave your books on the porch or at the top of your driveway. We'll send a confirmation email that day with your pickup window.</div>
        </div>
        <p style="margin:0 0 14px 0;">Questions? Just reply to this email or call <a href="tel:+19512493215" style="color:#2E5D3A;">(951) 249-3215</a>.</p>
        <p style="margin:0;">Thanks,<br/>Last Mile Books</p>
      </div>
      <div style="padding:12px 24px;background:#FBF8F0;color:#5C6359;font-size:12px;border-top:1px solid #DCD5C2;">
        <a href="https://lastmilebooks.com" style="color:#5C6359;text-decoration:none;">lastmilebooks.com</a>
      </div>
    </div>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendWithResend(
  toList: string[],
  subject: string,
  text: string,
  html: string
): Promise<{ ok: boolean; status: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to: toList, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[email] Resend failed:", res.status, body);
      return { ok: false, status: `resend_error_${res.status}` };
    }
    return { ok: true, status: "sent_resend" };
  } catch (e) {
    console.error("[email] Resend exception:", e);
    return { ok: false, status: "resend_exception" };
  }
}

async function sendWithSendGrid(
  toList: string[],
  subject: string,
  text: string,
  html: string
): Promise<{ ok: boolean; status: string }> {
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: toList.map((email) => ({ email })) }],
        from: { email: FROM, name: "Last Mile Books" },
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[email] SendGrid failed:", res.status, body);
      return { ok: false, status: `sendgrid_error_${res.status}` };
    }
    return { ok: true, status: "sent_sendgrid" };
  } catch (e) {
    console.error("[email] SendGrid exception:", e);
    return { ok: false, status: "sendgrid_exception" };
  }
}
