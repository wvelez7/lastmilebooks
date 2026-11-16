// Profit dashboard data (/#/profit). Pulls what each sale brought in and
// what the marketplace charged for it:
//  - Amazon: Finances API (financialEvents), the same numbers as Seller
//    Central's transaction view. Needs the "Finance and Accounting" role.
//  - eBay: the Fulfillment API orders the app already reads, which carry the
//    order total and eBay's fee (totalMarketplaceFee).
// Rows are stored in sync_state as JSON and merged by key, so pulling an
// overlapping range never counts a sale twice.
import { computeProfit } from "@shared/profit";
import { profitSettingsSchema } from "@shared/profitReport";
import type { AccountCharge, ProfitRow, ProfitSettings } from "@shared/profitReport";
import { inventoryStore } from "./store";
import * as amazon from "./amazon";
import * as ebay from "./ebay";
import { listSupplies } from "./supplies";
import { getScanSettings } from "./listings";
import { listListings as repricerListings } from "./repricer";
import { storedSales as amazonSales } from "./amazonReturns";

const ROWS_KEY = "profit_rows";
const CHARGES_KEY = "profit_charges";
const JOB_KEY = "profit_job";
const SETTINGS_KEY = "profit_settings";
const AMAZON_THROUGH_KEY = "profit_amazon_through";
const EBAY_THROUGH_KEY = "profit_ebay_through";

const FIRST_PULL_DAYS = 365;
// eBay refunds land on the order later, so recent orders are read again.
const EBAY_REREAD_DAYS = 90;

export interface ProfitJob {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  notes: string[];
}

function load<T>(key: string): T[] {
  try {
    return JSON.parse(inventoryStore.getState(key) ?? "[]") as T[];
  } catch {
    return [];
  }
}

export function storedRows(): ProfitRow[] {
  return load<ProfitRow>(ROWS_KEY);
}

export function storedCharges(): AccountCharge[] {
  return load<AccountCharge>(CHARGES_KEY);
}

export function getSettings(): ProfitSettings {
  const scan = getScanSettings();
  const defaults: ProfitSettings = {
    bookCost: scan.bookCost,
    amazonPostage: scan.shippingCost,
    ebayPostage: scan.shippingCost,
    suppliesPerOrder: null,
  };
  try {
    const saved = JSON.parse(inventoryStore.getState(SETTINGS_KEY) ?? "{}");
    return profitSettingsSchema.parse({ ...defaults, ...saved });
  } catch {
    return defaults;
  }
}

export function saveSettings(s: ProfitSettings): void {
  inventoryStore.setState(SETTINGS_KEY, JSON.stringify(s));
}

// What the supplies page says one order uses. Supplies that take turns (two
// mailer sizes) count as their average. null when no unit costs are entered.
export function suppliesCostPerOrder(): number | null {
  const used = listSupplies().filter((s) => s.usedPerOrder > 0 && s.unitCost !== null);
  if (!used.length) return null;
  const each = (s: (typeof used)[number]) => s.unitCost! * s.usedPerOrder;
  const fixed = used.filter((s) => !s.takesTurns).reduce((sum, s) => sum + each(s), 0);
  const turns = used.filter((s) => s.takesTurns);
  const turnAvg = turns.length ? turns.reduce((sum, s) => sum + each(s), 0) / turns.length : 0;
  return Math.round((fixed + turnAvg) * 100) / 100;
}

// ---- Amazon: financial events --------------------------------------------

