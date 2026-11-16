import { z } from "zod";

// Profit dashboard (/#/profit). The server stores what Amazon and eBay say
// each sale brought in and what they charged for it; the page adds the costs
// only you know (what the book cost, postage, supplies) and totals it up, so
// changing a cost updates the numbers at once.

export type ProfitPlatform = "amazon" | "ebay";

// One line of an order, or one refund. Money is in dollars. A refund row has
// sales and shipping at 0 and the money given back in `refunds`.
export interface ProfitRow {
  key: string;
  platform: ProfitPlatform;
  kind: "sale" | "refund";
  orderId: string;
  date: string; // ISO, when the money posted (Amazon) or the order was placed (eBay)
  sku: string;
  title: string;
  quantity: number;
  sales: number; // item price after discounts, without sales tax
  shipping: number; // shipping the buyer paid
  fees: number; // marketplace fees; negative when fees were given back on a refund
  refunds: number; // money given back to the buyer
  fba: boolean; // Amazon shipped it, so no postage of yours
  feesEstimated: boolean; // eBay didn't report the fee, so it's worked out from the fee rate
}

// Account-level money not tied to one book: the Amazon subscription, ads,
// shipping labels bought through Amazon, reimbursements. Positive = a cost.
export interface AccountCharge {
  key: string;
  platform: ProfitPlatform;
  date: string;
  description: string;
  amount: number;
}

export const profitSettingsSchema = z.object({
  bookCost: z.number().min(0), // what you paid per book, on average
  amazonPostage: z.number().min(0), // per order you ship yourself
  ebayPostage: z.number().min(0),
  // null = add up the supplies page (unit cost × used per order)
  suppliesPerOrder: z.number().min(0).nullable(),
});

export type ProfitSettings = z.infer<typeof profitSettingsSchema>;

export interface ProfitTotals {
  orders: number;
  units: number;
  sales: number; // item price + shipping the buyer paid
  fees: number;
  refunds: number;
  postage: number;
  supplies: number;
  bookCost: number;
  otherCharges: number;
  profit: number;
}

export interface ProfitBucket {
  label: string;
  start: string; // yyyy-mm-dd
  amazon: number; // profit
  ebay: number;
  sales: number;
}

export interface BookProfit {
  sku: string;
  title: string;
  platform: ProfitPlatform;
  units: number;
  sales: number;
  profit: number;
  lastSold: string;
}

export interface ProfitSummary {
  total: ProfitTotals;
  byPlatform: Record<ProfitPlatform, ProfitTotals>;
  buckets: ProfitBucket[];
  bucketSize: "day" | "week" | "month";
  books: BookProfit[];
  charges: AccountCharge[];
  feesEstimated: number; // eBay orders whose fee was worked out, not reported
}

function emptyTotals(): ProfitTotals {
  return { orders: 0, units: 0, sales: 0, fees: 0, refunds: 0, postage: 0, supplies: 0, bookCost: 0, otherCharges: 0, profit: 0 };
}

export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Local calendar date, so a sale at 9pm Pacific counts on that day.
export function localDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function bucketStart(day: string, size: ProfitSummary["bucketSize"]): string {
  if (size === "day") return day;
  if (size === "month") return `${day.slice(0, 7)}-01`;
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return localDay(d);
}

function bucketLabel(start: string, size: ProfitSummary["bucketSize"]): string {
  const [y, m, d] = start.split("-").map(Number);
  if (size === "month") return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
  return `${MONTHS[m - 1]} ${d}`;
}

