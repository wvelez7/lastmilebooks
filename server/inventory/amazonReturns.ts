// Amazon returns, read from the Reports API so they can be looked at by
// reason, by book and against what sold. Three reports:
//   GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE       books you ship yourself
//   GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA       FBA
//   GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL  what sold, for return rates
// Roles on the app: "Inventory and Order Tracking", "Direct to Consumer
// Shipping (Restricted)" for your own returns, "Amazon Fulfillment" for FBA.
// A report that isn't allowed is skipped and noted; the others still load.
//
// Rows are kept between refreshes, so after the first pull each refresh only
// asks for the last couple of weeks.
import { gunzipSync } from "node:zlib";
import { API_HOST, accessToken, amazonConfigured, marketplaceId } from "./amazon";
import { parseCsv } from "./ebayReport";
import { inventoryStore } from "./store";

export interface AmazonReturn {
  key: string;
  channel: "Merchant" | "FBA";
  orderId: string;
  orderDate: string | null; // yyyy-mm-dd
  returnDate: string; // yyyy-mm-dd
  sku: string;
  asin: string;
  title: string;
  quantity: number;
  reason: string;
  status: string;
  disposition: string | null; // FBA: what happened to the book, e.g. "Customer damaged"
  inPolicy: boolean | null;
  azClaim: boolean;
  refunded: number | null;
  labelCost: number | null; // only when you paid for the label
  comment: string | null;
}

export interface AmazonSale {
  key: string;
  orderId: string;
  orderDate: string;
  sku: string;
  title: string;
  quantity: number;
  channel: "Merchant" | "FBA";
}

export interface ReturnsJob {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  notes: string[]; // reports that were skipped, and why
}

const FIRST_PULL_DAYS = 180;
const OVERLAP_DAYS = 14; // returns get updated (refunds, claims) after they're first reported
const DAY = 86_400_000;

