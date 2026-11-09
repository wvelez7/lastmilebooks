import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "wouter";
import type { EbayListingRow } from "@shared/schema";
import { computeAmazonProfit, computeProfit, DEFAULT_SCAN_SETTINGS, scanSettingsSchema } from "@shared/profit";
import type { ScanSettings } from "@shared/profit";
import { BOOK_CONDITIONS, listBookSchema } from "@shared/listing";
import type { BookCondition, ListBookResponse, ListResult } from "@shared/listing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

// Phone page for checking a book against the eBay store and Amazon's prices,
// and listing it on either or both.
// Not linked from the site; open /#/scan and enter the ADMIN_KEY. Remembered on
// the device (unlike /#/inventory) because it's opened many times a day from
// the home screen.

const KEY_STORAGE = "lmb-scan-key";
const RESCAN_MS = 3000; // ignore the same barcode while it's still in frame
const MAX_ROWS = 100;

interface ListingsResponse {
  status: { connected: boolean; refreshing: boolean; refreshedAt: string | null; missingIsbn: number };
  settings: ScanSettings;
  listings: EbayListingRow[];
}

interface MarketOffer {
  title: string;
  price: number;
  shipping: number | null;
  condition: string | null;
  url: string | null;
  imageUrl: string | null;
}

interface LookupResponse {
  code: string;
  listings: EbayListingRow[];
  market: MarketOffer[];
  marketError: string | null;
  marketAvailable: boolean;
  amazon: AmazonBook | null;
  amazonError: string | null;
  amazonAvailable: boolean;
  canList: { amazon: boolean; ebay: boolean };
}

interface AmazonPrice {
  price: number;
  shipping: number;
}

interface AmazonBook {
  asin: string;
  title: string;
  imageUrl: string | null;
  salesRank: number | null;
  lowestUsed: AmazonPrice | null; // sellers who ship it themselves
  lowestUsedFba: AmazonPrice | null;
  lowestNew: AmazonPrice | null;
  buyBoxUsed: AmazonPrice | null;
  usedOffers: number;
  newOffers: number;
  restriction: string | null;
}

type Api = (method: string, url: string, body?: unknown) => Promise<any>;

function readKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function writeKey(key: string) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {}
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hr ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function ProfitBreakdown({
  price,
  shipping,
  settings,
}: {
  price: number;
  shipping: number | null;
  settings: ScanSettings;
}) {
  const p = computeProfit(price, shipping, settings);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-muted-foreground">eBay price</div>
          <div className="text-2xl font-semibold tabular-nums" data-testid="text-price">
            {money(p.price)}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Profit if sold</div>
          <div
            className={`text-2xl font-semibold tabular-nums ${p.profit < 0 ? "text-destructive" : "text-green-700 dark:text-green-400"}`}
            data-testid="text-profit"
          >
            {money(p.profit)}
          </div>
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">How this adds up</summary>
        <div className="mt-2 space-y-1">
          <Row label="Book price" value={money(p.price)} />
          <Row
            label={shipping === null ? "Shipping paid by buyer (calculated, est.)" : "Shipping paid by buyer"}
            value={money(p.shippingCharged)}
          />
          <Row label={`eBay fee (${settings.feePercent}% incl. shipping + tax)`} value={money(-p.finalValueFee)} />
          <Row label="eBay per-order fee" value={money(-p.orderFee)} />
          <Row label="Postage + supplies" value={money(-p.shippingCost)} />
          <Row label="Cost of book" value={money(-p.bookCost)} />
        </div>
      </details>
    </>
  );
}

