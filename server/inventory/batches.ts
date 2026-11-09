import { batchItems, listingBatches } from "@shared/schema";
import type { BatchItemRow, ListingBatchRow } from "@shared/schema";
import {
  batchDefaultsSchema,
  bookCondition,
  buildSku,
  DEFAULT_BATCH_DEFAULTS,
  DEFAULT_LISTING_SETTINGS,
  itemProblem,
  listingSettingsSchema,
  suggestedAmazonPrice,
} from "@shared/listing";
import type {
  AmazonBook,
  Batch,
  BatchDefaults,
  BatchDetail,
  BatchItem,
  BatchItemPatch,
  BatchStatus,
  BookCondition,
  ListingSettings,
  ListResult,
} from "@shared/listing";
import { toIsbn13 } from "@shared/profit";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../storage";
import { inventoryStore } from "./store";
import * as amazon from "./amazon";
import * as ebay from "./ebay";
import * as listings from "./listings";

// Batches of scanned books waiting to be listed (/#/scan, Batch tab). Each
// book is priced when scanned, can be changed until it's listed, and on
// listing joins the inventory sync under its SKU.

const SETTINGS_KEY = "listing_settings";
const SEQ_KEY = "sku_seq";

export class BatchError extends Error {}

export function getListingSettings(): ListingSettings {
  try {
    const saved = JSON.parse(inventoryStore.getState(SETTINGS_KEY) ?? "");
    return listingSettingsSchema.parse({ ...DEFAULT_LISTING_SETTINGS, ...saved });
  } catch {
    return DEFAULT_LISTING_SETTINGS;
  }
}

export function saveListingSettings(settings: ListingSettings): void {
  inventoryStore.setState(SETTINGS_KEY, JSON.stringify(settings));
}

// Never reused, even after a book is deleted, so no two books share a SKU.
function nextSeq(): number {
  return db.transaction(() => {
    const seq = Number(inventoryStore.getState(SEQ_KEY) ?? "0") + 1;
    inventoryStore.setState(SEQ_KEY, String(seq));
    return seq;
  });
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function toItem(row: BatchItemRow): BatchItem {
  return {
    id: row.id,
    batchId: row.batchId,
    sku: row.sku,
    isbn13: row.isbn13,
    title: row.title,
    amazon: parseJson<AmazonBook>(row.amazon),
    ebayLowest: row.ebayLowest,
    onEbayAlready: row.onEbayAlready,
    box: row.box,
    condition: row.condition as BookCondition,
    note: row.note,
    quantity: row.quantity,
    amazonPrice: row.amazonPrice,
    ebayPrice: row.ebayPrice,
    listAmazon: row.listAmazon,
    listEbay: row.listEbay,
    status: row.status as BatchItem["status"],
    amazonResult: parseJson<ListResult>(row.amazonResult),
    ebayResult: parseJson<ListResult>(row.ebayResult),
    createdAt: row.createdAt,
  };
}

function toBatch(row: ListingBatchRow, itemCount: number): Batch {
  const defaults = batchDefaultsSchema.safeParse(parseJson(row.defaults));
  return {
    id: row.id,
    name: row.name,
    status: row.status as BatchStatus,
    defaults: defaults.success ? defaults.data : DEFAULT_BATCH_DEFAULTS,
    createdAt: row.createdAt,
    itemCount,
  };
}

function getRow(id: number): ListingBatchRow {
  const row = db.select().from(listingBatches).where(eq(listingBatches.id, id)).get();
  if (!row) throw new BatchError("Batch not found");
  return row;
}

export function listBatches(): Batch[] {
  const counts = new Map(
    db
      .select({ batchId: batchItems.batchId, n: sql<number>`count(*)` })
      .from(batchItems)
      .groupBy(batchItems.batchId)
      .all()
      .map((r) => [r.batchId, r.n]),
  );
  return db
    .select()
    .from(listingBatches)
    .orderBy(desc(listingBatches.id))
    .all()
    .map((b) => toBatch(b, counts.get(b.id) ?? 0));
}

export function getBatch(id: number): BatchDetail {
  const items = db.select().from(batchItems).where(eq(batchItems.batchId, id)).orderBy(asc(batchItems.id)).all();
  return { ...toBatch(getRow(id), items.length), items: items.map(toItem) };
}

export function createBatch(defaults: BatchDefaults = DEFAULT_BATCH_DEFAULTS): Batch {
  const now = new Date();
  const name = `Batch ${now.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" })}`;
  const row = db
    .insert(listingBatches)
    .values({ name, status: "open", defaults: JSON.stringify(defaults), createdAt: now.toISOString() })
    .returning()
    .get();
  return toBatch(row, 0);
}

// New defaults apply to books scanned from now on.
export function updateBatch(id: number, patch: { name?: string; defaults?: BatchDefaults }): Batch {
  const row = getRow(id);
  const set: Partial<ListingBatchRow> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.defaults !== undefined) set.defaults = JSON.stringify(patch.defaults);
  if (Object.keys(set).length) db.update(listingBatches).set(set).where(eq(listingBatches.id, id)).run();
  return getBatch(row.id);
}

