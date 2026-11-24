import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  BadgeDollarSign,
  Boxes,
  CalendarDays,
  ChevronRight,
  Info,
  Package,
  RefreshCcw,
  Tags,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { forgetAdminKey, readAdminKey, saveAdminKey } from "@/lib/adminKey";
import { localDay, summarizeProfit } from "@shared/profitReport";
import type { AccountCharge, ProfitRow, ProfitSettings, ProfitTotals } from "@shared/profitReport";
import AdminNav from "@/components/AdminNav";

// Main admin page: the numbers that matter from every other admin page, each
// tile linking to its page. Not linked from the site; open /#/admin and enter
// the ADMIN_KEY (shared with the other admin pages).

interface OrderSource {
  name: string;
  on: boolean;
  checkedAt: string | null;
  error: string | null;
  staleAfterMs: number;
}

interface Job {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface Pickup {
  id: number;
  name: string;
  city: string;
  date: string;
  boxes: string;
  fullService: boolean;
  createdAt: string;
  emailFailed: boolean;
  onCalendar: boolean;
}

interface Summary {
  generatedAt: string;
  attention: { tone: "problem" | "warn" | "info"; text: string; href: string }[];
  profit: {
    amazonConnected: boolean;
    ebayConnected: boolean;
    amazonFinanceMissing: boolean;
    job: Job & { notes: string[] };
    settings: ProfitSettings;
    suppliesPerOrder: number | null;
    rows: ProfitRow[];
    charges: AccountCharge[];
  };
  inventory: {
    books: number;
    units: number;
    outOfStock: number;
    linked: { whatnot: number; ebay: number; amazon: number };
    listings: { amazon: number; ebay: number; amazonAt: string | null; ebayAt: string | null };
    sources: OrderSource[];
    errors24h: number;
    lastError: { message: string; createdAt: string } | null;
    lastEventAt: string | null;
  };
  returns: {
    connected: boolean;
    hasData: boolean;
    units: number;
    orders: number;
    returnRate: number | null;
    refunded: number;
    azClaims: number;
    topReason: string | null;
    job: Job;
  };
  repricer: {
    configured: boolean;
    enabled: boolean;
    intervalHours: number;
    listings: number;
    job: Job & { checked: number; changed: number; failed: number };
    changes24h: number;
    failed24h: number;
  };
  supplies: {
    count: number;
    low: { id: number; name: string; quantity: number; reorderAt: number; ordered: boolean; orderedQuantity: number | null }[];
    onOrder: number;
  };
  pickups: {
    today: string;
    upcoming: Pickup[];
    upcomingCount: number;
    newThisWeek: number;
    total: number;
    calendarOn: boolean;
  };
}

function money(n: number): string {
  const s = `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return n < 0 ? `−${s}` : s;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return formatDistanceToNow(t, { addSuffix: true });
}

function sourceProblem(s: OrderSource): boolean {
  if (!s.on) return false;
  if (s.error) return true;
  return Boolean(s.checkedAt) && Date.now() - new Date(s.checkedAt!).getTime() > s.staleAfterMs;
}

// "2026-11-25" → "Wed, Nov 25"
function pickupDay(day: string, today: string): string {
  if (day === today) return "Today";
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function Tile({
  href,
  title,
  icon: Icon,
  children,
  footer,
}: {
  href: string;
  title: string;
  icon: typeof Boxes;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
            {title}
          </CardTitle>
          <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
        </CardHeader>
        <CardContent className="space-y-3">
          {children}
          {footer && <div className="text-xs text-muted-foreground">{footer}</div>}
        </CardContent>
      </Card>
    </Link>
  );
}

function Big({ value, label, tone }: { value: string; label: string; tone?: "good" | "bad" }) {
  return (
    <div>
      <div
        className={`text-2xl font-semibold tabular-nums ${
          tone === "bad" ? "text-destructive" : tone === "good" ? "text-green-700 dark:text-green-400" : ""
        }`}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Line({ label, value, muted }: { label: string; value: ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums text-right ${muted ? "text-muted-foreground" : ""}`}>{value}</span>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">{children}</p>;
}

