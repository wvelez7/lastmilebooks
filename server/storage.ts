import { pickupRequests } from "@shared/schema";
import type { PickupRequest, InsertPickupRequest } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";

// On Render, point DATABASE_PATH at the persistent disk (see render.yaml);
// the default local file is wiped on every deploy there.
const sqlite = new Database(process.env.DATABASE_PATH || "data.db");
sqlite.pragma("journal_mode = WAL");

// Bootstrap table if it doesn't exist (so we don't require running drizzle-kit push)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pickup_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    pickup_address TEXT NOT NULL,
    city TEXT NOT NULL,
    number_of_boxes TEXT NOT NULL,
    preferred_date TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    email_status TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    whatnot_variant_id TEXT,
    ebay_item_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS processed_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    sku TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ebay_listings (
    item_id TEXT PRIMARY KEY,
    sku TEXT,
    title TEXT NOT NULL,
    isbn TEXT,
    price REAL NOT NULL,
    shipping REAL,
    quantity INTEGER NOT NULL DEFAULT 1,
    condition TEXT,
    image_url TEXT,
    url TEXT,
    details_fetched_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ebay_listings_isbn ON ebay_listings (isbn);
  CREATE INDEX IF NOT EXISTS ebay_listings_sku ON ebay_listings (sku);
`);

export const db = drizzle(sqlite);

export interface IStorage {
  createPickupRequest(req: InsertPickupRequest): Promise<PickupRequest>;
  listPickupRequests(): Promise<PickupRequest[]>;
  markEmailStatus(id: number, status: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async createPickupRequest(req: InsertPickupRequest): Promise<PickupRequest> {
    return db.insert(pickupRequests).values(req).returning().get();
  }
  async listPickupRequests(): Promise<PickupRequest[]> {
    return db
      .select()
      .from(pickupRequests)
      .orderBy(desc(pickupRequests.createdAt))
      .all();
  }
  async markEmailStatus(id: number, status: string): Promise<void> {
    db.update(pickupRequests)
      .set({ emailStatus: status })
      .where(eq(pickupRequests.id, id))
      .run();
  }
}

export const storage = new DatabaseStorage();
