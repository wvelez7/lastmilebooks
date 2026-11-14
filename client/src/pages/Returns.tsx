import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { forgetAdminKey, readAdminKey, saveAdminKey } from "@/lib/adminKey";

// Admin page for Amazon returns. Not linked from the site; open /#/returns
// and enter the ADMIN_KEY (shared with the other admin pages, remembered on the device).

interface ReturnRow {
  key: string;
  channel: string;
  orderId: string;
  returnDate: string;
  sku: string;
  title: string;
  quantity: number;
  reason: string;
  status: string;
  disposition: string | null;
  refunded: number | null;
  azClaim: boolean;
  comment: string | null;
}

interface Summary {
  from: string | null;
  to: string | null;
  returns: number;
  orders: number;
  soldUnits: number | null;
  returnRate: number | null;
  refunded: number;
  labelCost: number;
  azClaims: number;
  outOfPolicy: number;
  medianDaysToReturn: number | null;
  daysToReturn: { label: string; count: number }[];
  byReason: { reason: string; units: number; share: number }[];
  byChannel: { channel: string; units: number; sold: number | null; rate: number | null }[];
  byMonth: { month: string; returns: number; sold: number | null }[];
  byBook: { sku: string; title: string; returns: number; sold: number | null; reasons: string[] }[];
  fbaDisposition: { disposition: string; units: number }[];
  resold: {
    title: string;
    reason: string;
    returnDate: string;
    refunded: number | null;
    resoldOn: string;
    resoldSku: string;
    days: number;
  }[];
  notResold: number;
}

interface Job {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  notes: string[];
}

