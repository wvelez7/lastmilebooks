import { inventoryStore } from "./store";

// eBay: OAuth user token (authorization-code grant, refreshed automatically),
// the Fulfillment API to read orders, and the Trading API to change listing
// quantities. Works for listings created anywhere (Seller Hub, app, etc.).
//
// Env: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME (from
// developer.ebay.com → Application Keys / User Tokens).
const AUTH_HOST = "https://auth.ebay.com";
const API_HOST = "https://api.ebay.com";
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

function basicAuth(): string {
  const raw = `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function tokenRequest(form: Record<string, string>) {
  const res = await fetch(`${API_HOST}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`eBay token request failed: ${res.status} ${json.error_description ?? ""}`);
  }
  return json;
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
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
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
  const out: EbayListing[] = [];
  for (let pageNumber = 1; ; pageNumber++) {
    const xml = await trading(
      "GetMyeBaySelling",
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`,
    );
    const active = xml.match(/<ActiveList>([\s\S]*?)<\/ActiveList>/)?.[1] ?? "";
    for (const item of active.match(/<Item>[\s\S]*?<\/Item>/g) ?? []) {
      const sku = tag(item, "SKU")?.trim();
      const itemId = tag(item, "ItemID");
      if (!sku || !itemId) continue;
      out.push({
        itemId,
        sku,
        title: tag(item, "Title") ?? sku,
        quantity: Number(tag(item, "QuantityAvailable") ?? tag(item, "Quantity") ?? 0),
      });
    }
    const totalPages = Number(tag(active, "TotalNumberOfPages") ?? 1);
    if (pageNumber >= totalPages) return out;
  }
}
