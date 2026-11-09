// Amazon Selling Partner API. Reads orders you ship yourself (merchant-
// fulfilled) so they count against shipping supplies; FBA orders use none of
// our supplies and are skipped. Also looks up a scanned book's prices and
// sales rank, lists books, and keeps their quantity in sync.
//
// Env: AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN
// (Seller Central → Apps and Services → Develop Apps, a private app that you
// authorize for your own account), optional AMAZON_MARKETPLACE_ID (default US).
import type { AmazonBook, AmazonOffer, AmazonPrice } from "@shared/listing";

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const API_HOST = "https://sellingpartnerapi-na.amazon.com";
const US_MARKETPLACE = "ATVPDKIKX0DER";

// Paid for and not cancelled; "Pending" can still be cancelled, so it waits.
export const SHIPPABLE_STATUSES = ["Unshipped", "PartiallyShipped", "Shipped"];

export function amazonConfigured(): boolean {
  return Boolean(
    process.env.AMAZON_LWA_CLIENT_ID && process.env.AMAZON_LWA_CLIENT_SECRET && process.env.AMAZON_REFRESH_TOKEN,
  );
}

let cachedAccess: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt - 60_000 > Date.now()) return cachedAccess.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.AMAZON_REFRESH_TOKEN!,
      client_id: process.env.AMAZON_LWA_CLIENT_ID!,
      client_secret: process.env.AMAZON_LWA_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) throw new Error(`Amazon sign-in failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  cachedAccess = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedAccess.token;
}

export interface AmazonOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
  OrderStatus: string;
  FulfillmentChannel?: string; // "MFN" = you ship it, "AFN" = FBA
}

// Updated since `since`, so an order that was Pending when placed is still
// seen once it's paid. getOrders allows about one call a minute.
export async function listShippableOrdersSince(since: Date): Promise<AmazonOrder[]> {
  const out: AmazonOrder[] = [];
  const marketplace = process.env.AMAZON_MARKETPLACE_ID || US_MARKETPLACE;
  let nextToken: string | undefined;
  do {
    const qs = new URLSearchParams({ MarketplaceIds: marketplace });
    if (nextToken) qs.set("NextToken", nextToken);
    else {
      qs.set("LastUpdatedAfter", since.toISOString());
      qs.set("FulfillmentChannels", "MFN");
      qs.set("OrderStatuses", SHIPPABLE_STATUSES.join(","));
      qs.set("MaxResultsPerPage", "100");
    }
    const res = await fetch(`${API_HOST}/orders/v0/orders?${qs}`, {
      headers: { "x-amz-access-token": await accessToken() },
    });
    if (!res.ok) {
      throw new Error(`Amazon getOrders failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const page = (await res.json()) as { payload?: { Orders?: AmazonOrder[]; NextToken?: string } };
    out.push(...(page.payload?.Orders ?? []));
    nextToken = page.payload?.NextToken;
  } while (nextToken);
  // Filtered again in case the marketplace ignores a filter.
  return out.filter((o) => o.FulfillmentChannel !== "AFN" && SHIPPABLE_STATUSES.includes(o.OrderStatus));
}

// --- Book lookup for the barcode scanner ---
// Needs the "Product Listing" (catalog) and "Pricing" roles on the app, and a
// refresh token issued after those roles were added.

export type { AmazonBook, AmazonPrice };

function marketplaceId(): string {
  return process.env.AMAZON_MARKETPLACE_ID || US_MARKETPLACE;
}

