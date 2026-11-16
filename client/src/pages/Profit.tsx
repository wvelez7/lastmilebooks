import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { forgetAdminKey, readAdminKey, saveAdminKey } from "@/lib/adminKey";
import { localDay, summarizeListed, summarizeProfit } from "@shared/profitReport";
import type {
  AccountCharge,
  ListedFeeRates,
  ListedInventory,
  ListedSummary,
  ListedTotals,
  ProfitPlatform,
  ProfitRow,
  ProfitSettings,
  ProfitTotals,
} from "@shared/profitReport";
import AdminNav from "@/components/AdminNav";

// Admin page for profit across Amazon and eBay. Not linked from the site; open
// /#/profit and enter the ADMIN_KEY (shared with the other admin pages).

interface Job {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  notes: string[];
}

interface ProfitData {
  amazonConnected: boolean;
  ebayConnected: boolean;
  job: Job;
  settings: ProfitSettings;
  suppliesPerOrder: number | null;
  rows: ProfitRow[];
  charges: AccountCharge[];
  listed?: ListedInventory; // missing until the server is updated
  scan: ListedFeeRates;
}

type PeriodId = "month" | "lastMonth" | "30" | "90" | "year" | "12m";

const PERIODS: { id: PeriodId; label: string }[] = [
  { id: "month", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
  { id: "year", label: "This year" },
  { id: "12m", label: "12 months" },
];

function periodRange(id: PeriodId): { from: string; to: string } {
  const now = new Date();
  const today = localDay(now);
  const daysAgo = (n: number) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  switch (id) {
    case "month":
      return { from: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case "lastMonth":
      return {
        from: localDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: localDay(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    case "30":
      return { from: daysAgo(29), to: today };
    case "90":
      return { from: daysAgo(89), to: today };
    case "year":
      return { from: `${now.getFullYear()}-01-01`, to: today };
    case "12m":
      return { from: localDay(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)), to: today };
  }
}

function money(n: number): string {
  const s = `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return n < 0 ? `−${s}` : s;
}

function shortMoney(n: number): string {
  return Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`;
}

const PLATFORM_LABEL: Record<ProfitPlatform, string> = { amazon: "Amazon", ebay: "eBay" };

// Series colors, light and dark, from the validated categorical palette
// (slot 1 blue, slot 2 orange).
const CHART_STYLE = `
.profit-viz { --series-amazon: #2a78d6; --series-ebay: #eb6834; }
@media (prefers-color-scheme: dark) { .profit-viz { --series-amazon: #3987e5; --series-ebay: #d95926; } }
.dark .profit-viz { --series-amazon: #3987e5; --series-ebay: #d95926; }
`;

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === "bad" ? "text-destructive" : tone === "good" ? "text-green-700 dark:text-green-400" : ""
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value.toFixed(2));
  useEffect(() => setDraft(value.toFixed(2)), [value]);
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <Input
          id={id}
          inputMode="decimal"
          className="pl-6 tabular-nums"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            if (Number.isFinite(n) && n >= 0) onChange(Math.round(n * 100) / 100);
            else setDraft(value.toFixed(2));
          }}
        />
      </div>
    </div>
  );
}

function ago(iso: string | null): string {
  return iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : "not yet";
}

