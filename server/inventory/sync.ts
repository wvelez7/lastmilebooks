import type { InventoryItem, Platform } from "@shared/schema";
import { inventoryStore } from "./store";
import * as whatnot from "./whatnot";
import * as ebay from "./ebay";
import * as amazon from "./amazon";
import { useSuppliesForOrder } from "./supplies";
import { sendTeamAlert } from "../email";

// How it works: when a book sells on one marketplace, its quantity here goes
// down and the new quantity is pushed to every *other* marketplace it's
// listed on (at 0 the listing comes down). Sales arrive two ways: Whatnot
// webhooks (instant, optional) and a poll of both marketplaces' orders every
// INVENTORY_POLL_SECONDS (default 60), which also catches anything missed.

const OVERLAP_MS = 10 * 60 * 1000; // re-read the last 10 min of orders each poll
const PENDING_KEY = "pending_push"; // item ids whose push failed, retried each poll

function connected(platform: Platform): boolean {
  return platform === "whatnot" ? whatnot.whatnotConfigured() : ebay.ebayConnected();
}

function listingId(item: InventoryItem, platform: Platform): string | null {
  return platform === "whatnot" ? item.whatnotVariantId : item.ebayItemId;
}

async function setPlatformQuantity(platform: Platform, id: string, quantity: number): Promise<string> {
  if (platform === "whatnot") {
    await whatnot.setVariantQuantity(id, quantity);
    return "updated";
  }
  return ebay.setListingQuantity(id, quantity);
}

