import type { Express } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage } from "./storage";
import { insertPickupRequestSchema, type PickupRequest } from "@shared/schema";
import { sendPickupRequestEmail } from "./email";
import {
  addPickupToCalendar,
  calendarConfigured,
  retitlePickupOnCalendar,
} from "./calendar";
import { registerInventoryRoutes } from "./inventory/routes";
import { startInventorySync } from "./inventory/sync";
import { startListingRefresh } from "./inventory/listings";
import { recoverInterruptedBatches } from "./inventory/batches";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Submit a new donation pickup request
  app.post("/api/pickup-requests", async (req, res) => {
    const parsed = insertPickupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "validation_failed",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    try {
      const created = await storage.createPickupRequest(parsed.data);
      // Fire-and-forget email; surface status back for ops visibility.
      sendPickupRequestEmail(created)
        .then((r) => storage.markEmailStatus(created.id, r.status))
        .catch((e) => {
          console.error("[email] send error:", e);
          storage.markEmailStatus(created.id, "exception");
        });
      syncPickupToCalendar(created);
      return res.status(201).json({ id: created.id });
    } catch (e) {
      console.error("[pickup-requests] create error:", e);
      return res.status(500).json({ error: "server_error" });
    }
  });

  // Admin: list all submissions (basic shared-secret protection)
  app.get("/api/pickup-requests", async (req, res) => {
    const expected = process.env.ADMIN_KEY;
    const provided =
      (req.query.key as string) ||
      req.header("x-admin-key") ||
      "";
    if (!expected || provided !== expected) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const all = await storage.listPickupRequests();
    return res.json(all);
  });

  addUpcomingPickupsToCalendar().catch((e) =>
    console.error("[calendar] startup sync:", e)
  );

  // Cross-marketplace inventory sync (admin page at /#/inventory)
  registerInventoryRoutes(app);
  startInventorySync();
  startListingRefresh();
  recoverInterruptedBatches();

  return httpServer;
}

// Fire-and-forget: a calendar failure never fails the pickup request.
async function syncPickupToCalendar(r: PickupRequest): Promise<boolean> {
  try {
    const sameDay = await storage.listPickupsOnDate(r.preferredDate);
    const earlier = sameDay.filter((o) => o.id < r.id);
    const eventId = await addPickupToCalendar(r, earlier);
    if (!eventId) return false;
    await storage.setCalendarEventId(r.id, eventId);
    return true;
  } catch (e) {
    console.error(`[calendar] pickup #${r.id}:`, e);
    return false;
  }
}

// On startup, add upcoming requests that aren't on the calendar yet (ones made
// before the calendar was set up, or whose earlier attempt failed).
async function addUpcomingPickupsToCalendar() {
  if (!calendarConfigured()) return;
  const today = new Date().toISOString().slice(0, 10);

  // Keep titles of upcoming events in the current format ("Pickup – City").
  const onCalendar = await storage.listUpcomingPickupsOnCalendar(today);
  let retitled = 0;
  for (const r of onCalendar) {
    try {
      if (await retitlePickupOnCalendar(r, r.calendarEventId!)) retitled++;
    } catch (e) {
      console.error(`[calendar] retitle pickup #${r.id}:`, e);
    }
  }
  if (onCalendar.length) {
    console.log(`[calendar] updated titles of ${retitled} of ${onCalendar.length} upcoming pickup(s)`);
  }

  const missing = await storage.listUpcomingPickupsMissingFromCalendar(today);
  let added = 0;
  for (const r of missing) if (await syncPickupToCalendar(r)) added++;
  if (missing.length) {
    console.log(`[calendar] added ${added} of ${missing.length} upcoming pickup(s)`);
  }
}
