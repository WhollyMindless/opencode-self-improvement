// Opt-in auto-capture core. Pure and dependency-free: no opencode
// imports, no filesystem, no ambient clock — the transcript, the model call
// and time are all injected by the caller (src/index.ts), so everything here
// is unit-testable. Every candidate that leaves this module still flows
// through runWriteGate in index.ts: capture NEVER writes memories directly,
// so dupes/stale/canonical rules keep the moat (same as model-authored writes).
// All parsing functions are TOTAL: any malformed input yields [] / "" / null,
// never a throw.
import { STATUSES, TYPES } from "./types.ts";
import { flattenMemoryText } from "./sanitize.ts";
import { redactSecrets } from "./secrets.ts";

export interface CaptureOptions {
  model: string; // "provider/id"
  max: number;
}

export interface CaptureDeps {
  generate: (prompt: string) => Promise<string>;
  sessionText: string;
  now: () => Date;
}

export interface CaptureCandidate {
  type: string;
  scope: string;
  content: string;
  status?: "open" | "settled";
  /** Retrieval keywords (#40): indexed by the store, never rendered. */
  kw?: string[];
}

// Keywords are the vocabulary bridge for the strict-paraphrase wall, mined from
// the transcript the model just saw. Cap and shape mirror the store's own
// limits; the store normalises again at write, so this only has to stay
// junk-proof (capture.ts never imports the store — it stays dependency-free).
const CAPTURE_KEYWORD_CAP = 8;
const CAPTURE_KEYWORD_CHARS = 48;

function cleanKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const k = item.trim().toLowerCase();
    if (!k || k.length > CAPTURE_KEYWORD_CHARS || flattenMemoryText(k) !== k) continue;
    if (!out.includes(k)) out.push(k);
    if (out.length === CAPTURE_KEYWORD_CAP) break;
  }
  return out.length ? out : undefined;
}

// Prompt for the cheap capture model. The output contract is a bare JSON
// array so parseCandidates can trust it; anything else parses to [].
export function buildCapturePrompt(transcript: string, max = 3): string {
  return [
    "You mine one coding-agent session transcript for durable memories worth keeping across future sessions.",
    "",
    `Output ONLY a JSON array of at most ${max} objects (a fenced json block is fine), each:`,
    '{"type": "...", "scope": "...", "content": "...", "status": "...", "kw": ["...", "..."]}',
    "",
    "Rules:",
    `- type: one of ${TYPES.join(", ")}.`,
    "- scope: short area name (e.g. auth, api, build).",
    '- status: "open" for a live planning thread; otherwise "settled".',
    "- content: one self-contained fact, 20-600 characters, useful in a NEW session.",
    '- kw: 3-5 search keywords for how a DIFFERENT session would ask for this — synonyms and alternate names, other verb forms, the literal command or file name. They are indexed for retrieval and never shown to a model. Omit (or []) when the content already uses those words.',
    "- Keep: decisions made, working commands, user preferences, blockers hit, durable context, conventions.",
    "- Skip: anything derivable from the code or git history, small talk, and details that only mattered inside this conversation.",
    "- If nothing is worth remembering, output [ ].",
    "",
    "Transcript:",
    redactSecrets(transcript),
  ].join("\n");
}

const VALID_TYPES = new Set<string>(TYPES);

// Remove markdown code-fence marker lines, keeping the fenced payload.
function stripFences(text: string): string {
  return text.replace(/^[ \t]*```[^\n]*$/gm, "");
}

// First balanced [...] span, string-literal aware. null when absent or
// unbalanced (a model that truncates mid-array yields nothing, not garbage).
function firstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Extract memory candidates from a model reply. Never throws: any malformed
// input yields []. Items missing fields, with unknown types, or with content
// outside 20-600 chars are dropped; the result is clamped to `max`.
export function parseCandidates(raw: string, max: number): CaptureCandidate[] {
  try {
    if (typeof raw !== "string" || !raw.trim() || !(max > 0)) return [];
    const span = firstJsonArray(stripFences(raw));
    if (!span) return [];
    const parsed = JSON.parse(span);
    if (!Array.isArray(parsed)) return [];
    const out: CaptureCandidate[] = [];
    for (const item of parsed) {
      if (out.length >= max) break;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const o = item as Record<string, unknown>;
      const rawType = typeof o.type === "string" ? o.type : "";
      const rawScope = typeof o.scope === "string" ? o.scope : "";
      const type = rawType.trim();
      const scope = rawScope.trim();
      const content = typeof o.content === "string" ? o.content.trim() : "";
      if (!type || !scope || !content) continue;
      if (
        flattenMemoryText(rawType) !== rawType ||
        flattenMemoryText(rawScope) !== rawScope
      ) continue;
      if (!VALID_TYPES.has(type)) continue;
      if (content.length < 20 || content.length > 600) continue;
      const status = o.status === "open" || o.status === "settled" ? o.status : undefined;
      // A bad kw list costs the row its keywords, never the row itself.
      const kw = cleanKeywords(o.kw);
      out.push({
        ...(status ? { type, scope, content, status } : { type, scope, content }),
        ...(kw ? { kw } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

// "provider/id" -> { providerID, id }, splitting on the FIRST "/". Returns
// null when the string has no slash or either half is empty — the caller then
// skips capture entirely rather than guessing a model.
export function parseModelRef(ref: unknown): { providerID: string; id: string } | null {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf("/");
  if (i <= 0) return null;
  const providerID = ref.slice(0, i).trim();
  const id = ref.slice(i + 1).trim();
  if (!providerID || !id) return null;
  return { providerID, id };
}

// Render an array of session-context messages of unknown shape into
// "role: text" lines. Defensive by construction (the API shape varies and is
// not ours to trust): non-arrays and junk entries are skipped; role comes
// from info.role | role, text from parts[].text | text | content (strings
// only); capped at 40 user turns. Never throws.
const TRANSCRIPT_USER_TURN_CAP = 40;

export function flattenTranscript(msgs: unknown): string {
  try {
    if (!Array.isArray(msgs)) return "";
    const lines: string[] = [];
    let userTurns = 0;
    for (const msg of msgs) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const info =
        m.info && typeof m.info === "object" ? (m.info as Record<string, unknown>) : undefined;
      const role =
        typeof info?.role === "string" ? info.role : typeof m.role === "string" ? m.role : "";
      let text = "";
      let hadPrivatePart = false;
      if (Array.isArray(m.parts)) {
        text = m.parts
          .map((p) => {
            if (!p || typeof p !== "object") return undefined;
            const part = p as Record<string, unknown>;
            const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
            if (partType === "reasoning" || partType === "thinking") {
              hadPrivatePart = true;
              return undefined;
            }
            return part.text;
          })
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .join(" ");
      }
      if (!text && !hadPrivatePart) {
        for (const k of ["text", "content"]) {
          if (typeof m[k] === "string") {
            text = m[k] as string;
            break;
          }
        }
      }
      if (!role || !text.trim()) continue;
      if (role === "user") {
        userTurns++;
        if (userTurns > TRANSCRIPT_USER_TURN_CAP) break;
      }
      lines.push(`${role}: ${text.trim()}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}
