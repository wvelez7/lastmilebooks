import crypto from "node:crypto";

// Whatnot Seller API (REST v2): https://developers.whatnot.com
// Uses a personal access token from whatnot.com/dashboard/developer with
// read:orders, read:inventory and write:inventory.
const BASE = "https://api.whatnot.com/seller-api/rest/v2";

export function whatnotConfigured(): boolean {
  return Boolean(process.env.WHATNOT_API_TOKEN);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.WHATNOT_API_TOKEN;
  if (!token) throw new Error("WHATNOT_API_TOKEN is not set");

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // 10 requests/second per seller; honour Retry-After and back off.
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await sleep(retryAfter * 1000 * 2 ** attempt + Math.random() * 250);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Whatnot ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}

interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface WhatnotOrder {
  id: string;
  status: "pending" | "pending_fulfillment" | "completed" | "cancelled" | "failed";
  created_at: string | null;
}

export interface WhatnotOrderItem {
  id: string;
  order_id: string;
  variant_id: string | null;
  quantity: number;
  purchased_item: { title: string; sku: string | null } | null;
}

interface WhatnotProduct {
  id: string;
  title: string;
}

interface WhatnotVariant {
  id: string;
  sku: string | null;
  inventory: { available_quantity: number };
}

export interface WhatnotListing {
  variantId: string;
  sku: string;
  title: string;
  quantity: number;
}

// Orders created at or after `since`, newest first.
export async function listOrdersSince(since: Date): Promise<WhatnotOrder[]> {
  const out: WhatnotOrder[] = [];
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ limit: "50", reverse: "true" });
    if (cursor) qs.set("cursor", cursor);
    const page: Page<WhatnotOrder> = await request("GET", `/orders?${qs}`);
    for (const order of page.data) {
      if (order.created_at && new Date(order.created_at) < since) return out;
      out.push(order);
    }
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

export async function getOrder(orderId: string): Promise<WhatnotOrder> {
  return request("GET", `/orders/${encodeURIComponent(orderId)}`);
}

export async function listOrderItems(orderId: string): Promise<WhatnotOrderItem[]> {
  const out: WhatnotOrderItem[] = [];
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ limit: "50" });
    if (cursor) qs.set("cursor", cursor);
    const page: Page<WhatnotOrderItem> = await request(
      "GET",
      `/orders/${encodeURIComponent(orderId)}/items?${qs}`,
    );
    out.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

export async function setVariantQuantity(variantId: string, quantity: number): Promise<void> {
  const res: { results: { status: string }[] } = await request("POST", "/inventory/set", {
    items: [{ variant_id: variantId, quantity, idempotency_key: crypto.randomUUID() }],
  });
  const status = res.results[0]?.status;
  if (status !== "applied" && status !== "already_applied") {
    throw new Error(`Whatnot inventory update for variant ${variantId} returned "${status}"`);
  }
}

// Every product variant that has a SKU, for matching against eBay.
export async function listListings(): Promise<WhatnotListing[]> {
  const out: WhatnotListing[] = [];
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ limit: "50" });
    if (cursor) qs.set("cursor", cursor);
    const page: Page<WhatnotProduct> = await request("GET", `/products?${qs}`);
    for (const product of page.data) {
      let vCursor: string | null = null;
      do {
        const vqs = new URLSearchParams({ limit: "50" });
        if (vCursor) vqs.set("cursor", vCursor);
        const variants: Page<WhatnotVariant> = await request(
          "GET",
          `/products/${encodeURIComponent(product.id)}/variants?${vqs}`,
        );
        for (const v of variants.data) {
          if (!v.sku) continue;
          out.push({
            variantId: v.id,
            sku: v.sku.trim(),
            title: product.title,
            quantity: v.inventory.available_quantity,
          });
        }
        vCursor = variants.next_cursor;
      } while (vCursor);
      await sleep(150); // stay well under the rate limit on big catalogs
    }
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

// What the API returns for this token, for working out why listings don't match.
export async function checkProducts() {
  const raw = await request<Record<string, unknown>>("GET", "/products?limit=50");
  const products = (raw.data ?? []) as (WhatnotProduct & Record<string, unknown>)[];
  const results = [];
  for (const product of products) {
    const variants: Page<WhatnotVariant> = await request(
      "GET",
      `/products/${encodeURIComponent(product.id)}/variants?limit=50`,
    );
    results.push({
      title: product.title,
      id: product.id,
      options: (product.options as unknown[] | undefined)?.length ?? 0,
      variants: variants.data.length,
      withSku: variants.data.filter((v) => v.sku).length,
    });
    await sleep(150);
  }
  return {
    responseKeys: Object.keys(raw),
    productKeys: Object.keys(products[0] ?? {}),
    products: products.length,
    more: Boolean(raw.next_cursor),
    withVariants: results.filter((r) => r.variants > 0),
    sample: results.slice(0, 2),
    last: results.slice(-1),
  };
}

// Standard Webhooks signature check: HMAC-SHA256 over "{id}.{timestamp}.{body}".
export function verifyWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const secret = process.env.WHATNOT_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"];
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signatures !== "string") {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 5 * 60) return false;

  const key = Buffer.from(secret.replace(/^wn_wh_/, ""), "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest();
  return signatures.split(" ").some((entry) => {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}
