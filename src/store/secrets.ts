// Small, conservative credential scrubber shared by capture egress and the
// write gate. Prefix patterns are intentionally limited to well-known token
// families; generic values are redacted only when assigned to a credential-
// named field and they look high-entropy, so ordinary identifiers survive.
export const REDACTED_SECRET = "[redacted]";

// PEM redaction is a linear marker-pair scan, not one lazy regex. The old
// /-----BEGIN...[\s\S]*?-----END.../g re-scanned to end-of-input at every
// unmatched BEGIN, so a large tool output of repeated BEGIN lines with no END
// line stalled the hook for seconds per megabyte (#290). The marker regexes
// below are anchored (sticky) and never span lines, so each probe is bounded.
const PRIVATE_KEY_BEGIN = "-----BEGIN";
const PRIVATE_KEY_END = "-----END";
const BEGIN_MARKER = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/y;
const END_MARKER = /-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/y;

function scanMarkers(
  text: string,
  probe: string,
  marker: RegExp,
): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  for (let i = text.indexOf(probe); i >= 0; i = text.indexOf(probe, i + 1)) {
    marker.lastIndex = i;
    const m = marker.exec(text);
    if (m) found.push({ start: i, end: i + m[0].length });
  }
  return found;
}

// Equivalent to the old global regex replace with REDACTED_SECRET: earliest
// BEGIN wins, the lazy quantifier pairs it with the earliest END at or after
// the BEGIN marker, matches never overlap, and an unmatched BEGIN stays.
function redactPrivateKeyBlocks(text: string): string {
  const begins = scanMarkers(text, PRIVATE_KEY_BEGIN, BEGIN_MARKER);
  if (begins.length === 0) return text;
  const ends = scanMarkers(text, PRIVATE_KEY_END, END_MARKER);
  if (ends.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const begin of begins) {
    if (begin.start < pos) continue;
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid].start < begin.end) lo = mid + 1;
      else hi = mid;
    }
    // No END at or after this BEGIN: this pair cannot match. A later BEGIN
    // may still pair with an END inside this BEGIN's span, so keep going.
    if (lo === ends.length) continue;
    out += text.slice(pos, begin.start) + REDACTED_SECRET;
    pos = ends[lo].end;
  }
  return pos === 0 ? text : out + text.slice(pos);
}

const PREFIXED_SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[po]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/g;
// A real bearer token has digits; prose like "Bearer authentication-scheme" doesn't.
const BEARER_SECRET =
  /\bBearer\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi;
const ASSIGNED_SECRET =
  /(\b(?:[A-Za-z][A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)|password)\b["']?\s*(?::|=)\s*["']?)([A-Za-z0-9+/_=.-]{16,})/gi;
// `API_KEY=process.env.OPENAI_API_KEY` names where the key lives; keep it.
const DOTTED_IDENTIFIER =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function looksHighEntropy(value: string): boolean {
  if (value.length < 16 || new Set(value).size < 10) return false;
  if (!/[0-9]/.test(value) || DOTTED_IDENTIFIER.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(value),
  ).length;
  return classes >= 3;
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = redactPrivateKeyBlocks(text);
  out = out.replace(PREFIXED_SECRET, REDACTED_SECRET);
  out = out.replace(BEARER_SECRET, REDACTED_SECRET);
  return out.replace(ASSIGNED_SECRET, (match, prefix: string, value: string) =>
    looksHighEntropy(value) ? `${prefix}${REDACTED_SECRET}` : match,
  );
}

export function containsSecret(text: string | undefined): boolean {
  return typeof text === "string" && redactSecrets(text) !== text;
}
