import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  BOOK_CONDITIONS,
  itemProblem,
  listingSettingsSchema,
  researchLinks,
  SKU_TOKENS,
} from "@shared/listing";
import type {
  AmazonBook,
  Batch,
  BatchDefaults,
  BatchDetail,
  BatchItem,
  BatchItemPatch,
  BookCondition,
  ListingSettings,
  ListResult,
} from "@shared/listing";
import { computeAmazonProfit, computeProfit } from "@shared/profit";
import type { ScanSettings } from "@shared/profit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

// The Batch tab of the scanner, Accelerlist style: books scanned into a batch
// start at Amazon's lowest used price, get checked and adjusted here, then are
// listed together.

export type Api = (method: string, url: string, body?: unknown) => Promise<any>;

export interface BatchesResponse {
  batches: Batch[];
  settings: ListingSettings;
  canList: { amazon: boolean; ebay: boolean };
}

export function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

const selectClass = "flex h-9 w-full rounded-md border border-input bg-background px-2 text-base md:text-sm";

function conditionLabel(value: string): string {
  return BOOK_CONDITIONS.find((c) => c.value === value)?.label ?? value.replace(/_/g, " ");
}

function priceOrNull(draft: string): number | null {
  const n = Number(draft);
  return draft.trim() !== "" && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// The box new scans go into. Change it when you start filling a new box; books
// already scanned keep theirs.
export function BoxField({
  batch,
  api,
  onBatchChange,
}: {
  batch: BatchDetail;
  api: Api;
  onBatchChange: (batch: BatchDetail) => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState(batch.defaults.box);
  useEffect(() => setDraft(batch.defaults.box), [batch.defaults.box]);

  async function save() {
    const box = draft.trim().toUpperCase();
    if (box === batch.defaults.box) return;
    try {
      const updated = await api("PUT", `/api/batches/${batch.id}`, { defaults: { ...batch.defaults, box } });
      onBatchChange({ ...batch, ...updated, items: batch.items });
      toast({ title: box ? `Now scanning into box ${box}` : "No box set" });
    } catch (e) {
      setDraft(batch.defaults.box);
      toast({ title: "Couldn't change box", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <label className="flex flex-none items-center gap-2 text-sm">
      Box
      <Input
        value={draft}
        maxLength={8}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 w-20 font-mono uppercase"
        data-testid="input-box"
      />
    </label>
  );
}

// What other sellers ask, and where to look further.
export function Research({ isbn13, book }: { isbn13: string; book: AmazonBook | null }) {
  return (
    <div className="space-y-2 text-sm">
      {book && book.offers.length > 0 && (
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="font-normal">Used offers</th>
              <th className="font-normal">Price + ship</th>
              <th className="font-normal">Total</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {book.offers.map((o, i) => (
              <tr key={i}>
                <td>
                  {conditionLabel(o.condition)}
                  {o.fba && <span className="ml-1 text-muted-foreground">FBA</span>}
                </td>
                <td>
                  {money(o.price)} + {money(o.shipping)}
                </td>
                <td>{money(o.price + o.shipping)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {researchLinks(isbn13, book?.asin ?? null).map((l) => (
          <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="underline">
            {l.label}
          </a>
        ))}
      </div>
    </div>
  );
}

function ResultLine({ where, result }: { where: string; result: ListResult }) {
  return (
    <p className={`text-xs ${result.ok ? "text-green-700 dark:text-green-400" : "text-destructive"}`}>
      {where}: {result.ok ? "✓ " : "✗ "}
      {result.message}{" "}
      {result.url && (
        <a href={result.url} target="_blank" rel="noreferrer" className="underline">
          View
        </a>
      )}
    </p>
  );
}

// One book: price on each marketplace with its profit, condition, note and
// quantity. Saves each change as soon as it's made.
export function BatchItemEditor({
  item,
  settings,
  ebayShipping,
  canList,
  api,
  onChange,
  onDelete,
}: {
  item: BatchItem;
  settings: ScanSettings;
  ebayShipping: number | null;
  canList: { amazon: boolean; ebay: boolean };
  api: Api;
  onChange: (item: BatchItem) => void;
  onDelete: (id: number) => void;
}) {
  const { toast } = useToast();
  const [amazonDraft, setAmazonDraft] = useState(item.amazonPrice?.toFixed(2) ?? "");
  const [ebayDraft, setEbayDraft] = useState(item.ebayPrice?.toFixed(2) ?? "");
  const [noteDraft, setNoteDraft] = useState(item.note);
  const [qtyDraft, setQtyDraft] = useState(String(item.quantity));
  const [boxDraft, setBoxDraft] = useState(item.box);
  const locked = item.status === "listed";

  useEffect(() => {
    setAmazonDraft(item.amazonPrice?.toFixed(2) ?? "");
    setEbayDraft(item.ebayPrice?.toFixed(2) ?? "");
    setNoteDraft(item.note);
    setQtyDraft(String(item.quantity));
    setBoxDraft(item.box);
  }, [item.amazonPrice, item.ebayPrice, item.note, item.quantity, item.box]);

  async function save(patch: BatchItemPatch) {
    try {
      onChange(await api("PUT", `/api/batch-items/${item.id}`, patch));
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    }
  }

  const amazonPrice = priceOrNull(amazonDraft);
  const ebayPrice = priceOrNull(ebayDraft);
  const amazonProfit = amazonPrice === null ? null : computeAmazonProfit(amazonPrice, settings).profit;
  const ebayProfit = ebayPrice === null ? null : computeProfit(ebayPrice, ebayShipping, settings).profit;
  const profitClass = (p: number | null) =>
    `text-sm font-semibold tabular-nums ${p !== null && p < 0 ? "text-destructive" : "text-green-700 dark:text-green-400"}`;

  return (
    <div className="space-y-3">
      <div className="text-sm">
        SKU <span className="font-mono font-medium" data-testid={`text-sku-${item.id}`}>{item.sku}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.listAmazon}
              disabled={locked || !item.amazon || !canList.amazon}
              onChange={(e) => void save({ listAmazon: e.target.checked })}
              data-testid={`checkbox-amazon-${item.id}`}
            />
            Amazon
          </label>
          <Input
            inputMode="decimal"
            value={amazonDraft}
            disabled={locked || !item.amazon}
            placeholder={item.amazon ? "Price" : "Not on Amazon"}
            onChange={(e) => setAmazonDraft(e.target.value)}
            onBlur={() => amazonPrice !== item.amazonPrice && void save({ amazonPrice })}
            data-testid={`input-amazon-price-${item.id}`}
          />
          <div className={profitClass(amazonProfit)}>{amazonProfit === null ? "" : `${money(amazonProfit)} profit`}</div>
        </div>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.listEbay}
              disabled={locked || !canList.ebay}
              onChange={(e) => void save({ listEbay: e.target.checked })}
              data-testid={`checkbox-ebay-${item.id}`}
            />
            eBay
          </label>
          <Input
            inputMode="decimal"
            value={ebayDraft}
            disabled={locked}
            placeholder="Price"
            onChange={(e) => setEbayDraft(e.target.value)}
            onBlur={() => ebayPrice !== item.ebayPrice && void save({ ebayPrice })}
            data-testid={`input-ebay-price-${item.id}`}
          />
          <div className={profitClass(ebayProfit)}>{ebayProfit === null ? "" : `${money(ebayProfit)} profit`}</div>
        </div>
      </div>
      <div className="grid grid-cols-[5.5rem_1fr_4.5rem] gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Box</Label>
          <Input
            value={boxDraft}
            maxLength={8}
            disabled={locked}
            onChange={(e) => setBoxDraft(e.target.value.toUpperCase())}
            onBlur={() => boxDraft.trim() !== item.box && void save({ box: boxDraft.trim() })}
            className="font-mono uppercase"
            data-testid={`input-box-${item.id}`}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Condition</Label>
          <select
            value={item.condition}
            disabled={locked}
            onChange={(e) => void save({ condition: e.target.value as BookCondition })}
            className={selectClass}
            data-testid={`select-condition-${item.id}`}
          >
            {BOOK_CONDITIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Qty</Label>
          <Input
            inputMode="numeric"
            value={qtyDraft}
            disabled={locked}
            onChange={(e) => setQtyDraft(e.target.value)}
            onBlur={() => {
              const q = Number(qtyDraft);
              if (Number.isInteger(q) && q >= 1 && q !== item.quantity) void save({ quantity: q });
              else setQtyDraft(String(item.quantity));
            }}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Condition note</Label>
        <textarea
          rows={2}
          value={noteDraft}
          disabled={locked}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => noteDraft.trim() !== item.note && void save({ note: noteDraft })}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm"
        />
      </div>
      {item.amazon?.restriction && (
        <p className="text-xs text-destructive">Restricted on Amazon: {item.amazon.restriction}</p>
      )}
      {item.onEbayAlready > 0 && (
        <p className="text-xs text-muted-foreground">You already have {item.onEbayAlready} on eBay.</p>
      )}
      {item.amazonResult && <ResultLine where="Amazon" result={item.amazonResult} />}
      {item.ebayResult && <ResultLine where="eBay" result={item.ebayResult} />}
      <Research isbn13={item.isbn13} book={item.amazon} />
      {!locked && (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={async () => {
            try {
              await api("DELETE", `/api/batch-items/${item.id}`);
              onDelete(item.id);
            } catch (e) {
              toast({ title: "Couldn't remove", description: (e as Error).message, variant: "destructive" });
            }
          }}
          data-testid={`button-remove-${item.id}`}
        >
          Remove from batch
        </Button>
      )}
    </div>
  );
}

function statusBadge(item: BatchItem) {
  if (item.status === "listed") return <Badge className="bg-green-700">Listed</Badge>;
  if (item.status === "failed") return <Badge variant="destructive">Failed</Badge>;
  const problem = itemProblem(item);
  return problem ? <Badge variant="outline">{problem}</Badge> : null;
}

// A row in the batch: the summary line opens the editor.
function BatchRow(props: Parameters<typeof BatchItemEditor>[0]) {
  const { item, settings } = props;
  const [open, setOpen] = useState(false);
  const shown = [item.listAmazon && item.amazonPrice !== null && `A ${money(item.amazonPrice)}`, item.listEbay && item.ebayPrice !== null && `E ${money(item.ebayPrice)}`]
    .filter(Boolean)
    .join(" · ");
  const profit = item.listAmazon && item.amazonPrice !== null ? computeAmazonProfit(item.amazonPrice, settings).profit : null;
  return (
    <li className="py-2" data-testid={`row-item-${item.id}`}>
      <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(!open)}>
        {item.amazon?.imageUrl ? (
          <img src={item.amazon.imageUrl} alt="" className="h-12 w-9 flex-none rounded object-cover" />
        ) : (
          <div className="h-12 w-9 flex-none rounded bg-muted" />
        )}
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm font-medium">{item.title}</span>
          <span className="block text-xs text-muted-foreground">
            {item.box && <span className="font-medium text-foreground">Box {item.box} · </span>}
            {item.sku} · {conditionLabel(item.condition)}
            {item.amazon?.salesRank ? ` · #${item.amazon.salesRank.toLocaleString()}` : ""}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-2">{statusBadge(item)}</span>
        </span>
        <span className="flex-none text-right text-sm tabular-nums">
          <span className="block">{shown || "—"}</span>
          {profit !== null && (
            <span className={`block text-xs ${profit < 0 ? "text-destructive" : "text-muted-foreground"}`}>
              {money(profit)} profit
            </span>
          )}
        </span>
      </button>
      {open && <div className="mt-3 rounded-md border p-3">{<BatchItemEditor {...props} />}</div>}
    </li>
  );
}

function DefaultsForm({
  defaults,
  canList,
  onSave,
}: {
  defaults: BatchDefaults;
  canList: { amazon: boolean; ebay: boolean };
  onSave: (d: BatchDefaults) => Promise<void>;
}) {
  const [note, setNote] = useState(defaults.note);
  useEffect(() => setNote(defaults.note), [defaults.note]);
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        New books: {defaults.box ? `box ${defaults.box}, ` : ""}
        {conditionLabel(defaults.condition)}, qty {defaults.quantity},{" "}
        {[defaults.amazon && "Amazon", defaults.ebay && "eBay"].filter(Boolean).join(" + ") || "nowhere"}
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-[1fr_4.5rem] gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Condition</Label>
            <select
              value={defaults.condition}
              onChange={(e) => void onSave({ ...defaults, condition: e.target.value as BookCondition })}
              className={selectClass}
              data-testid="select-default-condition"
            >
              {BOOK_CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Qty</Label>
            <select
              value={defaults.quantity}
              onChange={(e) => void onSave({ ...defaults, quantity: Number(e.target.value) })}
              className={selectClass}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Condition note</Label>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note.trim() !== defaults.note && void onSave({ ...defaults, note: note.trim() })}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm"
            data-testid="input-default-note"
          />
        </div>
        <div className="flex gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={defaults.amazon}
              disabled={!canList.amazon}
              onChange={(e) => void onSave({ ...defaults, amazon: e.target.checked })}
            />
            List on Amazon
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={defaults.ebay}
              disabled={!canList.ebay}
              onChange={(e) => void onSave({ ...defaults, ebay: e.target.checked })}
              data-testid="checkbox-default-ebay"
            />
            List on eBay
          </label>
        </div>
        <p className="text-xs text-muted-foreground">Changes apply to books scanned from now on.</p>
      </div>
    </details>
  );
}

export function BatchTab({
  overview,
  batch,
  settings,
  ebayShipping,
  api,
  onSelect,
  onNewBatch,
  onBatchChange,
}: {
  overview: BatchesResponse;
  batch: BatchDetail | null;
  settings: ScanSettings;
  ebayShipping: number | null;
  api: Api;
  onSelect: (id: number) => void;
  onNewBatch: () => Promise<void>;
  onBatchChange: (batch: BatchDetail) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  if (!batch) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Start a batch, then scan books into it on the Scan tab.</p>
        <Button className="w-full" onClick={() => void onNewBatch()} data-testid="button-new-batch">
          New batch
        </Button>
      </div>
    );
  }

  const listing = batch.status === "listing";
  const todo = batch.items.filter((i) => i.status !== "listed");
  const ready = todo.filter((i) => !itemProblem(i));
  const listed = batch.items.filter((i) => i.status === "listed").length;
  const amazonTotal = ready.reduce((s, i) => s + (i.listAmazon && i.amazonPrice ? i.amazonPrice * i.quantity : 0), 0);
  const profitTotal = ready.reduce(
    (s, i) => s + (i.listAmazon && i.amazonPrice ? computeAmazonProfit(i.amazonPrice, settings).profit * i.quantity : 0),
    0,
  );

  const replaceItem = (item: BatchItem) =>
    onBatchChange({ ...batch, items: batch.items.map((i) => (i.id === item.id ? item : i)) });
  const removeItem = (id: number) =>
    onBatchChange({ ...batch, items: batch.items.filter((i) => i.id !== id), itemCount: batch.itemCount - 1 });

  const id = batch.id;
  async function listAll() {
    if (!window.confirm(`List ${ready.length} book${ready.length === 1 ? "" : "s"} now? They go live on the marketplaces.`)) return;
    setBusy(true);
    try {
      const res: { ready: number; problems: { sku: string; problem: string }[] } = await api(
        "POST",
        `/api/batches/${id}/list`,
      );
      toast({
        title: `Listing ${res.ready} book${res.ready === 1 ? "" : "s"}`,
        description: res.problems.length ? `${res.problems.length} need fixing first.` : "Progress shows below.",
      });
      onBatchChange(await api("GET", `/api/batches/${id}`));
    } catch (e) {
      toast({ title: "Couldn't list", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={batch.id}
          onChange={(e) => onSelect(Number(e.target.value))}
          className={selectClass}
          data-testid="select-batch"
        >
          {overview.batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.itemCount}){b.status === "done" ? " ✓" : ""}
            </option>
          ))}
        </select>
        <Button variant="outline" onClick={() => void onNewBatch()} data-testid="button-new-batch">
          New
        </Button>
      </div>

      {!listing && <BoxField batch={batch} api={api} onBatchChange={onBatchChange} />}

      <DefaultsForm
        defaults={batch.defaults}
        canList={overview.canList}
        onSave={async (defaults) => {
          try {
            onBatchChange({ ...batch, ...(await api("PUT", `/api/batches/${batch.id}`, { defaults })) });
          } catch (e) {
            toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
          }
        }}
      />

      <div className="rounded-md bg-muted/50 p-3 text-sm" data-testid="text-batch-summary">
        {batch.items.length} books · {ready.length} ready · {listed} listed
        {amazonTotal > 0 && (
          <span className="block text-xs text-muted-foreground">
            Amazon total {money(amazonTotal)}, about {money(profitTotal)} profit
          </span>
        )}
      </div>

      {listing && (
        <p className="text-sm font-medium" data-testid="text-listing-progress">
          Listing… {listed} of {listed + todo.length} done
        </p>
      )}
      {!listing && ready.length > 0 && (
        <Button className="w-full" disabled={busy} onClick={() => void listAll()} data-testid="button-list-batch">
          List {ready.length} book{ready.length === 1 ? "" : "s"}
        </Button>
      )}
      {!listing && todo.length > ready.length && (
        <p className="text-xs text-muted-foreground">
          {todo.length - ready.length} book{todo.length - ready.length === 1 ? " needs" : "s need"} a fix before listing.
        </p>
      )}

      <ul className="divide-y">
        {[...batch.items].reverse().map((item) => (
          <BatchRow
            key={item.id}
            item={item}
            settings={settings}
            ebayShipping={ebayShipping}
            canList={overview.canList}
            api={api}
            onChange={replaceItem}
            onDelete={removeItem}
          />
        ))}
      </ul>
    </div>
  );
}

export function SkuSettingsForm({ settings, onSave }: { settings: ListingSettings; onSave: (s: ListingSettings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings.skuTemplate);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings.skuTemplate), [settings.skuTemplate]);
  const parsed = listingSettingsSchema.safeParse({ skuTemplate: draft });

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
    <form className="space-y-2" onSubmit={submit}>
      <Label htmlFor="sku-template">SKU pattern</Label>
      <Input id="sku-template" value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="input-sku-template" />
      {!parsed.success && <p className="text-xs text-destructive">{parsed.error.issues[0]?.message}</p>}
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {SKU_TOKENS.map((t) => (
          <li key={t.token}>
            <button type="button" className="font-mono underline" onClick={() => setDraft(draft + t.token)}>
              {t.token}
            </button>{" "}
            {t.meaning}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Used for books scanned from now on. If the pattern has {"{COND}"} or {"{PRICE}"}, changing a book's condition or
        price before listing updates its SKU too.
      </p>
      <Button type="submit" className="w-full" disabled={!parsed.success || saving} data-testid="button-save-sku">
        {saving ? "Saving…" : "Save SKU pattern"}
      </Button>
    </form>
  );
}
