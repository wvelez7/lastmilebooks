import { toIsbn13 } from "@shared/profit";
import { inventoryStore } from "./store";
import { API_HOST, appToken, tokenRequest } from "./ebayApp";

// eBay: OAuth user token (authorization-code grant, refreshed automatically),
// the Fulfillment API to read orders, and the Trading API to change listing
// quantities. Works for listings created anywhere (Seller Hub, app, etc.).
//
// Env: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME (from
// developer.ebay.com → Application Keys / User Tokens).
const AUTH_HOST = "https://auth.ebay.com";
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");
const REFRESH_TOKEN_KEY = "ebay_refresh_token";

export function ebayAppConfigured(): boolean {
  return Boolean(
    process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET && process.env.EBAY_RU_NAME,
  );
}

export function ebayConnected(): boolean {
  return ebayAppConfigured() && Boolean(inventoryStore.getState(REFRESH_TOKEN_KEY));
}

export function authorizeUrl(state: string): string {
  const qs = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID!,
    redirect_uri: process.env.EBAY_RU_NAME!,
    response_type: "code",
    scope: SCOPES,
    state,
  });
  return `${AUTH_HOST}/oauth2/authorize?${qs}`;
}

let cachedAccess: { token: string; expiresAt: number } | null = null;

export async function exchangeCode(code: string): Promise<void> {
  const json = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.EBAY_RU_NAME!,
  });
  if (!json.refresh_token) throw new Error("eBay did not return a refresh token");
  inventoryStore.setState(REFRESH_TOKEN_KEY, json.refresh_token);
  cachedAccess = { token: json.access_token!, expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000 };
}

async function accessToken(): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt - 60_000 > Date.now()) return cachedAccess.token;
  const refresh = inventoryStore.getState(REFRESH_TOKEN_KEY);
  if (!refresh) throw new Error("eBay is not connected yet");
  const json = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refresh,
    scope: SCOPES,
  });
  cachedAccess = { token: json.access_token!, expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000 };
  return cachedAccess.token;
}

// ---- Orders (Fulfillment API) ---------------------------------------------

export interface EbayLineItem {
  lineItemId: string;
  legacyItemId: string;
  sku?: string;
  title: string;
  quantity: number;
}

export interface EbayOrder {
  orderId: string;
  creationDate: string;
  cancelStatus?: { cancelState?: string };
  lineItems: EbayLineItem[];
}