interface Money {
  CurrencyAmount?: number;
}
interface Charge {
  ChargeType?: string;
  ChargeAmount?: Money;
}
interface Fee {
  FeeType?: string;
  FeeAmount?: Money;
}
interface Promotion {
  PromotionAmount?: Money;
}
interface ShipmentItem {
  SellerSKU?: string;
  OrderItemId?: string;
  OrderAdjustmentItemId?: string;
  QuantityShipped?: number;
  ItemChargeList?: Charge[];
  ItemChargeAdjustmentList?: Charge[];
  ItemFeeList?: Fee[];
  ItemFeeAdjustmentList?: Fee[];
  PromotionList?: Promotion[];
  PromotionAdjustmentList?: Promotion[];
}
interface ShipmentEvent {
  AmazonOrderId?: string;
  PostedDate?: string;
  ShipmentItemList?: ShipmentItem[];
  ShipmentItemAdjustmentList?: ShipmentItem[];
  ShipmentFeeList?: Fee[];
  ShipmentFeeAdjustmentList?: Fee[];
  OrderFeeList?: Fee[];
  OrderFeeAdjustmentList?: Fee[];
}
interface ServiceFeeEvent {
  AmazonOrderId?: string;
  FeeReason?: string;
  FeeDescription?: string;
  SellerSKU?: string;
  FeeList?: Fee[];
}
interface AdjustmentEvent {
  AdjustmentType?: string;
  PostedDate?: string;
  AdjustmentAmount?: Money;
}
interface AdsEvent {
  postedDate?: string;
  invoiceId?: string;
  transactionType?: string;
  transactionValue?: Money;
}
type FinancialEvents = Record<string, unknown[] | undefined> & {
  ShipmentEventList?: ShipmentEvent[];
  RefundEventList?: ShipmentEvent[];
  GuaranteeClaimEventList?: ShipmentEvent[];
  ChargebackEventList?: ShipmentEvent[];
  ServiceFeeEventList?: ServiceFeeEvent[];
  AdjustmentEventList?: AdjustmentEvent[];
  ProductAdsPaymentEventList?: AdsEvent[];
};

const amt = (m?: Money) => m?.CurrencyAmount ?? 0;
const sumFees = (list?: Fee[]) => (list ?? []).reduce((s, f) => s + amt(f.FeeAmount), 0);
const isTax = (type = "") => /tax/i.test(type);

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