const REPORTS = {
  merchant: { type: "GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE", maxDays: 60, name: "Returns you ship" },
  fba: { type: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", maxDays: 60, name: "FBA returns" },
  sales: { type: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL", maxDays: 30, name: "Orders" },
} as const;
type ReportKind = keyof typeof REPORTS;

class NotAllowed extends Error {}

async function reportsApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  // createReport allows about one call a minute after a burst of 15.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_HOST}/reports/2021-06-30${path}`, {
      method,
      headers: {
        "x-amz-access-token": await accessToken(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(65_000);
      continue;
    }
    if (res.status === 403) throw new NotAllowed("not allowed for this app (missing role)");
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// One report for one date range; "" when Amazon has nothing for it.
async function fetchReport(kind: ReportKind, start: Date, end: Date): Promise<string> {
  const { reportId } = await reportsApi<{ reportId: string }>("POST", "/reports", {
    reportType: REPORTS[kind].type,
    marketplaceIds: [marketplaceId()],
    dataStartTime: start.toISOString(),
    dataEndTime: end.toISOString(),
  });
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    await sleep(20_000);
    const report = await reportsApi<{ processingStatus: string; reportDocumentId?: string }>(
      "GET",
      `/reports/${encodeURIComponent(reportId)}`,
    );
    if (report.processingStatus === "DONE" && report.reportDocumentId) {
      return downloadDocument(report.reportDocumentId);
    }
    // Amazon cancels a report when the range has no data.
    if (report.processingStatus === "CANCELLED") return "";
    if (report.processingStatus === "FATAL") {
      const detail = report.reportDocumentId ? (await downloadDocument(report.reportDocumentId)).slice(0, 300) : "";
      throw new Error(`Amazon couldn't make the report${detail ? `: ${detail}` : ""}`);
    }
    if (Date.now() > deadline) throw new Error("Amazon took more than 30 minutes to make the report");
  }
}

async function downloadDocument(documentId: string): Promise<string> {
  const doc = await reportsApi<{ url: string; compressionAlgorithm?: string }>(
    "GET",
    `/documents/${encodeURIComponent(documentId)}`,
  );
  const res = await fetch(doc.url);
  if (!res.ok) throw new Error(`report download failed: ${res.status}`);
  let bytes = Buffer.from(await res.arrayBuffer());
  if (doc.compressionAlgorithm === "GZIP") bytes = gunzipSync(bytes);
  const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function isXmlReport(text: string): boolean {
  return /^\s*<(\?xml|AmazonEnvelope)/.test(text);
}

function xmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Seller Central's Return Reports page often only offers XML: one
// <return_details> per return, with nested <item_details> and <label_details>.
// Each leaf becomes a field named like the flat file's (order_id \u2192 orderid).
function parseXmlReturns(text: string): Record<string, string>[] {
  return Array.from(text.matchAll(/<return_details>([\s\S]*?)<\/return_details>/g), ([, block]) => {
    const row: Record<string, string> = {};
    for (const [, tag, value] of Array.from(block.matchAll(/<([A-Za-z_]+)>([^<]*)<\/\1>/g))) {
      row[tag.toLowerCase().replace(/[^a-z0-9]/g, "")] = xmlText(value).trim();
    }
    return row;
  });
}

// Tab-delimited (what the API returns), CSV or XML (Seller Central
// downloads). Headers are matched loosely ("Order ID", "order-id" and
// "order_id" are all `orderid`) since the reports differ.
export function parseFlatFile(text: string): Record<string, string>[] {
  text = text.replace(/^\uFEFF/, "");
  if (isXmlReport(text)) return parseXmlReturns(text);
  const firstLine = text.split(/\r?\n/, 1)[0];
  const rows = firstLine.includes("\t")
    ? text.split(/\r?\n/).map((l) => l.split("\t"))
    : parseCsv(text.endsWith("\n") ? text : `${text}\n`);
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length < 2) return [];
  const clean = (s: string) => s.trim().replace(/^"(.*)"$/, "$1").trim();
  const headers = nonEmpty[0].map((h) => clean(h).toLowerCase().replace(/[^a-z0-9]/g, ""));
  return nonEmpty.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, clean(cells[i] ?? "")])));
}