export async function listOrdersSince(since: Date): Promise<EbayOrder[]> {
  const out: EbayOrder[] = [];
  const token = await accessToken();
  for (let offset = 0; ; offset += 200) {
    const qs = new URLSearchParams({
      filter: `creationdate:[${since.toISOString()}..]`,
      limit: "200",
      offset: String(offset),
    });
    const res = await fetch(`${API_HOST}/sell/fulfillment/v1/order?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`eBay getOrders failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const page = (await res.json()) as { orders?: EbayOrder[]; total?: number };
    out.push(...(page.orders ?? []));
    if (!page.orders?.length || offset + 200 >= (page.total ?? 0)) return out;
  }
}

// ---- Listings (Trading API) -----------------------------------------------

async function trading(callName: string, innerXml: string): Promise<string> {
  const token = await accessToken();
  const res = await fetch(`${API_HOST}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
      "X-EBAY-API-IAF-TOKEN": token,
      "Content-Type": "text/xml",
    },
    body: `<?xml version="1.0" encoding="utf-8"?><${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">${innerXml}</${callName}Request>`,
  });
  const xml = await res.text();
  const ack = tag(xml, "Ack");
  if (!res.ok || (ack !== "Success" && ack !== "Warning")) {
    const msg = tag(xml, "LongMessage") ?? tag(xml, "ShortMessage") ?? `HTTP ${res.status}`;
    throw new Error(`eBay ${callName} failed: ${msg}`);
  }
  return xml;
}

function tag(xml: string, name: string): string | undefined {
  // Attributes are allowed: prices look like <CurrentPrice currencyID="USD">.
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Sets the listing's available quantity. At 0 the listing is hidden
// (out-of-stock control); if the account doesn't allow 0, the listing is ended.
export async function setListingQuantity(itemId: string, quantity: number): Promise<"updated" | "ended"> {
  if (!/^\d+$/.test(itemId)) throw new Error(`Invalid eBay item ID "${itemId}"`);
  try {
    await trading(
      "ReviseInventoryStatus",
      `<InventoryStatus><ItemID>${itemId}</ItemID><Quantity>${quantity}</Quantity></InventoryStatus>`,
    );
    return "updated";
  } catch (e) {
    if (quantity !== 0) throw e;
    await trading(
      "EndFixedPriceItem",
      `<ItemID>${itemId}</ItemID><EndingReason>NotAvailable</EndingReason>`,
    );
    return "ended";
  }
}

export interface EbayListing {
  itemId: string;
  sku: string;
  title: string;
  quantity: number;
}

// Active listings that have a Custom label (SKU), for matching against Whatnot.
export async function listListings(): Promise<EbayListing[]> {
  const all = await listActiveListings();
  return all.flatMap((l) => (l.sku ? [{ ...l, sku: l.sku }] : []));
}

export interface EbayActiveListing {
  itemId: string;
  sku: string | null;
  title: string;
  quantity: number;
  price: number;
  url: string | null;
}

// Every active listing, with or without a Custom label.
export async function listActiveListings(): Promise<EbayActiveListing[]> {
  const out: EbayActiveListing[] = [];
  for (let pageNumber = 1; ; pageNumber++) {
    const xml = await trading(
      "GetMyeBaySelling",
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`,
    );
    const active = xml.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/)?.[1] ?? "";
    for (const item of active.match(/<Item>[\s\S]*?<\/Item>/g) ?? []) {
      const sku = tag(item, "SKU")?.trim() || null;
      const itemId = tag(item, "ItemID");
      if (!itemId) continue;
      out.push({
        itemId,
        sku,
        title: tag(item, "Title") ?? sku ?? itemId,
        quantity: Number(tag(item, "QuantityAvailable") ?? tag(item, "Quantity") ?? 0),
        price: Number(tag(item, "CurrentPrice") ?? tag(item, "BuyItNowPrice") ?? 0),
        url: tag(item, "ViewItemURL") ?? null,
      });
    }
    const totalPages = Number(tag(active, "TotalNumberOfPages") ?? 1);
    if (pageNumber >= totalPages) return out;
  }
}

export interface EbayListingDetails {
  isbn: string | null;
  shipping: number | null;
  condition: string | null;
  imageUrl: string | null;
}

// The listing call has no ISBN, so this reads it from the item's specifics or
// catalog product. One API call per listing; callers cache the result.
export async function getListingDetails(itemId: string): Promise<EbayListingDetails> {
  if (!/^\d+$/.test(itemId)) throw new Error(`Invalid eBay item ID "${itemId}"`);
  const xml = await trading(
    "GetItem",
    `<ItemID>${itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>`,
  );
  return parseListingDetails(xml);
}

export function parseListingDetails(xml: string): EbayListingDetails {
  const candidates = [tag(xml, "ISBN")];
  for (const pair of xml.match(/<NameValueList>[\s\S]*?<\/NameValueList>/g) ?? []) {
    if (!/^ISBN/i.test(tag(pair, "Name") ?? "")) continue;
    for (const v of pair.match(/<Value>[\s\S]*?<\/Value>/g) ?? []) candidates.push(tag(v, "Value"));
  }
  const isbn = candidates.map((c) => (c ? toIsbn13(c) : null)).find(Boolean) ?? null;

  const shippingBlock = tag(xml, "ShippingDetails") ?? "";
  const flat = !/Calculated/i.test(tag(shippingBlock, "ShippingType") ?? "");
  const cost = tag(shippingBlock, "ShippingServiceCost");
  return {
    isbn,
    shipping: flat && cost !== undefined ? Number(cost) : null,
    condition: tag(xml, "ConditionDisplayName") ?? null,
    imageUrl: tag(xml, "GalleryURL") ?? tag(xml, "PictureURL") ?? null,
  };
}

// ---- What others charge (Browse API) ---------------------------------------

export interface EbayMarketOffer {
  title: string;
  price: number;
  shipping: number | null;
  condition: string | null;
  url: string | null;
  imageUrl: string | null;
}

interface BrowseItem {
  title: string;
  price?: { value: string };
  shippingOptions?: { shippingCost?: { value: string } }[];
  condition?: string;
  itemWebUrl?: string;
  image?: { imageUrl: string };
}

// The cheapest fixed-price US listings for a barcode, cheapest (with shipping) first.
export async function searchMarket(gtin: string, limit = 3): Promise<EbayMarketOffer[]> {
  const qs = new URLSearchParams({
    gtin,
    filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US",
    sort: "price",
    limit: "20",
  });
  const res = await fetch(`${API_HOST}/buy/browse/v1/item_summary/search?${qs}`, {
    headers: {
      Authorization: `Bearer ${await appToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  if (!res.ok) {
    throw new Error(`eBay search failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const page = (await res.json()) as { itemSummaries?: BrowseItem[] };
  const offers: EbayMarketOffer[] = (page.itemSummaries ?? []).map((i) => {
    const shipping = i.shippingOptions?.[0]?.shippingCost?.value;
    return {
      title: i.title,
      price: Number(i.price?.value ?? 0),
      shipping: shipping === undefined ? null : Number(shipping),
      condition: i.condition ?? null,
      url: i.itemWebUrl ?? null,
      imageUrl: i.image?.imageUrl ?? null,
    };
  });
  return offers
    .sort((a, b) => a.price + (a.shipping ?? 0) - (b.price + (b.shipping ?? 0)))
    .slice(0, limit);
}
