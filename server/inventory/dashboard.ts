import { isLowOnSupply } from "@shared/schema";
import type { PickupRequest } from "@shared/schema";
import type { AccountCharge, ProfitRow } from "@shared/profitReport";
import { storage } from "../storage";
import { calendarConfigured } from "../calendar";
import { inventoryStore } from "./store";
import * as amazon from "./amazon";
import * as amazonReturns from "./amazonReturns";
import * as ebay from "./ebay";
import * as whatnot from "./whatnot";
import * as profit from "./profit";
import * as repricer from "./repricer";
import * as supplies from "./supplies";
import { AMAZON_POLL_MS } from "./sync";

// Main admin dashboard (/#/admin): one read of what the other admin pages
// show, so the business can be checked at a glance. Nothing here calls
// Amazon or eBay; it only reads what the app already stored.

const DAY = 86_400_000;

// Profit rows are summed on the page (in the viewer's time zone, like
// /#/profit), so only send enough for this month and the last 30 days.
const PROFIT_DAYS = 70;

export interface OrderSource {
  name: string;
  on: boolean;
  checkedAt: string | null;
  error: string | null;
  staleAfterMs: number; // no successful check in this long = something's wrong
}

// Where marketplace orders are counted from (shared with /#/supplies).
export function orderSources(): OrderSource[] {
  const checked = (key: string) => inventoryStore.getState(key) ?? null;
  const halfHour = 30 * 60 * 1000;
  return [
    { name: "eBay", on: ebay.ebayConnected(), checkedAt: checked("ebay_orders_since"), error: null, staleAfterMs: halfHour },
    {
      name: "Whatnot",
      on: whatnot.whatnotConfigured(),
      checkedAt: checked("whatnot_orders_since"),
      error: null,
      staleAfterMs: halfHour,
    },
    {
      name: "Amazon",
      on: amazon.amazonConfigured(),
      checkedAt: checked("amazon_orders_since"),
      error: checked("amazon_last_error") || null,
      staleAfterMs: AMAZON_POLL_MS + 2 * 60 * 60 * 1000,
    },
  ];
}

export interface AttentionItem {
  tone: "problem" | "warn" | "info";
  text: string;
  href: string;
}

