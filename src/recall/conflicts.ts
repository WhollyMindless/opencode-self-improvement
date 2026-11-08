// Contradiction surface (POC, bench FINDINGS §4). A user-guided row may
// declare ref (the code symbol its value is about), claim (the user's value)
// and klass (who holds authority). At render time the plugin reads the code —
// bounded, deterministic, NO model call — and a collision renders ONE flagged
// CONFLICT line whose Action is fixed by the class: behavior class trusts the
// code, spec class fixes it. #345 measured the alternative twice: a wrong
// guided row made the agent rewrite a correct constant (raw row) and the
// framing-only fix stayed a coin flip (2 harms in 5). The class rule held 6/6.
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { type Memory } from "../store/model/memory.ts";

export interface CodeFact {
  /** Repo-relative path where the declaration was read. */
  file: string;
  /** The declared literal, verbatim (trimmed). */
  value: string;
}

// Bounded scan: this runs on the injection path. A benchmark repo's src/ is
// tens of files; the caps keep a pathological workspace (or a symlink loop)
// from ever making injection slower than its own model call.
const MAX_FILES = 300;
const MAX_FILE_BYTES = 256 * 1024;
const SCAN_DEPTH = 3;
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".opencode",
]);

function walk(dir: string, root: string, depth: number, out: string[]): void {
  if (depth > SCAN_DEPTH || out.length >= MAX_FILES) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
        walk(join(dir, e.name), root, depth + 1, out);
    } else {
      const dot = e.name.lastIndexOf(".");
      if (dot >= 0 && EXTENSIONS.has(e.name.slice(dot)))
        out.push(join(dir, e.name));
    }
  }
}

/**
 * First `const REF ... = <literal>` under the repo (src/ preferred, whole
 * repo fallback). Deterministic and decidable ONLY for declared constants —
 * a behavior implemented as computed logic is deliberately not guessed: the
 * caller keeps the plain row and its verify-against-code caveat instead.
 */
export function findConstant(dir: string, ref: string): CodeFact | null {
  const files: string[] = [];
  walk(join(dir, "src"), dir, 0, files);
  if (!files.length) walk(dir, dir, 0, files);
  const ident = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${ident}\\b[^=\\n]*=\\s*([^;\\n]+)`,
  );
  for (const f of files) {
    let text: string;
    try {
      if (statSync(f).size > MAX_FILE_BYTES) continue;
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const m = re.exec(text);
    if (m?.[1]) return { file: f.slice(dir.length + 1), value: m[1].trim() };
  }
  return null;
}

/**
 * Numeric-aware agreement: "$50.00" == "50", "0.0825" == "0.0825", and a
 * percent claim matches the fraction it names ("8.25%" == "0.0825"). Anything
 * non-numeric must match after quote/whitespace/currency stripping.
 */
export function valuesAgree(claim: string, code: string): boolean {
  const strip = (s: string) => s.trim().replace(/["'`$,\s]/g, "");
  const a = strip(claim);
  const b = strip(code);
  if (a === b) return true;
  const na = Number(a.endsWith("%") ? a.slice(0, -1) : a);
  const nb = Number(b.endsWith("%") ? b.slice(0, -1) : b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  if (na === nb) return true;
  if (a.endsWith("%") && na / 100 === nb) return true;
  if (b.endsWith("%") && nb / 100 === na) return true;
  return false;
}

/** The one flagged object: both facts, the provenance, the FIXED verdict. */
export function conflictLine(m: Memory, fact: CodeFact): string {
  return (
    `CONFLICT (${m.ref}). Memory: ${m.claim} — user-stated, never verified. ` +
    `Code today: ${m.ref} = ${fact.value} (observed in ${fact.file}). ` +
    (m.klass === "spec"
      ? `Class: spec — the user is the authority on this value. Action: the code is the bug; fix ${m.ref} to ${m.claim}.`
      : `Class: behavior — working code is the authority. Action: trust the code; do not edit ${m.ref}; if the remembered rule looks intentional, raise it with the user instead.`)
  );
}
