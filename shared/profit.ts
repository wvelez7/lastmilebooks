import { z } from "zod";

// Profit estimate for the barcode scanner, shared so the server and the page
// always agree. eBay charges its final value fee on the whole order, including
// shipping and the sales tax the buyer pays, even though the seller never
// keeps that tax.

export const scanSettingsSchema = z.object({
  feePercent: z.number().min(0).max(100), // final value fee, books category
  orderFeeSmall: z.number().min(0), // per-order fee, order total $10 or less
  orderFeeLarge: z.number().min(0), // per-order fee, order total over $10
  salesTaxPercent: z.number().min(0).max(100), // typical buyer rate (varies by state)
  shippingCost: z.number().min(0), // postage + supplies you pay per book
  bookCost: z.number().min(0), // what you paid for the average book
});

export type ScanSettings = z.infer<typeof scanSettingsSchema>;

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  feePercent: 15.3,
  orderFeeSmall: 0.3,
  orderFeeLarge: 0.4,
  salesTaxPercent: 8,
  shippingCost: 5.5,
  bookCost: 0,
};

const SMALL_ORDER_LIMIT = 10;

export interface ProfitBreakdown {
  price: number;
  shippingCharged: number; // what the buyer pays for shipping
  salesTax: number;
  finalValueFee: number;
  orderFee: number;
  shippingCost: number;
  bookCost: number;
  profit: number;
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// shippingCharged null means calculated shipping: the buyer covers about what
// the postage costs, so it comes out even.
export function computeProfit(
  price: number,
  shippingCharged: number | null,
  settings: ScanSettings,
): ProfitBreakdown {
  const shipping = shippingCharged ?? settings.shippingCost;
  const subtotal = price + shipping;
  const salesTax = subtotal * (settings.salesTaxPercent / 100);
  const orderTotal = subtotal + salesTax;
  const finalValueFee = orderTotal * (settings.feePercent / 100);
  const orderFee = orderTotal > SMALL_ORDER_LIMIT ? settings.orderFeeLarge : settings.orderFeeSmall;
  return {
    price: roundCents(price),
    shippingCharged: roundCents(shipping),
    salesTax: roundCents(salesTax),
    finalValueFee: roundCents(finalValueFee),
    orderFee,
    shippingCost: settings.shippingCost,
    bookCost: settings.bookCost,
    profit: roundCents(subtotal - finalValueFee - orderFee - settings.shippingCost - settings.bookCost),
  };
}

// Barcodes and listings write the same book differently (ISBN-10, ISBN-13,
// hyphens), so everything is compared as ISBN-13. Returns null for anything
// that isn't a valid ISBN, such as "Does not apply".
export function toIsbn13(value: string): string | null {
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    const body = `978${s.slice(0, 9)}`;
    return body + isbn13CheckDigit(body);
  }
  if (/^97[89]\d{10}$/.test(s) && isbn13CheckDigit(s.slice(0, 12)) === s[12]) return s;
  return null;
}

function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
