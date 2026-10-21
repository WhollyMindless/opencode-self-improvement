// Minimal logfmt reader/writer shared by the durable store and the evidence
// log. Field order is preserved on write so chains are diffable.
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export type Fields = Record<string, unknown>;

// Escapes for quoted values. One record is one line, so a raw newline inside a
// value would end the record early and the rest of the value would be read
// back as a separate line of fields. Backslash is escaped too, so a value
// ending in `\` cannot swallow its closing quote.
const ESCAPE: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const UNESCAPE: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" };

export function quote(value: unknown): string {
  const s = String(value);
  if (s === "") return '""';
  return /[\s"=]/.test(s) ? `"${s.replace(/[\\"\n\r\t]/g, (c) => ESCAPE[c])}"` : s;
}

export function formatLine(fields: Fields): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${quote(v)}`);
  }
  return parts.join(" ");
}

// Unescape a quoted logfmt value and read it back. Unknown sequences are kept
// as written: older files stored backslashes unescaped (`C:\Program Files`).
function unquote(s: string): string {
  return s.replace(/\\(.)/g, (seq, c: string) => UNESCAPE[c] ?? seq);
}

export function parseLine(line: string): Fields | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("=")) return null;
  const fields: Fields = {};
  const re = /([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|[^\s]*)/g;
  for (;;) {
    const m = re.exec(trimmed);
    if (!m) break;
    const key = m[1];
    let raw = m[2];
    if (raw.startsWith('"') && raw.endsWith('"')) {
      raw = unquote(raw.slice(1, -1));
    }
    fields[key] = raw;
  }
  // parse booleans/numbers as strings is fine; callers coerce.
  return fields;
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function appendLog(file: string, line: string): Promise<void> {
  await ensureDir(dirname(file));
  const next = line.endsWith("\n") ? line : line + "\n";
  const f = Bun.file(file);
  const existing = (await f.exists()) ? await f.text() : "";
  await Bun.write(file, existing + next);
}

export async function readLines(file: string): Promise<string[]> {
  const f = Bun.file(file);
  if (!(await f.exists())) return [];
  const text = await f.text();
  return text.split("\n").filter((l) => l.trim().length > 0);
}

export function bracketList(items: string[]): string {
  return `[${items.join(",")}]`;
}
