import { z } from "zod";
import type { ScanSettings } from "./profit";

// Listing scanned books in batches, like Accelerlist: scan a stack into a
// batch, check and adjust each price, then list them all on Amazon and/or
// eBay at once. Each book gets one SKU used on every marketplace, so the
// inventory sync can take it down everywhere when it sells.

export const BOOK_CONDITIONS = [
  { value: "new", label: "New", code: "N", amazon: "new_new", ebayId: 1000 },
  { value: "like_new", label: "Like New", code: "LN", amazon: "used_like_new", ebayId: 2750 },
  { value: "very_good", label: "Very Good", code: "VG", amazon: "used_very_good", ebayId: 4000 },
  { value: "good", label: "Good", code: "G", amazon: "used_good", ebayId: 5000 },
  { value: "acceptable", label: "Acceptable", code: "A", amazon: "used_acceptable", ebayId: 6000 },
] as const;

export type BookCondition = (typeof BOOK_CONDITIONS)[number]["value"];
const conditionValues = BOOK_CONDITIONS.map((c) => c.value) as [BookCondition, ...BookCondition[]];

export function bookCondition(value: BookCondition) {
  return BOOK_CONDITIONS.find((c) => c.value === value)!;
}

// ---- Amazon data shown while pricing --------------------------------------

export interface AmazonPrice {
  price: number; // item price
  shipping: number; // what the buyer pays for shipping
}

export interface AmazonOffer extends AmazonPrice {
  condition: string; // e.g. "very_good"
  fba: boolean;
}

export interface AmazonBook {
  asin: string;
  title: string;
  imageUrl: string | null;
  salesRank: number | null; // in Books; lower sells faster
  lowestUsed: AmazonPrice | null; // among sellers who ship it themselves
  lowestUsedFba: AmazonPrice | null;
  lowestNew: AmazonPrice | null;
  buyBoxUsed: AmazonPrice | null;
  usedOffers: number;
  newOffers: number;
  offers: AmazonOffer[]; // cheapest used offers, cheapest first
  restriction: string | null; // why you can't list it used, if Amazon says so
}

export const MIN_PRICE = 0.99;

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// Matches the lowest used price, counting shipping, since that's what buyers
// compare. Amazon adds its fixed shipping charge to our price, so that comes
// off. FBA offers count too: they ship free.
export function suggestedAmazonPrice(book: AmazonBook, settings: ScanSettings): number | null {
  const candidates = [book.lowestUsed, book.lowestUsedFba].filter((p): p is AmazonPrice => p !== null);
  if (candidates.length === 0 && book.buyBoxUsed) candidates.push(book.buyBoxUsed);
  if (candidates.length === 0) return null;
  const lowest = Math.min(...candidates.map((p) => p.price + p.shipping));
  return Math.max(MIN_PRICE, roundCents(lowest - settings.amazonShippingCredit));
}

// Where to research a price before listing.
export function researchLinks(isbn13: string, asin: string | null) {
  const links = [
    { label: "eBay sold", url: `https://www.ebay.com/sch/i.html?_nkw=${isbn13}&LH_Sold=1&LH_Complete=1` },
    { label: "eBay active", url: `https://www.ebay.com/sch/i.html?_nkw=${isbn13}` },
    { label: "BookScouter", url: `https://bookscouter.com/book/${isbn13}` },
  ];
  if (asin) {
    links.unshift(
      { label: "Amazon offers", url: `https://www.amazon.com/dp/${asin}?aod=1` },
      { label: "Keepa", url: `https://keepa.com/#!product/1-${asin}` },
    );
  }
  return links;
}

// ---- Custom SKUs -------------------------------------------------------------

export const SKU_TOKENS = [
  { token: "{SEQ}", meaning: "running count, like 01, 02 … never repeats (required)" },
  { token: "{BOX}", meaning: "the box the book is stored in" },
  { token: "{DATE}", meaning: "date scanned, like 261109" },
  { token: "{MMYY}", meaning: "month and year scanned, like 1126" },
  { token: "{COND}", meaning: "condition: N, LN, VG, G or A" },
  { token: "{PRICE}", meaning: "Amazon price to the nearest dollar, like 32" },
  { token: "{ISBN}", meaning: "ISBN-13" },
  { token: "{ASIN}", meaning: "Amazon ASIN" },
  { token: "{BATCH}", meaning: "batch number" },
] as const;

// Box first, so a sold book's SKU says where to find it.
export const DEFAULT_SKU_TEMPLATE = "{BOX}-{DATE}-{COND}-{SEQ}";

// A box label: short so the SKU stays short, and only characters SKUs allow.
export const boxSchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(8, "Keep box names to 8 characters")
  .regex(/^[A-Z0-9_.-]*$/, "Use only letters, numbers, - _ and .");
export const MAX_SKU_LENGTH = 40; // Amazon's limit

export const listingSettingsSchema = z.object({
  skuTemplate: z
    .string()
    .trim()
    .min(1, "Enter a SKU pattern")
    .refine((t) => t.includes("{SEQ}"), "Include {SEQ} so every SKU is different")
    .refine((t) => /^[A-Za-z0-9\-_.{}]+$/.test(t), "Use only letters, numbers, - _ . and the {TOKENS}"),
});

