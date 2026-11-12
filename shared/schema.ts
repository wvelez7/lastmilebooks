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
// Cross-marketplace inventory sync (Whatnot, eBay and Amazon).
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
  amazonSku: text("amazon_sku"), // the seller SKU of our offer on Amazon

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

// Mailers, tape, labels and so on (admin page at /#/supplies). A row with
// used_per_order above 0 goes down by itself with each marketplace order.
// Rows with takes_turns set share orders instead: each order uses the next one,
// for things used interchangeably like two mailer sizes.
export const supplies = sqliteTable("supplies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull().default(0),
  reorderAt: integer("reorder_at").notNull().default(0), // low at or below this
  reorderQuantity: integer("reorder_quantity").notNull().default(1),
  usedPerOrder: integer("used_per_order").notNull().default(0),
  takesTurns: integer("takes_turns", { mode: "boolean" }).notNull().default(false),
  supplier: text("supplier"),
  productUrl: text("product_url"),
  unitCost: real("unit_cost"),
  orderedQuantity: integer("ordered_quantity"), // null = nothing on the way
  orderedAt: text("ordered_at"),
  alertedAt: text("alerted_at"), // last low-stock email, cleared once restocked
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const upsertSupplySchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  quantity: z.number({ message: "Enter how many you have" }).int().min(0),
  reorderAt: z.number({ message: "Enter when to reorder" }).int().min(0),
  reorderQuantity: z.number({ message: "Enter how many to reorder" }).int().min(1, "Reorder at least 1"),
  usedPerOrder: z.number({ message: "Enter how many each order uses" }).int().min(0),
  takesTurns: z.boolean().default(false),
  supplier: z.string().trim().min(1).nullable(),
  productUrl: z
    .string()
    .trim()
    .url("Enter a full link starting with https://")
    .refine((u) => /^https?:\/\//i.test(u), "Enter a full link starting with https://")
    .nullable(),
  unitCost: z.number().min(0).nullable(),
});

export type Supply = typeof supplies.$inferSelect;
export type UpsertSupply = z.infer<typeof upsertSupplySchema>;

export function isLowOnSupply(s: Pick<Supply, "quantity" | "reorderAt">): boolean {
  return s.quantity <= s.reorderAt;
}

// Every change to a supply's count, newest shown first on /#/supplies. The name
// is copied so rows still read right after a supply is renamed or removed.
export const supplyHistory = sqliteTable("supply_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  supplyId: integer("supply_id").notNull(),
  supplyName: text("supply_name").notNull(),
  change: integer("change").notNull(),
  quantity: integer("quantity").notNull(), // count after the change
  reason: text("reason").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type SupplyHistoryRow = typeof supplyHistory.$inferSelect;

// Books scanned for listing (/#/scan, Batch tab). JSON columns hold the
// shapes in shared/listing.ts.
export const listingBatches = sqliteTable("listing_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  status: text("status").notNull().default("open"), // "open" | "listing" | "done"
  defaults: text("defaults").notNull(), // BatchDefaults
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const batchItems = sqliteTable("batch_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: integer("batch_id").notNull(),
  seq: integer("seq").notNull(), // the {SEQ} in the SKU
  sku: text("sku").notNull(),
  isbn13: text("isbn13").notNull(),
  title: text("title").notNull(),
  amazon: text("amazon"), // AmazonBook snapshot, null if not on Amazon
  ebayLowest: real("ebay_lowest"),
  onEbayAlready: integer("on_ebay_already").notNull().default(0),
  box: text("box").notNull().default(""), // where the book is stored, for the {BOX} in its SKU
  labelPrintedAt: text("label_printed_at"), // once set, the SKU no longer changes
  condition: text("condition").notNull(),
  note: text("note").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  amazonPrice: real("amazon_price"),
  ebayPrice: real("ebay_price"),
  listAmazon: integer("list_amazon", { mode: "boolean" }).notNull(),
  listEbay: integer("list_ebay", { mode: "boolean" }).notNull(),
  status: text("status").notNull().default("pending"), // "pending" | "listed" | "failed"
  amazonResult: text("amazon_result"), // ListResult
  ebayResult: text("ebay_result"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export type BatchItemRow = typeof batchItems.$inferSelect;
export type ListingBatchRow = typeof listingBatches.$inferSelect;

export const PLATFORMS = ["whatnot", "ebay", "amazon"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const upsertInventoryItemSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required"),
  title: z.string().trim().min(1, "Title is required"),
  quantity: z.number().int().min(0),
  whatnotVariantId: z.string().trim().min(1).nullable().optional(),
  ebayItemId: z.string().trim().regex(/^\d+$/, "eBay item IDs are numbers").nullable().optional(),
  amazonSku: z.string().trim().min(1).max(40).nullable().optional(),
});

export type UpsertInventoryItem = z.infer<typeof upsertInventoryItemSchema>;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type SyncEvent = typeof syncEvents.$inferSelect;
