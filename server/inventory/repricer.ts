// Amazon repricer for books you ship yourself, in place of SmartRepricer's
// "Lowest MF Price" strategy. Each run:
//   1. reads every listing from the GET_MERCHANT_LISTINGS_ALL_DATA report,
//   2. asks Amazon for each book's offers in its condition (20 books a call),
//   3. matches the cheapest other seller who ships their own copy in the same
//      or better condition, compared with shipping included, kept within the
//      book's min and max,
//   4. sends the new prices to Amazon, but only while switched on; while off
//      it shows what it would do.
// Runs on its own every few hours while switched on (startRepricer).
import { asc, desc, eq } from "drizzle-orm";
import { repricerChanges, repricerListings } from "@shared/schema";
import type { RepricerListingRow } from "@shared/schema";
import {
  CONDITION_ORDER,
  DEFAULT_REPRICER_SETTINGS,
  effectiveMinMax,
  normalizeCondition,
  repricerSettingsSchema,
} from "@shared/repricer";
import type { RepricerChange, RepricerJob, RepricerListing, RepricerSettings } from "@shared/repricer";
import { db } from "../storage";
import * as amazon from "./amazon";
import type { ItemOffers } from "./amazon";
import { fetchReportOfType, parseFlatFile } from "./amazonReturns";
import { parseCsv } from "./ebayReport";
import { inventoryStore } from "./store";
import { isXlsx, readFirstSheet } from "./xlsx";

const SETTINGS_KEY = "repricer_settings";
const LAST_RUN_KEY = "repricer_last_run";

export function getSettings(): RepricerSettings {
  try {
    const saved = JSON.parse(inventoryStore.getState(SETTINGS_KEY) ?? "{}");
    return repricerSettingsSchema.parse({ ...DEFAULT_REPRICER_SETTINGS, ...saved });
  } catch {
    return DEFAULT_REPRICER_SETTINGS;
  }
}

export function saveSettings(s: RepricerSettings): void {
  const was = getSettings().enabled;
  inventoryStore.setState(SETTINGS_KEY, JSON.stringify(s));
  if (s.enabled !== was) {
    inventoryStore.log("info", s.enabled ? "Repricer switched on" : "Repricer switched off");
  }
}

// ---- Deciding a price ----------------------------------------------------

const round = (n: number) => Math.round(n * 100) / 100;
const rank = (c: string) => CONDITION_ORDER.indexOf(c as (typeof CONDITION_ORDER)[number]);

export interface Decision {
  target: number | null; // null = leave the price alone
  status: string;
  competitorPrice: number | null;
  competitorLabel: string | null;
  competitors: number;
  buyBoxPrice: number | null;
  hasBuyBox: boolean;
  myShipping: number;
}

function conditionLabel(c: string) {
  return c.replace(/_/g, " ").replace(/^\w/, (x) => x.toUpperCase());
}

// Exported for testing.
export function decidePrice(
  l: Pick<RepricerListing, "condition" | "price" | "minPrice" | "maxPrice" | "minMaxSource" | "openedAt" | "firstPrice">,
  item: ItemOffers,
  s: RepricerSettings,
  now = Date.now(),
): Decision {
  const mine = item.offers.find((o) => o.mine);
  const myShipping = mine?.shipping ?? s.myShipping;
  const base = {
    competitorPrice: null,
    competitorLabel: null,
    competitors: 0,
    buyBoxPrice: item.buyBox ? round(item.buyBox.price + item.buyBox.shipping) : null,
    hasBuyBox: Boolean(mine?.buyBoxWinner),
    myShipping,
  };
  const myCondition = normalizeCondition(l.condition);
  if (!myCondition) return { ...base, target: null, status: "Condition isn't repriced" };
  if (item.error) return { ...base, target: null, status: `Price check failed: ${item.error}` };
  const { min, max } = effectiveMinMax(l, s, now);
  if (min > max) return { ...base, target: null, status: `Min $${min.toFixed(2)} is above max $${max.toFixed(2)}` };

  const rivals = item.offers
    .filter((o) => !o.mine && (s.competeWithFba || !o.fba))
    .filter((o) => {
      const c = normalizeCondition(o.condition);
      return c !== null && rank(c) <= rank(myCondition);
    })
    .filter((o) => s.minFeedbackPercent === 0 || o.feedbackPercent === null || o.feedbackPercent >= s.minFeedbackPercent)
    .sort((a, b) => a.price + a.shipping - (b.price + b.shipping));
  const lowest = rivals[0];
  const clamp = (p: number) => round(Math.min(max, Math.max(min, p)));

  if (!lowest) {
    const target = s.noCompetition === "max" ? max : clamp(l.price);
    return {
      ...base,
      target,
      status: s.noCompetition === "max" ? "No competition: at max" : target === l.price ? "No competition: kept" : "No competition: moved inside min/max",
    };
  }

  const landed = round(lowest.price + lowest.shipping);
  const wanted = round(landed - myShipping);
  const target = clamp(wanted);
  const label = `${lowest.fba ? "FBA" : "MF"} ${conditionLabel(normalizeCondition(lowest.condition)!)}`;
  return {
    ...base,
    competitorPrice: landed,
    competitorLabel: label,
    competitors: rivals.length,
    target,
    status: wanted < min ? "At min: competitor is lower" : wanted > max ? "At max" : "Matching lowest",
  };
}

