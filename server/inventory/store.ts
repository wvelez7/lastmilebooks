import {
  inventoryItems,
  processedSales,
  syncEvents,
  syncState,
} from "@shared/schema";
import type { InventoryItem, SyncEvent, UpsertInventoryItem } from "@shared/schema";
import { db } from "../storage";
import { asc, desc, eq, isNotNull, sql } from "drizzle-orm";

export const inventoryStore = {
  listItems(): InventoryItem[] {
    return db.select().from(inventoryItems).orderBy(asc(inventoryItems.sku)).all();
  },

  getBySku(sku: string): InventoryItem | undefined {
    return db.select().from(inventoryItems).where(eq(inventoryItems.sku, sku)).get();
  },

  getByWhatnotVariant(variantId: string): InventoryItem | undefined {
    return db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.whatnotVariantId, variantId))
      .get();
  },

  getByEbayItem(itemId: string): InventoryItem | undefined {
    return db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.ebayItemId, itemId))
      .get();
  },

  getByAmazonSku(sku: string): InventoryItem | undefined {
    return db.select().from(inventoryItems).where(eq(inventoryItems.amazonSku, sku)).get();
  },

  hasAmazonListings(): boolean {
    return Boolean(db.select({ id: inventoryItems.id }).from(inventoryItems).where(isNotNull(inventoryItems.amazonSku)).get());
  },

  // Insert, or update the existing row with the same SKU. Fields left
  // undefined keep their current value.
  upsert(item: UpsertInventoryItem): InventoryItem {
    const now = new Date().toISOString();
    const existing = this.getBySku(item.sku);
    if (!existing) {
      return db
        .insert(inventoryItems)
        .values({ ...item, createdAt: now, updatedAt: now })
        .returning()
        .get();
    }
    const patch: Partial<InventoryItem> = { updatedAt: now, title: item.title, quantity: item.quantity };
    if (item.whatnotVariantId !== undefined) patch.whatnotVariantId = item.whatnotVariantId;
    if (item.ebayItemId !== undefined) patch.ebayItemId = item.ebayItemId;
    if (item.amazonSku !== undefined) patch.amazonSku = item.amazonSku;
    return db
      .update(inventoryItems)
      .set(patch)
      .where(eq(inventoryItems.id, existing.id))
      .returning()
      .get();
  },

  // Atomic so two sales of the same book can't both read the old quantity.
  decrement(id: number, by: number): InventoryItem | undefined {
    return db
      .update(inventoryItems)
      .set({
        quantity: sql`max(0, ${inventoryItems.quantity} - ${by})`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(inventoryItems.id, id))
      .returning()
      .get();
  },

  getById(id: number): InventoryItem | undefined {
    return db.select().from(inventoryItems).where(eq(inventoryItems.id, id)).get();
  },

  deleteItem(id: number): void {
    db.delete(inventoryItems).where(eq(inventoryItems.id, id)).run();
  },

  // Returns true the first time a sale key is seen, false on any repeat.
  claimSale(saleKey: string): boolean {
    const res = db
      .insert(processedSales)
      .values({ saleKey })
      .onConflictDoNothing()
      .run();
    return res.changes > 0;
  },

  hasSale(saleKey: string): boolean {
    return Boolean(
      db.select().from(processedSales).where(eq(processedSales.saleKey, saleKey)).get(),
    );
  },

  log(level: "info" | "warn" | "error", message: string, sku?: string | null): void {
    const prefix = level === "error" ? console.error : console.log;
    prefix(`[inventory] ${level}: ${message}${sku ? ` (${sku})` : ""}`);
    db.insert(syncEvents).values({ level, message, sku: sku ?? null }).run();
  },

  listEvents(limit = 200): SyncEvent[] {
    return db.select().from(syncEvents).orderBy(desc(syncEvents.id)).limit(limit).all();
  },

  getState(key: string): string | undefined {
    return db.select().from(syncState).where(eq(syncState.key, key)).get()?.value;
  },

  setState(key: string, value: string): void {
    db.insert(syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: syncState.key, set: { value } })
      .run();
  },
};
