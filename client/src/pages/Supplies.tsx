import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { isLowOnSupply } from "@shared/schema";
import type { Supply } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

// Admin page for shipping supplies. Not linked from the site; open /#/supplies
// and enter the ADMIN_KEY. Shares the inventory page's key for the session.

const KEY_STORAGE = "lmb-admin-key";
interface OrderSource {
  name: string;
  on: boolean;
  checkedAt: string | null;
  error: string | null;
  staleAfterMs: number; // no successful check in this long = something's wrong
}

function sourceStatus(s: OrderSource): { text: string; problem: boolean } {
  if (!s.on) return { text: "not set up", problem: false };
  if (s.error) return { text: "last check failed", problem: true };
  if (!s.checkedAt) return { text: "waiting for first check", problem: false };
  const ago = formatDistanceToNow(new Date(s.checkedAt), { addSuffix: true });
  const stale = Date.now() - new Date(s.checkedAt).getTime() > s.staleAfterMs;
  return { text: stale ? `no check since ${ago}` : `checked ${ago}`, problem: stale };
}

function readKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

const emptyForm = {
  name: "",
  quantity: "",
  reorderAt: "",
  reorderQuantity: "",
  usedPerOrder: "0",
  supplier: "",
  productUrl: "",
  unitCost: "",
};