// ---- Listings from Amazon's report ---------------------------------------

// item-condition in the listings report.
const REPORT_CONDITIONS: Record<string, string> = {
  "1": "like_new",
  "2": "very_good",
  "3": "good",
  "4": "acceptable",
  "11": "new",
};

// "2026-10-03 14:21:33 PDT" → ISO; the time zone is ignored, the day is what matters.
function openDate(s: string | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T]?(\d{2}:\d{2}:\d{2})?/.exec(s ?? "");
  return m ? `${m[1]}T${m[2] ?? "00:00:00"}Z` : null;
}

// Exported for testing. Books you ship yourself that are for sale now.
export function parseListingsReport(text: string) {
  return parseFlatFile(text)
    .filter((r) => (r.status ?? "Active").toLowerCase() === "active")
    .filter((r) => !r.fulfillmentchannel || r.fulfillmentchannel.toUpperCase() === "DEFAULT")
    .map((r) => ({
      sku: r.sellersku,
      asin: r.asin1 || r.productid || "",
      title: r.itemname || r.sellersku,
      condition: REPORT_CONDITIONS[r.itemcondition] ?? (r.itemcondition ? `other_${r.itemcondition}` : null),
      price: Number(r.price),
      quantity: Number(r.quantity) || 0,
      openedAt: openDate(r.opendate),
    }))
    .filter((r) => r.sku && r.asin && Number.isFinite(r.price) && r.price > 0 && r.quantity > 0);
}

function saveListings(found: ReturnType<typeof parseListingsReport>): void {
  const seen = new Set(found.map((l) => l.sku));
  db.transaction((tx) => {
    for (const l of found) {
      const existing = tx.select().from(repricerListings).where(eq(repricerListings.sku, l.sku)).get();
      if (existing) {
        tx.update(repricerListings)
          .set({ asin: l.asin, title: l.title, condition: l.condition, price: l.price, quantity: l.quantity, openedAt: l.openedAt, active: true })
          .where(eq(repricerListings.sku, l.sku))
          .run();
      } else {
        tx.insert(repricerListings).values({ ...l, firstPrice: l.price, active: true }).run();
      }
    }
    for (const row of tx.select({ sku: repricerListings.sku }).from(repricerListings).where(eq(repricerListings.active, true)).all()) {
      if (!seen.has(row.sku)) tx.update(repricerListings).set({ active: false }).where(eq(repricerListings.sku, row.sku)).run();
    }
  });
}

const LISTINGS_AT_KEY = "amazon_listings_refreshed_at";

// Refreshes the stored listings without repricing anything; the profit page
// uses it for what your listed books are worth.
export async function refreshListings(): Promise<number> {
  const found = parseListingsReport(await fetchReportOfType("GET_MERCHANT_LISTINGS_ALL_DATA"));
  if (found.length === 0) throw new Error("Amazon's listings report had no books you ship yourself");
  saveListings(found);
  inventoryStore.setState(LISTINGS_AT_KEY, new Date().toISOString());
  return found.length;
}

export function listingsRefreshedAt(): string | null {
  return inventoryStore.getState(LISTINGS_AT_KEY) ?? null;
}

// ---- A run -----------------------------------------------------------------

const job: RepricerJob = {
  running: false,
  step: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  checked: 0,
  changed: 0,
  failed: 0,
};

export function repricerJob(): RepricerJob {
  return { ...job };
}