async function spRequest<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_HOST}${path}`, {
    method,
    headers: {
      "x-amz-access-token": await accessToken(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 403) {
    throw new Error(`Amazon ${what} not allowed: add the Product Listing and Pricing roles to your app, then authorize it again`);
  }
  if (res.status === 429) throw new Error(`Amazon ${what} is busy. Try again in a few seconds.`);
  if (!res.ok) throw new Error(`Amazon ${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

function spGet<T>(path: string, what: string): Promise<T> {
  return spRequest<T>("GET", path, what);
}

interface CatalogItem {
  asin: string;
  summaries?: { itemName?: string }[];
  images?: { images?: { link: string; height?: number }[] }[];
  salesRanks?: { displayGroupRanks?: { rank: number }[]; classificationRanks?: { rank: number }[] }[];
}

// Every edition sharing the ISBN is one product, so the first match is the book.
async function findByIsbn13(isbn13: string): Promise<CatalogItem | null> {
  const qs = new URLSearchParams({
    identifiers: isbn13,
    identifiersType: "EAN",
    marketplaceIds: marketplaceId(),
    includedData: "summaries,images,salesRanks",
  });
  const page = await spGet<{ items?: CatalogItem[] }>(`/catalog/2022-04-01/items?${qs}`, "catalog search");
  return page.items?.[0] ?? null;
}

interface Money {
  Amount: number;
}

interface PriceEntry {
  condition: string; // "new", "used", ...
  fulfillmentChannel?: string; // "Amazon" or "Merchant"
  ListingPrice?: Money;
  Shipping?: Money;
}

interface OffersSummary {
  LowestPrices?: PriceEntry[];
  BuyBoxPrices?: PriceEntry[];
  NumberOfOffers?: { condition: string; OfferCount: number }[];
}

interface Offer {
  SubCondition?: string; // "very_good", "good", ...
  ListingPrice?: Money;
  Shipping?: Money;
  IsFulfilledByAmazon?: boolean;
}

interface OffersPayload {
  Summary?: OffersSummary;
  Offers?: Offer[];
}

const OFFERS_SHOWN = 10;

// Exported for testing with a saved response.
export function listOffers(offers: Offer[]): AmazonOffer[] {
  return offers
    .flatMap((o) =>
      o.ListingPrice
        ? [{
            price: o.ListingPrice.Amount,
            shipping: o.Shipping?.Amount ?? 0,
            condition: (o.SubCondition ?? "used").toLowerCase(),
            fba: Boolean(o.IsFulfilledByAmazon),
          }]
        : [],
    )
    .sort((a, b) => a.price + a.shipping - (b.price + b.shipping))
    .slice(0, OFFERS_SHOWN);
}

function toPrice(e: PriceEntry | undefined): AmazonPrice | null {
  if (!e?.ListingPrice) return null;
  return { price: e.ListingPrice.Amount, shipping: e.Shipping?.Amount ?? 0 };
}

function cheapest(entries: PriceEntry[]): AmazonPrice | null {
  const prices = entries.map(toPrice).filter((p): p is AmazonPrice => p !== null);
  prices.sort((a, b) => a.price + a.shipping - (b.price + b.shipping));
  return prices[0] ?? null;
}

// Exported for testing with a saved response.
export function summarizeOffers(summary: OffersSummary) {
  const lowest = summary.LowestPrices ?? [];
  const isUsed = (e: { condition: string }) => e.condition.toLowerCase() === "used";
  const isNew = (e: { condition: string }) => e.condition.toLowerCase() === "new";
  const offers = (match: (e: { condition: string }) => boolean) =>
    (summary.NumberOfOffers ?? []).filter(match).reduce((n, o) => n + o.OfferCount, 0);
  return {
    lowestUsed: cheapest(lowest.filter((e) => isUsed(e) && e.fulfillmentChannel !== "Amazon")),
    lowestUsedFba: cheapest(lowest.filter((e) => isUsed(e) && e.fulfillmentChannel === "Amazon")),
    lowestNew: cheapest(lowest.filter(isNew)),
    buyBoxUsed: toPrice((summary.BuyBoxPrices ?? []).find(isUsed)),
    usedOffers: offers(isUsed),
    newOffers: offers(isNew),
  };
}

// getItemOffers allows one call every 2 seconds, so fast scanning waits its turn.
const OFFERS_SPACING_MS = 2100;
let offersQueue: Promise<unknown> = Promise.resolve();

function getOffers(asin: string): Promise<OffersPayload> {
  const run = offersQueue.then(async () => {
    const qs = new URLSearchParams({ MarketplaceId: marketplaceId(), ItemCondition: "Used" });
    const page = await spGet<{ payload?: OffersPayload }>(
      `/products/pricing/v0/items/${encodeURIComponent(asin)}/offers?${qs}`,
      "price check",
    );
    return page.payload ?? {};
  });
  // The next call waits; this one returns as soon as Amazon answers.
  offersQueue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, OFFERS_SPACING_MS)));
  return run;
}

// null when Amazon doesn't carry the book.
export async function lookupBook(isbn13: string): Promise<AmazonBook | null> {
  const item = await findByIsbn13(isbn13);
  if (!item) return null;
  const images = item.images?.[0]?.images ?? [];
  const rank = item.salesRanks?.[0];
  const [offers, restriction] = await Promise.all([getOffers(item.asin), usedRestriction(item.asin)]);
  return {
    asin: item.asin,
    title: item.summaries?.[0]?.itemName ?? "",
    imageUrl: [...images].sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0]?.link ?? null,
    salesRank: rank?.displayGroupRanks?.[0]?.rank ?? rank?.classificationRanks?.[0]?.rank ?? null,
    ...summarizeOffers(offers.Summary ?? {}),
    offers: listOffers(offers.Offers ?? []),
    restriction,
  };
}

