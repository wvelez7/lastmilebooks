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

export const insertPickupRequestSchema = createInsertSchema(pickupRequests, {
  fullName: (s) => s.min(2, "Please enter your full name"),
  email: (s) => s.email("Please enter a valid email"),
  phone: (s) => s.min(7, "Please enter a valid phone number"),
  pickupAddress: (s) => s.min(5, "Please enter a street address"),
  city: (s) => s.min(2, "Please enter a city"),
  numberOfBoxes: (s) => s.min(1, "How many boxes?"),
  preferredDate: (s) => s.min(1, "Pick a preferred date"),
}).omit({ id: true, createdAt: true, emailStatus: true });

export type InsertPickupRequest = z.infer<typeof insertPickupRequestSchema>;
export type PickupRequest = typeof pickupRequests.$inferSelect;