const TONE_ICON = { problem: XCircle, warn: AlertTriangle, info: Info } as const;
const TONE_CLASS = {
  problem: "text-destructive",
  warn: "text-amber-600 dark:text-amber-500",
  info: "text-muted-foreground",
} as const;

function monthRange(): { from: string; to: string } {
  const now = new Date();
  return { from: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: localDay(now) };
}

export default function Dashboard() {
  const { toast } = useToast();
  const [adminKey, setAdminKey] = useState(readAdminKey);
  const [keyDraft, setKeyDraft] = useState("");
  const [data, setData] = useState<Summary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!adminKey) return;
    try {
      const res = await fetch("/api/dashboard", { headers: { "x-admin-key": adminKey } });
      if (res.status === 401) {
        setAdminKey("");
        forgetAdminKey();
        throw new Error("Wrong admin key");
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
      toast({ title: "Couldn't load the dashboard", description: (e as Error).message, variant: "destructive" });
    }
  }, [adminKey, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  // This month's sales and profit, worked out like /#/profit does.
  const month = useMemo(() => {
    if (!data) return null;
    const p = data.profit;
    const { from, to } = monthRange();
    const supplies = p.settings.suppliesPerOrder ?? p.suppliesPerOrder ?? 0;
    return summarizeProfit(p.rows, p.charges, p.settings, supplies, from, to);
  }, [data]);

  if (!adminKey) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Last Mile Books admin</CardTitle>
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

  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <AdminNav />
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {data ? `Updated ${ago(data.generatedAt)}. Refreshes every minute.` : loadError ? loadError : "Loading…"}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </header>

        {data && month && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">Needs attention</CardTitle>
              </CardHeader>
              <CardContent>
                {data.attention.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing right now.</p>
                ) : (
                  <ul className="divide-y">
                    {data.attention.map((a, i) => {
                      const Icon = TONE_ICON[a.tone];
                      const body = (
                        <>
                          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE_CLASS[a.tone]}`} aria-hidden />
                          <span className={`min-w-0 flex-1 break-words ${a.tone === "info" ? "" : "font-medium"}`}>{a.text}</span>
                          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        </>
                      );
                      const cls = "flex items-start gap-2 py-2 text-sm hover:text-primary";
                      return (
                        <li key={i}>
                          {a.href.startsWith("#") ? (
                            <a
                              href={a.href}
                              className={cls}
                              onClick={(e) => {
                                // In-page link; the URL hash is the router's.
                                e.preventDefault();
                                document.getElementById(a.href.slice(1))?.scrollIntoView({ behavior: "smooth" });
                              }}
                            >
                              {body}
                            </a>
                          ) : (
                            <Link href={a.href} className={cls}>
                              {body}
                            </Link>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ProfitTile data={data} month={month.byPlatform} total={month.total} monthName={monthName} />
              <InventoryTile inv={data.inventory} />
              <SuppliesTile s={data.supplies} />
              <RepricerTile r={data.repricer} />
              <ReturnsTile r={data.returns} />
              <PickupCountTile p={data.pickups} />
            </div>

            <PickupList p={data.pickups} />
          </>
        )}
      </div>
    </main>
  );
}

function ProfitTile({
  data,
  month,
  total,
  monthName,
}: {
  data: Summary;
  month: Record<"amazon" | "ebay", ProfitTotals>;
  total: ProfitTotals;
  monthName: string;
}) {
  const p = data.profit;
  // Amazon fees are only estimated without the Finance role, so its profit
  // (and the total) isn't shown as a number.
  const amazonProfitKnown = p.amazonConnected && !p.amazonFinanceMissing;
  const tone = (n: number) => (n < 0 ? "bad" : n > 0 ? "good" : undefined);
  return (
    <Tile
      href="/profit"
      title={`Sales · ${monthName}`}
      icon={BadgeDollarSign}
      footer={p.job.running ? "Refreshing now…" : `Updated ${ago(p.job.finishedAt)}`}
    >
      <div className="grid grid-cols-2 gap-3">
        <Big value={money(total.sales)} label={`${total.units} books · ${total.orders} orders`} />
        {amazonProfitKnown ? (
          <Big value={money(total.profit)} label="profit" tone={tone(total.profit)} />
        ) : (
          <Big value={money(month.ebay.profit)} label="eBay profit" tone={tone(month.ebay.profit)} />
        )}
      </div>
      <div className="space-y-1">
        <Line
          label={p.amazonConnected ? "Amazon sales" : "Amazon sales (not connected)"}
          value={money(month.amazon.sales)}
          muted={!p.amazonConnected}
        />
        <Line
          label={p.ebayConnected ? "eBay sales" : "eBay sales (not connected)"}
          value={money(month.ebay.sales)}
          muted={!p.ebayConnected}
        />
        {amazonProfitKnown && <Line label="Amazon profit" value={money(month.amazon.profit)} />}
        {amazonProfitKnown && <Line label="eBay profit" value={money(month.ebay.profit)} />}
      </div>
      {p.amazonConnected && p.amazonFinanceMissing && (
        <Note>Amazon profit isn't shown: its fees are estimates until the Finance and Accounting role is added.</Note>
      )}
      <Note>eBay profit leaves out promoted-listing fees and labels bought on eBay.</Note>
    </Tile>
  );
}

function InventoryTile({ inv }: { inv: Summary["inventory"] }) {
  const problems = inv.sources.filter(sourceProblem);
  return (
    <Tile href="/inventory" title="Inventory" icon={Boxes} footer={`Last sync activity ${ago(inv.lastEventAt)}`}>
      <div className="grid grid-cols-2 gap-3">
        <Big value={(inv.listings.amazon + inv.listings.ebay).toLocaleString()} label="listings" />
        <Big value={inv.books.toLocaleString()} label="books synced" />
      </div>
      <div className="space-y-1">
        <Line label="Amazon listings" value={inv.listings.amazon.toLocaleString()} />
        <Line label="eBay listings" value={inv.listings.ebay.toLocaleString()} />
        {inv.outOfStock > 0 && <Line label="Synced at 0 quantity" value={inv.outOfStock.toLocaleString()} />}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {inv.sources.map((s) => (
          <Badge
            key={s.name}
            variant={sourceProblem(s) ? "destructive" : s.on ? "secondary" : "outline"}
            className="font-normal"
            title={s.on ? `Orders checked ${ago(s.checkedAt)}` : "Not set up"}
          >
            {s.name}: {!s.on ? "off" : sourceProblem(s) ? "problem" : "ok"}
          </Badge>
        ))}
      </div>
      {inv.errors24h > 0 && inv.lastError ? (
        <p className="text-xs text-destructive">
          {inv.errors24h} error{inv.errors24h > 1 ? "s" : ""} in the last day. Latest: {inv.lastError.message}
        </p>
      ) : problems.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sync errors in the last day.</p>
      ) : null}
    </Tile>
  );
}

function SuppliesTile({ s }: { s: Summary["supplies"] }) {
  const toOrder = s.low.filter((l) => !l.ordered);
  return (
    <Tile href="/supplies" title="Shipping supplies" icon={Package} footer={`${s.count} supplies tracked`}>
      <div className="grid grid-cols-2 gap-3">
        <Big value={String(toOrder.length)} label="to reorder" tone={toOrder.length ? "bad" : undefined} />
        <Big value={String(s.onOrder)} label="on order" />
      </div>
      {s.low.length > 0 ? (
        <ul className="space-y-1">
          {s.low.slice(0, 5).map((l) => (
            <li key={l.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{l.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {l.quantity} left{l.ordered ? " · ordered" : ""}
              </span>
            </li>
          ))}
          {s.low.length > 5 && <li className="text-xs text-muted-foreground">and {s.low.length - 5} more</li>}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{s.count ? "Everything is above its reorder point." : "No supplies added yet."}</p>
      )}
    </Tile>
  );
}

function RepricerTile({ r }: { r: Summary["repricer"] }) {
  const status = !r.configured ? "Not set up" : r.enabled ? "On" : "Off";
  return (
    <Tile
      href="/repricer"
      title="Repricer"
      icon={Tags}
      footer={r.job.running ? "Running now…" : `Last run ${ago(r.job.finishedAt)}`}
    >
      <div className="grid grid-cols-2 gap-3">
        <Big value={status} label={r.enabled ? `every ${r.intervalHours} h` : "changes nothing"} />
        <Big value={r.listings.toLocaleString()} label="Amazon listings" />
      </div>
      <div className="space-y-1">
        <Line label={r.enabled ? "Prices changed, last day" : "Would change, last day"} value={r.changes24h.toLocaleString()} />
        {r.failed24h > 0 && <Line label="Failed, last day" value={<span className="text-destructive">{r.failed24h}</span>} />}
      </div>
      {r.job.error && <p className="text-xs text-destructive">{r.job.error}</p>}
    </Tile>
  );
}

function ReturnsTile({ r }: { r: Summary["returns"] }) {
  return (
    <Tile
      href="/returns"
      title="Amazon returns · 30 days"
      icon={RefreshCcw}
      footer={r.job.running ? "Pulling from Amazon…" : `Last pull ${ago(r.job.finishedAt)}`}
    >
      {r.hasData ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Big value={String(r.units)} label="books returned" />
            <Big
              value={r.returnRate === null ? "—" : `${(r.returnRate * 100).toFixed(1)}%`}
              label="return rate"
            />
          </div>
          <div className="space-y-1">
            <Line label="Refunded" value={money(r.refunded)} />
            {r.azClaims > 0 && <Line label="A-to-z claims" value={<span className="text-destructive">{r.azClaims}</span>} />}
            {r.topReason && <Line label="Top reason" value={<span className="line-clamp-1">{r.topReason}</span>} />}
          </div>
          {r.returnRate === null && <Note>No return rate until the orders report has been pulled.</Note>}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No returns loaded yet. Upload a report or pull from Amazon.</p>
      )}
    </Tile>
  );
}

function PickupCountTile({ p }: { p: Summary["pickups"] }) {
  const next = p.upcoming[0];
  return (
    <a
      href="#pickups"
      onClick={(e) => {
        e.preventDefault();
        document.getElementById("pickups")?.scrollIntoView({ behavior: "smooth" });
      }}
      className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden />
            Pickup requests
          </CardTitle>
          <ChevronRight className="h-4 w-4 rotate-90 text-muted-foreground" aria-hidden />
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Big value={String(p.upcomingCount)} label="upcoming" />
            <Big value={String(p.newThisWeek)} label="new this week" />
          </div>
          <Line label="Next pickup" value={next ? `${pickupDay(next.date, p.today)} · ${next.city}` : "none booked"} />
          <div className="text-xs text-muted-foreground">{p.total.toLocaleString()} requests in all</div>
        </CardContent>
      </Card>
    </a>
  );
}

function PickupList({ p }: { p: Summary["pickups"] }) {
  return (
    <Card id="pickups" className="scroll-mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Upcoming pickups</CardTitle>
        <p className="text-sm text-muted-foreground">From the website form. Pickups run Tuesdays and Wednesdays.</p>
      </CardHeader>
      <CardContent>
        {p.upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">No upcoming pickups.</p>
        ) : (
          <ul className="divide-y">
            {p.upcoming.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{pickupDay(r.date, p.today)}</span>
                  <span className="text-muted-foreground"> · </span>
                  {r.city}
                  <span className="text-muted-foreground"> · {r.name}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                  <span className="tabular-nums">{r.boxes} boxes</span>
                  {r.fullService && (
                    <Badge variant="secondary" className="font-normal">
                      Box &amp; carry out
                    </Badge>
                  )}
                  {r.emailFailed && (
                    <Badge variant="destructive" className="font-normal">
                      Email didn't send
                    </Badge>
                  )}
                  {p.calendarOn && !r.onCalendar && (
                    <Badge variant="outline" className="font-normal">
                      Not on calendar
                    </Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {p.upcomingCount > p.upcoming.length && (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the next {p.upcoming.length} of {p.upcomingCount}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
