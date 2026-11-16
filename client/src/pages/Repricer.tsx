import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { forgetAdminKey, readAdminKey, saveAdminKey } from "@/lib/adminKey";
import { CONDITION_LABELS, effectiveMinMax, normalizeCondition } from "@shared/repricer";
import type { MinMaxSource, RepricerChange, RepricerJob, RepricerListing, RepricerSettings } from "@shared/repricer";

// Admin page for the Amazon repricer. Not linked from the site; open
// /#/repricer and enter the ADMIN_KEY (shared with the other admin pages).

const SHOWN = 200;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "change", label: "Will change" },
  { key: "atMin", label: "Held at min" },
  { key: "none", label: "No competition" },
  { key: "buyBox", label: "Have Buy Box" },
  { key: "problem", label: "Problems" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const SOURCE_LABELS: Record<MinMaxSource, string> = {
  manual: "set by hand",
  new: "new listing",
  file: "from file",
  default: "default",
};

function money(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
}

const willChange = (l: RepricerListing) => l.targetPrice !== null && Math.abs(l.targetPrice - l.price) >= 0.01;
const isProblem = (l: RepricerListing) =>
  l.status !== null && /failed|isn't repriced|is above max/i.test(l.status);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  step = "0.01",
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min="0"
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function MinMaxEditor({
  listing,
  settings,
  onSave,
}: {
  listing: RepricerListing;
  settings: RepricerSettings;
  onSave: (min: number | null, max: number | null) => Promise<void>;
}) {
  const range = effectiveMinMax(listing, settings);
  const [editing, setEditing] = useState(false);
  const [min, setMin] = useState(String(range.min));
  const [max, setMax] = useState(String(range.max));

  if (!editing) {
    return (
      <button
        type="button"
        className="text-left hover:underline"
        onClick={() => {
          setMin(String(range.min));
          setMax(String(range.max));
          setEditing(true);
        }}
      >
        <span className="tabular-nums">
          {money(range.min)}–{money(range.max)}
        </span>
        <span className="block text-xs text-muted-foreground">{SOURCE_LABELS[range.source]}</span>
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(Number(min), Number(max)).then(() => setEditing(false));
      }}
    >
      <Input className="h-8 w-20" type="number" step="0.01" aria-label="Min" value={min} onChange={(e) => setMin(e.target.value)} />
      <Input className="h-8 w-20" type="number" step="0.01" aria-label="Max" value={max} onChange={(e) => setMax(e.target.value)} />
      <Button size="sm" type="submit">
        Save
      </Button>
      {listing.minMaxSource === "manual" && (
        <Button size="sm" type="button" variant="ghost" onClick={() => void onSave(null, null).then(() => setEditing(false))}>
          Automatic
        </Button>
      )}
      <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}

export default function Repricer() {
  const { toast } = useToast();
  const [adminKey, setAdminKey] = useState(readAdminKey);
  const [keyDraft, setKeyDraft] = useState("");
  const [configured, setConfigured] = useState(true);
  const [settings, setSettings] = useState<RepricerSettings | null>(null);
  const [draft, setDraft] = useState<RepricerSettings | null>(null);
  const [job, setJob] = useState<RepricerJob | null>(null);
  const [listings, setListings] = useState<RepricerListing[]>([]);
  const [changes, setChanges] = useState<RepricerChange[]>([]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const api = useCallback(
    async (method: string, url: string, body?: unknown) => {
      const res = await fetch(url, {
        method,
        headers: { "x-admin-key": adminKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401) {
        setAdminKey("");
        forgetAdminKey();
        throw new Error("Wrong admin key");
      }
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (!res.ok) throw new Error(json?.error ?? text ?? `Request failed (${res.status})`);
      return json;
    },
    [adminKey],
  );

  const load = useCallback(async () => {
    if (!adminKey) return;
    try {
      const data = await api("GET", "/api/repricer");
      setConfigured(data.configured);
      setSettings(data.settings);
      setDraft((d) => d ?? data.settings);
      setJob(data.job);
      setListings(data.listings);
      setChanges(data.changes);
    } catch (e) {
      toast({ title: "Couldn't load the repricer", description: (e as Error).message, variant: "destructive" });
    }
  }, [adminKey, api, toast]);

  // Checks every 10 seconds during a run.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), job?.running ? 10_000 : 60_000);
    return () => clearInterval(t);
  }, [load, job?.running]);

  async function runNow() {
    try {
      setJob(await api("POST", "/api/repricer/run"));
    } catch (e) {
      toast({ title: "Couldn't start", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function saveSettings(next: RepricerSettings, message?: string) {
    try {
      const saved = await api("PUT", "/api/repricer/settings", next);
      setSettings(saved);
      setDraft(saved);
      toast({ title: message ?? "Settings saved" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function saveMinMax(sku: string, min: number | null, max: number | null) {
    try {
      const updated: RepricerListing = await api("PUT", `/api/repricer/listings/${encodeURIComponent(sku)}/minmax`, { min, max });
      setListings((ls) => ls.map((l) => (l.sku === sku ? updated : l)));
      toast({ title: min === null ? "Back to the automatic min/max" : "Min/max saved", description: "Used from the next check." });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
      throw e;
    }
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const res = await fetch("/api/repricer/minmax", {
        method: "POST",
        headers: { "x-admin-key": adminKey, "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      toast({
        title: `Min/max loaded for ${json.updated + json.added} books`,
        description: [
          json.keptManual ? `${json.keptManual} set by hand were kept.` : "",
          json.skipped ? `${json.skipped} rows had no usable min/max.` : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined,
      });
      await load();
    } catch (e) {
      toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  const counts = useMemo(
    () => ({
      change: listings.filter(willChange).length,
      atMin: listings.filter((l) => l.status?.startsWith("At min")).length,
      none: listings.filter((l) => l.status?.startsWith("No competition")).length,
      buyBox: listings.filter((l) => l.hasBuyBox).length,
      problem: listings.filter(isProblem).length,
    }),
    [listings],
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return listings
      .filter((l) => {
        if (filter === "change") return willChange(l);
        if (filter === "atMin") return l.status?.startsWith("At min");
        if (filter === "none") return l.status?.startsWith("No competition");
        if (filter === "buyBox") return l.hasBuyBox;
        if (filter === "problem") return isProblem(l);
        return true;
      })
      .filter((l) => !q || l.title.toLowerCase().includes(q) || l.sku.toLowerCase().includes(q) || l.asin.toLowerCase().includes(q));
  }, [listings, filter, search]);

  if (!adminKey) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Amazon repricer</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveAdminKey(keyDraft);
                setAdminKey(keyDraft);
              }}
            >
              <Input type="password" placeholder="Admin key" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} autoFocus />
              <Button type="submit" className="w-full" disabled={!keyDraft}>
                Open
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  const on = settings?.enabled ?? false;
  const lastChecked = listings.reduce<string | null>((a, l) => (l.checkedAt && (!a || l.checkedAt > a) ? l.checkedAt : a), null);
  const set = <K extends keyof RepricerSettings>(k: K, v: RepricerSettings[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = draft && settings && JSON.stringify({ ...draft, enabled: settings.enabled }) !== JSON.stringify(settings);

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Amazon repricer</h1>
            <p className="text-sm text-muted-foreground">
              {job?.running
                ? `${job.step ?? "Working"}… started ${formatDistanceToNow(new Date(job.startedAt!), { addSuffix: true })}.`
                : lastChecked
                  ? `Last checked ${formatDistanceToNow(new Date(lastChecked), { addSuffix: true })}.`
                  : "Not checked yet. A check takes about 10 minutes for 1,000 books."}
            </p>
          </div>
          <Button onClick={runNow} disabled={!configured || job?.running}>
            {job?.running ? "Checking…" : on ? "Check and reprice now" : "Check now"}
          </Button>
        </header>

        {!configured && (
          <p className="text-sm text-destructive">Amazon listing isn't set up on the server (AMAZON_SELLER_ID and the Amazon keys).</p>
        )}
        {job?.error && <p className="text-sm text-destructive">Last check failed: {job.error}</p>}

        <Card className={on ? "border-primary" : undefined}>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
            <div className="text-sm">
              <div className="font-medium">{on ? "On: changing prices on Amazon" : "Off: showing what it would do"}</div>
              <div className="text-muted-foreground">
                {on
                  ? `Checks every ${settings!.intervalHours} hour${settings!.intervalHours === 1 ? "" : "s"} and sends new prices to Amazon.`
                  : "Turn off SmartRepricer before switching this on, or the two will keep changing each other's prices."}
              </div>
            </div>
            <Switch
              checked={on}
              disabled={!settings || !configured}
              aria-label="Change prices on Amazon"
              onCheckedChange={(v) =>
                settings && void saveSettings({ ...settings, enabled: v }, v ? "Repricer is on" : "Repricer is off")
              }
            />
          </CardContent>
        </Card>

        {job?.finishedAt && !job.running && !job.error && (
          <p className="text-sm text-muted-foreground">
            Last run checked {job.checked} books and {on ? `changed ${job.changed - job.failed}` : `would change ${job.changed}`}
            {job.failed ? `; ${job.failed} failed` : ""}.
          </p>
        )}

        <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
          <Stat label="Books" value={String(listings.length)} hint="you ship yourself, for sale" />
          <Stat label={on ? "Changing next" : "Would change"} value={String(counts.change)} />
          <Stat label="Held at min" value={String(counts.atMin)} hint="a seller is below your min" />
          <Stat label="No competition" value={String(counts.none)} />
          <Stat
            label="Buy Box"
            value={listings.length ? `${Math.round((counts.buyBox / listings.length) * 100)}%` : "—"}
            hint={`${counts.buyBox} books`}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Books</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {FILTERS.map((f) => (
                <Button key={f.key} size="sm" variant={filter === f.key ? "default" : "outline"} onClick={() => setFilter(f.key)}>
                  {f.label}
                  {f.key !== "all" && <span className="ml-1 tabular-nums opacity-70">{counts[f.key]}</span>}
                </Button>
              ))}
              <Input
                className="ml-auto w-full sm:w-64"
                placeholder="Search title, SKU or ASIN"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {listings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No books yet. Press Check now to read your listings from Amazon.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr className="border-b">
                      <th className="py-2 pr-3 font-medium">Book</th>
                      <th className="py-2 pr-3 font-medium">Your price</th>
                      <th className="py-2 pr-3 font-medium">Lowest seller</th>
                      <th className="py-2 pr-3 font-medium">New price</th>
                      <th className="py-2 pr-3 font-medium">Min–max</th>
                      <th className="py-2 font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.slice(0, SHOWN).map((l) => {
                      const cond = normalizeCondition(l.condition);
                      return (
                        <tr key={l.sku} className="border-b align-top">
                          <td className="py-2 pr-3">
                            <a
                              className="line-clamp-2 max-w-xs hover:underline"
                              href={`https://www.amazon.com/dp/${l.asin}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {l.title}
                            </a>
                            <div className="text-xs text-muted-foreground">
                              {cond ? CONDITION_LABELS[cond] : "Other condition"} · {l.sku}
                            </div>
                          </td>
                          <td className="py-2 pr-3 tabular-nums">
                            {money(l.price)}
                            <div className="text-xs text-muted-foreground">+ {money(l.myShipping ?? settings?.myShipping)} ship</div>
                          </td>
                          <td className="py-2 pr-3 tabular-nums">
                            {l.competitorPrice === null ? (
                              "—"
                            ) : (
                              <>
                                {money(l.competitorPrice)}
                                <div className="text-xs text-muted-foreground">
                                  {l.competitorLabel}, with shipping
                                  {l.competitors && l.competitors > 1 ? ` · ${l.competitors} sellers` : ""}
                                </div>
                              </>
                            )}
                          </td>
                          <td className="py-2 pr-3 tabular-nums">
                            {willChange(l) ? (
                              <span className={l.targetPrice! < l.price ? "text-red-600" : "text-green-700"}>
                                {money(l.targetPrice)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">no change</span>
                            )}
                            {l.hasBuyBox && <div className="text-xs text-green-700">Buy Box</div>}
                          </td>
                          <td className="py-2 pr-3">
                            {settings && <MinMaxEditor listing={l} settings={settings} onSave={(mn, mx) => saveMinMax(l.sku, mn, mx)} />}
                          </td>
                          <td className="py-2 text-muted-foreground">{l.status ?? "Not checked yet"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {shown.length > SHOWN && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing {SHOWN} of {shown.length}. Search to find a book.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          {draft && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Rules</CardTitle>
              </CardHeader>
              <CardContent>
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveSettings({ ...draft, enabled: settings!.enabled });
                  }}
                >
                  <p className="text-sm text-muted-foreground">
                    Each book matches the cheapest other seller who ships their own copy in the same or better condition,
                    shipping included, and stays within its min and max.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <NumberField id="defaultMin" label="Default min" value={draft.defaultMin} onChange={(n) => set("defaultMin", n)} />
                    <NumberField id="defaultMax" label="Default max" value={draft.defaultMax} onChange={(n) => set("defaultMax", n)} />
                    <NumberField
                      id="newBookDays"
                      label="New listings: days"
                      step="1"
                      value={draft.newBookDays}
                      onChange={(n) => set("newBookDays", n)}
                      hint="0 turns this off"
                    />
                    <NumberField
                      id="newBookPercent"
                      label="New listings: stay within %"
                      step="1"
                      value={draft.newBookPercent}
                      onChange={(n) => set("newBookPercent", n)}
                      hint="of the price it was listed at"
                    />
                    <NumberField
                      id="myShipping"
                      label="Your shipping charge"
                      value={draft.myShipping}
                      onChange={(n) => set("myShipping", n)}
                      hint="used when Amazon doesn't show your offer"
                    />
                    <NumberField
                      id="minFeedback"
                      label="Ignore sellers rated below %"
                      step="1"
                      value={draft.minFeedbackPercent}
                      onChange={(n) => set("minFeedbackPercent", n)}
                      hint="0 compares with everyone"
                    />
                    <NumberField
                      id="interval"
                      label="Check every (hours)"
                      step="1"
                      value={draft.intervalHours}
                      onChange={(n) => set("intervalHours", n)}
                    />
                    <div className="space-y-1">
                      <Label htmlFor="noCompetition">With no competition</Label>
                      <select
                        id="noCompetition"
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={draft.noCompetition}
                        onChange={(e) => set("noCompetition", e.target.value as RepricerSettings["noCompetition"])}
                      >
                        <option value="keep">Keep the price</option>
                        <option value="max">Go to max</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch id="fba" checked={draft.competeWithFba} onCheckedChange={(v) => set("competeWithFba", v)} />
                    <Label htmlFor="fba">Also match FBA sellers</Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Order used for each book's min/max: set by hand here, then the new-listing range, then the SmartRepricer
                    file, then the defaults.
                  </p>
                  <Button type="submit" disabled={!dirty}>
                    Save rules
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}

          <div className="space-y-6">
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                <div className="text-sm">
                  <div className="font-medium">Min/max from SmartRepricer</div>
                  <div className="text-muted-foreground">
                    Upload SmartRepricer's inventory export (.xlsx or .csv) to copy each book's min and max. A min/max
                    you set by hand here is kept.
                  </div>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.csv,.tsv,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void upload(file);
                  }}
                />
                <Button variant="secondary" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? "Uploading…" : "Upload file"}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Price changes</CardTitle>
              </CardHeader>
              <CardContent>
                {changes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None yet. Changes appear here once the repricer is on.</p>
                ) : (
                  <ul className="max-h-96 space-y-2 overflow-y-auto text-sm">
                    {changes.map((c) => (
                      <li key={c.id} className="border-b pb-2">
                        <div className="flex justify-between gap-3">
                          <span className="truncate">{c.title}</span>
                          <span className="shrink-0 tabular-nums">
                            {money(c.oldPrice)} → {money(c.newPrice)}
                          </span>
                        </div>
                        <div className={`text-xs ${c.error ? "text-destructive" : "text-muted-foreground"}`}>
                          {c.error ?? c.reason} · {formatDistanceToNow(new Date(`${c.createdAt.replace(" ", "T")}${c.createdAt.endsWith("Z") ? "" : "Z"}`), { addSuffix: true })}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