// Sync events are stored as ISO; very old ones were SQLite "yyyy-mm-dd hh:mm:ss" UTC.
function eventTime(createdAt: string): number {
  return Date.parse(createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`);
}

// Today in Pacific time, since pickup dates are local calendar days.
function pacificToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

// "today", "tomorrow" or "on Tue, Dec 1" for a yyyy-mm-dd pickup date.
function pickupWhen(date: string, today: string): string {
  if (date === today) return "today";
  const noon = (d: string) => new Date(`${d}T12:00:00Z`);
  if ((noon(date).getTime() - noon(today).getTime()) / DAY === 1) return "tomorrow";
  return `on ${noon(date).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })}`;
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

// Only what the dashboard shows: no phone, email, street address or photo.
function pickupSummary(r: PickupRequest) {
  return {
    id: r.id,
    name: firstName(r.fullName),
    city: r.city,
    date: r.preferredDate,
    boxes: r.numberOfBoxes,
    fullService: r.fullService,
    createdAt: r.createdAt,
    emailFailed: !r.emailStatus.startsWith("sent") && r.emailStatus !== "pending",
    onCalendar: Boolean(r.calendarEventId),
  };
}

export async function dashboardSummary() {
  const now = Date.now();
  const attention: AttentionItem[] = [];

  // ---- Sales and profit (/#/profit) ----
  const profitCutoff = new Date(now - PROFIT_DAYS * DAY).toISOString();
  const job = profit.profitJob();
  const jobText = [job.error ?? "", ...job.notes].join(" ");
  const amazonConnected = amazon.amazonConfigured();
  const ebayConnected = ebay.ebayConnected();
  const profitData = {
    amazonConnected,
    ebayConnected,
    job,
    // Without the Finance role Amazon fees are estimated, so Amazon profit
    // isn't shown as a number on the dashboard.
    amazonFinanceMissing: amazonConnected && /Finance and Accounting/i.test(jobText),
    settings: profit.getSettings(),
    suppliesPerOrder: profit.suppliesCostPerOrder(),
    rows: profit.storedRows().filter((r: ProfitRow) => r.date >= profitCutoff),
    charges: profit.storedCharges().filter((c: AccountCharge) => c.date >= profitCutoff),
  };
  if (job.error) attention.push({ tone: "problem", text: `Profit refresh failed: ${job.error}`, href: "/profit" });
  if (!ebayConnected) attention.push({ tone: "problem", text: "eBay isn't connected", href: "/inventory" });
  if (!amazonConnected) attention.push({ tone: "warn", text: "Amazon isn't connected on the server", href: "/profit" });

  // ---- Inventory sync (/#/inventory) ----
  const items = inventoryStore.listItems();
  const listed = profit.listedInventory();
  const events = inventoryStore.listEvents(200);
  const recentProblems = events.filter((e) => e.level === "error" && now - eventTime(e.createdAt) < DAY);
  const sources = orderSources();
  const inventory = {
    books: items.length,
    units: items.reduce((n, i) => n + i.quantity, 0),
    outOfStock: items.filter((i) => i.quantity <= 0).length,
    linked: {
      whatnot: items.filter((i) => i.whatnotVariantId).length,
      ebay: items.filter((i) => i.ebayItemId).length,
      amazon: items.filter((i) => i.amazonSku).length,
    },
    listings: {
      amazon: listed.items.filter((i) => i.platform === "amazon").length,
      ebay: listed.items.filter((i) => i.platform === "ebay").length,
      amazonAt: listed.amazonAt,
      ebayAt: listed.ebayAt,
    },
    sources,
    errors24h: recentProblems.length,
    lastError: recentProblems[0] ? { message: recentProblems[0].message, createdAt: recentProblems[0].createdAt } : null,
    lastEventAt: events[0]?.createdAt ?? null,
  };
  if (recentProblems.length) {
    attention.push({
      tone: "problem",
      text: `${recentProblems.length} sync error${recentProblems.length > 1 ? "s" : ""} in the last day`,
      href: "/inventory",
    });
  }
  for (const s of sources) {
    if (!s.on) continue;
    if (s.error) attention.push({ tone: "problem", text: `${s.name} order check failed`, href: "/supplies" });
    else if (s.checkedAt && now - Date.parse(s.checkedAt) > s.staleAfterMs) {
      attention.push({ tone: "problem", text: `${s.name} orders haven't been checked lately`, href: "/supplies" });
    }
  }

  // ---- Returns (/#/returns), last 30 days ----
  const returnRows = amazonReturns.storedReturns();
  const r30 = amazonReturns.summarizeReturns(returnRows, amazonReturns.storedSales(), 30);
  const returnsJob = amazonReturns.returnsJob();
  const returns = {
    connected: amazonConnected,
    hasData: returnRows.length > 0,
    units: r30.returns,
    orders: r30.orders,
    returnRate: r30.returnRate,
    refunded: r30.refunded,
    azClaims: r30.azClaims,
    topReason: r30.byReason[0]?.reason ?? null,
    job: returnsJob,
  };
  if (r30.azClaims > 0) {
    attention.push({ tone: "problem", text: `${r30.azClaims} A-to-z claim${r30.azClaims > 1 ? "s" : ""} in 30 days`, href: "/returns" });
  }

  // ---- Repricer (/#/repricer) ----
  const rSettings = repricer.getSettings();
  const rJob = repricer.repricerJob();
  const changes = repricer.listChanges(300).filter((c) => now - Date.parse(c.createdAt) < DAY);
  const repricerData = {
    configured: amazon.amazonListingConfigured(),
    enabled: rSettings.enabled,
    intervalHours: rSettings.intervalHours,
    listings: repricer.listListings().length,
    job: rJob,
    changes24h: changes.filter((c) => !c.error).length,
    failed24h: changes.filter((c) => c.error).length,
  };
  if (!repricerData.configured) {
    attention.push({ tone: "info", text: "Repricer can't change prices: Amazon listing access isn't set up", href: "/repricer" });
  } else if (!rSettings.enabled) {
    attention.push({ tone: "info", text: "Repricer is off (only showing what it would do)", href: "/repricer" });
  }
  if (rJob.error) attention.push({ tone: "problem", text: `Last repricer run failed: ${rJob.error}`, href: "/repricer" });

  // ---- Shipping supplies (/#/supplies) ----
  const all = supplies.listSupplies();
  const low = all.filter((s) => isLowOnSupply(s));
  const suppliesData = {
    count: all.length,
    low: low.map((s) => ({
      id: s.id,
      name: s.name,
      quantity: s.quantity,
      reorderAt: s.reorderAt,
      ordered: Boolean(s.orderedAt),
      orderedQuantity: s.orderedQuantity,
    })),
    onOrder: all.filter((s) => s.orderedAt).length,
  };
  for (const s of low) {
    attention.push(
      s.orderedAt
        ? { tone: "info", text: `${s.name} is low (${s.quantity} left); ${s.orderedQuantity} on the way`, href: "/supplies" }
        : { tone: "warn", text: `Reorder ${s.name}: ${s.quantity} left`, href: "/supplies" },
    );
  }

  // ---- Pickup requests (website form) ----
  const today = pacificToday();
  const allPickups = await storage.listPickupRequests();
  const upcoming = allPickups
    .filter((p) => p.preferredDate >= today)
    .sort((a, b) => a.preferredDate.localeCompare(b.preferredDate) || a.id - b.id);
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const pickups = {
    today,
    upcoming: upcoming.slice(0, 8).map(pickupSummary),
    upcomingCount: upcoming.length,
    newThisWeek: allPickups.filter((p) => p.createdAt >= weekAgo).length,
    total: allPickups.length,
    calendarOn: calendarConfigured(),
  };
  const nextDate = upcoming[0]?.preferredDate;
  if (nextDate) {
    const n = upcoming.filter((p) => p.preferredDate === nextDate).length;
    attention.push({
      tone: nextDate === today ? "warn" : "info",
      text: `${n} pickup${n > 1 ? "s" : ""} ${pickupWhen(nextDate, today)}`,
      href: "#pickups",
    });
  }
  const failedEmails = upcoming.filter((p) => pickupSummary(p).emailFailed).length;
  if (failedEmails) {
    attention.push({
      tone: "problem",
      text: `${failedEmails} upcoming pickup email${failedEmails > 1 ? "s" : ""} didn't send`,
      href: "#pickups",
    });
  }

  const order = { problem: 0, warn: 1, info: 2 } as const;
  attention.sort((a, b) => order[a.tone] - order[b.tone]);

  return {
    generatedAt: new Date(now).toISOString(),
    attention,
    profit: profitData,
    inventory,
    returns,
    repricer: repricerData,
    supplies: suppliesData,
    pickups,
  };
}

export type DashboardSummary = Awaited<ReturnType<typeof dashboardSummary>>;
