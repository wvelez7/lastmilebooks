import type { Express } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage } from "./storage";
import { insertPickupRequestSchema } from "@shared/schema";
import { sendPickupRequestEmail } from "./email";

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

  return httpServer;
}