export function startRun(): RepricerJob {
  if (!amazon.amazonListingConfigured()) {
    throw new Error("Set AMAZON_SELLER_ID and the Amazon keys on the server first");
  }
  if (!job.running) void run();
  return repricerJob();
}

async function run(): Promise<void> {
  const settings = getSettings();
  Object.assign(job, {
    running: true,
    step: "Getting your listings from Amazon",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    checked: 0,
    changed: 0,
    failed: 0,
  });
  inventoryStore.setState(LAST_RUN_KEY, job.startedAt!);
  try {
    const found = parseListingsReport(await fetchReportOfType("GET_MERCHANT_LISTINGS_ALL_DATA"));
    if (found.length === 0) throw new Error("Amazon's listings report had no books you ship yourself");
    saveListings(found);
    inventoryStore.setState(LISTINGS_AT_KEY, new Date().toISOString());

    const rows = db.select().from(repricerListings).where(eq(repricerListings.active, true)).all();
    const offers = new Map<string, ItemOffers>();
    for (const isNew of [false, true]) {
      const asins = Array.from(
        new Set(rows.filter((r) => (r.condition === "new") === isNew && normalizeCondition(r.condition)).map((r) => r.asin)),
      );
      if (asins.length === 0) continue;
      const before = offers.size;
      for (const o of await amazon.getOffersInBatches(asins, isNew, (done) => {
        job.step = `Checking competitors: ${before + done} of ${rows.length} books`;
      })) {
        offers.set(`${isNew}:${o.asin}`, o);
      }
    }

    job.step = settings.enabled ? "Updating prices on Amazon" : "Working out prices (switched off, nothing sent)";
    const now = new Date().toISOString();
    for (const row of rows) {
      const item = offers.get(`${row.condition === "new"}:${row.asin}`) ?? { asin: row.asin, offers: [], buyBox: null, error: null };
      const d = decidePrice({ ...row, minMaxSource: row.minMaxSource as RepricerListing["minMaxSource"] }, item, settings);
      job.checked++;
      const patch: Partial<RepricerListingRow> = {
        competitorPrice: d.competitorPrice,
        competitorLabel: d.competitorLabel,
        competitors: d.competitors,
        buyBoxPrice: d.buyBoxPrice,
        hasBuyBox: d.hasBuyBox,
        myShipping: d.myShipping,
        targetPrice: d.target,
        status: d.status,
        checkedAt: now,
      };
      if (d.target !== null && Math.abs(d.target - row.price) >= 0.01) {
        job.changed++;
        if (settings.enabled) {
          let error: string | null = null;
          try {
            await amazon.setOfferPrice(row.sku, d.target);
            patch.price = d.target;
            patch.changedAt = now;
          } catch (e) {
            error = (e as Error).message;
            job.failed++;
          }
          db.insert(repricerChanges)
            .values({
              sku: row.sku,
              title: row.title,
              oldPrice: row.price,
              newPrice: d.target,
              competitorPrice: d.competitorPrice,
              reason: d.status,
              error,
            })
            .run();
          await new Promise((r) => setTimeout(r, 250)); // listings calls allow 5 a second
        }
      }
      db.update(repricerListings).set(patch).where(eq(repricerListings.sku, row.sku)).run();
    }
    if (settings.enabled && job.changed > 0) {
      inventoryStore.log(
        job.failed ? "warn" : "info",
        `Repricer changed ${job.changed - job.failed} Amazon prices${job.failed ? `; ${job.failed} failed` : ""}`,
      );
    }
  } catch (e) {
    job.error = (e as Error).message;
    inventoryStore.log("error", `Repricer failed: ${job.error}`);
  } finally {
    job.running = false;
    job.step = null;
    job.finishedAt = new Date().toISOString();
  }
}

// Every few minutes, run if switched on and the last run is old enough.
export function startRepricer(): void {
  if (!amazon.amazonListingConfigured()) return;
  setInterval(() => {
    const s = getSettings();
    if (!s.enabled || job.running) return;
    const last = inventoryStore.getState(LAST_RUN_KEY);
    if (last && Date.now() - new Date(last).getTime() < s.intervalHours * 3_600_000) return;
    void run();
  }, 5 * 60_000);
}

// ---- What the page shows ---------------------------------------------------