// Amazon reports fees as negative amounts; rows keep fees positive.
export function parseFinancialEvents(
  ev: FinancialEvents,
  titles: Map<string, string>,
  unknownTypes: Set<string>,
): { rows: ProfitRow[]; charges: AccountCharge[] } {
  const rows: ProfitRow[] = [];
  const charges: AccountCharge[] = [];

  for (const s of ev.ShipmentEventList ?? []) {
    const orderId = s.AmazonOrderId ?? "";
    const date = s.PostedDate ?? "";
    // Fees on the shipment or order as a whole go on its first line.
    let orderLevelFees = -(sumFees(s.ShipmentFeeList) + sumFees(s.OrderFeeList));
    (s.ShipmentItemList ?? []).forEach((item, i) => {
      let sales = 0;
      let shipping = 0;
      for (const c of item.ItemChargeList ?? []) {
        if (isTax(c.ChargeType)) continue; // Amazon collects and pays the tax
        if (/shipping/i.test(c.ChargeType ?? "")) shipping += amt(c.ChargeAmount);
        else sales += amt(c.ChargeAmount);
      }
      for (const p of item.PromotionList ?? []) sales += amt(p.PromotionAmount); // negative
      const fees = -sumFees(item.ItemFeeList) + orderLevelFees;
      orderLevelFees = 0;
      const sku = item.SellerSKU ?? "";
      rows.push({
        key: `amazon:${orderId}:${item.OrderItemId ?? i}:${date}`,
        platform: "amazon",
        kind: "sale",
        orderId,
        date,
        sku,
        title: titles.get(sku) ?? sku,
        quantity: item.QuantityShipped ?? 1,
        sales: cents(sales),
        shipping: cents(shipping),
        fees: cents(fees),
        refunds: 0,
        fba: (item.ItemFeeList ?? []).some((f) => /^FBA/i.test(f.FeeType ?? "")),
        feesEstimated: false,
      });
    });
  }

  const refundLists: [string, ShipmentEvent[] | undefined][] = [
    ["refund", ev.RefundEventList],
    ["guarantee", ev.GuaranteeClaimEventList],
    ["chargeback", ev.ChargebackEventList],
  ];
  for (const [kind, list] of refundLists) {
    for (const s of list ?? []) {
      const orderId = s.AmazonOrderId ?? "";
      const date = s.PostedDate ?? "";
      let orderLevelFees = -(sumFees(s.ShipmentFeeAdjustmentList) + sumFees(s.OrderFeeAdjustmentList));
      (s.ShipmentItemAdjustmentList ?? []).forEach((item, i) => {
        let refunded = 0;
        for (const c of item.ItemChargeAdjustmentList ?? []) {
          if (!isTax(c.ChargeType)) refunded -= amt(c.ChargeAmount); // negative = money back to buyer
        }
        for (const p of item.PromotionAdjustmentList ?? []) refunded -= amt(p.PromotionAmount);
        // Positive adjustments are fees given back, less Amazon's refund admin fee.
        const fees = -sumFees(item.ItemFeeAdjustmentList) + orderLevelFees;
        orderLevelFees = 0;
        const sku = item.SellerSKU ?? "";
        rows.push({
          key: `amazon-${kind}:${orderId}:${item.OrderAdjustmentItemId ?? i}:${date}`,
          platform: "amazon",
          kind: "refund",
          orderId,
          date,
          sku,
          title: titles.get(sku) ?? sku,
          quantity: item.QuantityShipped ?? 0,
          sales: 0,
          shipping: 0,
          fees: cents(fees),
          refunds: cents(refunded),
          fba: false,
          feesEstimated: false,
        });
      });
    }
  }

  // Service fees carry no date of their own; the caller fills in the window.
  (ev.ServiceFeeEventList ?? []).forEach((f, i) => {
    const amount = cents(-sumFees(f.FeeList));
    if (!amount) return;
    const types = Array.from(new Set((f.FeeList ?? []).map((x) => x.FeeType).filter(Boolean))).join(", ");
    charges.push({
      key: `amazon-fee:${f.AmazonOrderId ?? ""}:${types}:${amount}:${i}`,
      platform: "amazon",
      date: "",
      description: f.FeeDescription || f.FeeReason || readable(types) || "Amazon fee",
      amount,
    });
  });
  (ev.AdjustmentEventList ?? []).forEach((a, i) => {
    const amount = cents(-amt(a.AdjustmentAmount));
    if (!amount) return;
    charges.push({
      key: `amazon-adj:${a.AdjustmentType}:${a.PostedDate}:${amount}:${i}`,
      platform: "amazon",
      date: a.PostedDate ?? "",
      description: readable(a.AdjustmentType ?? "Adjustment"),
      amount,
    });
  });
  for (const a of ev.ProductAdsPaymentEventList ?? []) {
    const value = amt(a.transactionValue);
    if (!value) continue;
    charges.push({
      key: `amazon-ads:${a.invoiceId}:${a.transactionType}`,
      platform: "amazon",
      date: a.postedDate ?? "",
      description: "Sponsored Products ads",
      // Charges come as positive transactionValue, refunds of ad spend as negative.
      amount: cents(a.transactionType === "refund" ? -Math.abs(value) : Math.abs(value)),
    });
  }

  const handled = new Set([
    "ShipmentEventList",
    "RefundEventList",
    "GuaranteeClaimEventList",
    "ChargebackEventList",
    "ServiceFeeEventList",
    "AdjustmentEventList",
    "ProductAdsPaymentEventList",
  ]);
  for (const [name, list] of Object.entries(ev)) {
    if (!handled.has(name) && Array.isArray(list) && list.length) unknownTypes.add(readable(name.replace(/EventList$/, "")));
  }
  return { rows, charges };
}

// "FBAInboundTransportationFee" → "FBA inbound transportation fee"
function readable(s: string): string {
  const spaced = s
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).replace(/\b([A-Z][a-z]+)/g, (w) => w.toLowerCase());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function financialEventsPage(qs: URLSearchParams): Promise<{ events: FinancialEvents; next?: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${amazon.API_HOST}/finances/v0/financialEvents?${qs}`, {
      headers: { "x-amz-access-token": await amazon.accessToken() },
    });
    if (res.status === 429 && attempt < 6) {
      await sleep(5_000 * (attempt + 1));
      continue;
    }
    if (res.status === 403) {
      throw new Error(
        "Amazon won't share your payments yet: in Seller Central → Develop Apps, add the Finance and Accounting role to your app, then authorize it again and put the new refresh token on Render.",
      );
    }
    if (!res.ok) throw new Error(`Amazon financial events failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { payload?: { FinancialEvents?: FinancialEvents; NextToken?: string } };
    return { events: json.payload?.FinancialEvents ?? {}, next: json.payload?.NextToken };
  }
}

function amazonTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const s of amazonSales()) if (s.title) titles.set(s.sku, s.title);
  for (const l of repricerListings()) titles.set(l.sku, l.title);
  for (const i of inventoryStore.listItems()) if (i.amazonSku) titles.set(i.amazonSku, i.title);
  return titles;
}

