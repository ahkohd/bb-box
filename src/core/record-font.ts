import { RECORD_DIR } from "./device-recording.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FontWeight = "regular" | "medium";
export type TextFont = FontWeight | "fallback";

export interface TextRun {
  readonly font: TextFont;
  readonly text: string;
}

export interface FontFile {
  readonly name: string;
  readonly bytes: Buffer;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

const NAMES: Readonly<Record<FontWeight, string>> = {
  regular: "Inter-Regular.ttf",
  medium: "Inter-Medium.ttf",
};

const bytes = new Map<string, Buffer>();
let spans: readonly Span[] | null = null;

function fontPath(name: string): string | null {
  const beside = join(dirname(fileURLToPath(import.meta.url)), "fonts", name);
  return existsSync(beside) ? beside : null;
}

export function fontBytes(weight: FontWeight): Buffer | null {
  const name = NAMES[weight];
  const hit = bytes.get(name);
  if (hit) return hit;
  const path = fontPath(name);
  if (!path) return null;
  const data = readFileSync(path);
  bytes.set(name, data);
  return data;
}

export function fontFiles(): readonly FontFile[] {
  return (["regular", "medium"] as const).flatMap((weight) => {
    const data = fontBytes(weight);
    return data ? [{ name: NAMES[weight], bytes: data }] : [];
  });
}

export function fontName(weight: FontWeight): string {
  return NAMES[weight];
}

export function fontInstallScript(): string {
  const files = fontFiles();
  if (!files.length) return "exit 0\n";
  const writes = files.map((file) => `printf '%s' '${file.bytes.toString("base64")}' | perl -MMIME::Base64 -e 'local $/; print decode_base64(<STDIN>)' > "$d/${file.name}"`);
  return `d="$HOME/${RECORD_DIR}"\nmkdir -p "$d"\n${writes.join("\n")}\n`;
}

function cmapSpans(data: Buffer): readonly Span[] {
  const tables = data.readUInt16BE(4);
  let cmapAt = 0;
  for (let table = 0; table < tables; table++) {
    const at = 12 + table * 16;
    if (data.toString("latin1", at, at + 4) === "cmap") cmapAt = data.readUInt32BE(at + 8);
  }
  if (!cmapAt) return [];
  const count = data.readUInt16BE(cmapAt + 2);
  let chosen = 0;
  let format = 0;
  for (let sub = 0; sub < count; sub++) {
    const at = cmapAt + 4 + sub * 8;
    const platform = data.readUInt16BE(at);
    const encoding = data.readUInt16BE(at + 2);
    const offset = cmapAt + data.readUInt32BE(at + 4);
    const next = data.readUInt16BE(offset);
    if (next === 12 && ((platform === 3 && encoding === 10) || platform === 0)) return groups(data, offset);
    if (format === 0 && next === 4 && platform === 3 && encoding === 1) {
      chosen = offset;
      format = 4;
    }
  }
  if (format !== 4) return [];
  const segments = data.readUInt16BE(chosen + 6) / 2;
  const ends = chosen + 14;
  const starts = ends + segments * 2 + 2;
  const out: Span[] = [];
  for (let segment = 0; segment < segments; segment++) {
    const start = data.readUInt16BE(starts + segment * 2);
    const end = data.readUInt16BE(ends + segment * 2);
    if (end === 0xffff) continue;
    out.push({ start, end });
  }
  return out;
}

function groups(data: Buffer, at: number): readonly Span[] {
  const count = data.readUInt32BE(at + 12);
  const out: Span[] = [];
  for (let group = 0; group < count; group++) {
    const row = at + 16 + group * 12;
    out.push({ start: data.readUInt32BE(row), end: data.readUInt32BE(row + 4) });
  }
  return out;
}

function covered(code: number): boolean {
  if (!spans) {
    const data = fontBytes("regular");
    spans = data ? cmapSpans(data) : [];
  }
  return spans.some((span) => code >= span.start && code <= span.end);
}

export function textRuns(text: string, weight: FontWeight): readonly TextRun[] {
  const runs: TextRun[] = [];
  for (const char of text) {
    const font: TextFont = covered(char.codePointAt(0) ?? 0) ? weight : "fallback";
    const last = runs.at(-1);
    if (last?.font === font) runs[runs.length - 1] = { font, text: last.text + char };
    else runs.push({ font, text: char });
  }
  return runs;
}