export function listListings(): RepricerListing[] {
  return db
    .select()
    .from(repricerListings)
    .where(eq(repricerListings.active, true))
    .orderBy(asc(repricerListings.title))
    .all()
    .map(({ active: _active, ...r }) => ({ ...r, minMaxSource: r.minMaxSource as RepricerListing["minMaxSource"] }));
}

export function listChanges(limit = 300): RepricerChange[] {
  return db.select().from(repricerChanges).orderBy(desc(repricerChanges.id)).limit(limit).all();
}

// null for both puts the book back on the automatic min/max.
export function setMinMax(sku: string, min: number | null, max: number | null): RepricerListing | null {
  const row = db.select().from(repricerListings).where(eq(repricerListings.sku, sku)).get();
  if (!row) return null;
  db.update(repricerListings)
    .set(min === null || max === null ? { minPrice: null, maxPrice: null, minMaxSource: null } : { minPrice: min, maxPrice: max, minMaxSource: "manual" })
    .where(eq(repricerListings.sku, sku))
    .run();
  return listListings().find((l) => l.sku === sku) ?? null;
}

export class MinMaxFileError extends Error {}

// SmartRepricer's inventory export (.xlsx or .csv): SKU, Min Price, Max Price,
// and, when there, Asin, Product Name and LISTING PRICE so books not seen yet
// still get their min/max. A min/max set by hand on the page is kept.
export function importMinMaxFile(bytes: Buffer): { updated: number; added: number; keptManual: number; skipped: number } {
  let table: string[][];
  try {
    table = isXlsx(bytes) ? readFirstSheet(bytes) : (() => {
      const text = bytes.toString("utf8").replace(/^﻿/, "");
      return text.split(/\r?\n/, 1)[0].includes("\t")
        ? text.split(/\r?\n/).map((l) => l.split("\t"))
        : parseCsv(text.endsWith("\n") ? text : `${text}\n`);
    })();
  } catch (e) {
    throw new MinMaxFileError(`Couldn't read the file: ${(e as Error).message}`);
  }
  const headers = (table[0] ?? []).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const col = (...names: string[]) => headers.findIndex((h) => names.includes(h));
  const [skuCol, minCol, maxCol] = [col("sku", "sellersku"), col("minprice", "min"), col("maxprice", "max")];
  if (skuCol < 0 || minCol < 0 || maxCol < 0) {
    throw new MinMaxFileError("The file needs SKU, Min Price and Max Price columns");
  }
  const [asinCol, titleCol, priceCol] = [col("asin", "asin1"), col("productname", "title", "itemname"), col("listingprice", "price")];
  const money = (s: string | undefined) => {
    const n = Number((s ?? "").replace(/[$,\s]/g, ""));
    return s && Number.isFinite(n) && n > 0 ? n : null;
  };
  const result = { updated: 0, added: 0, keptManual: 0, skipped: 0 };
  db.transaction((tx) => {
    for (const r of table.slice(1)) {
      const sku = (r[skuCol] ?? "").trim();
      const [min, max] = [money(r[minCol]), money(r[maxCol])];
      if (!sku || min === null || max === null || min > max) {
        if (r.some((c) => c.trim())) result.skipped++;
        continue;
      }
      const existing = tx.select().from(repricerListings).where(eq(repricerListings.sku, sku)).get();
      if (existing?.minMaxSource === "manual") {
        result.keptManual++;
      } else if (existing) {
        tx.update(repricerListings).set({ minPrice: min, maxPrice: max, minMaxSource: "file" }).where(eq(repricerListings.sku, sku)).run();
        result.updated++;
      } else {
        // Shown once the next run finds it on Amazon.
        tx.insert(repricerListings)
          .values({
            sku,
            // Excel turns ISBN-style ASINs into numbers and drops the leading zero.
            asin: asinCol >= 0 ? (r[asinCol] ?? "").trim().replace(/^\d{1,9}$/, (a) => a.padStart(10, "0")) : "",
            title: titleCol >= 0 ? (r[titleCol] ?? "").trim() || sku : sku,
            price: (priceCol >= 0 ? money(r[priceCol]) : null) ?? min,
            minPrice: min,
            maxPrice: max,
            minMaxSource: "file",
            active: false,
          })
          .run();
        result.added++;
      }
    }
  });
  inventoryStore.log("info", `Repricer min/max file: ${result.updated + result.added} books, ${result.keptManual} set by hand kept`);
  return result;
}