function nextBucket(start: string, size: ProfitSummary["bucketSize"]): string {
  const d = new Date(`${start}T12:00:00`);
  if (size === "day") d.setDate(d.getDate() + 1);
  else if (size === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return localDay(d);
}

// from/to are local yyyy-mm-dd, both included.
export function summarizeProfit(
  rows: ProfitRow[],
  charges: AccountCharge[],
  settings: ProfitSettings,
  suppliesPerOrder: number,
  from: string,
  to: string,
  platform: ProfitPlatform | "all" = "all",
): ProfitSummary {
  const spanDays = (new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86_400_000 + 1;
  const bucketSize: ProfitSummary["bucketSize"] = spanDays <= 31 ? "day" : spanDays <= 120 ? "week" : "month";

  const byPlatform: Record<ProfitPlatform, ProfitTotals> = { amazon: emptyTotals(), ebay: emptyTotals() };
  const buckets = new Map<string, ProfitBucket>();
  for (let b = bucketStart(from, bucketSize); b <= to; b = nextBucket(b, bucketSize)) {
    buckets.set(b, { label: bucketLabel(b, bucketSize), start: b, amazon: 0, ebay: 0, sales: 0 });
  }
  const books = new Map<string, BookProfit>();
  const shippedOrders = new Set<string>();
  let feesEstimated = 0;

  const inRange = (iso: string) => {
    const day = localDay(iso);
    return day >= from && day <= to;
  };
  const wanted = (p: ProfitPlatform) => platform === "all" || platform === p;

  for (const r of rows) {
    if (!wanted(r.platform) || !inRange(r.date)) continue;
    const t = byPlatform[r.platform];
    let profit = r.sales + r.shipping - r.fees - r.refunds;
    t.sales += r.sales + r.shipping;
    t.fees += r.fees;
    t.refunds += r.refunds;
    if (r.kind === "sale") {
      t.units += r.quantity;
      const cost = settings.bookCost * r.quantity;
      t.bookCost += cost;
      profit -= cost;
      if (r.feesEstimated) feesEstimated++;
      const orderKey = `${r.platform}:${r.orderId}`;
      if (!shippedOrders.has(orderKey)) {
        shippedOrders.add(orderKey);
        t.orders++;
        if (!r.fba) {
          const postage = r.platform === "amazon" ? settings.amazonPostage : settings.ebayPostage;
          t.postage += postage;
          t.supplies += suppliesPerOrder;
          profit -= postage + suppliesPerOrder;
        }
      }
    }
    const bucket = buckets.get(bucketStart(localDay(r.date), bucketSize));
    if (bucket) {
      bucket[r.platform] += profit;
      bucket.sales += r.sales + r.shipping;
    }
    const bookKey = `${r.platform}:${r.sku || r.title}`;
    const book = books.get(bookKey) ?? {
      sku: r.sku,
      title: r.title,
      platform: r.platform,
      units: 0,
      sales: 0,
      profit: 0,
      lastSold: r.date,
    };
    if (r.kind === "sale") book.units += r.quantity;
    book.sales += r.sales + r.shipping;
    book.profit += profit;
    if (r.date > book.lastSold) book.lastSold = r.date;
    if (!book.title || book.title === book.sku) book.title = r.title;
    books.set(bookKey, book);
  }

  const shownCharges = charges
    .filter((c) => wanted(c.platform) && inRange(c.date))
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const c of shownCharges) {
    byPlatform[c.platform].otherCharges += c.amount;
    const bucket = buckets.get(bucketStart(localDay(c.date), bucketSize));
    if (bucket) bucket[c.platform] -= c.amount;
  }

  const total = emptyTotals();
  for (const t of Object.values(byPlatform)) {
    t.profit = t.sales - t.fees - t.refunds - t.postage - t.supplies - t.bookCost - t.otherCharges;
    for (const k of Object.keys(total) as (keyof ProfitTotals)[]) total[k] += t[k];
  }
  const round = (t: ProfitTotals) => {
    for (const k of Object.keys(t) as (keyof ProfitTotals)[]) t[k] = roundCents(t[k]);
  };
  round(total);
  round(byPlatform.amazon);
  round(byPlatform.ebay);

  return {
    total,
    byPlatform,
    bucketSize,
    buckets: Array.from(buckets.values()).map((b) => ({
      ...b,
      amazon: roundCents(b.amazon),
      ebay: roundCents(b.ebay),
      sales: roundCents(b.sales),
    })),
    books: Array.from(books.values())
      .map((b) => ({ ...b, sales: roundCents(b.sales), profit: roundCents(b.profit) }))
      .sort((a, b) => b.profit - a.profit),
    charges: shownCharges,
    feesEstimated,
  };
}

// ---- Listed inventory: what it's worth if it all sells at its price -------

export interface ListedItem {
  platform: ProfitPlatform;
  id: string; // Amazon seller SKU or eBay item ID
  title: string;
  price: number;
  shipping: number | null; // eBay: what the buyer pays; null = calculated
  quantity: number;
}

export interface ListedInventory {
  items: ListedItem[];
  crossListed: { amazon: string; ebay: string }[]; // one book listed on both
  amazonAt: string | null; // when each list was last refreshed
  ebayAt: string | null;
}

export interface ListedTotals {
  listings: number;
  books: number;
  value: number; // price × quantity, what buyers would pay for the books
  fees: number;
  profit: number; // after fees, postage, supplies and book cost
  losing: number; // listings that would lose money at their price
}

export interface ListedSummary {
  total: ListedTotals; // Amazon + eBay-only
  byPlatform: Record<ProfitPlatform, ListedTotals>;
  crossListed: number; // eBay listings left out because the book is on Amazon
  priceBands: { label: string; books: number; value: number }[];
}

export interface ListedFeeRates {
  feePercent: number;
  orderFeeSmall: number;
  orderFeeLarge: number;
  salesTaxPercent: number;
  amazonReferralPercent: number;
  amazonClosingFee: number;
  amazonShippingCredit: number;
}

function emptyListed(): ListedTotals {
  return { listings: 0, books: 0, value: 0, fees: 0, profit: 0, losing: 0 };
}

// One copy sold at its listed price: fees, and profit after your costs.
export function listedUnitProfit(
  item: ListedItem,
  settings: ProfitSettings,
  suppliesPerOrder: number,
  rates: ListedFeeRates,
): { fees: number; profit: number } {
  if (item.platform === "amazon") {
    const shipping = rates.amazonShippingCredit;
    const fees = (item.price + shipping) * (rates.amazonReferralPercent / 100) + rates.amazonClosingFee;
    return {
      fees: roundCents(fees),
      profit: roundCents(item.price + shipping - fees - settings.amazonPostage - suppliesPerOrder - settings.bookCost),
    };
  }
  // Calculated shipping: the buyer pays about what the postage costs.
  const shipping = item.shipping ?? settings.ebayPostage;
  const subtotal = item.price + shipping;
  const orderTotal = subtotal * (1 + rates.salesTaxPercent / 100); // eBay charges its fee on the tax too
  const fees = orderTotal * (rates.feePercent / 100) + (orderTotal > 10 ? rates.orderFeeLarge : rates.orderFeeSmall);
  return {
    fees: roundCents(fees),
    profit: roundCents(subtotal - fees - settings.ebayPostage - suppliesPerOrder - settings.bookCost),
  };
}

const BANDS: [number, string][] = [
  [10, "Under $10"],
  [20, "$10–20"],
  [40, "$20–40"],
  [Infinity, "$40 and up"],
];

export function summarizeListed(
  listed: ListedInventory,
  settings: ProfitSettings,
  suppliesPerOrder: number,
  rates: ListedFeeRates,
  platform: ProfitPlatform | "all" = "all",
): ListedSummary {
  const byPlatform: Record<ProfitPlatform, ListedTotals> = { amazon: emptyListed(), ebay: emptyListed() };
  // With both marketplaces shown, Amazon counts every listing and eBay only
  // the books that aren't also on Amazon, so the two rows add up to the total.
  const amazonIds = new Set(listed.items.filter((i) => i.platform === "amazon").map((i) => i.id));
  const ebayAlsoOnAmazon = new Set(
    platform === "all" ? listed.crossListed.filter((p) => amazonIds.has(p.amazon)).map((p) => p.ebay) : [],
  );
  const unit: ListedItem[] = [];
  let crossListed = 0;
  for (const item of listed.items) {
    if (platform !== "all" && item.platform !== platform) continue;
    if (item.platform === "ebay" && ebayAlsoOnAmazon.has(item.id)) {
      crossListed++;
      continue;
    }
    const u = listedUnitProfit(item, settings, suppliesPerOrder, rates);
    unit.push(item);
    const t = byPlatform[item.platform];
    t.listings++;
    t.books += item.quantity;
    t.value += item.price * item.quantity;
    t.fees += u.fees * item.quantity;
    t.profit += u.profit * item.quantity;
    if (u.profit < 0) t.losing++;
  }

  const total = emptyListed();
  for (const t of Object.values(byPlatform)) {
    for (const k of Object.keys(total) as (keyof ListedTotals)[]) total[k] += t[k];
  }

  const bands = BANDS.map(([, label]) => ({ label, books: 0, value: 0 }));
  for (const item of unit) {
    const i = BANDS.findIndex(([max]) => item.price < max);
    bands[i].books += item.quantity;
    bands[i].value += item.price * item.quantity;
  }

  const round = (t: ListedTotals) => {
    t.value = roundCents(t.value);
    t.fees = roundCents(t.fees);
    t.profit = roundCents(t.profit);
    return t;
  };
  return {
    total: round(total),
    byPlatform: { amazon: round(byPlatform.amazon), ebay: round(byPlatform.ebay) },
    crossListed,
    priceBands: bands.map((b) => ({ ...b, value: roundCents(b.value) })),
  };
}