const PERIODS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
  { days: 0, label: "Everything" },
];

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function percent(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Bars({ rows }: { rows: { label: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="flex justify-between gap-3">
            <span className="truncate">{r.label}</span>
            <span className="tabular-nums text-muted-foreground">{r.note ?? r.value}</span>
          </div>
          <div className="mt-1 h-2 rounded bg-muted">
            <div className="h-2 rounded bg-primary" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Returns() {
  const { toast } = useToast();
  const [adminKey, setAdminKey] = useState(readAdminKey);
  const [keyDraft, setKeyDraft] = useState("");
  const [days, setDays] = useState(90);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [connected, setConnected] = useState(true);
  const [uploadedAt, setUploadedAt] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const api = useCallback(
    async (method: string, url: string) => {
      const res = await fetch(url, { method, headers: { "x-admin-key": adminKey } });
      if (res.status === 401) {
        setAdminKey("");
        forgetAdminKey();
        throw new Error("Wrong admin key");
      }
      if (!res.ok) {
        const text = await res.text();
        let message = text;
        try {
          message = JSON.parse(text).error ?? text;
        } catch {}
        throw new Error(typeof message === "string" ? message : `Request failed (${res.status})`);
      }
      return res.json();
    },
    [adminKey],
  );

  const load = useCallback(async () => {
    if (!adminKey) return;
    try {
      const data = await api("GET", `/api/amazon/returns${days ? `?days=${days}` : ""}`);
      setSummary(data.summary);
      setRows(data.rows);
      setJob(data.job);
      setConnected(data.connected);
      setUploadedAt(data.uploadedAt);
    } catch (e) {
      toast({ title: "Couldn't load returns", description: (e as Error).message, variant: "destructive" });
    }
  }, [adminKey, api, days, toast]);

  // Checks every 10 seconds while Amazon is making the reports.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), job?.running ? 10_000 : 60_000);
    return () => clearInterval(t);
  }, [load, job?.running]);

  async function refresh() {
    try {
      setJob(await api("POST", "/api/amazon/returns/refresh"));
    } catch (e) {
      toast({ title: "Refresh failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const res = await fetch("/api/amazon/returns/upload", {
        method: "POST",
        headers: { "x-admin-key": adminKey, "Content-Type": "text/plain" },
        body: await file.text(),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      toast({
        title: `Added ${json.rows} ${json.kind === "FBA" ? "FBA " : ""}returns`,
        description: `${json.total} returns stored in all. Re-uploading the same file doesn't double them.`,
      });
      await load();
    } catch (e) {
      toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  if (!adminKey) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Amazon returns</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveAdminKey(keyDraft);
                setAdminKey(keyDraft);
              }}
            >
              <Input
                type="password"
                placeholder="Admin key"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                autoFocus
              />
              <Button type="submit" className="w-full" disabled={!keyDraft}>
                Open
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  const cutoff = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : "";
  const recent = rows
    .filter((r) => r.returnDate >= cutoff)
    .sort((a, b) => b.returnDate.localeCompare(a.returnDate))
    .slice(0, 50);
  const s = summary;
  const neverPulled = !job?.finishedAt && !job?.running && !uploadedAt;

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Amazon returns</h1>
            <p className="text-sm text-muted-foreground">
              {job?.running
                ? `Asking Amazon for reports, started ${formatDistanceToNow(new Date(job.startedAt!), { addSuffix: true })}. This takes a few minutes.`
                : job?.finishedAt
                  ? `Last pulled ${formatDistanceToNow(new Date(job.finishedAt), { addSuffix: true })}.`
                  : "Not pulled from Amazon yet. The first pull covers the last 180 days."}
            </p>
          </div>
          <Button onClick={refresh} disabled={!connected || job?.running}>
            {job?.running ? "Pulling…" : "Pull from Amazon"}
          </Button>
        </header>

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <div className="text-sm">
              <div className="font-medium">Upload returns you ship yourself</div>
              <div className="text-muted-foreground">
                Seller Central → Orders → Return Reports: pick exact dates (up to 60 days), then download the XML or
                TSV and upload it here as is. Amazon's API only gives these to apps with a restricted role.
                {uploadedAt && ` Last upload ${formatDistanceToNow(new Date(uploadedAt), { addSuffix: true })}.`}
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xml,.txt,.tsv,.csv,text/xml,application/xml,text/plain,text/csv,text/tab-separated-values"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }}
            />
            <Button variant="secondary" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "Uploading…" : "Upload file"}
            </Button>
          </CardContent>
        </Card>

        {!connected && <p className="text-sm text-destructive">Amazon isn't connected on the server.</p>}
        {job?.error && <p className="text-sm text-destructive">{job.error}</p>}
        {job && job.notes.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {job.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {PERIODS.map((p) => (
            <Button
              key={p.days}
              size="sm"
              variant={days === p.days ? "default" : "outline"}
              onClick={() => setDays(p.days)}
            >
              {p.label}
            </Button>
          ))}
        </div>

        {s && s.returns === 0 && !neverPulled && (
          <p className="text-sm text-muted-foreground">No returns in this period.</p>
        )}

        {s && s.returns > 0 && (
          <>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <Stat
                label="Return rate"
                value={percent(s.returnRate)}
                hint={s.soldUnits === null ? "Orders report not available" : `of ${s.soldUnits} books sold`}
              />
              <Stat label="Books returned" value={String(s.returns)} hint={`${s.orders} orders`} />
              <Stat
                label="Refunded"
                value={money(s.refunded)}
                hint={s.labelCost > 0 ? `plus ${money(s.labelCost)} in return labels` : "books you ship only"}
              />
              <Stat
                label="Days to return"
                value={s.medianDaysToReturn === null ? "—" : String(s.medianDaysToReturn)}
                hint="median, order to return"
              />
            </div>

            {(s.azClaims > 0 || s.outOfPolicy > 0) && (
              <p className="text-sm">
                {s.azClaims > 0 && <span className="text-destructive">{s.azClaims} A-to-z claim{s.azClaims > 1 ? "s" : ""}. </span>}
                {s.outOfPolicy > 0 && (
                  <span>
                    {s.outOfPolicy} out-of-policy return{s.outOfPolicy > 1 ? "s" : ""}: you may be able to refund less.
                  </span>
                )}
              </p>
            )}

            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Why they came back</CardTitle>
                </CardHeader>
                <CardContent>
                  <Bars
                    rows={s.byReason.map((r) => ({
                      label: r.reason,
                      value: r.units,
                      note: `${r.units} · ${percent(r.share)}`,
                    }))}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">How long after the sale</CardTitle>
                </CardHeader>
                <CardContent>
                  <Bars rows={s.daysToReturn.map((d) => ({ label: d.label, value: d.count }))} />
                </CardContent>
              </Card>
              {s.byChannel.length > 1 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">You ship vs FBA</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Bars
                      rows={s.byChannel.map((c) => ({
                        label: c.channel === "FBA" ? "FBA" : "You ship",
                        value: c.units,
                        note: `${c.units} returned · ${percent(c.rate)}`,
                      }))}
                    />
                  </CardContent>
                </Card>
              )}
              {s.fbaDisposition.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">FBA: condition when it came back</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Bars rows={s.fbaDisposition.map((d) => ({ label: d.disposition, value: d.units }))} />
                  </CardContent>
                </Card>
              )}
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">By month</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-4 font-normal">Month</th>
                      <th className="py-1 pr-4 font-normal text-right">Returned</th>
                      <th className="py-1 pr-4 font-normal text-right">Sold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byMonth.map((m) => (
                      <tr key={m.month} className="border-t">
                        <td className="py-1 pr-4">{m.month}</td>
                        <td className="py-1 pr-4 text-right tabular-nums">{m.returns}</td>
                        <td className="py-1 pr-4 text-right tabular-nums">{m.sold ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Books returned most</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-4 font-normal">Book</th>
                      <th className="py-1 pr-4 font-normal text-right">Returned</th>
                      <th className="py-1 pr-4 font-normal text-right">Sold</th>
                      <th className="py-1 font-normal">Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byBook.map((b) => (
                      <tr key={b.sku} className="border-t align-top">
                        <td className="py-1 pr-4">
                          <div className="line-clamp-2">{b.title}</div>
                          <div className="text-xs text-muted-foreground">{b.sku}</div>
                        </td>
                        <td className="py-1 pr-4 text-right tabular-nums">{b.returns}</td>
                        <td className="py-1 pr-4 text-right tabular-nums">{b.sold ?? "—"}</td>
                        <td className="py-1 text-muted-foreground">{b.reasons.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {s.soldUnits !== null && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Returned, then sold again</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {s.resold.length} of {s.resold.length + s.notResold} returned books sold again on Amazon (same SKU
                    or same title). Sales on eBay or Whatnot aren't counted.
                  </p>
                </CardHeader>
                {s.resold.length > 0 && (
                  <CardContent className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-muted-foreground">
                        <tr>
                          <th className="py-1 pr-4 font-normal">Book</th>
                          <th className="py-1 pr-4 font-normal">Returned</th>
                          <th className="py-1 pr-4 font-normal">Sold again</th>
                          <th className="py-1 font-normal text-right">Days</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.resold.map((r) => (
                          <tr key={`${r.returnDate}-${r.resoldSku}`} className="border-t align-top">
                            <td className="py-1 pr-4">
                              <div className="line-clamp-2">{r.title}</div>
                              <div className="text-xs text-muted-foreground">
                                {r.reason}
                                {r.refunded !== null && ` · refunded ${money(r.refunded)}`}
                              </div>
                            </td>
                            <td className="py-1 pr-4 whitespace-nowrap">{r.returnDate}</td>
                            <td className="py-1 pr-4">
                              <div className="whitespace-nowrap">{r.resoldOn}</div>
                              <div className="text-xs text-muted-foreground">{r.resoldSku}</div>
                            </td>
                            <td className="py-1 text-right tabular-nums">{r.days}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                )}
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Latest returns</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-4 font-normal">Date</th>
                      <th className="py-1 pr-4 font-normal">Book</th>
                      <th className="py-1 pr-4 font-normal">Reason</th>
                      <th className="py-1 pr-4 font-normal">Status</th>
                      <th className="py-1 font-normal text-right">Refund</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => (
                      <tr key={r.key} className="border-t align-top">
                        <td className="py-1 pr-4 whitespace-nowrap">{r.returnDate}</td>
                        <td className="py-1 pr-4">
                          <div className="line-clamp-2">{r.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.orderId} · {r.channel === "FBA" ? "FBA" : "you ship"}
                          </div>
                          {r.comment && <div className="text-xs italic">“{r.comment}”</div>}
                        </td>
                        <td className="py-1 pr-4">
                          {r.reason}
                          {r.azClaim && <span className="ml-1 text-destructive">A-to-z</span>}
                        </td>
                        <td className="py-1 pr-4 text-muted-foreground">{r.disposition ?? r.status}</td>
                        <td className="py-1 text-right tabular-nums">{r.refunded === null ? "—" : money(r.refunded)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