export function deleteBatch(id: number): void {
  if (getRow(id).status === "listing") throw new BatchError("Wait for the batch to finish listing");
  db.delete(batchItems).where(eq(batchItems.batchId, id)).run();
  db.delete(listingBatches).where(eq(listingBatches.id, id)).run();
}

// ---- Books -------------------------------------------------------------------

function skuFor(item: Pick<BatchItemRow, "seq" | "createdAt" | "condition" | "amazonPrice" | "isbn13" | "amazon" | "batchId" | "box">): string {
  return buildSku(getListingSettings().skuTemplate, {
    box: item.box,
    seq: item.seq,
    scannedAt: item.createdAt,
    condition: item.condition as BookCondition,
    amazonPrice: item.amazonPrice,
    isbn13: item.isbn13,
    asin: parseJson<AmazonBook>(item.amazon)?.asin ?? null,
    batchId: item.batchId,
  });
}

export interface ScanInfo {
  amazon: AmazonBook | null;
  ebayLowest: number | null;
  onEbayAlready: number;
  title: string | null;
}

// Prices the book from what the scan found and adds it with the batch's
// defaults. Amazon is only ticked when the book can be listed there.
export function addItem(batchId: number, code: string, info: ScanInfo, amazonSettings: Parameters<typeof suggestedAmazonPrice>[1]): BatchItem {
  const batch = toBatch(getRow(batchId), 0);
  if (batch.status === "listing") throw new BatchError("This batch is listing; start a new one");
  const isbn13 = toIsbn13(code);
  if (!isbn13) throw new BatchError("Only books with an ISBN can be listed");

  const d = batch.defaults;
  const amazonPrice = info.amazon ? suggestedAmazonPrice(info.amazon, amazonSettings) : null;
  const ebayPrice = info.ebayLowest ?? amazonPrice;
  const base = {
    batchId,
    seq: nextSeq(),
    isbn13,
    title: info.amazon?.title || info.title || isbn13,
    amazon: info.amazon ? JSON.stringify(info.amazon) : null,
    ebayLowest: info.ebayLowest,
    onEbayAlready: info.onEbayAlready,
    box: d.box,
    condition: d.condition,
    note: d.note,
    quantity: d.quantity,
    amazonPrice,
    ebayPrice,
    listAmazon: d.amazon && info.amazon !== null && !info.amazon.restriction,
    listEbay: d.ebay,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const row = db.insert(batchItems).values({ ...base, sku: skuFor(base) }).returning().get();
  return toItem(row);
}

function getItemRow(id: number): BatchItemRow {
  const row = db.select().from(batchItems).where(eq(batchItems.id, id)).get();
  if (!row) throw new BatchError("Book not found");
  return row;
}

// The SKU follows the pattern, so changing the condition or price can change it.
export function updateItem(id: number, patch: BatchItemPatch): BatchItem {
  const row = getItemRow(id);
  if (row.status === "listed") throw new BatchError("Already listed; change it on Amazon or eBay");
  if (getRow(row.batchId).status === "listing") throw new BatchError("Wait for the batch to finish listing");
  const next = { ...row, ...patch };
  if (patch.listAmazon && !row.amazon) throw new BatchError("This book isn't on Amazon");
  // Once listed somewhere, the SKU is how the sync finds it, so it stays.
  const listedSomewhere = parseJson<ListResult>(row.amazonResult)?.ok || parseJson<ListResult>(row.ebayResult)?.ok;
  const updated = db
    .update(batchItems)
    .set({ ...patch, sku: listedSomewhere ? row.sku : skuFor(next) })
    .where(eq(batchItems.id, id))
    .returning()
    .get();
  return toItem(updated);
}

export function deleteItem(id: number): void {
  const row = getItemRow(id);
  if (row.status === "listed") throw new BatchError("Already listed; it's in your inventory now");
  db.delete(batchItems).where(eq(batchItems.id, id)).run();
}

// ---- Listing -------------------------------------------------------------------

function setResult(id: number, set: Partial<BatchItemRow>): void {
  db.update(batchItems).set(set).where(eq(batchItems.id, id)).run();
}

// Lists one book where it's ticked and not already listed (so a retry only
// redoes what failed), then adds it to inventory under its SKU.
async function listOne(item: BatchItem): Promise<void> {
  const condition = bookCondition(item.condition);
  const existing = inventoryStore.getBySku(item.sku);
  if (existing && !item.amazonResult?.ok && !item.ebayResult?.ok) {
    const result = { ok: false, message: `SKU ${item.sku} is already used by another book. Change the SKU pattern.` };
    setResult(item.id, { status: "failed", amazonResult: JSON.stringify(result) });
    return;
  }
  inventoryStore.upsert({ sku: item.sku, title: item.title, quantity: item.quantity });
  let amazonResult = item.amazonResult;
  let ebayResult = item.ebayResult;

  if (item.listEbay && !ebayResult?.ok) {
    try {
      const { itemId, shippingPolicy } = await ebay.createListing({
        sku: item.sku,
        isbn13: item.isbn13,
        title: item.title,
        conditionId: condition.ebayId,
        note: item.note,
        price: item.ebayPrice!,
        quantity: item.quantity,
      });
      const url = `https://www.ebay.com/itm/${itemId}`;
      inventoryStore.upsert({ sku: item.sku, title: item.title, quantity: item.quantity, ebayItemId: itemId });
      listings.addListing({
        itemId,
        sku: item.sku,
        title: item.title,
        isbn: item.isbn13,
        price: item.ebayPrice!,
        quantity: item.quantity,
        condition: condition.label,
        url,
      });
      inventoryStore.log("info", `Listed on eBay at $${item.ebayPrice!.toFixed(2)} (item ${itemId})`, item.sku);
      ebayResult = { ok: true, message: `Listed at $${item.ebayPrice!.toFixed(2)}, shipping "${shippingPolicy}"`, url };
    } catch (e) {
      inventoryStore.log("error", `eBay listing failed: ${(e as Error).message}`, item.sku);
      ebayResult = { ok: false, message: (e as Error).message };
    }
  }

  if (item.listAmazon && !amazonResult?.ok) {
    try {
      await amazon.createOffer({
        sku: item.sku,
        asin: item.amazon!.asin,
        conditionType: condition.amazon,
        note: item.note,
        price: item.amazonPrice!,
        quantity: item.quantity,
      });
      inventoryStore.upsert({ sku: item.sku, title: item.title, quantity: item.quantity, amazonSku: item.sku });
      inventoryStore.log("info", `Listed on Amazon at $${item.amazonPrice!.toFixed(2)}`, item.sku);
      amazonResult = {
        ok: true,
        message: `Listed at $${item.amazonPrice!.toFixed(2)}`,
        url: `https://www.amazon.com/dp/${item.amazon!.asin}`,
      };
    } catch (e) {
      inventoryStore.log("error", `Amazon listing failed: ${(e as Error).message}`, item.sku);
      amazonResult = { ok: false, message: (e as Error).message };
    }
  }

  const wanted = [item.listAmazon && amazonResult, item.listEbay && ebayResult].filter(Boolean) as ListResult[];
  const allOk = wanted.every((r) => r.ok);
  // Nothing listed anywhere: keep it out of the inventory sync.
  if (!wanted.some((r) => r.ok)) {
    const inv = inventoryStore.getBySku(item.sku);
    if (inv && !inv.ebayItemId && !inv.amazonSku) inventoryStore.deleteItem(inv.id);
  }
  setResult(item.id, {
    status: allOk ? "listed" : "failed",
    amazonResult: amazonResult ? JSON.stringify(amazonResult) : null,
    ebayResult: ebayResult ? JSON.stringify(ebayResult) : null,
  });
}

export interface ListingCheck {
  ready: number;
  problems: { sku: string; title: string; problem: string }[];
}

function checkMarketplaces(item: BatchItem): string | null {
  if (item.listAmazon && !amazon.amazonListingConfigured()) return "Amazon listing isn't set up (AMAZON_SELLER_ID)";
  if (item.listEbay && !ebay.ebayListingConfigured()) return "eBay listing isn't set up (EBAY_POSTAL_CODE)";
  return null;
}

// Starts listing every book that's ready and returns at once; the batch page
// polls for progress. Books with a problem are left for you to fix.
export function startListing(batchId: number): ListingCheck {
  const batch = getBatch(batchId);
  if (batch.status === "listing") throw new BatchError("Already listing");
  const todo = batch.items.filter((i) => i.status !== "listed");
  const problems = todo.flatMap((i) => {
    const problem = itemProblem(i) ?? checkMarketplaces(i);
    return problem ? [{ sku: i.sku, title: i.title, problem }] : [];
  });
  const ready = todo.filter((i) => !problems.some((p) => p.sku === i.sku));
  if (ready.length === 0) return { ready: 0, problems };

  db.update(listingBatches).set({ status: "listing" }).where(eq(listingBatches.id, batchId)).run();
  void (async () => {
    try {
      for (const item of ready) await listOne(item);
    } catch (e) {
      inventoryStore.log("error", `Batch ${batchId} listing stopped: ${(e as Error).message}`);
    } finally {
      const left = getBatch(batchId).items.some((i) => i.status !== "listed");
      db.update(listingBatches)
        .set({ status: left ? "open" : "done" })
        .where(eq(listingBatches.id, batchId))
        .run();
    }
  })();
  return { ready: ready.length, problems };
}

// A restart mid-listing leaves the rest of the batch pending; let it be listed again.
export function recoverInterruptedBatches(): void {
  db.update(listingBatches).set({ status: "open" }).where(eq(listingBatches.status, "listing")).run();
}