async function pullAmazon(notes: string[]): Promise<{ rows: ProfitRow[]; charges: AccountCharge[] }> {
  const through = inventoryStore.getState(AMAZON_THROUGH_KEY);
  // Amazon wants the end at least two minutes in the past.
  const end = new Date(Date.now() - 5 * 60_000);
  // Picks up exactly where the last pull ended: service fees have no date of
  // their own, so an overlap would store them twice.
  let start = through ? new Date(through) : new Date(Date.now() - FIRST_PULL_DAYS * 86_400_000);
  const titles = amazonTitles();
  const unknown = new Set<string>();
  const rows: ProfitRow[] = [];
  const charges: AccountCharge[] = [];
  // Windows of 30 days keep each one's dateless service fees near their real date.
  while (start < end) {
    const windowEnd = new Date(Math.min(end.getTime(), start.getTime() + 30 * 86_400_000));
    let next: string | undefined;
    do {
      const qs = new URLSearchParams({ MaxResultsPerPage: "100" });
      if (next) qs.set("NextToken", next);
      else {
        qs.set("PostedAfter", start.toISOString());
        qs.set("PostedBefore", windowEnd.toISOString());
      }
      const page = await financialEventsPage(qs);
      const parsed = parseFinancialEvents(page.events, titles, unknown);
      rows.push(...parsed.rows);
      for (const c of parsed.charges) {
        if (!c.date) {
          c.date = windowEnd.toISOString();
          c.key = `${c.key}:${start.toISOString().slice(0, 10)}`;
        }
        charges.push(c);
      }
      next = page.next;
      await sleep(2_100); // about one call every two seconds
    } while (next);
    start = windowEnd;
  }
  inventoryStore.setState(AMAZON_THROUGH_KEY, end.toISOString());
  if (unknown.size) notes.push(`Amazon also reported ${Array.from(unknown).join(", ")}; those aren't counted.`);
  return { rows, charges };
}

// ---- eBay: orders ---------------------------------------------------------

interface EbayMoney {
  value?: string;
}
export interface EbayMoneyOrder {
  orderId: string;
  creationDate: string;
  cancelStatus?: { cancelState?: string };
  orderPaymentStatus?: string;
  pricingSummary?: { priceSubtotal?: EbayMoney; deliveryCost?: EbayMoney; priceDiscount?: EbayMoney };
  totalMarketplaceFee?: EbayMoney;
  paymentSummary?: { refunds?: { amount?: EbayMoney; refundDate?: string; refundStatus?: string }[] };
  lineItems: {
    lineItemId: string;
    legacyItemId: string;
    sku?: string;
    title: string;
    quantity: number;
    lineItemCost?: EbayMoney;
    discountedLineItemCost?: EbayMoney;
  }[];
}

const num = (m?: EbayMoney) => Number(m?.value ?? 0) || 0;

export function parseEbayOrders(orders: EbayMoneyOrder[]): { rows: ProfitRow[]; dropped: string[] } {
  const scan = getScanSettings();
  const rows: ProfitRow[] = [];
  const dropped: string[] = [];
  for (const o of orders) {
    if (o.cancelStatus?.cancelState === "CANCELED" || o.orderPaymentStatus === "FAILED" || o.orderPaymentStatus === "PENDING") {
      dropped.push(o.orderId);
      continue;
    }
    const lines = o.lineItems.map((l) => ({ l, cost: num(l.discountedLineItemCost ?? l.lineItemCost) }));
    const subtotal = lines.reduce((s, x) => s + x.cost, 0);
    const shipping = num(o.pricingSummary?.deliveryCost);
    const reported = o.totalMarketplaceFee?.value !== undefined;
    const fee = reported
      ? num(o.totalMarketplaceFee)
      : (() => {
          const p = computeProfit(subtotal, shipping, scan);
          return p.finalValueFee + p.orderFee;
        })();
    lines.forEach(({ l, cost }, i) => {
      const share = subtotal > 0 ? cost / subtotal : 1 / lines.length;
      rows.push({
        key: `ebay:${o.orderId}:${l.lineItemId}`,
        platform: "ebay",
        kind: "sale",
        orderId: o.orderId,
        date: o.creationDate,
        sku: l.sku ?? l.legacyItemId,
        title: l.title,
        quantity: l.quantity,
        sales: cents(cost),
        shipping: cents(shipping * share),
        fees: cents(fee * share),
        refunds: 0,
        fba: false,
        feesEstimated: !reported && i === 0,
      });
    });
    (o.paymentSummary?.refunds ?? []).forEach((r, i) => {
      if (r.refundStatus === "FAILED") return;
      const first = o.lineItems[0];
      rows.push({
        key: `ebay-refund:${o.orderId}:${i}`,
        platform: "ebay",
        kind: "refund",
        orderId: o.orderId,
        date: r.refundDate ?? o.creationDate,
        sku: first?.sku ?? first?.legacyItemId ?? "",
        title: first?.title ?? "",
        quantity: 0,
        sales: 0,
        shipping: 0,
        fees: 0,
        refunds: cents(num(r.amount)),
        fba: false,
        feesEstimated: false,
      });
    });
  }
  return { rows, dropped };
}