function day(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function amount(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function yes(s: string | undefined): boolean {
  return /^(y|yes|true)$/i.test(s ?? "");
}

// "CR-UNWANTED_ITEM", "AMZ-PG-BAD-DESC" and "UNWANTED_ITEM" read as "Unwanted item".
export function reasonLabel(code: string): string {
  const words = code.replace(/^(CR|AMZ-PG|AMZ)-/i, "").replace(/[_-]+/g, " ").trim().toLowerCase();
  const plain: Record<string, string> = {
    "bad desc": "Not as described",
    "apparel style": "Not as described",
    "missed estimated delivery": "Arrived late",
    "qualitiy unacceptable": "Poor quality",
    "quality unacceptable": "Poor quality",
    // What the buyer picked: "Product damaged, but shipping box OK" vs "Both product and box damaged".
    "damaged by fc": "Arrived damaged, box OK",
    "damaged by carrier": "Arrived damaged, box damaged too",
    switcheroo: "Different item sent back",
  };
  if (plain[words]) return plain[words];
  return words ? words[0].toUpperCase() + words.slice(1) : "No reason given";
}

export function parseMerchantReturns(text: string): AmazonReturn[] {
  return parseFlatFile(text).flatMap((r) => {
    const returnDate = day(r.returnrequestdate);
    if (!r.orderid || !returnDate) return [];
    const sku = r.merchantsku ?? "";
    const paidBy = (r.labeltobepaidby ?? "").toLowerCase();
    return [{
      key: `M:${r.orderid}:${sku}:${r.amazonrmaid ?? returnDate}`,
      channel: "Merchant" as const,
      orderId: r.orderid,
      orderDate: day(r.orderdate),
      returnDate,
      sku,
      asin: r.asin ?? "",
      title: r.itemname ?? sku,
      quantity: Number(r.returnquantity) || 1,
      reason: reasonLabel(r.returnreason ?? r.returnreasoncode ?? ""),
      status: [r.returnrequeststatus, r.resolution].filter(Boolean).join(" · "),
      disposition: null,
      inPolicy: r.inpolicy ? yes(r.inpolicy) : null,
      azClaim: yes(r.atozclaim),
      refunded: amount(r.refundedamount ?? r.refundamount),
      labelCost: paidBy.includes("seller") || paidBy.includes("merchant") ? amount(r.labelcost) : null,
      comment: null,
    }];
  });
}

export function parseFbaReturns(text: string): AmazonReturn[] {
  return parseFlatFile(text).flatMap((r) => {
    const returnDate = day(r.returndate);
    if (!r.orderid || !returnDate) return [];
    const sku = r.sku ?? "";
    return [{
      key: `F:${r.orderid}:${sku}:${r.licenseplatenumber || returnDate}`,
      channel: "FBA" as const,
      orderId: r.orderid,
      orderDate: null,
      returnDate,
      sku,
      asin: r.asin ?? "",
      title: r.productname ?? sku,
      quantity: Number(r.quantity) || 1,
      reason: reasonLabel(r.reason ?? ""),
      status: r.status ?? "",
      disposition: r.detaileddisposition ? reasonLabel(r.detaileddisposition) : null,
      inPolicy: null,
      azClaim: false,
      refunded: null,
      labelCost: null,
      comment: r.customercomments || null,
    }];
  });
}

export function parseSales(text: string): AmazonSale[] {
  return parseFlatFile(text).flatMap((r) => {
    const orderDate = day(r.purchasedate);
    if (!r.amazonorderid || !orderDate || /cancel/i.test(r.orderstatus ?? "")) return [];
    const quantity = Number(r.quantity) || 0;
    if (quantity === 0) return [];
    return [{
      key: `${r.amazonorderid}:${r.sku}`,
      orderId: r.amazonorderid,
      orderDate,
      sku: r.sku ?? "",
      title: r.productname ?? r.sku ?? "",
      quantity,
      channel: /amazon|afn/i.test(r.fulfillmentchannel ?? "") ? ("FBA" as const) : ("Merchant" as const),
    }];
  });
}

const PARSERS = { merchant: parseMerchantReturns, fba: parseFbaReturns, sales: parseSales };

function load<T>(key: string): T[] {
  try {
    return JSON.parse(inventoryStore.getState(key) ?? "[]") as T[];
  } catch {
    return [];
  }
}

// Labels the first upload (2026-11-14) stored before they were reworded.
const RENAMED_REASONS: Record<string, string> = {
  "Damaged at Amazon warehouse": reasonLabel("CR-DAMAGED_BY_FC"),
  "Damaged in shipping": reasonLabel("CR-DAMAGED_BY_CARRIER"),
  Switcheroo: reasonLabel("CR-SWITCHEROO"),
};

export function storedReturns(): AmazonReturn[] {
  return load<AmazonReturn>("amazon_returns").map((r) =>
    RENAMED_REASONS[r.reason] ? { ...r, reason: RENAMED_REASONS[r.reason] } : r,
  );
}

export function storedSales(): AmazonSale[] {
  return load<AmazonSale>("amazon_sales");
}

let job: ReturnsJob = { running: false, startedAt: null, finishedAt: null, error: null, notes: [] };

export function returnsJob(): ReturnsJob {
  if (!job.running && !job.finishedAt) {
    const last = inventoryStore.getState("amazon_returns_job");
    if (last) job = { ...(JSON.parse(last) as ReturnsJob), running: false };
  }
  return job;
}

// Starts a refresh in the background; returns at once. Takes a few minutes
// because Amazon makes each report on its own schedule.
export function startReturnsRefresh(): ReturnsJob {
  if (!amazonConfigured()) throw new Error("Amazon isn't connected");
  if (job.running) return job;
  job = { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, notes: [] };
  void refresh().finally(() => {
    job.running = false;
    job.finishedAt = new Date().toISOString();
    inventoryStore.setState("amazon_returns_job", JSON.stringify(job));
  });
  return job;
}

function merge<T extends { key: string }>(old: T[], fresh: T[]): T[] {
  const byKey = new Map(old.map((r) => [r.key, r]));
  for (const r of fresh) byKey.set(r.key, r);
  return Array.from(byKey.values());
}

export class ReturnsFileError extends Error {}

// A returns report downloaded from Seller Central: Orders → Return Reports
// for books you ship, or Reports → Fulfillment → Customer Returns for FBA.
// Same fields as the API reports, as TSV, CSV or XML. Rows already stored are
// updated, not doubled.
export function importReturnsFile(text: string): { kind: "Merchant" | "FBA"; rows: number; total: number } {
  const header = Object.keys(parseFlatFile(text)[0] ?? {});
  let rows: AmazonReturn[];
  let kind: "Merchant" | "FBA";
  // An XML returns report with no <return_details> just means no returns in that range.
  if (header.includes("returnrequestdate") || /<MessageType>Returns-Report<\/MessageType>/.test(text)) {
    rows = parseMerchantReturns(text);
    kind = "Merchant";
  } else if (header.includes("returndate") && header.includes("detaileddisposition")) {
    rows = parseFbaReturns(text);
    kind = "FBA";
  } else {
    throw new ReturnsFileError(
      "This doesn't look like an Amazon returns report. Download it from Seller Central → Orders → Return Reports.",
    );
  }
  if (rows.length === 0) throw new ReturnsFileError("No returns found in this file. Nothing was changed.");
  const all = merge(storedReturns(), rows);
  inventoryStore.setState("amazon_returns", JSON.stringify(all));
  inventoryStore.setState("amazon_returns_uploaded", new Date().toISOString());
  return { kind, rows: rows.length, total: all.length };
}

async function refresh(): Promise<void> {
  const end = new Date(Date.now() - 5 * 60_000); // Amazon refuses an end time in the future
  const fetched: { [K in ReportKind]?: ReturnType<(typeof PARSERS)[K]> } = {};
  let anyWorked = false;
  for (const kind of Object.keys(REPORTS) as ReportKind[]) {
    const { maxDays, name } = REPORTS[kind];
    // Each report keeps its own window, so one that failed is asked for again
    // in full next time without re-pulling the others.
    const lastPull = inventoryStore.getState(`amazon_returns_through_${kind}`);
    const start = lastPull
      ? new Date(new Date(lastPull).getTime() - OVERLAP_DAYS * DAY)
      : new Date(end.getTime() - FIRST_PULL_DAYS * DAY);
    const rows: (AmazonReturn | AmazonSale)[] = [];
    try {
      for (let from = start.getTime(); from < end.getTime(); from += maxDays * DAY) {
        const to = new Date(Math.min(from + maxDays * DAY, end.getTime()));
        rows.push(...PARSERS[kind](await fetchReport(kind, new Date(from), to)));
      }
      (fetched as Record<string, unknown>)[kind] = rows;
      anyWorked = true;
      inventoryStore.setState(`amazon_returns_through_${kind}`, end.toISOString());
    } catch (e) {
      const message = (e as Error).message;
      // Reading your own returns needs a restricted role, so those come from an upload instead.
      const hint = e instanceof NotAllowed && kind === "merchant" ? " Upload the returns file from Seller Central instead." : "";
      job.notes.push(`${name}: ${message}.${hint}`);
      inventoryStore.log("warn", `Amazon returns refresh, ${name}: ${message}`);
      if (!(e instanceof NotAllowed) && !/couldn't make the report/.test(message)) job.error = message;
    }
  }
  if (!anyWorked) {
    job.error ??= "Amazon didn't allow any of the returns reports. See the notes.";
    return;
  }

  inventoryStore.setState(
    "amazon_returns",
    JSON.stringify(merge(storedReturns(), [...(fetched.merchant ?? []), ...(fetched.fba ?? [])])),
  );
  if (fetched.sales) inventoryStore.setState("amazon_sales", JSON.stringify(merge(storedSales(), fetched.sales)));
}

// --- Analysis ---

export interface ReturnsSummary {
  from: string | null;
  to: string | null;
  returns: number; // units
  orders: number;
  soldUnits: number | null; // null when the orders report isn't available
  returnRate: number | null; // returned units of orders in the sales data / units sold
  refunded: number;
  labelCost: number;
  azClaims: number;
  outOfPolicy: number;
  medianDaysToReturn: number | null;
  daysToReturn: { label: string; count: number }[];
  byReason: { reason: string; units: number; share: number }[];
  byChannel: { channel: string; units: number; sold: number | null; rate: number | null }[];
  byMonth: { month: string; returns: number; sold: number | null }[];
  byBook: { sku: string; title: string; returns: number; sold: number | null; reasons: string[] }[];
  fbaDisposition: { disposition: string; units: number }[];
  resold: ResoldReturn[];
  notResold: number; // returns with no later Amazon sale of the same book
}

export interface ResoldReturn {
  title: string;
  reason: string;
  returnDate: string;
  refunded: number | null;
  resoldOn: string;
  resoldSku: string;
  days: number; // from the return request to the next sale
}

// Returned books that sold again on Amazon: the next sale of the same SKU or
// the same title (a re-scanned copy gets a new SKU) after the return was
// requested. Each sale counts for one return only, oldest return first. A
// later sale of the same title may be a different copy if you had two.
export function findResold(returns: AmazonReturn[], sales: AmazonSale[]): ResoldReturn[] {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const used = new Set<string>();
  const byDate = [...sales].sort((a, b) => a.orderDate.localeCompare(b.orderDate));
  return [...returns]
    .sort((a, b) => a.returnDate.localeCompare(b.returnDate))
    .flatMap((r) => {
      const sale = byDate.find(
        (s) =>
          !used.has(s.key) &&
          s.orderId !== r.orderId &&
          s.orderDate >= r.returnDate &&
          (s.sku === r.sku || norm(s.title) === norm(r.title)),
      );
      if (!sale) return [];
      used.add(sale.key);
      return [{
        title: r.title,
        reason: r.reason,
        returnDate: r.returnDate,
        refunded: r.refunded,
        resoldOn: sale.orderDate,
        resoldSku: sale.sku,
        days: Math.round((Date.parse(sale.orderDate) - Date.parse(r.returnDate)) / DAY),
      }];
    });
}

export function summarizeReturns(rows: AmazonReturn[], sales: AmazonSale[], sinceDays?: number): ReturnsSummary {
  const cutoff = sinceDays ? new Date(Date.now() - sinceDays * DAY).toISOString().slice(0, 10) : "";
  const returns = rows.filter((r) => r.returnDate >= cutoff);
  const sold = sales.filter((s) => s.orderDate >= cutoff);
  const haveSales = sales.length > 0;
  const units = (list: { quantity: number }[]) => list.reduce((n, r) => n + r.quantity, 0);
  const soldUnits = units(sold);
  const orderDates = new Map(sales.map((s) => [s.orderId, s.orderDate]));
  const soldOrders = new Set(sold.map((s) => s.orderId));

  const tally = <K>(list: AmazonReturn[], keyOf: (r: AmazonReturn) => K) => {
    const m = new Map<K, number>();
    for (const r of list) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + r.quantity);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };
  const total = units(returns);

  const days = returns.flatMap((r) => {
    const ordered = r.orderDate ?? orderDates.get(r.orderId);
    if (!ordered) return [];
    return [Math.max(0, Math.round((Date.parse(r.returnDate) - Date.parse(ordered)) / DAY))];
  });
  days.sort((a, b) => a - b);
  const buckets = [
    { label: "Within a week", test: (d: number) => d <= 7 },
    { label: "8–30 days", test: (d: number) => d > 7 && d <= 30 },
    { label: "31–60 days", test: (d: number) => d > 30 && d <= 60 },
    { label: "Over 60 days", test: (d: number) => d > 60 },
  ];

  const soldBySku = new Map<string, number>();
  const soldByMonth = new Map<string, number>();
  const soldByChannel = new Map<string, number>();
  for (const s of sold) {
    soldBySku.set(s.sku, (soldBySku.get(s.sku) ?? 0) + s.quantity);
    soldByMonth.set(s.orderDate.slice(0, 7), (soldByMonth.get(s.orderDate.slice(0, 7)) ?? 0) + s.quantity);
    soldByChannel.set(s.channel, (soldByChannel.get(s.channel) ?? 0) + s.quantity);
  }
  // A rate only counts returns of orders inside the sales data, so a return
  // of a book sold before the window doesn't inflate it.
  const rate = (list: AmazonReturn[], soldCount: number) =>
    haveSales && soldCount > 0 ? units(list.filter((r) => soldOrders.has(r.orderId))) / soldCount : null;

  const books = new Map<string, { sku: string; title: string; returns: number; reasons: Set<string> }>();
  for (const r of returns) {
    const b = books.get(r.sku) ?? { sku: r.sku, title: r.title, returns: 0, reasons: new Set<string>() };
    b.returns += r.quantity;
    b.reasons.add(r.reason);
    books.set(r.sku, b);
  }
  const months = new Set([...returns.map((r) => r.returnDate.slice(0, 7)), ...Array.from(soldByMonth.keys())]);
  const returnsByMonth = new Map(tally(returns, (r) => r.returnDate.slice(0, 7)));
  const dates = returns.map((r) => r.returnDate).sort();
  // All sales, not just the window: a book returned in it may sell again later.
  const resold = findResold(returns, sales);

  return {
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    returns: total,
    orders: new Set(returns.map((r) => r.orderId)).size,
    soldUnits: haveSales ? soldUnits : null,
    returnRate: rate(returns, soldUnits),
    refunded: returns.reduce((n, r) => n + (r.refunded ?? 0), 0),
    labelCost: returns.reduce((n, r) => n + (r.labelCost ?? 0), 0),
    azClaims: returns.filter((r) => r.azClaim).length,
    outOfPolicy: returns.filter((r) => r.inPolicy === false).length,
    medianDaysToReturn: days.length ? days[Math.floor(days.length / 2)] : null,
    daysToReturn: buckets.map((b) => ({ label: b.label, count: days.filter(b.test).length })),
    byReason: tally(returns, (r) => r.reason).map(([reason, n]) => ({ reason, units: n, share: total ? n / total : 0 })),
    byChannel: tally(returns, (r) => r.channel).map(([channel, n]) => {
      const soldCount = soldByChannel.get(channel) ?? 0;
      return {
        channel,
        units: n,
        sold: haveSales ? soldCount : null,
        rate: rate(returns.filter((r) => r.channel === channel), soldCount),
      };
    }),
    byMonth: Array.from(months).sort().map((month) => ({
      month,
      returns: returnsByMonth.get(month) ?? 0,
      sold: haveSales ? soldByMonth.get(month) ?? 0 : null,
    })),
    byBook: Array.from(books.values())
      .sort((a, b) => b.returns - a.returns)
      .slice(0, 25)
      .map((b) => ({ ...b, sold: haveSales ? soldBySku.get(b.sku) ?? 0 : null, reasons: Array.from(b.reasons) })),
    fbaDisposition: tally(returns.filter((r) => r.disposition), (r) => r.disposition!).map(([disposition, n]) => ({
      disposition,
      units: n,
    })),
    resold: resold.sort((a, b) => b.resoldOn.localeCompare(a.resoldOn)),
    notResold: returns.length - resold.length,
  };
}
