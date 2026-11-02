import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
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
