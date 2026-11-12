import { createSign } from "node:crypto";
import type { PickupRequest } from "@shared/schema";

/**
 * Puts each pickup request on a Google Calendar on the customer's preferred
 * date: 2 hours for 21+ boxes, 1 hour otherwise. The day's first pickup starts
 * at 9 AM Pacific; later requests for the same day follow
 * back-to-back. The real time is set by moving the event once confirmed.
 *
 * Uses a Google Cloud service account (no googleapis dependency):
 *   GOOGLE_SERVICE_ACCOUNT_JSON -> the service account's JSON key file contents
 *   GOOGLE_CALENDAR_ID          -> the calendar to write to, shared with the
 *                                  service account ("Make changes to events")
 *
 * If either is missing, calendar sync is simply skipped.
 */

type ServiceAccount = { client_email: string; private_key: string };

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !process.env.GOOGLE_CALENDAR_ID) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) throw new Error("missing fields");
    return { client_email: sa.client_email, private_key: sa.private_key };
  } catch (e) {
    console.error("[calendar] GOOGLE_SERVICE_ACCOUNT_JSON is not a valid key file:", e);
    return null;
  }
}

export function calendarConfigured(): boolean {
  return serviceAccount() !== null;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned =
    b64({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/calendar.events",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(sa.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return body.access_token;
}

const TIME_ZONE = "America/Los_Angeles";
const PICKUP_DAY_START = 9 * 60; // minutes after midnight: 9:00 AM

/** How long a pickup takes, in minutes. */
export function pickupMinutes(r: Pick<PickupRequest, "numberOfBoxes">): number {
  return /^21\+/.test(r.numberOfBoxes) ? 120 : 60;
}

function clock(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}:00`;
}

/**
 * @param earlierSameDay requests for the same date submitted before this one;
 * this pickup is scheduled after them.
 */
export function pickupEvent(
  r: PickupRequest,
  earlierSameDay: Pick<PickupRequest, "numberOfBoxes">[] = []
) {
  const start =
    PICKUP_DAY_START + earlierSameDay.reduce((sum, e) => sum + pickupMinutes(e), 0);
  const end = start + pickupMinutes(r);
  return {
    summary: `Pickup: ${r.fullName} — ${r.city} (${r.numberOfBoxes})`,
    location: `${r.pickupAddress}, ${r.city}, CA`,
    description: [
      `Name: ${r.fullName}`,
      `Phone: ${r.phone}`,
      `Email: ${r.email}`,
      `Address: ${r.pickupAddress}, ${r.city}`,
      `Boxes: ${r.numberOfBoxes}`,
      `Notes: ${r.notes || "(none)"}`,
      `Photo: ${r.photo ? "yes, attached to the pickup request email" : "(none)"}`,
      ``,
      `Request #${r.id}, submitted ${r.createdAt}`,
    ].join("\n"),
    start: { dateTime: `${r.preferredDate}T${clock(start)}`, timeZone: TIME_ZONE },
    end: { dateTime: `${r.preferredDate}T${clock(end)}`, timeZone: TIME_ZONE },
  };
}

/** Creates the calendar event and returns its id, or null if not configured. */
export async function addPickupToCalendar(
  r: PickupRequest,
  earlierSameDay: Pick<PickupRequest, "numberOfBoxes">[] = []
): Promise<string | null> {
  const sa = serviceAccount();
  if (!sa) return null;
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID!);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken(sa)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pickupEvent(r, earlierSameDay)),
    }
  );
  if (!res.ok) {
    throw new Error(`Google Calendar insert failed: ${res.status} ${await res.text()}`);
  }
  const event = (await res.json()) as { id: string };
  return event.id;
}
