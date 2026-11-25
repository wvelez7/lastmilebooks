// eBay price check for the most expensive listings: compares each book with
// the cheapest other eBay listing and the cheapest used Amazon offer in the
// same or better condition (shipping included, since buyers compare totals)
// and works out the price that matches it. A check only reports; prices change
// only when the chosen changes are sent to applyPrices.
import { desc, eq } from "drizzle-orm";
import { ebayListings } from "@shared/schema";
import { toIsbn13 } from "@shared/profit";
import { CONDITION_ORDER, normalizeCondition } from "@shared/repricer";
import type { RepricerCondition } from "@shared/repricer";
import { db } from "../storage";
import * as ebay from "./ebay";
import * as amazon from "./amazon";
import { inventoryStore } from "./store";

const RESULT_KEY = "ebay_price_check";
// A match this far below the current price is more likely a different
// edition or a misdescribed copy, so it is held for a person to look at.
const HOLD_BELOW = 0.5;

export interface PriceCheckRow {
  itemId: string;
  title: string;
  isbn: string | null;
  condition: string | null;
  price: number;
  shipping: number | null;
  ebayLowest: { total: number; price: number; shipping: number; condition: string | null; url: string | null } | null;
  amazonLowest: { total: number; price: number; shipping: number; condition: string; fba: boolean } | null;
  target: number | null; // the price that matches the cheapest competitor
  status: "lower" | "hold" | "competitive" | "no-competitors" | "no-isbn" | "error";
  note: string | null;
}

export interface PriceCheckJob {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  done: number;
  total: number;
  rows: PriceCheckRow[];
}

let job: PriceCheckJob = { running: false, startedAt: null, finishedAt: null, done: 0, total: 0, rows: [] };

export function priceCheckJob(): PriceCheckJob {
  if (job.rows.length || job.running) return job;
  try {
    return JSON.parse(inventoryStore.getState(RESULT_KEY) ?? "") as PriceCheckJob;
  } catch {
    return job;
  }
}

// eBay's Browse API says "Brand New"; books otherwise use the same names.
function ebayCondition(raw: string | null): RepricerCondition | null {
  if (/brand\s*new/i.test(raw ?? "")) return "new";
  return normalizeCondition(raw);
}

const rank = (c: RepricerCondition) => CONDITION_ORDER.indexOf(c);
const round = (n: number) => Math.round(n * 100) / 100;

export function startCheck(limit: number): PriceCheckJob {
  if (job.running) return job;
  const rows = db
    .select()
    .from(ebayListings)
    .orderBy(desc(ebayListings.price))
    .all()
    .filter((l) => l.quantity > 0)
    .slice(0, limit);
  job = { running: true, startedAt: new Date().toISOString(), finishedAt: null, done: 0, total: rows.length, rows: [] };
  const ours = new Set(db.select({ itemId: ebayListings.itemId }).from(ebayListings).all().map((r) => r.itemId));

  void (async () => {
    for (const l of rows) {
      const isbn = l.isbn ?? toIsbn13(l.sku ?? "");
      const row: PriceCheckRow = {
        itemId: l.itemId,
        title: l.title,
        isbn,
        condition: l.condition,
        price: l.price,
        shipping: l.shipping,
        ebayLowest: null,
        amazonLowest: null,
        target: null,
        status: "no-competitors",
        note: null,
      };
      try {
        if (!isbn) {
          row.status = "no-isbn";
        } else {
          checkRow(row, await competitors(isbn, ours, ebayCondition(l.condition)));
        }
      } catch (e) {
        row.status = "error";
        row.note = (e as Error).message;
      }
      job.rows.push(row);
      job.done++;
    }
    job.running = false;
    job.finishedAt = new Date().toISOString();
    inventoryStore.setState(RESULT_KEY, JSON.stringify(job));
  })();
  return job;
}

async function competitors(isbn: string, ours: Set<string>, condition: RepricerCondition | null) {
  // Unknown condition on our side: compare with every copy.
  const ok = (c: RepricerCondition | null) => condition === null || (c !== null && rank(c) <= rank(condition));
  const [market, book] = await Promise.all([
    ebay.searchMarket(isbn, 20),
    amazon.amazonConfigured() ? amazon.lookupBook(isbn) : Promise.resolve(null),
  ]);
  const ebayBest = market
    .filter((o) => !(o.itemId && ours.has(o.itemId)) && o.shipping !== null && o.price > 0)
    .filter((o) => ok(ebayCondition(o.condition)))
    .map((o) => ({ total: round(o.price + o.shipping!), price: o.price, shipping: o.shipping!, condition: o.condition, url: o.url }))
    .sort((a, b) => a.total - b.total)[0] ?? null;
  const amazonBest = (book?.offers ?? [])
    .filter((o) => !o.mine && ok(normalizeCondition(o.condition)))
    .map((o) => ({ total: round(o.price + o.shipping), price: o.price, shipping: o.shipping, condition: o.condition, fba: o.fba }))
    .sort((a, b) => a.total - b.total)[0] ?? null;
  return { ebayBest, amazonBest };
}

function checkRow(row: PriceCheckRow, c: Awaited<ReturnType<typeof competitors>>): void {
  row.ebayLowest = c.ebayBest;
  row.amazonLowest = c.amazonBest;
  const best = [c.ebayBest?.total, c.amazonBest?.total].filter((t): t is number => t !== undefined);
  if (!best.length) return;
  const lowest = Math.min(...best);
  // Buyers pay our flat shipping on top; with calculated shipping it's unknown,
  // so compare item prices alone.
  const ourShipping = row.shipping ?? 0;
  if (row.shipping === null) row.note = "calculated shipping: compared on totals as if free";
  const target = round(lowest - ourShipping);
  if (row.price + ourShipping <= lowest + 0.005) {
    row.status = "competitive";
    return;
  }
  row.target = Math.max(0.99, target);
  row.status = row.target < row.price * HOLD_BELOW ? "hold" : "lower";
}

// Sends new prices to eBay and updates the local copy.
export async function applyPrices(changes: { itemId: string; price: number }[]) {
  const results: { itemId: string; price: number; ok: boolean; error?: string }[] = [];
  for (const { itemId, price } of changes) {
    try {
      await ebay.setListingPrice(itemId, round(price));
      db.update(ebayListings).set({ price: round(price) }).where(eq(ebayListings.itemId, itemId)).run();
      results.push({ itemId, price, ok: true });
    } catch (e) {
      results.push({ itemId, price, ok: false, error: (e as Error).message });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  inventoryStore.log("info", `eBay price check: changed ${ok} of ${changes.length} prices`);
  return results;
}
