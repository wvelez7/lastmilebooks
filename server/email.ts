import type { PickupRequest } from "@shared/schema";

const NOTIFY_TO =
  process.env.EMAIL_TO ||
  process.env.NOTIFY_EMAIL ||
  "thelastmilebooks@gmail.com";

/**
 * Send an email notification when a new pickup request comes in.
 *
 * Two transports are supported:
 *   1. RESEND_API_KEY  -> uses Resend REST API (https://resend.com)
 *   2. SENDGRID_API_KEY -> uses SendGrid REST API
 *
 * If neither key is set we just log to the console — the request is still
 * stored in the database so nothing is lost. The owner can wire up a
 * provider later by setting an env var; no code change needed.
 */
export async function sendPickupRequestEmail(
  req: PickupRequest
): Promise<{ ok: boolean; status: string }> {
  const subject = `New donation pickup request — ${req.fullName} (${req.city})`;
  const text = renderText(req);
  const html = renderHtml(req);

  if (process.env.RESEND_API_KEY) {
    return sendWithResend(subject, text, html);
  }
  if (process.env.SENDGRID_API_KEY) {
    return sendWithSendGrid(subject, text, html);
  }

  console.log("[email] No mail provider configured. Logging request:");
  console.log(text);
  return { ok: false, status: "no_provider_configured" };
}

function renderText(r: PickupRequest): string {
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

function renderHtml(r: PickupRequest): string {
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendWithResend(
  subject: string,
  text: string,
  html: string
): Promise<{ ok: boolean; status: string }> {
  const from =
    process.env.EMAIL_FROM ||
    process.env.NOTIFY_FROM ||
    "Last Mile Books <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [NOTIFY_TO], subject, text, html }),
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
  subject: string,
  text: string,
  html: string
): Promise<{ ok: boolean; status: string }> {
  const from =
    process.env.EMAIL_FROM ||
    process.env.NOTIFY_FROM ||
    "no-reply@lastmilebooks.com";
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: NOTIFY_TO }] }],
        from: { email: from, name: "Last Mile Books" },
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
