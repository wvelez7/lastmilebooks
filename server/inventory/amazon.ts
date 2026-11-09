// Amazon Selling Partner API, used only to read orders you ship yourself
// (merchant-fulfilled) so they count against shipping supplies. FBA orders use
// none of our supplies and are skipped. Books are not synced to Amazon.
//
// Env: AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN
// (Seller Central → Apps and Services → Develop Apps, a private app that you
// authorize for your own account), optional AMAZON_MARKETPLACE_ID (default US).
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