async function pullEbay(): Promise<{ rows: ProfitRow[]; dropped: string[] }> {
  const through = inventoryStore.getState(EBAY_THROUGH_KEY);
  const days = through ? EBAY_REREAD_DAYS : FIRST_PULL_DAYS;
  const now = new Date();
  // listOrdersSince returns eBay's full order objects; only the type is narrower.
  const orders = (await ebay.listOrdersSince(new Date(Date.now() - days * 86_400_000))) as unknown as EbayMoneyOrder[];
  inventoryStore.setState(EBAY_THROUGH_KEY, now.toISOString());
  return parseEbayOrders(orders);
}

// ---- Refresh job ------------------------------------------------------------

let job: ProfitJob = { running: false, startedAt: null, finishedAt: null, error: null, notes: [] };

export function profitJob(): ProfitJob {
  if (!job.running && !job.finishedAt) {
    const last = inventoryStore.getState(JOB_KEY);
    if (last) job = { ...(JSON.parse(last) as ProfitJob), running: false };
  }
  return job;
}

function merge<T extends { key: string; date: string }>(old: T[], fresh: T[], drop: (r: T) => boolean = () => false): T[] {
  const byKey = new Map(old.filter((r) => !drop(r)).map((r) => [r.key, r]));
  for (const r of fresh) byKey.set(r.key, r);
  return Array.from(byKey.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function startProfitRefresh(): ProfitJob {
  if (job.running) return job;
  if (!amazon.amazonConfigured() && !ebay.ebayConnected()) throw new Error("Neither Amazon nor eBay is connected");
  job = { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, notes: [] };
  void refresh().finally(() => {
    job.running = false;
    job.finishedAt = new Date().toISOString();
    inventoryStore.setState(JOB_KEY, JSON.stringify(job));
  });
  return job;
}

async function refresh(): Promise<void> {
  const errors: string[] = [];
  if (amazon.amazonConfigured()) {
    try {
      const { rows, charges } = await pullAmazon(job.notes);
      inventoryStore.setState(ROWS_KEY, JSON.stringify(merge(storedRows(), rows)));
      inventoryStore.setState(CHARGES_KEY, JSON.stringify(merge(storedCharges(), charges)));
    } catch (e) {
      errors.push((e as Error).message);
    }
  } else job.notes.push("Amazon isn't connected on the server.");

  if (ebay.ebayConnected()) {
    try {
      const { rows, dropped } = await pullEbay();
      const cancelled = new Set(dropped);
      inventoryStore.setState(
        ROWS_KEY,
        JSON.stringify(merge(storedRows(), rows, (r) => r.platform === "ebay" && cancelled.has(r.orderId))),
      );
    } catch (e) {
      errors.push((e as Error).message);
    }
  } else job.notes.push("eBay isn't connected.");

  job.error = errors.length ? errors.join(" ") : null;
}

// Pulls on its own twice a day so the page is current when opened.
const AUTO_MS = 12 * 3_600_000;
export function startProfitAutoRefresh(): void {
  const tick = () => {
    const last = profitJob().finishedAt;
    if (!last || Date.now() - new Date(last).getTime() > AUTO_MS) {
      try {
        startProfitRefresh();
      } catch {
        // nothing connected
      }
    }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 3_600_000);
}
