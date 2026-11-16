import { z } from "zod";

// Amazon repricer (admin page at /#/repricer), in place of SmartRepricer's
// "Lowest MF Price" strategy: each book you ship yourself is priced to match
// the cheapest other seller who also ships their own copy in the same or
// better condition, never below its min or above its max.

export const repricerSettingsSchema = z.object({
  enabled: z.boolean(), // off: checks and shows what it would do, changes nothing
  intervalHours: z.number().min(1, "Check at least an hour apart").max(24),
  defaultMin: z.number().positive("Enter a default min"),
  defaultMax: z.number().positive("Enter a default max"),
  // New listings stay within this percent of their first price for this many days.
  newBookDays: z.number().int().min(0).max(365),
  newBookPercent: z.number().min(0).max(100),
  competeWithFba: z.boolean(), // FBA copies are compared at their price, shipping included
  minFeedbackPercent: z.number().min(0).max(100), // ignore sellers rated below this; 0 = everyone
  noCompetition: z.enum(["keep", "max"]), // when no one else qualifies
  myShipping: z.number().min(0), // what buyers pay you for shipping, when Amazon doesn't say
});

export type RepricerSettings = z.infer<typeof repricerSettingsSchema>;

export const DEFAULT_REPRICER_SETTINGS: RepricerSettings = {
  enabled: false,
  intervalHours: 2,
  defaultMin: 9.5,
  defaultMax: 500,
  newBookDays: 30,
  newBookPercent: 10,
  competeWithFba: false,
  minFeedbackPercent: 0,
  noCompetition: "keep",
  myShipping: 3.99,
};

// Best first. Amazon calls like new "mint" in offers and "like_new" in listings.
export const CONDITION_ORDER = ["new", "like_new", "very_good", "good", "acceptable"] as const;
export type RepricerCondition = (typeof CONDITION_ORDER)[number];

export const CONDITION_LABELS: Record<RepricerCondition, string> = {
  new: "New",
  like_new: "Like New",
  very_good: "Very Good",
  good: "Good",
  acceptable: "Acceptable",
};

// "VeryGood", "very_good", "used_very_good", "Mint" and so on. null for
// conditions books don't use (collectible, refurbished).
export function normalizeCondition(raw: string | null | undefined): RepricerCondition | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "").replace(/^used/, "");
  if (s === "new" || s === "newnew") return "new";
  if (s === "mint" || s === "likenew") return "like_new";
  if (s === "verygood") return "very_good";
  if (s === "good") return "good";
  if (s === "acceptable") return "acceptable";
  return null;
}

export type MinMaxSource = "manual" | "new" | "file" | "default";

export interface RepricerListing {
  sku: string;
  asin: string;
  title: string;
  condition: string | null;
  price: number;
  quantity: number;
  openedAt: string | null;
  firstPrice: number | null;
  minPrice: number | null; // set by hand or from a SmartRepricer file
  maxPrice: number | null;
  minMaxSource: "manual" | "file" | null;
  competitorPrice: number | null; // their price plus shipping
  competitorLabel: string | null;
  competitors: number | null;
  buyBoxPrice: number | null; // price plus shipping
  hasBuyBox: boolean;
  myShipping: number | null;
  targetPrice: number | null;
  status: string | null;
  checkedAt: string | null;
  changedAt: string | null;
}

const round = (n: number) => Math.round(n * 100) / 100;

// Set by hand wins; then a new listing stays near its first price; then a
// min/max from the SmartRepricer file; then the defaults.
export function effectiveMinMax(
  l: Pick<RepricerListing, "minPrice" | "maxPrice" | "minMaxSource" | "openedAt" | "firstPrice">,
  s: RepricerSettings,
  now = Date.now(),
): { min: number; max: number; source: MinMaxSource } {
  if (l.minMaxSource === "manual" && l.minPrice !== null && l.maxPrice !== null) {
    return { min: l.minPrice, max: l.maxPrice, source: "manual" };
  }
  const ageDays = l.openedAt ? (now - new Date(l.openedAt).getTime()) / 86_400_000 : Infinity;
  if (l.firstPrice !== null && s.newBookDays > 0 && ageDays < s.newBookDays) {
    const pct = s.newBookPercent / 100;
    return { min: round(l.firstPrice * (1 - pct)), max: round(l.firstPrice * (1 + pct)), source: "new" };
  }
  if (l.minMaxSource === "file" && l.minPrice !== null && l.maxPrice !== null) {
    return { min: l.minPrice, max: l.maxPrice, source: "file" };
  }
  return { min: s.defaultMin, max: s.defaultMax, source: "default" };
}

export interface RepricerJob {
  running: boolean;
  step: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  checked: number;
  changed: number; // pushed to Amazon, or would be while off
  failed: number;
}

export interface RepricerChange {
  id: number;
  sku: string;
  title: string;
  oldPrice: number;
  newPrice: number;
  competitorPrice: number | null;
  reason: string;
  error: string | null;
  createdAt: string;
}