function pending(): Set<number> {
  try {
    return new Set(JSON.parse(inventoryStore.getState(PENDING_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function savePending(ids: Set<number>): void {
  inventoryStore.setState(PENDING_KEY, JSON.stringify(Array.from(ids)));
}

// Push the item's current quantity to every connected marketplace except
// `skip` (the one where the sale happened, which already updated itself).
export async function pushQuantity(item: InventoryItem, skip?: Platform): Promise<boolean> {
  let ok = true;
  for (const platform of ["whatnot", "ebay"] as const) {
    if (platform === skip) continue;
    const id = listingId(item, platform);
    if (!id || !connected(platform)) continue;
    try {
      const result = await setPlatformQuantity(platform, id, item.quantity);
      inventoryStore.log(
        "info",
        result === "ended"
          ? `Ended eBay listing ${id} (sold out)`
          : `Set ${platform} quantity to ${item.quantity}`,
        item.sku,
      );
    } catch (e) {
      ok = false;
      inventoryStore.log("error", `Could not update ${platform}: ${(e as Error).message}`, item.sku);
    }
  }

  const ids = pending();
  const alreadyPending = ids.has(item.id);
  if (ok) ids.delete(item.id);
  else ids.add(item.id);
  savePending(ids);

  // Email once when a sold-out book first fails to come down, not on every retry.
  if (!ok && !alreadyPending && item.quantity === 0) {
    sendTeamAlert(
      `Inventory sync: pull "${item.title}" by hand`,
      `"${item.title}" (SKU ${item.sku}) sold out, but the sync couldn't update every marketplace.\n` +
        `It will keep retrying every minute. To be safe, remove the listing yourself now.\n\n` +
        `Details are on the inventory page: /#/inventory`,
    ).catch((e) => console.error("[inventory] alert email failed:", e));
  }
  return ok;
}

interface Sale {
  platform: Platform;
  saleKey: string;
  quantity: number;
  title: string;
  sku?: string | null;
  listingId?: string | null;
}

// An eBay sale can't reach a Whatnot listing that has no variant, so ask for it to
// be pulled by hand rather than risk selling the same copy twice.
async function warnIfOnWhatnot(title: string, sku?: string | null): Promise<void> {
  if (!whatnot.whatnotConfigured()) return;
  try {
    if (!(await whatnot.hasProductTitled(title))) return;
    inventoryStore.log("warn", `Sold on eBay, also on Whatnot: remove "${title}" by hand`, sku ?? undefined);
    await sendTeamAlert(
      `Remove from Whatnot: "${title}"`,
      `"${title}" just sold on eBay and is also listed on Whatnot, where the sync can't update it.
` +
        `Remove it from Whatnot now so it doesn't sell twice.`,
    );
  } catch (e) {
    inventoryStore.log("error", `Could not check Whatnot for "${title}": ${(e as Error).message}`, sku ?? undefined);
  }
}

export async function recordSale(sale: Sale): Promise<void> {
  if (!inventoryStore.claimSale(sale.saleKey)) return; // already handled

  // Before the lookup below: books that aren't cross-listed still ship.
  await useSuppliesForOrder(sale.saleKey.slice(0, sale.saleKey.lastIndexOf(":"))).catch((e) =>
    inventoryStore.log("error", `Could not update supplies: ${(e as Error).message}`),
  );

  const item =
    (sale.listingId &&
      (sale.platform === "whatnot"
        ? inventoryStore.getByWhatnotVariant(sale.listingId)
        : inventoryStore.getByEbayItem(sale.listingId))) ||
    (sale.sku ? inventoryStore.getBySku(sale.sku.trim()) : undefined);

  if (!item) {
    // Normal for live-show books that were never cross-listed.
    inventoryStore.log("info", `Sold on ${sale.platform}, not cross-listed: ${sale.title}`, sale.sku);
    if (sale.platform === "ebay") await warnIfOnWhatnot(sale.title, sale.sku);
    return;
  }

  const updated = inventoryStore.decrement(item.id, sale.quantity)!;
  inventoryStore.log(
    "info",
    `Sold ${sale.quantity} on ${sale.platform}; ${updated.quantity} left`,
    item.sku,
  );
  await pushQuantity(updated, sale.platform);
  if (sale.platform === "ebay" && !updated.whatnotVariantId && updated.quantity === 0) {
    await warnIfOnWhatnot(updated.title, updated.sku);
  }
}

// ---- Whatnot ---------------------------------------------------------------

export async function handleWhatnotOrder(orderId: string): Promise<void> {
  const orderKey = `whatnot:order:${orderId}`;
  if (inventoryStore.hasSale(orderKey)) return;
  const order = await whatnot.getOrder(orderId);
  await processWhatnotOrder(order);
}

async function processWhatnotOrder(order: whatnot.WhatnotOrder): Promise<void> {
  const orderKey = `whatnot:order:${order.id}`;
  if (inventoryStore.hasSale(orderKey)) return;
  if (order.status === "cancelled" || order.status === "failed") return;

  const items = await whatnot.listOrderItems(order.id);
  for (const line of items) {
    await recordSale({
      platform: "whatnot",
      saleKey: `whatnot:${order.id}:${line.id}`,
      quantity: line.quantity,
      title: line.purchased_item?.title ?? "(untitled)",
      sku: line.purchased_item?.sku,
      listingId: line.variant_id,
    });
  }
  inventoryStore.claimSale(orderKey);
}

async function pollWhatnot(): Promise<void> {
  const started = new Date();
  const since = checkpoint("whatnot_orders_since", started);
  const orders = await whatnot.listOrdersSince(new Date(since.getTime() - OVERLAP_MS));
  for (const order of orders.reverse()) await processWhatnotOrder(order);
  inventoryStore.setState("whatnot_orders_since", started.toISOString());
}

// ---- eBay ------------------------------------------------------------------

async function pollEbay(): Promise<void> {
  const started = new Date();
  const since = checkpoint("ebay_orders_since", started);
  const orders = await ebay.listOrdersSince(new Date(since.getTime() - OVERLAP_MS));
  for (const order of orders) {
    if (order.cancelStatus?.cancelState === "CANCELED") continue;
    for (const line of order.lineItems) {
      await recordSale({
        platform: "ebay",
        saleKey: `ebay:${order.orderId}:${line.lineItemId}`,
        quantity: line.quantity,
        title: line.title,
        sku: line.sku,
        listingId: line.legacyItemId,
      });
    }
  }
  inventoryStore.setState("ebay_orders_since", started.toISOString());
}

// ---- Amazon ----------------------------------------------------------------

// Amazon only counts against shipping supplies; books aren't synced there, so
// once a day is enough. A failed check is retried every 5 minutes instead.
export const AMAZON_POLL_MS = (Number(process.env.AMAZON_POLL_SECONDS) || 86_400) * 1000;
const AMAZON_RETRY_MS = Math.min(5 * 60 * 1000, AMAZON_POLL_MS);
let lastAmazonAttempt = 0;

async function pollAmazon(): Promise<void> {
  // Last success is saved, so a restart or deploy doesn't trigger an early check.
  const lastSuccess = inventoryStore.getState("amazon_orders_since");
  if (lastSuccess && Date.now() - new Date(lastSuccess).getTime() < AMAZON_POLL_MS) return;
  if (Date.now() - lastAmazonAttempt < AMAZON_RETRY_MS) return;
  lastAmazonAttempt = Date.now();
  const started = new Date();
  // Orders placed before the first check were never counted and are skipped
  // even when they ship later. The checked-up-to time is only saved on success,
  // so the supplies page can show whether Amazon is really working.
  const firstCheck = checkpoint("amazon_orders_start", started);
  const since = new Date(inventoryStore.getState("amazon_orders_since") ?? started.toISOString());
  try {
    const orders = await amazon.listShippableOrdersSince(new Date(since.getTime() - OVERLAP_MS));
    for (const order of orders) {
      if (new Date(order.PurchaseDate) < firstCheck) continue;
      await useSuppliesForOrder(`amazon:${order.AmazonOrderId}`);
    }
  } catch (e) {
    inventoryStore.setState("amazon_last_error", (e as Error).message);
    throw e;
  }
  inventoryStore.setState("amazon_last_error", "");
  inventoryStore.setState("amazon_orders_since", started.toISOString());
}

// First poll starts from "now" so old orders are never replayed.
function checkpoint(key: string, now: Date): Date {
  const saved = inventoryStore.getState(key);
  if (saved) return new Date(saved);
  inventoryStore.setState(key, now.toISOString());
  return now;
}

// ---- Poll loop ---------------------------------------------------------------

let running = false;

export async function runSyncOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (whatnot.whatnotConfigured()) {
      await pollWhatnot().catch((e) =>
        inventoryStore.log("error", `Whatnot order check failed: ${(e as Error).message}`),
      );
    }
    if (ebay.ebayConnected()) {
      await pollEbay().catch((e) =>
        inventoryStore.log("error", `eBay order check failed: ${(e as Error).message}`),
      );
    }
    if (amazon.amazonConfigured()) {
      await pollAmazon().catch((e) =>
        inventoryStore.log("error", `Amazon order check failed: ${(e as Error).message}`),
      );
    }
    for (const id of Array.from(pending())) {
      const item = inventoryStore.getById(id);
      if (item) await pushQuantity(item);
      else {
        const ids = pending();
        ids.delete(id);
        savePending(ids);
      }
    }
  } finally {
    running = false;
  }
}

export function startInventorySync(): void {
  const seconds = Number(process.env.INVENTORY_POLL_SECONDS) || 60;
  if (!whatnot.whatnotConfigured() && !ebay.ebayAppConfigured() && !amazon.amazonConfigured()) {
    console.log("[inventory] No marketplace credentials set; sync is off.");
    return;
  }
  console.log(`[inventory] Checking orders every ${seconds}s.`);
  setInterval(() => void runSyncOnce(), seconds * 1000);
  setTimeout(() => void runSyncOnce(), 5_000);
}

// ---- Import / match by SKU ------------------------------------------------

export interface ImportSummary {
  matched: number;
  whatnotOnly: number;
  ebayOnly: number;
  duplicates: string[];
}

// Pull every SKU'd listing from both marketplaces and link them by SKU.
// Existing rows keep their quantity; new rows start at the lowest quantity
// any marketplace shows.
export async function importListings(): Promise<ImportSummary> {
  const [wn, eb] = await Promise.all([
    whatnot.whatnotConfigured() ? whatnot.listListings() : Promise.resolve([]),
    ebay.ebayConnected() ? ebay.listListings() : Promise.resolve([]),
  ]);

  const duplicates = new Set<string>();
  const bySku = new Map<string, { title: string; qty: number[]; wn?: string; eb?: string }>();
  for (const l of wn) {
    const row = bySku.get(l.sku) ?? { title: l.title, qty: [] };
    if (row.wn) duplicates.add(`${l.sku} (Whatnot)`);
    row.wn = l.variantId;
    row.qty.push(l.quantity);
    bySku.set(l.sku, row);
  }
  for (const l of eb) {
    const row = bySku.get(l.sku) ?? { title: l.title, qty: [] };
    if (row.eb) duplicates.add(`${l.sku} (eBay)`);
    row.eb = l.itemId;
    row.qty.push(l.quantity);
    bySku.set(l.sku, row);
  }

  const summary: ImportSummary = { matched: 0, whatnotOnly: 0, ebayOnly: 0, duplicates: Array.from(duplicates) };
  for (const [sku, row] of Array.from(bySku)) {
    const existing = inventoryStore.getBySku(sku);
    inventoryStore.upsert({
      sku,
      title: existing?.title ?? row.title,
      quantity: existing?.quantity ?? Math.min(...row.qty),
      whatnotVariantId: row.wn ?? existing?.whatnotVariantId ?? null,
      ebayItemId: row.eb ?? existing?.ebayItemId ?? null,
    });
    if (row.wn && row.eb) summary.matched++;
    else if (row.wn) summary.whatnotOnly++;
    else summary.ebayOnly++;
  }
  inventoryStore.log(
    "info",
    `Imported listings: ${summary.matched} on both, ${summary.whatnotOnly} Whatnot only, ${summary.ebayOnly} eBay only`,
  );
  for (const d of summary.duplicates) {
    inventoryStore.log("warn", `SKU used on more than one listing: ${d}. Give each book its own SKU.`);
  }
  return summary;
}
