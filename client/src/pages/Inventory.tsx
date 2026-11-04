import { useCallback, useEffect, useState } from "react";
import type { InventoryItem, SyncEvent } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

// Admin page for the Whatnot + eBay inventory sync. Not linked from the site;
// open /#/inventory and enter the ADMIN_KEY.

const KEY_STORAGE = "lmb-admin-key";

interface InventoryResponse {
  status: { whatnot: boolean; whatnotWebhook: boolean; ebayApp: boolean; ebay: boolean };
  items: InventoryItem[];
  events: SyncEvent[];
}

function readKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

const emptyForm = { sku: "", title: "", quantity: "1", whatnotVariantId: "", ebayItemId: "" };

export default function Inventory() {
  const { toast } = useToast();
  const [adminKey, setAdminKey] = useState(readKey);
  const [keyDraft, setKeyDraft] = useState("");
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState("");

  const api = useCallback(
    async (method: string, url: string, body?: unknown) => {
      const res = await fetch(url, {
        method,
        headers: { "x-admin-key": adminKey, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) {
        setAdminKey("");
        try {
          sessionStorage.removeItem(KEY_STORAGE);
        } catch {}
        throw new Error("Wrong admin key");
      }
      if (!res.ok) {
        const text = await res.text();
        let message = text;
        try {
          message = JSON.parse(text).error ?? text;
        } catch {}
        throw new Error(typeof message === "string" ? message : `Request failed (${res.status})`);
      }
      return res.status === 204 ? null : res.json();
    },
    [adminKey],
  );

  const load = useCallback(async () => {
    if (!adminKey) return;
    try {
      setData(await api("GET", "/api/inventory"));
    } catch (e) {
      toast({ title: "Couldn't load inventory", description: (e as Error).message, variant: "destructive" });
    }
  }, [adminKey, api, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // The eBay sign-in callback lands on /?ebay=connected#/inventory.
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("ebay");
    if (!result) return;
    if (result === "connected") toast({ title: "eBay connected" });
    else toast({ title: "eBay connection failed", description: "Try Connect eBay again.", variant: "destructive" });
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }, [toast]);

  async function run(label: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(label);
    try {
      await fn();
      if (success) toast({ title: success });
      await load();
    } catch (e) {
      toast({ title: `${label} failed`, description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  if (!adminKey) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Inventory sync</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  sessionStorage.setItem(KEY_STORAGE, keyDraft);
                } catch {}
                setAdminKey(keyDraft);
              }}
            >
              <Input
                type="password"
                placeholder="Admin key"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                autoFocus
              />
              <Button type="submit" className="w-full" disabled={!keyDraft}>
                Open
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  const status = data?.status;
  const items = (data?.items ?? []).filter((i) =>
    `${i.sku} ${i.title}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Inventory sync</h1>
            <p className="text-sm text-muted-foreground">
              When a book sells on one marketplace, it comes down on the others. Orders are checked every minute.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => run("Check orders", () => api("POST", "/api/inventory/sync"), "Orders checked")}
            >
              {busy === "Check orders" ? "Checking…" : "Check orders now"}
            </Button>
            <Button
              disabled={!!busy}
              onClick={() =>
                run("Import", async () => {
                  const s = await api("POST", "/api/inventory/import");
                  toast({
                    title: "Listings imported",
                    description: `${s.matched} on both · ${s.whatnotOnly} Whatnot only · ${s.ebayOnly} eBay only`,
                  });
                })
              }
            >
              {busy === "Import" ? "Importing…" : "Import & match by SKU"}
            </Button>
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardContent className="flex items-center justify-between pt-6">
              <div>
                <div className="font-medium">Whatnot</div>
                <div className="text-sm text-muted-foreground">
                  {status?.whatnot
                    ? status.whatnotWebhook
                      ? "Token set · instant webhooks on"
                      : "Token set · checking every minute"
                    : "Set WHATNOT_API_TOKEN on the server"}
                </div>
              </div>
              <Badge variant={status?.whatnot ? "default" : "secondary"}>
                {status?.whatnot ? "Connected" : "Not set up"}
              </Badge>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between gap-3 pt-6">
              <div>
                <div className="font-medium">eBay</div>
                <div className="text-sm text-muted-foreground">
                  {status?.ebay
                    ? "Signed in · checking every minute"
                    : status?.ebayApp
                      ? "App keys set · sign in to finish"
                      : "Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME"}
                </div>
              </div>
              {status?.ebay ? (
                <Badge>Connected</Badge>
              ) : (
                <Button
                  size="sm"
                  disabled={!status?.ebayApp || !!busy}
                  onClick={() =>
                    run("Connect eBay", async () => {
                      const { url } = await api("POST", "/api/inventory/ebay/connect");
                      window.location.href = url;
                    })
                  }
                >
                  Connect eBay
                </Button>
              )}
            </CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Add or edit a book</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 sm:grid-cols-[1fr_2fr_90px_1fr_1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                run(
                  "Save",
                  () =>
                    api("POST", "/api/inventory/items", {
                      sku: form.sku,
                      title: form.title,
                      quantity: Number(form.quantity),
                      whatnotVariantId: form.whatnotVariantId || null,
                      ebayItemId: form.ebayItemId || null,
                    }).then(() => setForm(emptyForm)),
                  "Saved and pushed to marketplaces",
                );
              }}
            >
              <Input placeholder="SKU" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
              <Input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <Input
                type="number"
                min={0}
                placeholder="Qty"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
              <Input
                placeholder="Whatnot variant ID"
                value={form.whatnotVariantId}
                onChange={(e) => setForm({ ...form, whatnotVariantId: e.target.value })}
              />
              <Input
                placeholder="eBay item ID"
                value={form.ebayItemId}
                onChange={(e) => setForm({ ...form, ebayItemId: e.target.value })}
              />
              <Button type="submit" disabled={!form.sku || !form.title || !!busy}>
                Save
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              Easier: give each book the same SKU on Whatnot and as the eBay “Custom label”, then use Import &amp; match.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle className="text-lg">Books ({data?.items.length ?? 0})</CardTitle>
            <Input
              className="max-w-xs"
              placeholder="Search SKU or title"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">SKU</th>
                  <th className="py-2 pr-3 font-medium">Title</th>
                  <th className="py-2 pr-3 font-medium">Qty</th>
                  <th className="py-2 pr-3 font-medium">Whatnot</th>
                  <th className="py-2 pr-3 font-medium">eBay</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{item.sku}</td>
                    <td className="py-2 pr-3">{item.title}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={item.quantity > 0 ? "outline" : "secondary"}>
                        {item.quantity > 0 ? item.quantity : "Sold out"}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3">{item.whatnotVariantId ? "✓" : "—"}</td>
                    <td className="py-2 pr-3">
                      {item.ebayItemId ? (
                        <a
                          className="underline"
                          href={`https://www.ebay.com/itm/${item.ebayItemId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {item.ebayItemId}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setForm({
                            sku: item.sku,
                            title: item.title,
                            quantity: String(item.quantity),
                            whatnotVariantId: item.whatnotVariantId ?? "",
                            ebayItemId: item.ebayItemId ?? "",
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => run("Remove", () => api("DELETE", `/api/inventory/items/${item.id}`))}
                      >
                        Stop syncing
                      </Button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      No books yet. Connect the marketplaces, then Import &amp; match by SKU.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {(data?.events ?? []).map((ev) => (
                <li key={ev.id} className="flex gap-3">
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {new Date(ev.createdAt.includes("T") ? ev.createdAt : `${ev.createdAt}Z`).toLocaleString()}
                  </span>
                  <span
                    className={
                      ev.level === "error" ? "text-destructive" : ev.level === "warn" ? "text-amber-600" : undefined
                    }
                  >
                    {ev.message}
                    {ev.sku && <span className="ml-1 font-mono text-xs text-muted-foreground">{ev.sku}</span>}
                  </span>
                </li>
              ))}
              {data?.events.length === 0 && <li className="text-muted-foreground">Nothing yet.</li>}
            </ul>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
