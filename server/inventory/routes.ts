import type { Express, NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { upsertInventoryItemSchema } from "@shared/schema";
import { inventoryStore } from "./store";
import * as whatnot from "./whatnot";
import * as ebay from "./ebay";
import { handleWhatnotOrder, importListings, pushQuantity, runSyncOnce } from "./sync";

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_KEY;
  const provided = req.header("x-admin-key") || "";
  const ok =
    Boolean(expected) &&
    provided.length === expected!.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected!));
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}

// OAuth `state` values for eBay connect, valid for 10 minutes.
const ebayStates = new Map<string, number>();

export function registerInventoryRoutes(app: Express) {
  app.get("/api/inventory", requireAdmin, (_req, res) => {
    res.json({
      status: {
        whatnot: whatnot.whatnotConfigured(),
        whatnotWebhook: Boolean(process.env.WHATNOT_WEBHOOK_SECRET),
        ebayApp: ebay.ebayAppConfigured(),
        ebay: ebay.ebayConnected(),
      },
      items: inventoryStore.listItems(),
      events: inventoryStore.listEvents(),
    });
  });

  // Add or edit a book, then push its quantity everywhere it's listed.
  app.post("/api/inventory/items", requireAdmin, async (req, res) => {
    const parsed = upsertInventoryItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten().fieldErrors });
    }
    const item = inventoryStore.upsert(parsed.data);
    inventoryStore.log("info", `Saved by hand: quantity ${item.quantity}`, item.sku);
    const pushed = await pushQuantity(item);
    res.json({ item, pushed });
  });

  app.delete("/api/inventory/items/:id", requireAdmin, (req, res) => {
    const item = inventoryStore.getById(Number(req.params.id));
    if (!item) return res.status(404).json({ error: "not_found" });
    inventoryStore.deleteItem(item.id);
    inventoryStore.log("info", "Removed from sync (listings left as they are)", item.sku);
    res.status(204).end();
  });

  app.post("/api/inventory/import", requireAdmin, async (_req, res) => {
    try {
      res.json(await importListings());
    } catch (e) {
      inventoryStore.log("error", `Import failed: ${(e as Error).message}`);
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.post("/api/inventory/sync", requireAdmin, async (_req, res) => {
    await runSyncOnce();
    res.status(204).end();
  });

  // Returns the eBay sign-in URL; the page sends the browser there.
  app.post("/api/inventory/ebay/connect", requireAdmin, (_req, res) => {
    if (!ebay.ebayAppConfigured()) {
      return res.status(400).json({ error: "Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RU_NAME first" });
    }
    const state = crypto.randomUUID();
    ebayStates.set(state, Date.now() + 10 * 60 * 1000);
    res.json({ url: ebay.authorizeUrl(state) });
  });

  // eBay redirects here (the RuName's "auth accepted" URL) after sign-in.
  app.get("/api/inventory/ebay/callback", async (req, res) => {
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    const expires = ebayStates.get(state);
    ebayStates.delete(state);
    if (!code || !expires || expires < Date.now()) {
      return res.redirect("/?ebay=failed#/inventory");
    }
    try {
      await ebay.exchangeCode(code);
      inventoryStore.log("info", "eBay account connected");
      res.redirect("/?ebay=connected#/inventory");
    } catch (e) {
      inventoryStore.log("error", `eBay connect failed: ${(e as Error).message}`);
      res.redirect("/?ebay=failed#/inventory");
    }
  });

  // Whatnot webhook (orders.created / orders.updated). Optional: polling
  // catches every sale anyway, this just makes it near-instant.
  app.post("/api/webhooks/whatnot", (req, res) => {
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw) || !whatnot.verifyWebhook(raw, req.headers)) {
      return res.status(400).end();
    }
    res.status(204).end(); // Whatnot times out at 5s; do the work afterwards

    const event = req.body as { type?: string; data?: { id?: string; status?: string } };
    const orderId = event.data?.id;
    if (!orderId) return;
    if (event.type === "orders.created" || event.type === "orders.updated") {
      if (event.data?.status === "cancelled" && inventoryStore.hasSale(`whatnot:order:${orderId}`)) {
        inventoryStore.log(
          "warn",
          `Whatnot order ${orderId} was cancelled after the sync delisted it. Relist by hand if the book is back on the shelf.`,
        );
        return;
      }
      handleWhatnotOrder(orderId).catch((e) =>
        inventoryStore.log("error", `Whatnot webhook for order ${orderId} failed: ${(e as Error).message}`),
      );
    }
  });
}
