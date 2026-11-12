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
    amazon_sku TEXT,
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

  CREATE TABLE IF NOT EXISTS supplies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    reorder_at INTEGER NOT NULL DEFAULT 0,
    reorder_quantity INTEGER NOT NULL DEFAULT 1,
    used_per_order INTEGER NOT NULL DEFAULT 0,
    takes_turns INTEGER NOT NULL DEFAULT 0,
    supplier TEXT,
    product_url TEXT,
    unit_cost REAL,
    ordered_quantity INTEGER,
    ordered_at TEXT,
    alerted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS supply_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supply_id INTEGER NOT NULL,
    supply_name TEXT NOT NULL,
    change INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS listing_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    defaults TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    sku TEXT NOT NULL,
    isbn13 TEXT NOT NULL,
    title TEXT NOT NULL,
    amazon TEXT,
    ebay_lowest REAL,
    on_ebay_already INTEGER NOT NULL DEFAULT 0,
    box TEXT NOT NULL DEFAULT '',
    label_printed_at TEXT,
    condition TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL DEFAULT 1,
    amazon_price REAL,
    ebay_price REAL,
    list_amazon INTEGER NOT NULL,
    list_ebay INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    amazon_result TEXT,
    ebay_result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS batch_items_batch ON batch_items (batch_id);
`);

// Columns added after a table was first created, which CREATE TABLE IF NOT
// EXISTS leaves out of existing databases.
function addColumn(table: string, column: string, type: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn("inventory_items", "amazon_sku", "TEXT");
addColumn("supplies", "takes_turns", "INTEGER NOT NULL DEFAULT 0");
addColumn("batch_items", "box", "TEXT NOT NULL DEFAULT ''");
addColumn("batch_items", "label_printed_at", "TEXT");
addColumn("pickup_requests", "photo", "TEXT");

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