// What everything listed right now would bring in if it all sold at its
// listed price. Doesn't follow the period buttons: it's a snapshot.
function ListedSection({
  listed,
  summary,
  platform,
}: {
  listed: ListedInventory;
  summary: ListedSummary;
  platform: ProfitPlatform | "all";
}) {
  const t = summary.total;
  const platforms: ProfitPlatform[] = platform === "all" ? ["amazon", "ebay"] : [platform];
  const maxBand = Math.max(1, ...summary.priceBands.map((b) => b.value));
  const row = (label: string, p: ListedTotals, bold = false) => (
    <tr key={label} className={bold ? "border-t-2 font-semibold" : "border-t"}>
      <td className="py-1.5 pr-3">{label}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{p.books.toLocaleString()}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap">{money(p.value)}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap text-muted-foreground">{money(-p.fees)}</td>
      <td className={`py-1.5 text-right tabular-nums whitespace-nowrap ${p.profit < 0 ? "text-destructive" : ""}`}>
        {money(p.profit)}
      </td>
    </tr>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Listed inventory</CardTitle>
        <p className="text-sm text-muted-foreground">
          What everything listed right now is worth if it all sells at its listed price. Doesn't change with the period
          buttons. Amazon listings updated {ago(listed.amazonAt)}, eBay {ago(listed.ebayAt)}.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <Stat label="Books listed" value={t.books.toLocaleString()} hint={`${t.listings.toLocaleString()} listings`} />
          <Stat label="Listed value" value={money(t.value)} hint={t.books ? `average ${money(t.value / t.books)}` : undefined} />
          <Stat
            label="Profit if it all sells"
            value={money(t.profit)}
            tone={t.profit < 0 ? "bad" : t.profit > 0 ? "good" : undefined}
            hint="after fees and your costs"
          />
          <Stat
            label="Would lose money"
            value={t.losing.toLocaleString()}
            tone={t.losing > 0 ? "bad" : undefined}
            hint="listings priced below your costs"
          />
        </div>

        <div className="grid gap-6 md:grid-cols-5">
          <div className="overflow-x-auto md:col-span-3">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-normal" />
                  <th className="py-1 pr-3 font-normal text-right">Books</th>
                  <th className="py-1 pr-3 font-normal text-right">Value</th>
                  <th className="py-1 pr-3 font-normal text-right">Fees</th>
                  <th className="py-1 font-normal text-right">Profit</th>
                </tr>
              </thead>
              <tbody>
                {platform === "all" ? (
                  <>
                    {row("Amazon (all)", summary.byPlatform.amazon)}
                    {row("eBay (not on Amazon)", summary.byPlatform.ebay)}
                    {row("Total", t, true)}
                  </>
                ) : (
                  platforms.map((p) => row(PLATFORM_LABEL[p], summary.byPlatform[p]))
                )}
              </tbody>
            </table>
            {platform === "all" && (
              <p className="mt-2 text-xs text-muted-foreground">
                {summary.crossListed.toLocaleString()} eBay listing{summary.crossListed === 1 ? " is" : "s are"} left out
                because the same book is on Amazon (same SKU, same ISBN, or linked on /#/inventory).
              </p>
            )}
          </div>
          <div className="md:col-span-2">
            <div className="mb-2 text-sm text-muted-foreground">Value by listed price</div>
            <ul className="space-y-2">
              {summary.priceBands.map((b) => (
                <li key={b.label} className="text-sm">
                  <div className="flex justify-between gap-3">
                    <span>{b.label}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {money(b.value)} · {b.books.toLocaleString()} books
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded bg-muted">
                    <div className="h-2 rounded bg-primary" style={{ width: `${(b.value / maxBand) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Fees use your rates on /#/scan; postage, supplies and cost per book come from Your costs below. Whatnot
          listings aren't included.
        </p>
      </CardContent>
    </Card>
  );
}

const BREAKDOWN:{ key: keyof ProfitTotals; label: string; minus: boolean; hint?: string }[] = [
  { key: "sales", label: "Sales (book + shipping paid)", minus: false },
  { key: "fees", label: "Marketplace fees", minus: true },
  { key: "refunds", label: "Refunds", minus: true },
  { key: "postage", label: "Postage", minus: true, hint: "estimate" },
  { key: "supplies", label: "Supplies", minus: true, hint: "estimate" },
  { key: "bookCost", label: "Cost of books", minus: true, hint: "estimate" },
  { key: "otherCharges", label: "Other charges (subscription, ads…)", minus: true },
];

export default function Profit() {
  const { toast } = useToast();
  const [adminKey, setAdminKey] = useState(readAdminKey);
  const [keyDraft, setKeyDraft] = useState("");
  const [data, setData] = useState<ProfitData | null>(null);
  const [period, setPeriod] = useState<PeriodId>("month");
  const [platform, setPlatform] = useState<ProfitPlatform | "all">("all");
  const [search, setSearch] = useState("");
  const [showAllBooks, setShowAllBooks] = useState(false);

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
      if (!res.ok) {
        let message = text;
        try {
          message = JSON.parse(text).error ?? text;
        } catch {}
        throw new Error(message || `Request failed (${res.status})`);
      }
      return JSON.parse(text);
    },
    [adminKey],
  );

  const load = useCallback(async () => {
    if (!adminKey) return;
    try {
      setData(await api("GET", "/api/profit"));
    } catch (e) {
      toast({ title: "Couldn't load profit", description: (e as Error).message, variant: "destructive" });
    }
  }, [adminKey, api, toast]);

  const running = data?.job.running ?? false;
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), running ? 5_000 : 120_000);
    return () => clearInterval(t);
  }, [load, running]);

  async function refresh() {
    try {
      const job = await api("POST", "/api/profit/refresh");
      setData((d) => (d ? { ...d, job } : d));
    } catch (e) {
      toast({ title: "Refresh failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function saveSettings(next: ProfitSettings) {
    setData((d) => (d ? { ...d, settings: next } : d));
    try {
      await api("PUT", "/api/profit/settings", next);
    } catch (e) {
      toast({ title: "Couldn't save costs", description: (e as Error).message, variant: "destructive" });
      void load();
    }
  }

  const range = periodRange(period);
  const summary = useMemo(() => {
    if (!data) return null;
    const supplies = data.settings.suppliesPerOrder ?? data.suppliesPerOrder ?? 0;
    return summarizeProfit(data.rows, data.charges, data.settings, supplies, range.from, range.to, platform);
  }, [data, range.from, range.to, platform]);
  const listedSummary = useMemo(() => {
    if (!data?.listed) return null;
    const supplies = data.settings.suppliesPerOrder ?? data.suppliesPerOrder ?? 0;
    return summarizeListed(data.listed, data.settings, supplies, data.scan, platform);
  }, [data, platform]);

  if (!adminKey) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Profit</CardTitle>
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

  const job = data?.job;
  const t = summary?.total;
  const margin = t && t.sales > 0 ? t.profit / t.sales : null;
  const platforms: ProfitPlatform[] = platform === "all" ? ["amazon", "ebay"] : [platform];
  const labelCharges = summary?.charges.some((c) => c.platform === "amazon" && /label|shipping/i.test(c.description));
  const needle = search.trim().toLowerCase();
  const books = (summary?.books ?? []).filter(
    (b) => !needle || b.title.toLowerCase().includes(needle) || b.sku.toLowerCase().includes(needle),
  );
  const shownBooks = showAllBooks || needle ? books : [...books.slice(0, 10), ...books.slice(10).filter((b) => b.profit < 0).slice(-5)];

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <style>{CHART_STYLE}</style>
      <div className="mx-auto max-w-5xl space-y-6">
        <AdminNav />
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Profit</h1>
            <p className="text-sm text-muted-foreground">
              {running
                ? `Pulling sales from Amazon and eBay, started ${formatDistanceToNow(new Date(job!.startedAt!), { addSuffix: true })}. The first pull covers a year and can take several minutes.`
                : job?.finishedAt
                  ? `Updated ${formatDistanceToNow(new Date(job.finishedAt), { addSuffix: true })}. Updates on its own twice a day.`
                  : "Not pulled yet. The first pull covers the last 12 months."}
            </p>
          </div>
          <Button onClick={refresh} disabled={running || !data || (!data.amazonConnected && !data.ebayConnected)}>
            {running ? "Pulling…" : "Pull latest"}
          </Button>
        </header>

        {data && !data.amazonConnected && <p className="text-sm text-destructive">Amazon isn't connected on the server.</p>}
        {data && !data.ebayConnected && <p className="text-sm text-destructive">eBay isn't connected. Connect it on /#/inventory.</p>}
        {job?.error && <p className="text-sm text-destructive">{job.error}</p>}
        {job && job.notes.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {job.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {PERIODS.map((p) => (
              <Button key={p.id} size="sm" variant={period === p.id ? "default" : "outline"} onClick={() => setPeriod(p.id)}>
                {p.label}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            {(["all", "amazon", "ebay"] as const).map((p) => (
              <Button key={p} size="sm" variant={platform === p ? "default" : "outline"} onClick={() => setPlatform(p)}>
                {p === "all" ? "Both" : PLATFORM_LABEL[p]}
              </Button>
            ))}
          </div>
        </div>

        {t && (
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            <Stat
              label="Profit"
              value={money(t.profit)}
              tone={t.profit < 0 ? "bad" : t.profit > 0 ? "good" : undefined}
              hint={margin === null ? "no sales yet" : `${(margin * 100).toFixed(0)}% of sales`}
            />
            <Stat label="Sales" value={money(t.sales)} hint={`${t.units} books · ${t.orders} orders`} />
            <Stat
              label="Profit per book"
              value={t.units ? money(t.profit / t.units) : "—"}
              hint={t.units ? `average sale ${money(t.sales / t.units)}` : undefined}
            />
            <Stat
              label="Fees + refunds"
              value={money(t.fees + t.refunds)}
              hint={t.sales > 0 ? `${(((t.fees + t.refunds) / t.sales) * 100).toFixed(0)}% of sales` : undefined}
            />
          </div>
        )}

        {summary && t && (
          <div className="grid gap-6 md:grid-cols-5">
            <Card className="md:col-span-3">
              <CardHeader>
                <CardTitle className="text-lg">
                  Profit by {summary.bucketSize === "day" ? "day" : summary.bucketSize === "week" ? "week" : "month"}
                </CardTitle>
              </CardHeader>
              <CardContent className="profit-viz h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={summary.buckets} stackOffset="sign" barCategoryGap="20%">
                    <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      fontSize={12}
                      stroke="hsl(var(--muted-foreground))"
                      interval="preserveStartEnd"
                      minTickGap={12}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      fontSize={12}
                      width={48}
                      stroke="hsl(var(--muted-foreground))"
                      tickFormatter={shortMoney}
                    />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip
                      cursor={{ fill: "hsl(var(--muted))", opacity: 0.6 }}
                      contentStyle={{
                        background: "hsl(var(--background))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 13,
                        color: "hsl(var(--foreground))",
                      }}
                      formatter={(v: number, name: string) => [money(v), name]}
                    />
                    {platforms.length > 1 && <Legend iconType="square" wrapperStyle={{ fontSize: 13 }} />}
                    {platforms.map((p, i) => (
                      <Bar
                        key={p}
                        dataKey={p}
                        name={PLATFORM_LABEL[p]}
                        stackId="profit"
                        fill={`var(--series-${p})`}
                        stroke="hsl(var(--card))"
                        strokeWidth={1}
                        radius={i === platforms.length - 1 ? [4, 4, 0, 0] : 0}
                        maxBarSize={36}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle className="text-lg">Where the money went</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-2 font-normal" />
                      {platform === "all" && (
                        <>
                          <th className="py-1 pr-2 font-normal text-right">Amazon</th>
                          <th className="py-1 pr-2 font-normal text-right">eBay</th>
                        </>
                      )}
                      <th className="py-1 font-normal text-right">{platform === "all" ? "Total" : ""}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BREAKDOWN.map((b) => (
                      <tr key={b.key} className="border-t">
                        <td className="py-1.5 pr-2">
                          {b.label}
                          {b.hint && <span className="text-xs text-muted-foreground"> · {b.hint}</span>}
                        </td>
                        {platform === "all" && (
                          <>
                            <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                              {money((b.minus ? -1 : 1) * summary.byPlatform.amazon[b.key])}
                            </td>
                            <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                              {money((b.minus ? -1 : 1) * summary.byPlatform.ebay[b.key])}
                            </td>
                          </>
                        )}
                        <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money((b.minus ? -1 : 1) * t[b.key])}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 font-semibold">
                      <td className="py-1.5 pr-2">Profit</td>
                      {platform === "all" && (
                        <>
                          <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">{money(summary.byPlatform.amazon.profit)}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">{money(summary.byPlatform.ebay.profit)}</td>
                        </>
                      )}
                      <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money(t.profit)}</td>
                    </tr>
                  </tbody>
                </table>
                {summary.feesEstimated > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Fees on {summary.feesEstimated} order line{summary.feesEstimated > 1 ? "s" : ""} are worked out from
                    your fee rates on /#/scan until the marketplace posts the real ones (Amazon: about a week after
                    delivery).
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {data?.listed && listedSummary && (
          <ListedSection listed={data.listed} summary={listedSummary} platform={platform} />
        )}

        {data && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Your costs</CardTitle>
              <p className="text-sm text-muted-foreground">
                Amazon and eBay don't know these, so set what's typical. Postage and supplies count once per order you ship
                yourself (not FBA).
              </p>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
              <NumberField
                id="book-cost"
                label="Cost per book"
                value={data.settings.bookCost}
                onChange={(n) => saveSettings({ ...data.settings, bookCost: n })}
              />
              <NumberField
                id="amazon-postage"
                label="Postage per Amazon order"
                value={data.settings.amazonPostage}
                onChange={(n) => saveSettings({ ...data.settings, amazonPostage: n })}
              />
              <NumberField
                id="ebay-postage"
                label="Postage per eBay order"
                value={data.settings.ebayPostage}
                onChange={(n) => saveSettings({ ...data.settings, ebayPostage: n })}
              />
              <div className="space-y-1">
                <NumberField
                  id="supplies"
                  label="Supplies per order"
                  value={data.settings.suppliesPerOrder ?? data.suppliesPerOrder ?? 0}
                  disabled={data.settings.suppliesPerOrder === null}
                  onChange={(n) => saveSettings({ ...data.settings, suppliesPerOrder: n })}
                />
                <div className="flex items-center gap-2 pt-1">
                  <Switch
                    id="supplies-auto"
                    checked={data.settings.suppliesPerOrder === null}
                    onCheckedChange={(on) =>
                      saveSettings({ ...data.settings, suppliesPerOrder: on ? null : (data.suppliesPerOrder ?? 0) })
                    }
                  />
                  <Label htmlFor="supplies-auto" className="text-xs font-normal text-muted-foreground">
                    {data.suppliesPerOrder === null ? "From /#/supplies (no unit costs yet)" : "From /#/supplies"}
                  </Label>
                </div>
              </div>
              {labelCharges && data.settings.amazonPostage > 0 && (
                <p className="text-sm sm:col-span-2 md:col-span-4">
                  Amazon shipping-label charges show under other charges below. If you buy all your Amazon labels there, set
                  postage per Amazon order to $0 so they aren't counted twice.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {summary && (
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-lg">By book</CardTitle>
              <Input
                className="w-full sm:w-64"
                placeholder="Search title or SKU"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {books.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sales in this period.</p>
              ) : (
                <>
                  <table className="w-full text-sm">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-4 font-normal">Book</th>
                        <th className="py-1 pr-4 font-normal">Where</th>
                        <th className="py-1 pr-4 font-normal text-right">Sold</th>
                        <th className="py-1 pr-4 font-normal text-right">Sales</th>
                        <th className="py-1 font-normal text-right">Profit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownBooks.map((b) => (
                        <tr key={`${b.platform}:${b.sku}:${b.title}`} className="border-t">
                          <td className="max-w-xs py-1.5 pr-4">
                            <div className="truncate">{b.title || b.sku}</div>
                            <div className="truncate text-xs text-muted-foreground">{b.sku}</div>
                          </td>
                          <td className="py-1.5 pr-4">{PLATFORM_LABEL[b.platform]}</td>
                          <td className="py-1.5 pr-4 text-right tabular-nums whitespace-nowrap">{b.units}</td>
                          <td className="py-1.5 pr-4 text-right tabular-nums whitespace-nowrap">{money(b.sales)}</td>
                          <td className={`py-1.5 text-right tabular-nums whitespace-nowrap ${b.profit < 0 ? "text-destructive" : ""}`}>
                            {money(b.profit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!needle && books.length > shownBooks.length && (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAllBooks(true)}>
                      Show all {books.length} books
                    </Button>
                  )}
                  {!needle && !showAllBooks && books.length > 10 && (
                    <p className="text-xs text-muted-foreground">Top 10 by profit, then the books that lost the most.</p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {summary && summary.charges.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Other charges</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {summary.charges.slice(0, 100).map((c) => (
                    <tr key={c.key} className="border-t first:border-t-0">
                      <td className="py-1.5 pr-4 whitespace-nowrap text-muted-foreground">{localDay(c.date)}</td>
                      <td className="py-1.5 pr-4">{PLATFORM_LABEL[c.platform]}</td>
                      <td className="py-1.5 pr-4">{c.description}</td>
                      <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money(-c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          Amazon sales come from your orders report, dated when the order was placed, like Seller Central counts them;
          fees, refunds and other charges come from your payments as Amazon posts them. eBay numbers come from each order's total and eBay's fee, dated when the order was placed; promoted
          listing fees and labels bought on eBay aren't included yet. Sales tax is left out on both.
        </p>
      </div>
    </main>
  );
}
