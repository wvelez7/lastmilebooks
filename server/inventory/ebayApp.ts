// eBay calls that only need the application keys. Kept apart from ./ebay, which
// opens the database, so command-line scripts can use them.
export const API_HOST = "https://api.ebay.com";

function basicAuth(): string {
  const raw = `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

export async function tokenRequest(form: Record<string, string>) {
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

// Browse requires an application token, separate from the seller's user token.
let cachedAppToken: { token: string; expiresAt: number } | null = null;

export async function appToken(): Promise<string> {
  if (cachedAppToken && cachedAppToken.expiresAt - 60_000 > Date.now()) return cachedAppToken.token;
  const json = await tokenRequest({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  cachedAppToken = { token: json.access_token!, expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000 };
  return cachedAppToken.token;
}

// A listing's full-size photos, main photo first. Works before the seller has
// clicked Connect eBay.
export async function getListingPhotos(itemId: string): Promise<string[]> {
  if (!/^\d+$/.test(itemId)) throw new Error(`Invalid eBay item ID "${itemId}"`);
  const qs = new URLSearchParams({ legacy_item_id: itemId });
  const res = await fetch(`${API_HOST}/buy/browse/v1/item/get_item_by_legacy_id?${qs}`, {
    headers: {
      Authorization: `Bearer ${await appToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  if (!res.ok) {
    throw new Error(`eBay item lookup failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const item = (await res.json()) as {
    image?: { imageUrl: string };
    additionalImages?: { imageUrl: string }[];
  };
  return [item.image, ...(item.additionalImages ?? [])].flatMap((i) => (i ? [i.imageUrl] : []));
}
