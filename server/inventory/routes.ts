import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { upsertInventoryItemSchema, upsertSupplySchema } from "@shared/schema";
import { scanSettingsSchema, toIsbn13 } from "@shared/profit";
import { z } from "zod";
import {
  batchDefaultsSchema,
  batchItemPatchSchema,
  DEFAULT_BATCH_DEFAULTS,
  listingSettingsSchema,
  MAX_SKU_LENGTH,
} from "@shared/listing";
import type { AmazonBook } from "@shared/listing";
import { inventoryStore } from "./store";
import * as batches from "./batches";
import { BatchError } from "./batches";
import * as supplies from "./supplies";
import * as whatnot from "./whatnot";
import * as ebay from "./ebay";
import * as amazon from "./amazon";
import * as listings from "./listings";
import { parseActiveListingsReport, ReportError } from "./ebayReport";
import { AMAZON_POLL_MS, handleWhatnotOrder, importListings, pushQuantity, runSyncOnce } from "./sync";

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

// Must exactly match the endpoint URL entered in the eBay developer portal.
const EBAY_DELETION_ENDPOINT =
  process.env.EBAY_DELETION_ENDPOINT || "https://lastmilebooks.com/api/ebay/account-deletion";

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

  // Barcode scanner (admin page at /#/scan). Profit is worked out on the page
  // from these numbers, so changing a setting updates it instantly.
  app.get("/api/scan/listings", requireAdmin, (_req, res) => {
    res.json({
      status: listings.listingStatus(),
      settings: listings.getScanSettings(),
      listings: listings.listAllListings(),
    });
  });

  app.get("/api/scan/lookup/:code", requireAdmin, async (req, res) => {
    const code = String(req.params.code).trim();
    const isbn13 = toIsbn13(code);
    const found = listings.findListings(code);
    let market: ebay.EbayMarketOffer[] = [];
    let marketError: string | null = null;
    let amazonBook: amazon.AmazonBook | null = null;
    let amazonError: string | null = null;
    await Promise.all([
      // Not one of ours: show what the book is going for instead.
      (async () => {
        if (found.length > 0 || !ebay.ebayAppConfigured() || !/^\d{8,14}$/.test(code)) return;
        try {
          market = await ebay.searchMarket(isbn13 ?? code);
        } catch (e) {
          marketError = (e as Error).message;
          inventoryStore.log("warn", `eBay price search failed: ${marketError}`);
        }
      })(),
      // Checked even when it's on eBay, since it might be worth more on Amazon.
      (async () => {
        if (!isbn13 || !amazon.amazonConfigured()) return;
        try {
          amazonBook = await amazon.lookupBook(isbn13);
        } catch (e) {
          amazonError = (e as Error).message;
          inventoryStore.log("warn", `Amazon price check failed: ${amazonError}`);
        }
      })(),
    ]);
    res.json({
      code,
      listings: found,
      market,
      marketError,
      marketAvailable: ebay.ebayAppConfigured(),
      amazon: amazonBook,
      amazonError,
      amazonAvailable: amazon.amazonConfigured() && isbn13 !== null,
      canList: { amazon: amazon.amazonListingConfigured(), ebay: ebay.ebayListingConfigured() },
    });
  });

  // ---- Listing batches (Batch tab on /#/scan) ----
  const sendBatchError = (res: Response, e: unknown) => {
    if (e instanceof BatchError) return res.status(400).json({ error: e.message });
    throw e;
  };

  app.get("/api/batches", requireAdmin, (_req, res) => {
    res.json({
      batches: batches.listBatches(),
      settings: batches.getListingSettings(),
      canList: { amazon: amazon.amazonListingConfigured(), ebay: ebay.ebayListingConfigured() },
    });
  });

  app.post("/api/batches", requireAdmin, (req, res) => {
    const parsed = batchDefaultsSchema.safeParse(req.body?.defaults ?? DEFAULT_BATCH_DEFAULTS);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    res.json(batches.createBatch(parsed.data));
  });

  app.get("/api/batches/:id", requireAdmin, (req, res) => {
    try {
      res.json(batches.getBatch(Number(req.params.id)));
    } catch (e) {
      sendBatchError(res, e);
    }
  });

  app.put("/api/batches/:id", requireAdmin, (req, res) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(80).optional(), defaults: batchDefaultsSchema.optional() })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    try {
      res.json(batches.updateBatch(Number(req.params.id), parsed.data));
    } catch (e) {
      sendBatchError(res, e);
    }
  });

  app.delete("/api/batches/:id", requireAdmin, (req, res) => {
    try {
      batches.deleteBatch(Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      sendBatchError(res, e);
    }
  });

  // The page sends what its lookup found, so the book isn't looked up twice.
  const scanInfoSchema = z.object({
    code: z.string().trim().min(1),
    amazon: z.custom<AmazonBook | null>((v) => v === null || (typeof v === "object" && typeof (v as AmazonBook).asin === "string")),
    ebayLowest: z.number().nullable(),
    onEbayAlready: z.number().int().min(0),
    title: z.string().nullable(),
  });

  app.post("/api/batches/:id/items", requireAdmin, (req, res) => {
    const parsed = scanInfoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    const { code, ...info } = parsed.data;
    try {
      res.json(batches.addItem(Number(req.params.id), code, info, listings.getScanSettings()));
    } catch (e) {
      sendBatchError(res, e);
    }
  });

  app.put("/api/batch-items/:id", requireAdmin, (req, res) => {
    const parsed = batchItemPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    try {
      res.json(batches.updateItem(Number(req.params.id), parsed.data));
    } catch (e) {
      sendBatchError(res, e);
    }
  });

  app.delete("/api/batch-items/:id", requireAdmin, (req, res) => {
    try {
      batches.deleteItem(Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      sendBatchError(res, e);
    }
  });

  app.post("/api/batches/:id/list", requireAdmin, (req, res) => {
    try {
      res.json(batches.startListing(Number(req.params.id)));
    } catch (e) {
      sendBatchError(res, e);
    }
  });

  app.put("/api/listing-settings", requireAdmin, (req, res) => {
    const parsed = listingSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    // The longest values each token can take must still fit Amazon's limit.
    const longest = parsed.data.skuTemplate
      .replace(/\{SEQ\}/g, "999999")
      .replace(/\{DATE\}/g, "261231")
      .replace(/\{COND\}/g, "LN")
      .replace(/\{PRICE\}/g, "99999")
      .replace(/\{ISBN\}/g, "9780000000000")
      .replace(/\{ASIN\}/g, "B000000000")
      .replace(/\{BATCH\}/g, "9999")
      .replace(/\{BOX\}/g, "BOX12345");
    if (longest.length > MAX_SKU_LENGTH) {
      return res.status(400).json({ error: `That pattern can make SKUs over Amazon's ${MAX_SKU_LENGTH} characters` });
    }
    batches.saveListingSettings(parsed.data);
    res.json(parsed.data);
  });

  app.put("/api/scan/settings", requireAdmin, (req, res) => {
    const parsed = scanSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten().fieldErrors });
    }
    listings.saveScanSettings(parsed.data);
    res.json(parsed.data);
  });

  // Seller Hub report upload, for when the eBay API isn't available. Replaces
  // the whole list, so an empty or unrecognized file changes nothing.
  app.post(
    "/api/scan/import",
    requireAdmin,
    express.text({ type: "text/csv", limit: "25mb" }),
    (req, res) => {
      const shipping = req.query.shipping === undefined ? null : Number(req.query.shipping);
      if (shipping !== null && (!Number.isFinite(shipping) || shipping < 0)) {
        return res.status(400).json({ error: "Enter a valid shipping amount" });
      }
      if (listings.isRefreshing()) {
        return res.status(409).json({ error: "A refresh is running. Try again in a few minutes." });
      }
      try {
        const report = parseActiveListingsReport(typeof req.body === "string" ? req.body : "", shipping);
        if (report.listings.length === 0) {
          return res.status(400).json({ error: "No listings found in this file. Nothing was changed." });
        }
        listings.importReport(report.listings);
        res.json({
          imported: report.listings.length,
          skipped: report.skipped,
          withIsbn: report.listings.filter((l) => l.isbn).length,
        });
      } catch (e) {
        if (e instanceof ReportError) return res.status(400).json({ error: e.message });
        throw e;
      }
    },
  );

  // Starts in the background: the first run reads every listing one by one.
  app.post("/api/scan/refresh", requireAdmin, (_req, res) => {
    if (!ebay.ebayConnected()) return res.status(400).json({ error: "Connect eBay on the inventory page first" });
    void listings.refreshListings();
    res.status(202).json({ refreshing: true });
  });

  // Shipping supplies (admin page at /#/supplies). Any stock change can cross a
  // reorder point, so each route below re-checks and emails in the background.
  app.get("/api/supplies", requireAdmin, (_req, res) => {
    const checked = (key: string) => inventoryStore.getState(key) ?? null;
    const halfHour = 30 * 60 * 1000;
    res.json({
      // Where orders are counted from, when each was last read, and how long
      // without a check means something is wrong.
      sources: [
        {
          name: "eBay",
          on: ebay.ebayConnected(),
          checkedAt: checked("ebay_orders_since"),
          error: null,
          staleAfterMs: halfHour,
        },
        {
          name: "Whatnot",
          on: whatnot.whatnotConfigured(),
          checkedAt: checked("whatnot_orders_since"),
          error: null,
          staleAfterMs: halfHour,
        },
        {
          name: "Amazon",
          on: amazon.amazonConfigured(),
          checkedAt: checked("amazon_orders_since"),
          error: checked("amazon_last_error") || null,
          staleAfterMs: AMAZON_POLL_MS + 2 * 60 * 60 * 1000,
        },
      ],
      supplies: supplies.listSupplies(),
    });
  });

  app.post("/api/supplies", requireAdmin, (req, res) => {
    const parsed = upsertSupplySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    const supply = supplies.createSupply(parsed.data);
    void supplies.alertLowSupplies();
    res.status(201).json(supply);
  });

  app.put("/api/supplies/:id", requireAdmin, (req, res) => {
    const parsed = upsertSupplySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    const supply = supplies.updateSupply(Number(req.params.id), parsed.data);
    if (!supply) return res.status(404).json({ error: "not_found" });
    void supplies.alertLowSupplies();
    res.json(supply);
  });

  app.delete("/api/supplies/:id", requireAdmin, (req, res) => {
    if (!supplies.deleteSupply(Number(req.params.id))) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
  });

  app.post("/api/supplies/:id/adjust", requireAdmin, (req, res) => {
    const by = req.body?.by;
    if (!Number.isInteger(by)) return res.status(400).json({ error: "by must be a whole number" });
    const supply = supplies.adjustSupply(Number(req.params.id), by);
    if (!supply) return res.status(404).json({ error: "not_found" });
    void supplies.alertLowSupplies();
    res.json(supply);
  });

  app.post("/api/supplies/:id/order", requireAdmin, (req, res) => {
    const supply = supplies.markOrdered(Number(req.params.id));
    if (!supply) return res.status(404).json({ error: "not_found" });
    inventoryStore.log("info", `Ordered ${supply.orderedQuantity} of ${supply.name}`);
    res.json(supply);
  });

  app.delete("/api/supplies/:id/order", requireAdmin, (req, res) => {
    const supply = supplies.cancelOrder(Number(req.params.id));
    if (!supply) return res.status(404).json({ error: "not_found" });
    void supplies.alertLowSupplies();
    res.json(supply);
  });

  app.post("/api/supplies/:id/receive", requireAdmin, (req, res) => {
    const supply = supplies.markReceived(Number(req.params.id));
    if (!supply) return res.status(409).json({ error: "Nothing on order for this supply" });
    inventoryStore.log("info", `Received ${supply.name}; ${supply.quantity} in stock`);
    void supplies.alertLowSupplies();
    res.json(supply);
  });

  // eBay requires this before Production keys work. GET proves we own the URL;
  // POST is a notice that some eBay member closed their account. We keep no
  // buyer data, so there's nothing to delete and the notice is just acknowledged.
  app.get("/api/ebay/account-deletion", (req, res) => {
    const code = req.query.challenge_code;
    const token = process.env.EBAY_VERIFICATION_TOKEN;
    if (!token) return res.status(503).json({ error: "EBAY_VERIFICATION_TOKEN is not set" });
    if (typeof code !== "string" || !code) return res.status(400).json({ error: "challenge_code is required" });
    const hash = crypto.createHash("sha256").update(code).update(token).update(EBAY_DELETION_ENDPOINT);
    res.status(200).json({ challengeResponse: hash.digest("hex") });
  });

  app.post("/api/ebay/account-deletion", (_req, res) => {
    res.status(204).end();
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
