// Shared logfmt test helpers extracted from duplicated per-file copies (#225).
// Behavior-preserving: each body is byte-identical to the majority copy it replaces.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../../src/core/config/paths.ts";
import { parseLine, type Fields } from "../../src/core/logfmt/format.ts";
import { dateStr } from "../../src/core/time.ts";

export function readEvidenceLog(): Fields[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((f): f is Fields => f !== null);
}

export function field(line: Fields | undefined, key: string): string {
  return line ? String(line[key] ?? "") : "";
}

export function ev(lines: Fields[], name: string): Fields[] {
  return lines.filter((l) => l.ev === name);
}

export function dayFile(offsetDays = 0): string {
  return join(
    process.env.OPENCODE_MEMORY_DIR!,
    `${dateStr(new Date(Date.now() - offsetDays * 86_400_000))}.logfmt`,
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
