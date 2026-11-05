import { toIsbn13 } from "@shared/profit";
import type { EbayActiveListing, EbayListingDetails } from "./ebay";

// Seller Hub's "All active listings" report (Reports → Downloads), for loading
// the scanner without eBay API access. Column names vary, so they're matched
// loosely, and a file that doesn't look like this report is refused rather
// than imported with wrong prices.

export type ReportListing = EbayActiveListing & Omit<EbayListingDetails, "imageUrl">;

export interface ParsedReport {
  listings: ReportListing[];
  skipped: number;
}

export class ReportError extends Error {}

const HEADER_SEARCH_ROWS = 20; // some reports start with a few lines of notes
const ITEM_ID = ["itemnumber", "itemid"];
const TITLE = ["title"];
const SKU = ["customlabelsku", "customlabel", "sku"];
const QUANTITY = ["availablequantity", "quantityavailable", "quantity"];
const PRICES = ["currentprice", "startprice", "auctionbuyitnowprice", "buyitnowprice", "price"];
const CONDITION = ["condition", "conditiondescription"];
const ISBNS = ["pisbn", "isbn", "pean", "ean"];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') cell += text[++i];
      else quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

function normalize(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function column(headers: string[], names: string[]): number {
  for (const name of names) {
    const i = headers.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

function parsePrice(value: string | undefined): number {
  const n = Number((value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// `shipping` is what buyers pay, which the report doesn't include. Null means
// calculated shipping.
export function parseActiveListingsReport(text: string, shipping: number | null): ParsedReport {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const headerIndex = rows
    .slice(0, HEADER_SEARCH_ROWS)
    .findIndex((r) => {
      const headers = r.map(normalize);
      return column(headers, ITEM_ID) >= 0 && column(headers, TITLE) >= 0;
    });
  if (headerIndex < 0) {
    throw new ReportError(
      "This doesn't look like an eBay active listings report: no Item number and Title columns.",
    );
  }

  const headers = rows[headerIndex].map(normalize);
  const priceColumns = PRICES.map((name) => headers.indexOf(name)).filter((i) => i >= 0);
  if (priceColumns.length === 0) {
    throw new ReportError("This report has no price column. Download the \"All active listings\" report.");
  }
  const itemColumn = column(headers, ITEM_ID);
  const titleColumn = column(headers, TITLE);
  const skuColumn = column(headers, SKU);
  const quantityColumn = column(headers, QUANTITY);
  const conditionColumn = column(headers, CONDITION);
  const isbnColumns = ISBNS.map((name) => headers.indexOf(name)).filter((i) => i >= 0);

  const byId = new Map<string, ReportListing>();
  let skipped = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    const itemId = row[itemColumn]?.trim() ?? "";
    if (!itemId) continue; // blank lines
    const title = row[titleColumn]?.trim();
    const price = priceColumns.map((i) => parsePrice(row[i])).find((p) => p > 0);
    if (!/^\d+$/.test(itemId) || !title || !price) {
      skipped++;
      continue;
    }
    if (byId.has(itemId)) continue; // variations repeat the item number
    const quantity = quantityColumn >= 0 ? Number(row[quantityColumn]) : 1;
    byId.set(itemId, {
      itemId,
      sku: (skuColumn >= 0 && row[skuColumn]?.trim()) || null,
      title,
      quantity: Number.isInteger(quantity) && quantity >= 0 ? quantity : 1,
      price,
      url: `https://www.ebay.com/itm/${itemId}`,
      isbn: isbnColumns.map((i) => toIsbn13(row[i] ?? "")).find(Boolean) ?? null,
      shipping,
      condition: (conditionColumn >= 0 && row[conditionColumn]?.trim()) || null,
    });
  }
  return { listings: Array.from(byId.values()), skipped };
}
