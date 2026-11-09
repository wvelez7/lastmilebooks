import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "wouter";
import type { EbayListingRow } from "@shared/schema";
import { computeAmazonProfit, computeProfit, DEFAULT_SCAN_SETTINGS, scanSettingsSchema, toIsbn13 } from "@shared/profit";
import type { ScanSettings } from "@shared/profit";
import { suggestedAmazonPrice } from "@shared/listing";
import type { AmazonBook, AmazonPrice, BatchDetail, BatchItem } from "@shared/listing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { BatchItemEditor, BatchTab, BoxField, Research, SkuSettingsForm } from "./ScanBatch";
import type { Api, BatchesResponse } from "./ScanBatch";

// Phone page for checking books against the eBay store and Amazon's prices,
// and listing them in batches (Batch tab), the way Accelerlist does.
// Not linked from the site; open /#/scan and enter the ADMIN_KEY. Remembered on
// the device (unlike /#/inventory) because it's opened many times a day from
// the home screen. Works with a USB or Bluetooth scanner too.

const KEY_STORAGE = "lmb-scan-key";
const BATCH_STORAGE = "lmb-scan-batch";
const AUTO_ADD_STORAGE = "lmb-scan-auto-add";
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

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

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

function AmazonCard({ book, settings }: { book: AmazonBook; settings: ScanSettings }) {
  const suggested = suggestedAmazonPrice(book, settings);
  const p = suggested === null ? null : computeAmazonProfit(suggested, settings);

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
        {p && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Matching lowest used</div>
              <div className="text-2xl font-semibold tabular-nums" data-testid="text-amazon-suggested">{money(p.price)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Profit if sold</div>
              <div
                className={`text-2xl font-semibold tabular-nums ${p.profit < 0 ? "text-destructive" : "text-green-700 dark:text-green-400"}`}
                data-testid="text-amazon-profit"
              >
                {money(p.profit)}
              </div>
            </div>
          </div>
        )}
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

// What a scan found, in the form the batch keeps.
function scanInfo(lookup: LookupResponse) {
  return {
    code: lookup.code,
    amazon: lookup.amazon,
    ebayLowest: lookup.market[0]?.price ?? lookup.listings[0]?.price ?? null,
    onEbayAlready: lookup.listings.reduce((n, l) => n + l.quantity, 0),
    title: lookup.listings[0]?.title ?? null,
  };
}

// One scanned book: its place in the batch, the Amazon card, and your eBay
// listings or other sellers' prices.
function LookupResult({
  lookup,
  added,
  batch,
  settings,
  ebayShipping,
  canList,
  api,
  onAdd,
  onItemChange,
  onItemDelete,
  onNewBatch,
}: {
  lookup: LookupResponse;
  added: BatchItem | null;
  batch: BatchDetail | null;
  settings: ScanSettings;
  ebayShipping: number | null;
  canList: { amazon: boolean; ebay: boolean };
  api: Api;
  onAdd: () => Promise<void>;
  onItemChange: (item: BatchItem) => void;
  onItemDelete: (id: number) => void;
  onNewBatch: () => Promise<void>;
}) {
  const isbn13 = toIsbn13(lookup.code);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3" data-testid="section-result">
      <p className="text-xs text-muted-foreground">Barcode {lookup.code}</p>

      {isbn13 && (
        <Card data-testid="card-batch-item">
          <CardContent className="space-y-3 p-4">
            {added ? (
              <>
                <div className="font-medium" data-testid="text-added">
                  Added to {batch?.name ?? "batch"}
                </div>
                <BatchItemEditor
                  item={added}
                  settings={settings}
                  ebayShipping={ebayShipping}
                  canList={canList}
                  api={api}
                  onChange={onItemChange}
                  onDelete={onItemDelete}
                />
              </>
            ) : batch && batch.status !== "listing" ? (
              <Button
                className="w-full"
                disabled={adding}
                onClick={async () => {
                  setAdding(true);
                  try {
                    await onAdd();
                  } finally {
                    setAdding(false);
                  }
                }}
                data-testid="button-add-to-batch"
              >
                {adding ? "Adding…" : `Add to ${batch.name}`}
              </Button>
            ) : (
              <Button className="w-full" variant="outline" onClick={() => void onNewBatch()} data-testid="button-start-batch">
                Start a batch to list books
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {lookup.amazon && <AmazonCard book={lookup.amazon} settings={settings} />}
      {lookup.amazonAvailable && !lookup.amazon && !lookup.amazonError && (
        <p className="text-sm text-muted-foreground" data-testid="text-amazon-missing">Not found on Amazon.</p>
      )}
      {lookup.amazonError && (
        <p className="text-sm text-destructive" data-testid="text-amazon-error">{lookup.amazonError}</p>
      )}
      {isbn13 && !added && <Research isbn13={isbn13} book={lookup.amazon} />}

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
  const [tab, setTab] = useState("scan");
  const [overview, setOverview] = useState<BatchesResponse | null>(null);
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [added, setAdded] = useState<BatchItem | null>(null);
  const [autoAdd, setAutoAdd] = useState(() => readStored(AUTO_ADD_STORAGE) !== "off");
  const lastScan = useRef({ code: "", at: 0 });
  const batchRef = useRef<BatchDetail | null>(null);
  batchRef.current = batch;
  const autoAddRef = useRef(autoAdd);
  autoAddRef.current = autoAdd;

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

  // ---- Batches ----

  const openBatch = useCallback(
    async (id: number | null) => {
      writeStored(BATCH_STORAGE, id === null ? null : String(id));
      setBatch(id === null ? null : await api("GET", `/api/batches/${id}`));
    },
    [api],
  );

  // Reopens the batch this device last used, else the newest unfinished one.
  const loadBatches = useCallback(async () => {
    if (!adminKey) return;
    try {
      const res: BatchesResponse = await api("GET", "/api/batches");
      setOverview(res);
      const stored = Number(readStored(BATCH_STORAGE));
      const pick = res.batches.find((b) => b.id === stored) ?? res.batches.find((b) => b.status !== "done") ?? null;
      await openBatch(pick?.id ?? null);
    } catch (e) {
      toast({ title: "Couldn't load batches", description: (e as Error).message, variant: "destructive" });
    }
  }, [adminKey, api, openBatch, toast]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  // Listing runs on the server; watch it work through the batch.
  const batchListing = batch?.status === "listing";
  const batchId = batch?.id;
  useEffect(() => {
    if (!batchListing || batchId === undefined) return;
    const t = setInterval(async () => {
      try {
        const next: BatchDetail = await api("GET", `/api/batches/${batchId}`);
        setBatch(next);
        if (next.status !== "listing") void loadBatches();
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [batchListing, batchId, api, loadBatches]);

  const newBatch = useCallback(async () => {
    try {
      // Keeps the current batch's condition, note and marketplaces.
      const created = await api("POST", "/api/batches", { defaults: batchRef.current?.defaults });
      setOverview((o) => (o ? { ...o, batches: [created, ...o.batches] } : o));
      await openBatch(created.id);
      setAdded(null);
      toast({ title: `Started ${created.name}` });
    } catch (e) {
      toast({ title: "Couldn't start a batch", description: (e as Error).message, variant: "destructive" });
    }
  }, [api, openBatch, toast]);

  const addToBatch = useCallback(
    async (found: LookupResponse) => {
      const target = batchRef.current;
      if (!target) return;
      try {
        const item: BatchItem = await api("POST", `/api/batches/${target.id}/items`, scanInfo(found));
        setAdded(item);
        setBatch((b) => (b && b.id === item.batchId ? { ...b, items: [...b.items, item], itemCount: b.itemCount + 1 } : b));
        setOverview((o) =>
          o ? { ...o, batches: o.batches.map((b) => (b.id === item.batchId ? { ...b, itemCount: b.itemCount + 1 } : b)) } : o,
        );
      } catch (e) {
        toast({ title: "Couldn't add to batch", description: (e as Error).message, variant: "destructive" });
      }
    },
    [api, toast],
  );

  const changeItem = useCallback((item: BatchItem) => {
    setBatch((b) => (b ? { ...b, items: b.items.map((i) => (i.id === item.id ? item : i)) } : b));
    setAdded((a) => (a?.id === item.id ? item : a));
  }, []);

  const removeItem = useCallback((id: number) => {
    setBatch((b) => (b ? { ...b, items: b.items.filter((i) => i.id !== id), itemCount: b.itemCount - 1 } : b));
    setAdded((a) => (a?.id === id ? null : a));
  }, []);

  const scan = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      if (!code) return;
      const now = Date.now();
      if (code === lastScan.current.code && now - lastScan.current.at < RESCAN_MS) return;
      lastScan.current = { code, at: now };
      navigator.vibrate?.(60);
      setLooking(true);
      setAdded(null);
      try {
        const found: LookupResponse = await api("GET", `/api/scan/lookup/${encodeURIComponent(code)}`);
        setLookup(found);
        setScanCount((n) => n + 1);
        const target = batchRef.current;
        if (autoAddRef.current && target && target.status !== "listing" && toIsbn13(code)) await addToBatch(found);
      } catch (e) {
        toast({ title: "Lookup failed", description: (e as Error).message, variant: "destructive" });
      } finally {
        setLooking(false);
      }
    },
    [api, toast, addToBatch],
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
  const ebayShipping = typicalShipping(data?.listings ?? []);
  const canList = overview?.canList ?? { amazon: false, ebay: false };
  const status = data?.status;
  const needle = filter.trim().toLowerCase();
  const matching = (data?.listings ?? []).filter((l) =>
    `${l.title} ${l.sku ?? ""} ${l.isbn ?? ""}`.toLowerCase().includes(needle),
  );

  return (
    <main className="mx-auto min-h-screen max-w-md space-y-4 bg-background px-4 py-4 md:max-w-2xl">
      <h1 className="text-xl font-semibold">Book scanner</h1>

      {status && !status.connected && (
        <p className="rounded-md border p-3 text-sm" data-testid="text-not-connected">
          {data?.listings.length
            ? `Using your uploaded eBay report${status.refreshedAt ? ` from ${ago(status.refreshedAt)}` : ""}. Prices won't update until you upload a new one.`
            : "eBay isn't connected yet. Upload an eBay report on the Inventory tab to get started."}{" "}
          <Link href="/inventory" className="underline">Connect eBay</Link>
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="scan">Scan</TabsTrigger>
          <TabsTrigger value="batch" data-testid="tab-batch">
            Batch{batch ? ` (${batch.items.filter((i) => i.status !== "listed").length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="inventory" data-testid="tab-inventory">eBay</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="scan" className="space-y-4">
          <div className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm" data-testid="text-scan-target">
            {batch ? (
              <button type="button" className="min-w-0 truncate text-left underline" onClick={() => setTab("batch")}>
                {batch.name}: {batch.items.length} books
              </button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void newBatch()} data-testid="button-scan-new-batch">
                Start a batch
              </Button>
            )}
            <label className="flex flex-none items-center gap-2">
              <input
                type="checkbox"
                checked={autoAdd}
                onChange={(e) => {
                  setAutoAdd(e.target.checked);
                  writeStored(AUTO_ADD_STORAGE, e.target.checked ? "on" : "off");
                }}
                data-testid="checkbox-auto-add"
              />
              Add every scan
            </label>
          </div>
          {batch && batch.status !== "listing" && (
            <BoxField batch={batch} api={api} onBatchChange={(next) => setBatch(next)} />
          )}

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
              added={added}
              batch={batch}
              settings={settings}
              ebayShipping={ebayShipping}
              canList={canList}
              api={api}
              onAdd={() => addToBatch(lookup)}
              onItemChange={changeItem}
              onItemDelete={removeItem}
              onNewBatch={newBatch}
            />
          )}
        </TabsContent>

        <TabsContent value="batch">
          {overview && (
            <BatchTab
              overview={overview}
              batch={batch}
              settings={settings}
              ebayShipping={ebayShipping}
              api={api}
              onSelect={(id) => void openBatch(id)}
              onNewBatch={newBatch}
              onBatchChange={(next) => {
                setBatch(next);
                setAdded((a) => (a ? (next.items.find((i) => i.id === a.id) ?? null) : a));
              }}
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

        <TabsContent value="settings" className="space-y-6">
          {overview && (
            <SkuSettingsForm
              settings={overview.settings}
              onSave={async (next, applyToUnlisted) => {
                try {
                  const saved = await api("PUT", "/api/listing-settings", { ...next, applyToUnlisted });
                  setOverview((o) => (o ? { ...o, settings: { skuTemplate: saved.skuTemplate } } : o));
                  const applied: { updated: number; tooLong: string[] } | null = saved.applied;
                  if (applied && batch) await openBatch(batch.id);
                  toast({
                    title: "SKU pattern saved",
                    description: applied
                      ? `${applied.updated} unlisted book${applied.updated === 1 ? "" : "s"} got new SKUs.` +
                        (applied.tooLong.length ? ` ${applied.tooLong.length} kept the old one (new SKU too long).` : "")
                      : "Books scanned from now on use it.",
                  });
                } catch (e) {
                  toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
                }
              }}
            />
          )}
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
