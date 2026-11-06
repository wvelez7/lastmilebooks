import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { getListingPhotos } from "../server/inventory/ebayApp";
import { parseActiveListingsReport, ReportError, type ReportListing } from "../server/inventory/ebayReport";

// Turns Seller Hub's "All active listings" report into a CSV for Whatnot's
// Inventory → Import from CSV, which creates drafts. Each import creates new
// drafts, so delete old ones before importing a corrected file.
//
//   npx tsx script/ebay-to-whatnot.ts report.csv --shipping "12-15 oz"
//
// Add --photos to fill in the image links from eBay, one API call per listing.
// Needs EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.

// Matches the US template, including its unnamed fourth column:
// docs.google.com/spreadsheets/d/1UNxbyQoXjpjuqYcCE_Ie94OTCEB7lXR7Yz84aynILW4
const HEADERS = [
  "Category", "Sub Category", "Title", "", "Description", "Quantity", "Type", "Price",
  "Shipping Profile", "Offerable", "Hazmat", "Condition", "Cost Per Item", "SKU",
  "Image URL 1", "Image URL 2", "Image URL 3", "Image URL 4",
  "Image URL 5", "Image URL 6", "Image URL 7", "Image URL 8",
];

const SUBCATEGORIES = ["New & Used Books", "Rare & Vintage Books", "Graphic Novels", "Magazines"];
const MAX_PHOTOS = 8;

// eBay's book conditions, by name or numeric id, to the template's Books values.
// Plain "Used" (3000) says nothing about wear, so it's left for a person to grade.
const CONDITIONS: Record<string, string> = {
  "brand new": "Brand New",
  new: "Brand New",
  "1000": "Brand New",
  "like new": "Like New",
  "2750": "Like New",
  "very good": "Very Good",
  "4000": "Very Good",
  good: "Good",
  "5000": "Good",
  acceptable: "Fair",
  "6000": "Fair",
};

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Photos for each item id. A listing that can't be looked up is reported, not
// fatal, but bad keys would fail every listing, so those stop the run.
async function fetchPhotos(listings: ReportListing[]): Promise<Map<string, string[]>> {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    throw new ReportError("--photos needs EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env.");
  }
  const photos = new Map<string, string[]>();
  for (const listing of listings) {
    try {
      photos.set(listing.itemId, (await getListingPhotos(listing.itemId)).slice(0, MAX_PHOTOS));
    } catch (e) {
      const message = (e as Error).message;
      if (message.startsWith("eBay token request failed")) throw new ReportError(message);
      console.log(`  No photos for ${listing.itemId}: ${message}`);
    }
  }
  return photos;
}

function whatnotRow(
  listing: ReportListing,
  type: string,
  shipping: string,
  subcategory: string,
  photos: string[],
): string[] {
  const condition = CONDITIONS[(listing.condition ?? "").trim().toLowerCase()] ?? "";
  const description = listing.isbn ? `${listing.title}\nISBN ${listing.isbn}` : listing.title;
  const row = [
    "Books", subcategory, listing.title, "", description, String(listing.quantity), type,
    listing.price.toFixed(2), shipping, "", "Not Hazmat", condition, "", listing.sku ?? "",
    ...photos,
  ];
  return [...row, ...Array<string>(HEADERS.length - row.length).fill("")];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      shipping: { type: "string", default: "1 lb" },
      type: { type: "string", default: "Buy It Now" },
      subcategory: { type: "string", default: "New & Used Books" },
      photos: { type: "boolean", default: false },
    },
  });

  const input = positionals[0];
  if (!input) throw new ReportError("Usage: npx tsx script/ebay-to-whatnot.ts <report.csv> [--shipping \"12-15 oz\"]");
  if (!SUBCATEGORIES.includes(values.subcategory)) {
    throw new ReportError(`--subcategory must be one of: ${SUBCATEGORIES.join(", ")}`);
  }

  const { listings, skipped } = parseActiveListingsReport(await readFile(input, "utf8"), null);
  const inStock = listings.filter((l) => l.quantity > 0);
  const photos = values.photos ? await fetchPhotos(inStock) : new Map<string, string[]>();
  const rows = inStock.map((l) =>
    whatnotRow(l, values.type, values.shipping, values.subcategory, photos.get(l.itemId) ?? []),
  );

  const parsed = path.parse(input);
  const out = values.out ?? path.join(parsed.dir, `${parsed.name}-whatnot.csv`);
  const lines = [HEADERS, ...rows].map((row) => row.map(csvCell).join(","));
  await writeFile(out, lines.join("\r\n") + "\r\n");

  const ungraded = inStock.filter((l) => !CONDITIONS[(l.condition ?? "").trim().toLowerCase()]);
  const noSku = inStock.filter((l) => !l.sku);

  console.log(`Wrote ${rows.length} listings to ${out}`);
  console.log(`Shipping profile: ${values.shipping}. Type: ${values.type}.`);
  if (listings.length > inStock.length) console.log(`Left out ${listings.length - inStock.length} sold-out listings.`);
  if (skipped) console.log(`Skipped ${skipped} report rows with no usable item number, title or price.`);
  if (values.photos) {
    const withPhotos = inStock.filter((l) => photos.get(l.itemId)?.length).length;
    console.log(`Photos found for ${withPhotos} of ${inStock.length} listings.`);
  }
  if (ungraded.length) {
    console.log(`\n${ungraded.length} need a Condition filled in (eBay's value didn't map):`);
    for (const l of ungraded) console.log(`  ${l.itemId}  ${l.condition ?? "(blank)"}  ${l.title}`);
  }
  if (noSku.length) {
    console.log(`\n${noSku.length} have no Custom label, so the inventory sync won't link them:`);
    for (const l of noSku) console.log(`  ${l.itemId}  ${l.title}`);
  }
}

main().catch((e) => {
  if (!(e instanceof ReportError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
});
