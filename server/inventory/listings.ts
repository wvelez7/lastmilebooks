import { ebayListings } from "@shared/schema";
import type { EbayListingRow } from "@shared/schema";
import { DEFAULT_SCAN_SETTINGS, scanSettingsSchema, toIsbn13 } from "@shared/profit";
import type { ScanSettings } from "@shared/profit";
import { asc, eq, or, sql } from "drizzle-orm";
import { db } from "../storage";
import { inventoryStore } from "./store";
import * as ebay from "./ebay";

// Local copy of the seller's active eBay listings for the barcode scanner, so
// a scan answers instantly. Titles, prices and quantities are refreshed every
// 15 minutes in one cheap call. ISBNs need a call per listing, so those are
// fetched once and only re-checked weekly, a batch at a time.

const REFRESH_MS = 15 * 60 * 1000;
const DETAILS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DETAILS_PER_REFRESH = 1000; // keeps a huge store within eBay's daily call limit
const REFRESHED_KEY = "ebay_listings_refreshed_at";
const SETTINGS_KEY = "scan_settings";

let refreshing = false;

export function isRefreshing(): boolean {
  return refreshing;
}

export async function refreshListings(): Promise<void> {
  if (refreshing || !ebay.ebayConnected()) return;
  refreshing = true;
  try {
    const now = new Date().toISOString();
    const active = await ebay.listActiveListings();

    const activeIds = new Set(active.map((l) => l.itemId));
    db.transaction((tx) => {
      for (const row of tx.select({ itemId: ebayListings.itemId }).from(ebayListings).all()) {
        if (!activeIds.has(row.itemId)) {
          tx.delete(ebayListings).where(eq(ebayListings.itemId, row.itemId)).run();
        }
      }
      for (const l of active) {
        tx.insert(ebayListings)
          .values({ ...l, updatedAt: now })
          .onConflictDoUpdate({
            target: ebayListings.itemId,
            set: {
              sku: l.sku,
              title: l.title,
              price: l.price,
              quantity: l.quantity,
              url: l.url,
              updatedAt: now,
            },
          })
          .run();
      }
    });
    inventoryStore.setState(REFRESHED_KEY, now);

    await fillMissingDetails();
  } catch (e) {
    inventoryStore.log("error", `eBay listing refresh failed: ${(e as Error).message}`);
  } finally {
    refreshing = false;
  }
}

async function fillMissingDetails(): Promise<void> {
  const cutoff = new Date(Date.now() - DETAILS_MAX_AGE_MS).toISOString();
  const stale = db
    .select({ itemId: ebayListings.itemId })
    .from(ebayListings)
    .where(sql`${ebayListings.detailsFetchedAt} IS NULL OR ${ebayListings.detailsFetchedAt} < ${cutoff}`)
    .limit(DETAILS_PER_REFRESH)
    .all();
  let failed = 0;
  for (const { itemId } of stale) {
    try {
      const details = await ebay.getListingDetails(itemId);
      db.update(ebayListings)
        .set({ ...details, detailsFetchedAt: new Date().toISOString() })
        .where(eq(ebayListings.itemId, itemId))
        .run();
    } catch (e) {
      if (failed++ === 0) {
        inventoryStore.log("warn", `Could not read eBay listing ${itemId}: ${(e as Error).message}`);
      }
    }
  }
  if (failed > 1) inventoryStore.log("warn", `${failed} eBay listings could not be read; retrying next refresh`);
}

export function startListingRefresh(): void {
  setInterval(() => void refreshListings(), REFRESH_MS);
  setTimeout(() => void refreshListings(), 10_000);
}

export function listAllListings(): EbayListingRow[] {
  return db.select().from(ebayListings).orderBy(asc(ebayListings.title)).all();
}

// A scan matches on ISBN, or on the SKU for sellers who use the barcode as
// their Custom label (and for non-ISBN codes such as a UPC).
export function findListings(code: string): EbayListingRow[] {
  const raw = code.trim();
  const isbn = toIsbn13(raw);
  const matches = [eq(ebayListings.sku, raw)];
  if (isbn) matches.push(eq(ebayListings.isbn, isbn), eq(ebayListings.sku, isbn));
  return db.select().from(ebayListings).where(or(...matches)).orderBy(asc(ebayListings.price)).all();
}

export function listingStatus() {
  const unscannable = (l: EbayListingRow) => l.detailsFetchedAt && !l.isbn && !toIsbn13(l.sku ?? "");
  const missingIsbn = listAllListings().filter(unscannable).length;
  return {
    connected: ebay.ebayConnected(),
    refreshing,
    refreshedAt: inventoryStore.getState(REFRESHED_KEY) ?? null,
    missingIsbn,
  };
}

export function getScanSettings(): ScanSettings {
  try {
    return scanSettingsSchema.parse(JSON.parse(inventoryStore.getState(SETTINGS_KEY) ?? ""));
  } catch {
    return DEFAULT_SCAN_SETTINGS;
  }
}

export function saveScanSettings(settings: ScanSettings): void {
  inventoryStore.setState(SETTINGS_KEY, JSON.stringify(settings));
}