// --- Listing books you ship yourself ---
// Needs AMAZON_SELLER_ID: Seller Central → Settings → Account Info → Merchant Token.

export function amazonListingConfigured(): boolean {
  return amazonConfigured() && Boolean(process.env.AMAZON_SELLER_ID);
}

function listingPath(sku: string): string {
  const qs = new URLSearchParams({ marketplaceIds: marketplaceId() });
  return `/listings/2021-08-01/items/${encodeURIComponent(process.env.AMAZON_SELLER_ID!)}/${encodeURIComponent(sku)}?${qs}`;
}

// Some books are gated by publisher or condition. Checked as "used, good",
// which matches what most of our books are; null also when it can't be
// checked, so a failed check never hides the price.
async function usedRestriction(asin: string): Promise<string | null> {
  if (!amazonListingConfigured()) return null;
  const qs = new URLSearchParams({
    asin,
    sellerId: process.env.AMAZON_SELLER_ID!,
    marketplaceIds: marketplaceId(),
    conditionType: "used_good",
  });
  try {
    const page = await spGet<{ restrictions?: { reasons?: { message?: string }[] }[] }>(
      `/listings/2021-08-01/restrictions?${qs}`,
      "restriction check",
    );
    const reasons = (page.restrictions ?? []).flatMap((r) => r.reasons ?? []);
    if ((page.restrictions ?? []).length === 0) return null;
    return reasons.map((r) => r.message).filter(Boolean).join(" ") || "Amazon doesn't let you list this book.";
  } catch {
    return null;
  }
}

interface ListingIssue {
  message: string;
  severity: string; // "ERROR" | "WARNING" | "INFO"
}

interface ListingSubmission {
  status: string; // "ACCEPTED" | "INVALID"
  issues?: ListingIssue[];
}

function submissionError(what: string, result: ListingSubmission): Error | null {
  const errors = (result.issues ?? []).filter((i) => i.severity === "ERROR");
  if (result.status === "ACCEPTED" && errors.length === 0) return null;
  return new Error(`Amazon ${what}: ${errors.map((i) => i.message).join(" ") || result.status}`);
}

export interface NewOffer {
  sku: string;
  asin: string;
  conditionType: string; // e.g. "used_very_good"
  note: string;
  price: number;
  quantity: number;
}

// An offer on the book's existing Amazon page, shipped by you with your
// default shipping template. Amazon accepts it at once and has it live
// within about 15 minutes.
export async function createOffer(offer: NewOffer): Promise<void> {
  const marketplace_id = marketplaceId();
  const attributes: Record<string, unknown[]> = {
    merchant_suggested_asin: [{ value: offer.asin, marketplace_id }],
    condition_type: [{ value: offer.conditionType, marketplace_id }],
    purchasable_offer: [
      { currency: "USD", marketplace_id, our_price: [{ schedule: [{ value_with_tax: offer.price }] }] },
    ],
    fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: offer.quantity }],
  };
  if (offer.note) {
    attributes.condition_note = [{ value: offer.note, language_tag: "en_US", marketplace_id }];
  }
  const result = await spRequest<ListingSubmission>("PUT", listingPath(offer.sku), "listing", {
    productType: "PRODUCT",
    requirements: "LISTING_OFFER_ONLY",
    attributes,
  });
  const error = submissionError("didn't accept the listing", result);
  if (error) throw error;
}

// At 0 the offer stays on Amazon but can't be bought.
export async function setOfferQuantity(sku: string, quantity: number): Promise<void> {
  const result = await spRequest<ListingSubmission>("PATCH", listingPath(sku), "quantity update", {
    productType: "PRODUCT",
    patches: [
      {
        op: "replace",
        path: "/attributes/fulfillment_availability",
        value: [{ fulfillment_channel_code: "DEFAULT", quantity }],
      },
    ],
  });
  const error = submissionError("didn't accept the quantity", result);
  if (error) throw error;
}

export interface AmazonOrderItem {
  OrderItemId: string;
  SellerSKU?: string;
  Title?: string;
  QuantityOrdered: number;
}

// Which books an order is for; the order list doesn't say.
export async function listOrderItems(orderId: string): Promise<AmazonOrderItem[]> {
  const out: AmazonOrderItem[] = [];
  let nextToken: string | undefined;
  do {
    const qs = nextToken ? `?${new URLSearchParams({ NextToken: nextToken })}` : "";
    const page = await spGet<{ payload?: { OrderItems?: AmazonOrderItem[]; NextToken?: string } }>(
      `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems${qs}`,
      "order items",
    );
    out.push(...(page.payload?.OrderItems ?? []));
    nextToken = page.payload?.NextToken;
  } while (nextToken);
  return out;
}
