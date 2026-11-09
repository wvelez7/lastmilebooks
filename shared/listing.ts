import { z } from "zod";

// Listing a scanned book on Amazon and eBay at once (/#/scan). Both get the
// same SKU so the inventory sync can take one down when the other sells.

export const BOOK_CONDITIONS = [
  { value: "new", label: "New", amazon: "new_new", ebayId: 1000 },
  { value: "like_new", label: "Like New", amazon: "used_like_new", ebayId: 2750 },
  { value: "very_good", label: "Very Good", amazon: "used_very_good", ebayId: 4000 },
  { value: "good", label: "Good", amazon: "used_good", ebayId: 5000 },
  { value: "acceptable", label: "Acceptable", amazon: "used_acceptable", ebayId: 6000 },
] as const;

export type BookCondition = (typeof BOOK_CONDITIONS)[number]["value"];

export function bookCondition(value: BookCondition) {
  return BOOK_CONDITIONS.find((c) => c.value === value)!;
}

const price = z.number().min(0.99, "Price must be at least $0.99").max(10_000);

export const listBookSchema = z
  .object({
    code: z.string().trim().min(1),
    title: z.string().trim().min(1, "Title is required").max(200),
    asin: z.string().trim().regex(/^[A-Z0-9]{10}$/).nullable(),
    condition: z.enum(BOOK_CONDITIONS.map((c) => c.value) as [BookCondition, ...BookCondition[]]),
    note: z.string().trim().max(1000),
    quantity: z.number().int().min(1).max(99),
    amazonPrice: price.nullable(),
    ebayPrice: price.nullable(),
  })
  .refine((b) => b.amazonPrice !== null || b.ebayPrice !== null, "Pick Amazon, eBay or both")
  .refine((b) => b.amazonPrice === null || b.asin !== null, "This book isn't on Amazon");

export type ListBookRequest = z.infer<typeof listBookSchema>;

export interface ListResult {
  ok: boolean;
  message: string; // what happened, in plain words
  url?: string;
}

export interface ListBookResponse {
  sku: string;
  amazon: ListResult | null; // null = not asked for
  ebay: ListResult | null;
}

// Same SKU on every marketplace: the ISBN plus a timestamp, so several copies
// of one book each get their own. Amazon allows 40 characters.
export function newSku(isbn13: string, now = Date.now()): string {
  return `${isbn13}-${now.toString(36).toUpperCase()}`;
}
