// Prints book labels on a DYMO LabelWriter through DYMO Connect, which runs a
// small web service on this computer (https://127.0.0.1:41951). Only works in a
// browser on the computer the printer is plugged into, with DYMO Connect
// installed. The label is DYMO's 30334 (2-1/4" x 1-1/4"): the title, a
// Code 128 barcode of the SKU, and the SKU in print.

const PORTS = [41951, 41952, 41953, 41954, 41955];
export const DEFAULT_PRINTER = "DYMO LabelWriter 4XL";

let foundHost: string | null = null;

async function call(path: string, form?: Record<string, string>, timeoutMs = 4000): Promise<string> {
  const hosts = foundHost
    ? [foundHost]
    : PORTS.flatMap((p) => [`https://127.0.0.1:${p}`, `https://localhost:${p}`]);
  let lastError: unknown = null;
  for (const host of hosts) {
    try {
      const res = await fetch(`${host}/DYMO/DLS/Printing/${path}`, {
        method: form ? "POST" : "GET",
        headers: form ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      foundHost = host;
      if (!res.ok) throw new Error(`DYMO ${path} failed (${res.status}): ${text.slice(0, 200)}`);
      return text;
    } catch (e) {
      lastError = e;
      if (foundHost) break; // reached DYMO; this is a real error, not the wrong port
    }
  }
  if (lastError instanceof Error && lastError.message.startsWith("DYMO")) throw lastError;
  foundHost = null;
  throw new Error(
    "Can't reach DYMO Connect on this computer. Make sure it's installed and running, and allow this site to use devices on your local network if Chrome asks.",
  );
}

// The service answers JSON-ish strings: true, "base64…", or an error message.
function unquote(text: string): string {
  const t = text.trim();
  return t.startsWith('"') ? (JSON.parse(t) as string) : t;
}

export async function dymoConnected(): Promise<boolean> {
  try {
    return unquote(await call("StatusConnected", undefined, 2500)) === "true";
  } catch {
    return false;
  }
}

// Printer names DYMO knows. Some DYMO Connect versions fail this call, so the
// page falls back to the usual 4XL name.
export async function dymoPrinters(): Promise<string[]> {
  const xml = unquote(await call("GetPrinters"));
  return Array.from(xml.matchAll(/<Name>([^<]+)<\/Name>/g)).map((m) => m[1]);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const BRUSHES = `<Brushes>
  <BackgroundBrush><SolidColorBrush><Color A="0" R="1" G="1" B="1"></Color></SolidColorBrush></BackgroundBrush>
  <BorderBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderBrush>
  <StrokeBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></StrokeBrush>
  <FillBrush><SolidColorBrush><Color A="0" R="1" G="1" B="1"></Color></SolidColorBrush></FillBrush>
</Brushes>`;

const COMMON = `<Rotation>Rotation0</Rotation>
<OutlineThickness>1</OutlineThickness>
<IsOutlined>False</IsOutlined>
<Margin><DYMOThickness Left="0" Top="0" Right="0" Bottom="0" /></Margin>`;

function font(size: number, bold: boolean): string {
  return `<FontInfo>
  <FontName>Arial</FontName>
  <FontSize>${size}</FontSize>
  <IsBold>${bold ? "True" : "False"}</IsBold>
  <IsItalic>False</IsItalic>
  <IsUnderline>False</IsUnderline>
  <FontBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></FontBrush>
</FontInfo>`;
}

// Sizes in inches, from the label's top-left corner.
function layout(x: number, y: number, w: number, h: number): string {
  return `<ObjectLayout><DYMOPoint><X>${x}</X><Y>${y}</Y></DYMOPoint><Size><Width>${w}</Width><Height>${h}</Height></Size></ObjectLayout>`;
}

function text(name: string, value: string, size: number, bold: boolean, box: [number, number, number, number]): string {
  return `<TextObject>
<Name>${name}</Name>
${BRUSHES}
${COMMON}
<HorizontalAlignment>Center</HorizontalAlignment>
<VerticalAlignment>Middle</VerticalAlignment>
<FitMode>AlwaysFit</FitMode>
<IsVertical>False</IsVertical>
<FormattedText>
  <FitMode>AlwaysFit</FitMode>
  <HorizontalAlignment>Center</HorizontalAlignment>
  <VerticalAlignment>Middle</VerticalAlignment>
  <IsVertical>False</IsVertical>
  <LineTextSpan><TextSpan><Text>${escapeXml(value)}</Text>${font(size, bold)}</TextSpan></LineTextSpan>
</FormattedText>
${layout(...box)}
</TextObject>`;
}

export interface BookLabel {
  sku: string;
  title: string;
}

// 30334 is 2.25" x 1.25". Title on top, the barcode across the middle, and the
// SKU underneath in bold so it can be read without a scanner.
export function bookLabelXml(label: BookLabel): string {
  const title = label.title.length > 60 ? `${label.title.slice(0, 57)}…` : label.title;
  return `<?xml version="1.0" encoding="utf-8"?>
<LabelFile version="1">
<LabelApplication>Blank</LabelApplication>
<DYMOLabel>
<Description>Last Mile Books SKU</Description>
<Orientation>Landscape</Orientation>
<LabelName>Small30334</LabelName>
<InitialLength>0</InitialLength>
<BorderStyle>SolidLine</BorderStyle>
<DYMORect><DYMOPoint><X>0.05</X><Y>0.05</Y></DYMOPoint><Size><Width>2.15</Width><Height>1.15</Height></Size></DYMORect>
<BorderColor><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderColor>
<BorderThickness>1</BorderThickness>
<Show_Border>False</Show_Border>
<DynamicLayoutManager>
<RotationBehavior>ClearObjects</RotationBehavior>
<LabelObjects>
${text("TITLE", title, 7, false, [0.08, 0.06, 2.09, 0.2])}
<BarcodeObject>
<Name>BARCODE</Name>
${BRUSHES}
${COMMON}
<BarcodeFormat>Code128Auto</BarcodeFormat>
<Data>${escapeXml(label.sku)}</Data>
<HorizontalAlignment>Center</HorizontalAlignment>
<VerticalAlignment>Middle</VerticalAlignment>
<Size>Small</Size>
<TextPosition>None</TextPosition>
${font(7, false)}
${layout(0.04, 0.28, 2.17, 0.6)}
</BarcodeObject>
${text("SKU", label.sku, 9, true, [0.08, 0.9, 2.09, 0.24])}
</LabelObjects>
</DynamicLayoutManager>
</DYMOLabel>
</LabelFile>`;
}

export async function printBookLabel(label: BookLabel, printerName: string): Promise<void> {
  const result = unquote(
    await call(
      "PrintLabel",
      { printerName, printParamsXml: "", labelXml: bookLabelXml(label), labelSetXml: "" },
      15000,
    ),
  );
  if (result !== "true") throw new Error(`DYMO didn't print: ${result.slice(0, 200)}`);
}

// A PNG of the label as DYMO would print it, without printing.
export async function previewBookLabel(label: BookLabel, printerName: string): Promise<string> {
  const png = unquote(
    await call("RenderLabel", { labelXml: bookLabelXml(label), renderParamsXml: "", printerName }, 15000),
  );
  return `data:image/png;base64,${png}`;
}
