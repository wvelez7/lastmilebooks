// Just enough of .xlsx to read the first sheet of a SmartRepricer export as
// rows of text, so no spreadsheet library is needed. An .xlsx file is a zip of
// XML files; formulas come through as their saved values.
import { inflateRawSync } from "node:zlib";

export function isXlsx(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

function unzip(bytes: Buffer): Map<string, Buffer> {
  // The central directory, found from its end record near the end of the file.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = bytes.readUInt16LE(end + 10);
  let p = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged zip file");
    const method = bytes.readUInt16LE(p + 10);
    const size = bytes.readUInt32LE(p + 20);
    const nameLength = bytes.readUInt16LE(p + 28);
    const extraLength = bytes.readUInt16LE(p + 30);
    const commentLength = bytes.readUInt16LE(p + 32);
    const local = bytes.readUInt32LE(p + 42);
    const name = bytes.toString("utf8", p + 46, p + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Some writers prefix every tag (<x:row>), so prefixes are dropped first.
const unprefix = (xml: string) => xml.replace(/<(\/?)[A-Za-z]+:/g, "<$1");

const texts = (xml: string) => Array.from(xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g), (m) => decode(m[1])).join("");

function columnIndex(ref: string): number {
  let n = 0;
  for (const c of ref) n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
}

export function readFirstSheet(bytes: Buffer): string[][] {
  const files = unzip(bytes);
  const sheetName =
    Array.from(files.keys())
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))[0] ?? "";
  const sheet = files.get(sheetName);
  if (!sheet) throw new Error("no sheet in this file");
  const strings = Array.from(
    unprefix(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
    (m) => texts(m[1]),
  );
  const rows: string[][] = [];
  for (const [, body] of Array.from(unprefix(sheet.toString("utf8")).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g))) {
    const row: string[] = [];
    for (const [, col, attrs, inner = ""] of Array.from(
      body.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g),
    )) {
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      row[columnIndex(col)] =
        type === "s" ? (strings[Number(v)] ?? "") : type === "inlineStr" ? texts(inner) : decode(v ?? "");
    }
    rows.push(Array.from(row, (c) => c ?? ""));
  }
  return rows;
}