export type ListingSettings = z.infer<typeof listingSettingsSchema>;
export const DEFAULT_LISTING_SETTINGS: ListingSettings = { skuTemplate: DEFAULT_SKU_TEMPLATE };

export interface SkuParts {
  seq: number;
  scannedAt: string; // ISO date
  condition: BookCondition;
  amazonPrice: number | null;
  isbn13: string;
  asin: string | null;
  batchId: number;
  box: string;
}

// The date where the books are, not the server's clock (UTC), so an evening
// scan doesn't get tomorrow's date.
function scanDate(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? "00";
  return { yy: get("year"), mm: get("month"), dd: get("day") };
}

export function buildSku(template: string, p: SkuParts): string {
  const { yy, mm, dd } = scanDate(p.scannedAt);
  const values: Record<string, string> = {
    "{SEQ}": String(p.seq).padStart(2, "0"),
    "{DATE}": `${yy}${mm}${dd}`,
    "{MMYY}": `${mm}${yy}`,
    "{COND}": bookCondition(p.condition).code,
    "{PRICE}": String(Math.round(p.amazonPrice ?? 0)),
    "{ISBN}": p.isbn13,
    "{ASIN}": p.asin ?? "",
    "{BATCH}": String(p.batchId),
    "{BOX}": p.box,
  };
  // An empty token (no box yet) would leave "--"; close the gap instead. Never
  // cut short: the running count is usually last, and cutting it off could
  // give two books the same SKU. Callers reject one over MAX_SKU_LENGTH.
  return template
    .replace(/\{[A-Z]+\}/g, (t) => values[t] ?? t)
    .replace(/([-_.])[-_.]+/g, "$1")
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

// The longest SKU a pattern is likely to make, for checking it when saved.
// Assumes a 4-character box and a price under $1,000; a longer box is caught
// when a book is scanned.
export function longestSku(template: string): string {
  return buildSku(template, {
    seq: 9999,
    scannedAt: "2026-12-31T20:00:00Z",
    condition: "like_new",
    amazonPrice: 999.99,
    isbn13: "9780000000000",
    asin: "B000000000",
    batchId: 9999,
    box: "BOX1",
  });
}

// ---- Batches -------------------------------------------------------------------

export const batchDefaultsSchema = z.object({
  box: boxSchema.default(""), // box new scans go into; change it when you start a new box
  condition: z.enum(conditionValues),
  note: z.string().trim().max(1000),
  quantity: z.number().int().min(1).max(99),
  amazon: z.boolean(), // list on Amazon
  ebay: z.boolean(), // list on eBay
});

export type BatchDefaults = z.infer<typeof batchDefaultsSchema>;

export const DEFAULT_BATCH_DEFAULTS: BatchDefaults = {
  box: "",
  condition: "good",
  note: "",
  quantity: 1,
  amazon: true,
  ebay: false,
};

const price = z.number().min(MIN_PRICE, `Price must be at least $${MIN_PRICE}`).max(10_000);

// What can be changed on a book before the batch is listed.
export const batchItemPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    box: boxSchema,
    condition: z.enum(conditionValues),
    note: z.string().trim().max(1000),
    quantity: z.number().int().min(1).max(99),
    amazonPrice: price.nullable(),
    ebayPrice: price.nullable(),
    listAmazon: z.boolean(),
    listEbay: z.boolean(),
  })
  .partial();

export type BatchItemPatch = z.infer<typeof batchItemPatchSchema>;

export interface ListResult {
  ok: boolean;
  message: string; // what happened, in plain words
  url?: string;
}

export type BatchItemStatus = "pending" | "listed" | "failed";
export type BatchStatus = "open" | "listing" | "done";

export interface BatchItem {
  id: number;
  batchId: number;
  sku: string;
  isbn13: string;
  title: string;
  amazon: AmazonBook | null; // snapshot from when it was scanned
  ebayLowest: number | null; // cheapest fixed-price eBay listing, item price only
  onEbayAlready: number; // copies already in your eBay store
  box: string; // where the book is stored
  condition: BookCondition;
  note: string;
  quantity: number;
  amazonPrice: number | null;
  ebayPrice: number | null;
  listAmazon: boolean;
  listEbay: boolean;
  status: BatchItemStatus;
  amazonResult: ListResult | null;
  ebayResult: ListResult | null;
  createdAt: string;
}

export interface Batch {
  id: number;
  name: string;
  status: BatchStatus;
  defaults: BatchDefaults;
  createdAt: string;
  itemCount: number;
}

export interface BatchDetail extends Batch {
  items: BatchItem[];
}

// Why a book can't be listed as set, or null when it's ready.
export function itemProblem(item: Pick<BatchItem, "listAmazon" | "listEbay" | "amazonPrice" | "ebayPrice" | "amazon">): string | null {
  if (!item.listAmazon && !item.listEbay) {
    return item.amazon?.restriction ? "Restricted on Amazon; tick eBay or remove" : "Not set to list anywhere";
  }
  if (item.listAmazon && !item.amazon) return "Not on Amazon";
  if (item.listAmazon && item.amazonPrice === null) return "Needs an Amazon price";
  if (item.listEbay && item.ebayPrice === null) return "Needs an eBay price";
  return null;
}