function ListingCard({ listing, settings }: { listing: EbayListingRow; settings: ScanSettings }) {
  return (
    <Card data-testid={`card-listing-${listing.itemId}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex gap-3">
          {listing.imageUrl && (
            <img src={listing.imageUrl} alt="" className="h-16 w-12 flex-none rounded object-cover" />
          )}
          <div className="min-w-0">
            <div className="font-medium leading-snug">{listing.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {listing.condition && <Badge variant="secondary">{listing.condition}</Badge>}
              <span>Qty {listing.quantity}</span>
              {listing.sku && <span>SKU {listing.sku}</span>}
            </div>
          </div>
        </div>
        <ProfitBreakdown price={listing.price} shipping={listing.shipping} settings={settings} />
        {listing.url && (
          <a href={listing.url} target="_blank" rel="noreferrer" className="block text-sm underline">
            View on eBay
          </a>
        )}
      </CardContent>
    </Card>
  );
}

function landed(p: AmazonPrice | null): string {
  return p ? money(p.price + p.shipping) : "—";
}

// Starts at the price that matches the cheapest used copy someone ships
// themselves (counting shipping), which is what buyers compare.
function suggestedAmazonPrice(book: AmazonBook, settings: ScanSettings): number | null {
  const match = book.lowestUsed ?? book.buyBoxUsed ?? book.lowestUsedFba;
  if (!match) return null;
  return Math.max(0.01, Math.round((match.price + match.shipping - settings.amazonShippingCredit) * 100) / 100);
}

// The price box here is also the Amazon price used when listing.
function AmazonCard({
  book,
  settings,
  priceDraft,
  setPriceDraft,
}: {
  book: AmazonBook;
  settings: ScanSettings;
  priceDraft: string;
  setPriceDraft: (value: string) => void;
}) {
  const price = Number(priceDraft);
  const p = priceDraft.trim() !== "" && price > 0 ? computeAmazonProfit(price, settings) : null;

  return (
    <Card data-testid="card-amazon">
      <CardContent className="space-y-3 p-4">
        <div className="flex gap-3">
          {book.imageUrl && <img src={book.imageUrl} alt="" className="h-16 w-12 flex-none rounded object-cover" />}
          <div className="min-w-0">
            <div className="text-xs font-medium text-muted-foreground">Amazon</div>
            <div className="font-medium leading-snug">{book.title || book.asin}</div>
            <div className="mt-1 text-sm" data-testid="text-sales-rank">
              {book.salesRank === null ? "No sales rank" : `Rank #${book.salesRank.toLocaleString()} in Books`}
            </div>
          </div>
        </div>
        {book.restriction && (
          <p className="rounded-md border border-destructive/40 p-2 text-sm text-destructive" data-testid="text-amazon-restricted">
            Restricted for you on Amazon: {book.restriction}
          </p>
        )}
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Used, seller ships</div>
            <div className="tabular-nums" data-testid="text-amazon-used">{landed(book.lowestUsed)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Used, FBA</div>
            <div className="tabular-nums">{landed(book.lowestUsedFba)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">New</div>
            <div className="tabular-nums">{landed(book.lowestNew)}</div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Lowest prices including shipping. {book.usedOffers} used and {book.newOffers} new offers.
        </p>
        <div className="grid grid-cols-2 items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="amazon-price" className="text-xs text-muted-foreground">Your Amazon price</Label>
            <Input
              id="amazon-price"
              inputMode="decimal"
              value={priceDraft}
              onChange={(e) => setPriceDraft(e.target.value)}
              data-testid="input-amazon-price"
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Profit if sold</div>
            <div
              className={`text-2xl font-semibold tabular-nums ${p && p.profit < 0 ? "text-destructive" : "text-green-700 dark:text-green-400"}`}
              data-testid="text-amazon-profit"
            >
              {p ? money(p.profit) : "—"}
            </div>
          </div>
        </div>
        {p && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">How this adds up</summary>
            <div className="mt-2 space-y-1">
              <Row label="Book price" value={money(p.price)} />
              <Row label="Shipping paid by buyer" value={money(p.shippingCredit)} />
              <Row label={`Amazon referral fee (${settings.amazonReferralPercent}% incl. shipping)`} value={money(-p.referralFee)} />
              <Row label="Amazon closing fee" value={money(-p.closingFee)} />
              <Row label="Postage + supplies" value={money(-p.shippingCost)} />
              <Row label="Cost of book" value={money(-p.bookCost)} />
            </div>
          </details>
        )}
        <a
          href={`https://www.amazon.com/dp/${book.asin}`}
          target="_blank"
          rel="noreferrer"
          className="block text-sm underline"
        >
          View on Amazon
        </a>
      </CardContent>
    </Card>
  );
}

// A new eBay listing gets the account's default shipping policy, so its
// profit uses what the store's listings most often charge (null = calculated).
function typicalShipping(listings: EbayListingRow[]): number | null {
  const counts = new Map<number | null, number>();
  for (const l of listings) counts.set(l.shipping, (counts.get(l.shipping) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  counts.forEach((n, shipping) => {
    if (n > bestCount) [best, bestCount] = [shipping, n];
  });
  return best;
}

function priceOrNull(draft: string): number | null {
  const n = Number(draft);
  return draft.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

function ResultLine({ where, result }: { where: string; result: ListResult }) {
  return (
    <p className={`text-sm ${result.ok ? "" : "text-destructive"}`} data-testid={`text-listed-${where.toLowerCase()}`}>
      <span className="font-medium">{where}: </span>
      {result.ok ? "✓ " : "Not listed. "}
      {result.message}{" "}
      {result.url && (
        <a href={result.url} target="_blank" rel="noreferrer" className="underline">
          View
        </a>
      )}
    </p>
  );
}

// List the scanned book on Amazon, eBay or both. The Amazon price comes from
// the Amazon card above.
function ListPanel({
  lookup,
  settings,
  amazonPrice,
  ebayShipping,
  api,
}: {
  lookup: LookupResponse;
  settings: ScanSettings;
  amazonPrice: string;
  ebayShipping: number | null;
  api: Api;
}) {
  const { toast } = useToast();
  const book = lookup.amazon;
  const ownListing = lookup.listings[0];
  const shipping = ownListing ? ownListing.shipping : ebayShipping;
  const amazonPossible = lookup.canList.amazon && book !== null;
  const ebayPossible = lookup.canList.ebay;
  const defaultEbayPrice = ownListing?.price ?? lookup.market[0]?.price ?? priceOrNull(amazonPrice);

  const [title, setTitle] = useState(book?.title || ownListing?.title || "");
  const [condition, setCondition] = useState<BookCondition>("good");
  const [note, setNote] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [onAmazon, setOnAmazon] = useState(amazonPossible && !book?.restriction);
  const [onEbay, setOnEbay] = useState(ebayPossible);
  const [ebayPrice, setEbayPrice] = useState(defaultEbayPrice ? defaultEbayPrice.toFixed(2) : "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ListBookResponse | null>(null);

  if (!amazonPossible && !ebayPossible) {
    if (lookup.canList.amazon || lookup.canList.ebay) return null; // set up, just nowhere to list this book
    return (
      <p className="text-xs text-muted-foreground" data-testid="text-listing-off">
        Listing from here needs AMAZON_SELLER_ID (Amazon) or EBAY_POSTAL_CODE (eBay) set on the server.
      </p>
    );
  }

  const ebayNumber = priceOrNull(ebayPrice);
  const request = {
    code: lookup.code,
    title,
    asin: book?.asin ?? null,
    condition,
    note,
    quantity: Number(quantity),
    amazonPrice: onAmazon ? priceOrNull(amazonPrice) : null,
    ebayPrice: onEbay ? ebayNumber : null,
  };
  const check = listBookSchema.safeParse(request);
  const problem =
    (onAmazon && request.amazonPrice === null && "Enter an Amazon price above") ||
    (onEbay && request.ebayPrice === null && "Enter an eBay price") ||
    (!check.success && check.error.issues[0]?.message) ||
    null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    try {
      const res: ListBookResponse = await api("POST", "/api/scan/list", request);
      setResult(res);
      const listed = [res.amazon?.ok && "Amazon", res.ebay?.ok && "eBay"].filter(Boolean).join(" and ");
      toast(
        listed
          ? { title: `Listed on ${listed}`, description: `SKU ${res.sku}` }
          : { title: "Not listed", description: "See the details below.", variant: "destructive" },
      );
    } catch (err) {
      toast({ title: "Listing failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Card data-testid="card-list-result">
        <CardContent className="space-y-2 p-4">
          <div className="font-medium">Write SKU {result.sku} on the book</div>
          {result.amazon && <ResultLine where="Amazon" result={result.amazon} />}
          {result.ebay && <ResultLine where="eBay" result={result.ebay} />}
          <Button variant="outline" className="w-full" onClick={() => setResult(null)} data-testid="button-list-again">
            List another copy
          </Button>
        </CardContent>
      </Card>
    );
  }

  const ebayProfit = ebayNumber === null ? null : computeProfit(ebayNumber, shipping, settings).profit;

  return (
    <Card data-testid="card-list">
      <CardContent className="p-4">
        <form className="space-y-3" onSubmit={submit}>
          <div className="font-medium">List this book</div>
          <div className="space-y-1">
            <Label htmlFor="list-title">Title</Label>
            <Input id="list-title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="input-list-title" />
          </div>
          <div className="grid grid-cols-[1fr_5rem] gap-3">
            <div className="space-y-1">
              <Label htmlFor="list-condition">Condition</Label>
              <select
                id="list-condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value as BookCondition)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm"
                data-testid="select-condition"
              >
                {BOOK_CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="list-qty">Qty</Label>
              <Input
                id="list-qty"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                data-testid="input-list-qty"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="list-note">Condition note</Label>
            <textarea
              id="list-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Light shelf wear, clean pages, no markings."
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm"
              data-testid="input-list-note"
            />
          </div>

          <label className={`flex items-center gap-2 text-sm ${amazonPossible ? "" : "text-muted-foreground"}`}>
            <input
              type="checkbox"
              checked={onAmazon}
              disabled={!amazonPossible}
              onChange={(e) => setOnAmazon(e.target.checked)}
              data-testid="checkbox-amazon"
            />
            Amazon at {priceOrNull(amazonPrice) === null ? "the price above" : money(priceOrNull(amazonPrice)!)}
            {!book && " (not on Amazon)"}
          </label>

          <div className="space-y-2">
            <label className={`flex items-center gap-2 text-sm ${ebayPossible ? "" : "text-muted-foreground"}`}>
              <input
                type="checkbox"
                checked={onEbay}
                disabled={!ebayPossible}
                onChange={(e) => setOnEbay(e.target.checked)}
                data-testid="checkbox-ebay"
              />
              eBay{!ebayPossible && " (not set up)"}
            </label>
            {onEbay && (
              <div className="grid grid-cols-2 items-end gap-3 pl-6">
                <div className="space-y-1">
                  <Label htmlFor="list-ebay-price" className="text-xs text-muted-foreground">eBay price</Label>
                  <Input
                    id="list-ebay-price"
                    inputMode="decimal"
                    value={ebayPrice}
                    onChange={(e) => setEbayPrice(e.target.value)}
                    data-testid="input-ebay-price"
                  />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    {shipping === null
                      ? "Profit if buyer pays postage"
                      : `Profit with ${shipping === 0 ? "free" : money(shipping)} shipping`}
                  </div>
                  <div
                    className={`text-lg font-semibold tabular-nums ${ebayProfit !== null && ebayProfit < 0 ? "text-destructive" : "text-green-700 dark:text-green-400"}`}
                    data-testid="text-ebay-list-profit"
                  >
                    {ebayProfit === null ? "—" : money(ebayProfit)}
                  </div>
                </div>
              </div>
            )}
          </div>

          {problem && (onAmazon || onEbay) && <p className="text-xs text-muted-foreground">{problem}</p>}
          <Button type="submit" className="w-full" disabled={busy || Boolean(problem)} data-testid="button-list">
            {busy ? "Listing…" : "List"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// One scanned book: the Amazon card, your eBay listings or other sellers'
// prices, and the listing form. Keyed by scan so its inputs start fresh.
function LookupResult({
  lookup,
  settings,
  ebayShipping,
  api,
}: {
  lookup: LookupResponse;
  settings: ScanSettings;
  ebayShipping: number | null;
  api: Api;
}) {
  const suggested = lookup.amazon ? suggestedAmazonPrice(lookup.amazon, settings) : null;
  const [amazonPrice, setAmazonPrice] = useState(suggested === null ? "" : suggested.toFixed(2));

  return (
    <div className="space-y-3" data-testid="section-result">
      <p className="text-xs text-muted-foreground">Barcode {lookup.code}</p>

      {lookup.amazon && (
        <AmazonCard book={lookup.amazon} settings={settings} priceDraft={amazonPrice} setPriceDraft={setAmazonPrice} />
      )}
      {lookup.amazonAvailable && !lookup.amazon && !lookup.amazonError && (
        <p className="text-sm text-muted-foreground" data-testid="text-amazon-missing">Not found on Amazon.</p>
      )}
      {lookup.amazonError && (
        <p className="text-sm text-destructive" data-testid="text-amazon-error">{lookup.amazonError}</p>
      )}

      {lookup.listings.map((l) => (
        <ListingCard key={l.itemId} listing={l} settings={settings} />
      ))}

      {lookup.listings.length === 0 && (
        <>
          <p className="font-medium" data-testid="text-not-found">
            Not in your eBay inventory.
          </p>
          {lookup.market.length > 0 && (
            <p className="text-sm text-muted-foreground">Cheapest listings from other sellers:</p>
          )}
          {lookup.market.map((m, i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-4">
                <div className="font-medium leading-snug">{m.title}</div>
                {m.condition && <Badge variant="secondary">{m.condition}</Badge>}
                <ProfitBreakdown price={m.price} shipping={m.shipping} settings={settings} />
                {m.url && (
                  <a href={m.url} target="_blank" rel="noreferrer" className="block text-sm underline">
                    View on eBay
                  </a>
                )}
              </CardContent>
            </Card>
          ))}
          {lookup.marketAvailable && lookup.market.length === 0 && !lookup.marketError && (
            <p className="text-sm text-muted-foreground">No other fixed-price listings found either.</p>
          )}
          {lookup.marketError && <p className="text-sm text-destructive">Couldn't check eBay prices just now.</p>}
        </>
      )}

      <ListPanel lookup={lookup} settings={settings} amazonPrice={amazonPrice} ebayShipping={ebayShipping} api={api} />
    </div>
  );
}

function CameraScanner({ onCode }: { onCode: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("The camera only works on the https:// site.");
        }
        // Loaded here so the barcode code never weighs down the public site.
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        const hints = new Map<number, unknown>([
          [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.UPC_A]],
          [DecodeHintType.TRY_HARDER, true],
        ]);
        const reader = new BrowserMultiFormatReader(hints as never, { delayBetweenScanAttempts: 150 });
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } },
          videoRef.current!,
          (result) => {
            if (result) onCodeRef.current(result.getText());
          },
        );
        if (cancelled) controls.stop();
        else stop = () => controls.stop();
      } catch (e) {
        if (cancelled) return;
        const denied = (e as Error).name === "NotAllowedError";
        setError(denied ? "Camera permission is off. Allow it for this site, then try again." : (e as Error).message);
        setOn(false);
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [on]);

  return (
    <div className="space-y-2">
      <div className={`relative overflow-hidden rounded-lg bg-black ${on ? "aspect-video" : "hidden"}`}>
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        <div className="pointer-events-none absolute inset-x-6 top-1/2 h-0.5 bg-red-500/80" />
      </div>
      <Button
        className="w-full"
        variant={on ? "outline" : "default"}
        onClick={() => {
          setError(null);
          setOn(!on);
        }}
        data-testid="button-camera"
      >
        {on ? "Stop camera" : "Scan with camera"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function ReportImport({ onImport }: { onImport: (file: File, shipping: string) => Promise<void> }) {
  const [shipping, setShipping] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const shippingValid = shipping.trim() === "" || Number(shipping) >= 0;

  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Upload eBay report</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          In Seller Hub: Reports → Downloads → Download report → Listings → All active listings. Upload the file as
          eBay gives it, because opening and saving it in Excel can damage ISBNs. This replaces the list here.
        </p>
        <div className="space-y-1">
          <Label htmlFor="report-shipping">Shipping buyers pay ($)</Label>
          <Input
            id="report-shipping"
            inputMode="decimal"
            value={shipping}
            onChange={(e) => setShipping(e.target.value)}
            data-testid="input-report-shipping"
          />
          <p className="text-xs text-muted-foreground">
            Leave blank when buyers pay the postage. Enter a flat rate only if you charge one.
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            try {
              await onImport(file, shipping.trim());
            } finally {
              setBusy(false);
            }
          }}
          data-testid="input-report-file"
        />
        <Button
          className="w-full"
          variant="secondary"
          disabled={busy || !shippingValid}
          onClick={() => fileRef.current?.click()}
          data-testid="button-report-upload"
        >
          {busy ? "Uploading…" : "Choose file"}
        </Button>
      </div>
    </details>
  );
}

const SETTING_FIELDS: { key: keyof ScanSettings; label: string; hint?: string }[] = [
  { key: "bookCost", label: "Cost per book ($)", hint: "Your average. $0 for donated books." },
  { key: "shippingCost", label: "Postage + supplies you pay ($)", hint: "Media Mail plus the mailer." },
  { key: "feePercent", label: "eBay final value fee (%)", hint: "Check Seller Hub; a Store plan lowers it." },
  { key: "orderFeeSmall", label: "Per-order fee, orders $10 or less ($)" },
  { key: "orderFeeLarge", label: "Per-order fee, orders over $10 ($)" },
  { key: "salesTaxPercent", label: "Typical buyer sales tax (%)", hint: "eBay's fee is charged on this too." },
  { key: "amazonReferralPercent", label: "Amazon referral fee (%)", hint: "Books: 15%, charged on shipping too." },
  { key: "amazonClosingFee", label: "Amazon closing fee ($)", hint: "Flat fee on every book sold." },
  { key: "amazonShippingCredit", label: "Amazon shipping paid by buyer ($)", hint: "Set by Amazon for books." },
];

function SettingsForm({
  settings,
  onSave,
}: {
  settings: ScanSettings;
  onSave: (next: ScanSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])));
  }, [settings]);

  const parsed = scanSettingsSchema.safeParse(
    Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim() === "" ? NaN : Number(v)])),
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed.success) return;
    setSaving(true);
    try {
      await onSave(parsed.data);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      {SETTING_FIELDS.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={f.key}>{f.label}</Label>
          <Input
            id={f.key}
            inputMode="decimal"
            value={draft[f.key] ?? ""}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            data-testid={`input-${f.key}`}
          />
          {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
        </div>
      ))}
      <Button type="submit" className="w-full" disabled={!parsed.success || saving} data-testid="button-save-settings">
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

export default function Scan() {
  const { toast } = useToast();
  const [adminKey, setAdminKey] = useState(readKey);
  const [keyDraft, setKeyDraft] = useState("");
  const [data, setData] = useState<ListingsResponse | null>(null);
  const [typed, setTyped] = useState("");
  const [lookup, setLookup] = useState<LookupResponse | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [looking, setLooking] = useState(false);
  const [filter, setFilter] = useState("");
  const lastScan = useRef({ code: "", at: 0 });

  const api = useCallback(
    async (method: string, url: string, body?: unknown) => {
      const res = await fetch(url, {
        method,
        headers: { "x-admin-key": adminKey, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) {
        writeKey("");
        setAdminKey("");
        throw new Error("Wrong admin key");
      }
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `Request failed (${res.status})`);
      return json;
    },
    [adminKey],
  );

  const load = useCallback(async () => {
    if (!adminKey) return;
    try {
      setData(await api("GET", "/api/scan/listings"));
    } catch (e) {
      toast({ title: "Couldn't load listings", description: (e as Error).message, variant: "destructive" });
    }
  }, [adminKey, api, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refreshing reads listings one at a time, so watch it fill in.
  const refreshing = data?.status.refreshing ?? false;
  useEffect(() => {
    if (!refreshing) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [refreshing, load]);

  const scan = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      if (!code) return;
      const now = Date.now();
      if (code === lastScan.current.code && now - lastScan.current.at < RESCAN_MS) return;
      lastScan.current = { code, at: now };
      navigator.vibrate?.(60);
      setLooking(true);
      try {
        setLookup(await api("GET", `/api/scan/lookup/${encodeURIComponent(code)}`));
        setScanCount((n) => n + 1);
      } catch (e) {
        toast({ title: "Lookup failed", description: (e as Error).message, variant: "destructive" });
      } finally {
        setLooking(false);
      }
    },
    [api, toast],
  );

  if (!adminKey) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Book scanner</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                writeKey(keyDraft);
                setAdminKey(keyDraft);
              }}
            >
              <Input
                type="password"
                placeholder="Admin key"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                autoFocus
                data-testid="input-admin-key"
              />
              <Button type="submit" className="w-full" disabled={!keyDraft} data-testid="button-open">
                Open
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  const settings = data?.settings ?? DEFAULT_SCAN_SETTINGS;
  const status = data?.status;
  const needle = filter.trim().toLowerCase();
  const matching = (data?.listings ?? []).filter((l) =>
    `${l.title} ${l.sku ?? ""} ${l.isbn ?? ""}`.toLowerCase().includes(needle),
  );

  return (
    <main className="mx-auto min-h-screen max-w-md space-y-4 bg-background px-4 py-4">
      <h1 className="text-xl font-semibold">Book scanner</h1>

      {status && !status.connected && (
        <p className="rounded-md border p-3 text-sm" data-testid="text-not-connected">
          {data?.listings.length
            ? `Using your uploaded eBay report${status.refreshedAt ? ` from ${ago(status.refreshedAt)}` : ""}. Prices won't update until you upload a new one.`
            : "eBay isn't connected yet. Upload an eBay report on the Inventory tab to get started."}{" "}
          <Link href="/inventory" className="underline">Connect eBay</Link>
        </p>
      )}

      <Tabs defaultValue="scan">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="scan">Scan</TabsTrigger>
          <TabsTrigger value="inventory" data-testid="tab-inventory">Inventory</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Costs</TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="space-y-4">
          <CameraScanner onCode={(c) => void scan(c)} />

          {/* USB and Bluetooth scanners type the code and press Enter here. */}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              lastScan.current = { code: "", at: 0 };
              void scan(typed);
              setTyped("");
            }}
          >
            <Input
              placeholder="Or type the ISBN"
              inputMode="numeric"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="input-code"
            />
            <Button type="submit" variant="secondary" disabled={!typed.trim() || looking} data-testid="button-lookup">
              Look up
            </Button>
          </form>

          {looking && <p className="text-sm text-muted-foreground">Looking it up…</p>}

          {lookup && !looking && (
            <LookupResult
              key={scanCount}
              lookup={lookup}
              settings={settings}
              ebayShipping={typicalShipping(data?.listings ?? [])}
              api={api}
            />
          )}
        </TabsContent>

        <TabsContent value="inventory" className="space-y-3">
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span data-testid="text-status">
              {data?.listings.length ?? 0} listings
              {status?.refreshedAt ? `, updated ${ago(status.refreshedAt)}` : ""}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={refreshing || !status?.connected}
              onClick={async () => {
                try {
                  await api("POST", "/api/scan/refresh");
                  await load();
                } catch (e) {
                  toast({ title: "Refresh failed", description: (e as Error).message, variant: "destructive" });
                }
              }}
              data-testid="button-refresh"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <ReportImport
            onImport={async (file, shipping) => {
              try {
                const qs = shipping ? `?shipping=${encodeURIComponent(shipping)}` : "";
                const res = await fetch(`/api/scan/import${qs}`, {
                  method: "POST",
                  headers: { "x-admin-key": adminKey, "Content-Type": "text/csv" },
                  body: await file.text(),
                });
                const json = await res.json();
                if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
                await load();
                toast({
                  title: `Loaded ${json.imported} listings`,
                  description: `${json.withIsbn} have an ISBN${json.skipped ? `; ${json.skipped} rows skipped` : ""}.`,
                });
              } catch (e) {
                toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
              }
            }}
          />
          {Boolean(status?.missingIsbn) && (
            <p className="text-xs text-muted-foreground">
              No ISBN on eBay for {status!.missingIsbn} {status!.missingIsbn === 1 ? "listing" : "listings"}, so a scan
              can't find {status!.missingIsbn === 1 ? "it" : "them"}. Add the ISBN on eBay, or use it as the Custom
              label.
            </p>
          )}
          <Input
            placeholder="Search title, SKU or ISBN"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="input-filter"
          />
          <ul className="divide-y">
            {matching.slice(0, MAX_ROWS).map((l) => (
              <li key={l.itemId} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="line-clamp-2">{l.title}</span>
                  <span className="text-xs text-muted-foreground">Qty {l.quantity}</span>
                </span>
                <span className="flex-none text-right tabular-nums">
                  <span className="block">{money(l.price)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {money(computeProfit(l.price, l.shipping, settings).profit)} profit
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {matching.length > MAX_ROWS && (
            <p className="text-xs text-muted-foreground">
              Showing {MAX_ROWS} of {matching.length}. Search to narrow it down.
            </p>
          )}
        </TabsContent>

        <TabsContent value="settings">
          <SettingsForm
            settings={settings}
            onSave={async (next) => {
              try {
                await api("PUT", "/api/scan/settings", next);
                await load();
                toast({ title: "Costs saved" });
              } catch (e) {
                toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
              }
            }}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}