function reorderCost(s: Supply): number | null {
  return s.unitCost === null ? null : s.unitCost * s.reorderQuantity;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function Supplies() {
  const { toast } = useToast();
  const [adminKey, setAdminKey] = useState(readKey);
  const [keyDraft, setKeyDraft] = useState("");
  const [rows, setRows] = useState<Supply[] | null>(null);
  const [sources, setSources] = useState<OrderSource[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);

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
      const data = await api("GET", "/api/supplies");
      setRows(data.supplies);
      setSources(data.sources);
    } catch (e) {
      toast({ title: "Couldn't load supplies", description: (e as Error).message, variant: "destructive" });
    }
  }, [adminKey, api, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

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

  function closeForm() {
    setForm(emptyForm);
    setEditingId(null);
    setFormOpen(false);
  }

  function openEdit(s: Supply) {
    setForm({
      name: s.name,
      quantity: String(s.quantity),
      reorderAt: String(s.reorderAt),
      reorderQuantity: String(s.reorderQuantity),
      usedPerOrder: String(s.usedPerOrder),
      supplier: s.supplier ?? "",
      productUrl: s.productUrl ?? "",
      unitCost: s.unitCost === null ? "" : String(s.unitCost),
    });
    setEditingId(s.id);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function save() {
    // Blank number boxes stay null so the server reports them, rather than 0.
    const count = (v: string) => (v.trim() === "" ? null : Number(v));
    const body = {
      name: form.name,
      quantity: count(form.quantity),
      reorderAt: count(form.reorderAt),
      reorderQuantity: count(form.reorderQuantity),
      usedPerOrder: count(form.usedPerOrder),
      supplier: form.supplier.trim() || null,
      productUrl: form.productUrl.trim() || null,
      unitCost: count(form.unitCost),
    };
    void run("Save", async () => {
      if (editingId === null) await api("POST", "/api/supplies", body);
      else await api("PUT", `/api/supplies/${editingId}`, body);
      closeForm();
    });
  }

  if (!adminKey) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Shipping supplies</CardTitle>
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

  const toBuy = (rows ?? []).filter((s) => isLowOnSupply(s) && !s.orderedAt);
  const total = toBuy.reduce((sum, s) => sum + (reorderCost(s) ?? 0), 0);
  const allPriced = toBuy.every((s) => s.unitCost !== null);

  const field = (key: keyof typeof emptyForm, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`supply-${key}`}>{label}</Label>
      <Input
        id={`supply-${key}`}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...props}
      />
    </div>
  );
  const wholeNumber = { type: "number", min: 0, step: 1, inputMode: "numeric" } as const;

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Shipping supplies</h1>
            <p className="text-sm text-muted-foreground">
              You get an email when something runs low. Buying is still up to you.
            </p>
          </div>
          {!formOpen && <Button onClick={() => setFormOpen(true)}>Add supply</Button>}
        </header>

        {sources.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Orders counted from:{" "}
            {sources.map((s, i) => {
              const status = sourceStatus(s);
              return (
                <span key={s.name}>
                  {i > 0 && " · "}
                  <span
                    className={status.problem ? "text-destructive" : undefined}
                    title={s.error ?? undefined}
                  >
                    {s.name} {status.text}
                  </span>
                </span>
              );
            })}
          </p>
        )}

        {formOpen && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{editingId === null ? "Add a supply" : `Edit ${form.name}`}</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save();
                }}
              >
                <div className="sm:col-span-2">{field("name", "Name", { placeholder: "6 x 9 bubble mailers" })}</div>
                {field("quantity", "In stock", wholeNumber)}
                {field("reorderAt", "Reorder when down to", wholeNumber)}
                {field("reorderQuantity", "How many to reorder", { ...wholeNumber, min: 1 })}
                {field("usedPerOrder", "Used per order (0 to count by hand)", wholeNumber)}
                {field("supplier", "Supplier (optional)")}
                {field("unitCost", "Cost each (optional)", { type: "number", min: 0, step: "0.01", inputMode: "decimal" })}
                <div className="sm:col-span-2">
                  {field("productUrl", "Link to buy it (optional)", { type: "url", placeholder: "https://" })}
                </div>
                <div className="flex gap-2 sm:col-span-2">
                  <Button type="submit" disabled={!!busy}>
                    {busy === "Save" ? "Saving…" : "Save"}
                  </Button>
                  <Button type="button" variant="ghost" onClick={closeForm}>
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {toBuy.length > 0 && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-lg">Reorder now ({toBuy.length})</CardTitle>
              {total > 0 && (
                <span className="text-sm text-muted-foreground">
                  {allPriced ? "About" : "At least"} {money(total)}
                </span>
              )}
            </CardHeader>
            <CardContent className="divide-y">
              {toBuy.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {s.quantity} left · buy {s.reorderQuantity}
                      {s.supplier && ` from ${s.supplier}`}
                      {reorderCost(s) !== null && ` · ${money(reorderCost(s)!)}`}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {s.productUrl && (
                      <Button asChild size="sm" variant="outline">
                        <a href={s.productUrl} target="_blank" rel="noreferrer">
                          Buy
                        </a>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={!!busy}
                      onClick={() => run("Mark ordered", () => api("POST", `/api/supplies/${s.id}/order`))}
                    >
                      Mark ordered
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">All supplies ({rows?.length ?? 0})</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {(rows ?? []).map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {s.orderedAt ? (
                      <Badge variant="secondary">{s.orderedQuantity} on order</Badge>
                    ) : isLowOnSupply(s) ? (
                      <Badge variant="destructive">Low</Badge>
                    ) : null}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Reorders at {s.reorderAt}
                    {s.usedPerOrder > 0 ? ` · ${s.usedPerOrder} per order` : " · counted by hand"}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`One less ${s.name}`}
                    disabled={!!busy || s.quantity === 0}
                    onClick={() => run("Update", () => api("POST", `/api/supplies/${s.id}/adjust`, { by: -1 }))}
                  >
                    −
                  </Button>
                  <span className="w-12 text-center font-medium tabular-nums">{s.quantity}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`One more ${s.name}`}
                    disabled={!!busy}
                    onClick={() => run("Update", () => api("POST", `/api/supplies/${s.id}/adjust`, { by: 1 }))}
                  >
                    +
                  </Button>
                  {s.orderedAt && (
                    <>
                      <Button
                        size="sm"
                        className="ml-2"
                        disabled={!!busy}
                        onClick={() => run("Received", () => api("POST", `/api/supplies/${s.id}/receive`))}
                      >
                        Received
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => run("Cancel order", () => api("DELETE", `/api/supplies/${s.id}/order`))}
                      >
                        Cancel order
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => openEdit(s)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => {
                      if (window.confirm(`Remove ${s.name}?`)) {
                        void run("Remove", () => api("DELETE", `/api/supplies/${s.id}`));
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            {rows?.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No supplies yet. Add your mailers, tape and labels to start tracking them.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
