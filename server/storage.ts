import { pickupRequests } from "@shared/schema";
import type { PickupRequest, InsertPickupRequest } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";

const sqlite = new Database("data.db");
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
