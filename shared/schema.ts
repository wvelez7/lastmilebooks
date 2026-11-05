import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const pickupRequests = sqliteTable("pickup_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  pickupAddress: text("pickup_address").notNull(),
  city: text("city").notNull(),
  numberOfBoxes: text("number_of_boxes").notNull(),
  preferredDate: text("preferred_date").notNull(),
  notes: text("notes"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  emailStatus: text("email_status").notNull().default("pending"),
});

// Pickups run on Tuesdays (2) and Wednesdays (3) only.
export const PICKUP_WEEKDAYS = [2, 3];

export function isPickupDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return PICKUP_WEEKDAYS.includes(day);
}

export const insertPickupRequestSchema = createInsertSchema(pickupRequests, {
  fullName: (s) => s.min(2, "Please enter your full name"),
  email: (s) => s.email("Please enter a valid email"),
  phone: (s) => s.min(7, "Please enter a valid phone number"),
  pickupAddress: (s) => s.min(5, "Please enter a street address"),
  city: (s) => s.min(2, "Please enter a city"),
  numberOfBoxes: (s) => s.min(1, "How many boxes?"),
  preferredDate: (s) =>
    s
      .min(1, "Pick a preferred date")
      .refine(isPickupDay, "Pickups are only available on Tuesdays and Wednesdays"),
}).omit({ id: true, createdAt: true, emailStatus: true });

export type InsertPickupRequest = z.infer<typeof insertPickupRequestSchema>;
export type PickupRequest = typeof pickupRequests.$inferSelect;

// ---------------------------------------------------------------------------
// Cross-marketplace inventory sync (Whatnot + eBay; Amazon later).
// One row per book. The SKU must match the Whatnot variant SKU and the eBay
// "Custom label" so listings can be matched automatically.
// ---------------------------------------------------------------------------

export const inventoryItems = sqliteTable("inventory_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sku: text("sku").notNull().unique(),
  title: text("title").notNull(),
  quantity: integer("quantity").notNull().default(1),
  whatnotVariantId: text("whatnot_variant_id"),
  ebayItemId: text("ebay_item_id"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// Every sale we have already acted on, so a sale is never applied twice
// (webhook retries, overlapping polls).
export const processedSales = sqliteTable("processed_sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // "<platform>:<order id>:<line item id>"
  saleKey: text("sale_key").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// Human-readable history shown on the inventory admin page.
export const syncEvents = sqliteTable("sync_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  level: text("level").notNull(), // "info" | "warn" | "error"
  message: text("message").notNull(),
  sku: text("sku"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// Small key/value store for poll checkpoints and the eBay refresh token.
export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Every active eBay listing, for the barcode scanner (/#/scan). Separate from
// inventory_items because it includes listings with no SKU and is only ever
// read from eBay, never pushed back.
export const ebayListings = sqliteTable("ebay_listings", {
  itemId: text("item_id").primaryKey(),
  sku: text("sku"),
  title: text("title").notNull(),
  isbn: text("isbn"), // ISBN-13, null if the listing has none
  price: real("price").notNull(),
  shipping: real("shipping"), // what the buyer pays; null = calculated
  quantity: integer("quantity").notNull().default(1),
  condition: text("condition"),
  imageUrl: text("image_url"),
  url: text("url"),
  detailsFetchedAt: text("details_fetched_at"), // ISBN etc. come from a slower per-item call
  updatedAt: text("updated_at").notNull(),
});

export type EbayListingRow = typeof ebayListings.$inferSelect;

export const PLATFORMS = ["whatnot", "ebay"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const upsertInventoryItemSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required"),
  title: z.string().trim().min(1, "Title is required"),
  quantity: z.number().int().min(0),
  whatnotVariantId: z.string().trim().min(1).nullable().optional(),
  ebayItemId: z.string().trim().regex(/^\d+$/, "eBay item IDs are numbers").nullable().optional(),
});

export type UpsertInventoryItem = z.infer<typeof upsertInventoryItemSchema>;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type SyncEvent = typeof syncEvents.$inferSelect;
