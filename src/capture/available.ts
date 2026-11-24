// capture spends its budget on facts the next session cannot obtain any
// other way.
//
// Measured (FINDINGS 2026-11-10, base3 vs base4): reuse does not pay — six pairs,
// every arm 6/6, median L2/L0 0.98x — while transport does: an empty store 0/5,
// the same store seeded 5/5. The difference is not "interesting" and not
// "durable". It is whether the next session could get the fact by itself. Capture
// had no notion of that question, and at roughly a third of a session's own
// generation a row that changes nothing is not free.
//
// Two availability questions are answerable by a CODE PATH, with no prompt and no
// model call, which is what criterion 1 demands:
//
//   1. Is this text already in the working tree? A row that restates a tracked
//      file is readable there by the next session.
//   2. Is this command already declared by the project's own gates? A row that
//      says "run `make deploy`" is answered by the Makefile.
//
// Both questions now REFUSE the candidate at capture time: the next session
// reads the file named in the refusal line, so the row buys nothing. An
// earlier refusal rule was retired for matching fragments — it refused rows
// that were not restatements at all — and the matcher built in its place is
// the predicate that refuses now:
//
//   - every claim is checked, not sampled: one unchecked clause is enough to
//     make the row new, and the unchecked part is where the new fact lives;
//   - polarity and numbers are VETOES, not evidence: they can only decline to
//     refuse, never create a refusal. The number check is the house
//     `numericTokens` set from `core/tokenize.ts`; see the two vetoes below
//     for why the polarity check keeps its own cue list as well.
//
// The vetoes can only REMOVE a refusal, never add one — which holds only
// because the one place that compares two texts, `findClause`, compares them
// on the narrow cue list. Widen that comparison and agreement gets easier,
// and an agreement is what refuses; see VETO 1. Saltzer & Schroeder's
// fail-safe principle, applied to a suppression filter: the default is keep,
// and a bug must surface as a visible duplicate rather than as content that
// is gone.
//
// The two error directions are not symmetric, and the shape follows that. A
// wrong keep costs one redundant row — a second copy of something readable
// in the tree. A wrong refusal costs a fact the next session cannot rebuild,
// and the transport benchmark says the store's only measured benefit is
// exactly those facts. So refusal demands the strictest evidence the check
// can hold — every assertion restatable verbatim modulo formatting, same
// polarity, no new figure — and abstains, keeping the candidate, on anything
// less. Refusal is scoped to auto-capture: direct writes, updates, imports
// and consolidation are not this filter's business. History: docs/adr/.
//
// Fail-open is the rule throughout. A missing git, an unreadable file, a repo
// that is not a repo, or a budget that ran out is NOT evidence that a fact is
// available — refusing on those would lose the transport win, which is the one
// measured benefit capture has. Every uncertainty keeps the candidate.
import { lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  POL_NEG,
  figureExtent,
  numericTokens,
  polaritySigns,
  tokens,
} from "../core/tokenize.ts";
import { redactSecrets } from "../store/secrets.ts";

/** What made a candidate restatable, and where the next session can get it. */
export type AvailabilityVerdict = {
  reason: "in_tracked_file" | "declared_gate";
  /** Repo-relative file, or the gate's location (`package.json scripts.test`). */
  where: string;
  /** The span that matched, for the evidence line. */
  matched: string;
};

// Tokens that carry no claim of their own: function words, and the handful of
// verbs whose whole meaning is "this command gets run". A fragment made of
// nothing but these is a MENTION, and a mention is what the manifest already
// declares. Everything else is a claim, however short it is — `never` is five
// characters and it is the entire fact: a length
// cutoff drops `Never` and refuses the prohibition).
//
// This is a whitelist for FILLER, which is the only direction a word list can
// safely go: a word left off it is read as a claim and the row is kept. The
// RESTRICTION list this replaces whitelisted what counted as NEW, so every word
// missing from it lost a fact.
//
// Temporal and conditional words (before, after, until, unless, when, if, only,
// once) and every modal are deliberately absent: they state a condition, and a
// manifest declares THAT a command exists, never when it may be run.
//
// Exported for the coverage sweep pin in `test/capture/`: the pin must decide
// "dropped only FILLER" with the SAME whitelist the matcher uses, or a drift
// between two copies loosens the pin in silence.
export const FILLER = new Set([
  // function words
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "so",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "than",
  "it",
  "its",
  "us",
  "we",
  "our",
  "you",
  "your",
  "they",
  "their",
  "them",
  "he",
  "she",
  "i",
  "me",
  "my",
  "is",
  "are",
  "am",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  // mention verbs: "ship with X", "run X", "use X" say only that X is there
  "run",
  "runs",
  "running",
  "use",
  "uses",
  "using",
  "ship",
  "ships",
  "shipping",
  "deploy",
  "deploys",
  "deploying",
  "call",
  "calls",
  "calling",
  "invoke",
  "invokes",
  "invoking",
  "execute",
  "executes",
  "executing",
]);

// Assertion boundaries: the edges of the one sentence a match is judged inside.
// The candidate is split on these, and the text in the tree is walked back to
// them. Code 0 is the joiner the scan puts between tracked
// files, so a clause can never match across two of them.
function isBoundary(code: number): boolean {
  return (
    code === 46 || // .
    code === 59 || // ;
    code === 58 || // :
    code === 44 || // ,
    code === 10 || // newline
    code === 0 // the file joiner
  );
}

// Words that reverse an assertion. This is deliberately NOT the RESTRICTION
// list it replaces. That list tried to decide whether a candidate says anything
// NEW, and an open vocabulary can never do that:
// any word left off the list reopens the class. This one answers one closed
// question — does the sentence the tree states have the same POLARITY as the
// clause matched inside it? `We do not use tabs` and `Use tabs` are not the
// same assertion, and a gate that cannot tell them apart stores the reversal of
// the rule it was reading.
const NEGATION =
  /\b(no|not|nor|never|none|cannot|can'?t|don'?t|doesn'?t|didn'?t|won'?t|isn'?t|aren'?t|without|lacks?|lacking|absent|avoid\w*|prohibit\w*|forbid\w*|disallow\w*|refrain\w*|refuses?|instead of|rather than)\b/;

/**
 * VETO 1: is this sentence reversed?
 *
 * Two sources, unioned, because they answer different questions:
 *
 *   - `NEGATION`, the cue list: "we do NOT use tabs" is negated prose.
 *   - `core/tokenize.ts`'s `polaritySigns`, which is NOT a negation detector and
 *     must not be used as one. It extracts the SIGNED PREDICATES a text asserts
 *     for the contradiction surface, so "we do not use tabs" returns `[]` —
 *     `use` is not a table term. Substituting it for the cue list would have
 *     compared `[]` with `[]`, matched, and re-opened the exact round-3 defect
 *     this regex was written to close. What it adds here is the part a cue list
 *     cannot see: the antonym pairs and the dual-role "never", so "must never
 *     disable" and "enable" do not read as the same claim.
 *
 * USE THIS ONLY WHERE THE ANSWER IS ABSOLUTE. `forbidsCommand` asks "does this
 * sentence forbid the command?" and a yes declines to refuse, so widening it can
 * only ever decline — the fail-safe direction.
 *
 * The relative use, where one text's polarity is compared with another's, is
 * `cueNegated`, and the difference is not academic. Equality gets EASIER as both
 * predicates get broader, and in `findClause` an agreement is what CREATES the
 * refusal. The union predicate must never be that comparison: on the tree
 * `Do not assume the cleaner removes unused rows.` against the candidate
 * `The cleaner removes unused rows.`, `polaritySigns` reads the dual-role
 * `removes` as negative in BOTH strings, the union agrees, and the affirmative
 * claim is refused as restating the sentence that warns against it. The cue
 * list alone sees `not` on one side and nothing on the other and declines;
 * `test/capture/availability-case-bank.test.ts` pins that shape. That is the
 * defect this veto exists for, arriving from the opposite direction.
 */
function negated(text: string): boolean {
  return NEGATION.test(text) || polaritySigns(text).includes(POL_NEG);
}

/**
 * Cue-list polarity, for the one place that COMPARES two texts. Narrow on
 * purpose: a broader predicate here agrees more often, and every extra agreement
 * is a refusal.
 */
function cueNegated(text: string): boolean {
  return NEGATION.test(text);
}

/**
 * True when every figure `text` states appears in `known` as a whole token —
 * the figure rule behind both figure checks, aimed at the matched region on the
 * tracked path and at the vouching declarations on the gate path.
 * `core/tokenize.ts` states the grammar and `store/tombstones/tombstone.ts`
 * measures why a figure is checked at all: a correction scores HIGHER than an
 * honest rewording, so overlap alone cannot separate "the same fact again" from
 * "the fact has changed". `claims()` no longer splits
 * inside a figure and `findClause` admits no hit that cuts one, so a figure the
 * tree never states (`1.5`, `1.4.3`, `10.20.30.40`) cannot reassemble from
 * fragments of separate sentences; this check stays as the second net, because
 * it costs nothing on the fail-open side and catches a figure in prose that no
 * claim matched. A corrected figure is the transport class, the row the store
 * exists to keep. Fails safe in both directions of uncertainty: a candidate
 * with no figures has an empty set and stays restatable.
 */
function figuresWithin(text: string, known: Set<string>): boolean {
  for (const n of numericTokens(text)) if (!known.has(n)) return false;
  return true;
}
// The scan is bounded by bytes, not files: a monorepo's tracked list is huge and
// the point is a cheap check, not an index. One capture pass already pays for a
// model call, which costs far more than this.
const TOTAL_CAP = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST_FILES = 20_000;
const LIST_TIMEOUT_MS = 2_000;

// Docs and config carry restated facts far more often than source does, so they
// are read first and are the first to consume the byte budget.
const PRIORITY = [
  ".md",
  ".mdx",
  ".txt",
  ".adoc",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
];
const TEXT_EXTENSIONS = new Set([
  ...PRIORITY,
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".go",
  ".py",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cc",
  ".sh",
  ".bash",
  ".sql",
  ".css",
  ".html",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor"]);

/**
 * Normalise for a "same words, different wrapping" comparison: case, markdown
 * emphasis and backticks, and runs of whitespace. Newlines survive the collapse
 * as one `\n` because a line is the only separator a markdown heading or list
 * item ever gets, and the coverage test needs to see it; the polarity walk
 * deliberately steps over it, so every polarity decision stays scoped exactly
 * as it was when `norm()` erased newlines. This is verbatim modulo formatting,
 * and the evidence line says so rather than claiming fuzzy matching.
 */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, (m) => (m.includes("\n") ? "\n" : " "))
    .trim();
}

/**
 * Candidate-side normalisation: a row's own line wrapping is formatting, so
 * its newlines collapse to spaces and its claims stay whole. The tree keeps
 * its newlines — they are the only edge a heading or list item gets — so a
 * candidate that would have to re-wrap ACROSS a tree line does not match,
 * which keeps the row: the safe direction.
 */
function normCandidate(s: string): string {
  return norm(s).replace(/\n/g, " ");
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function listed(repoDir: string): string[] | null {
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(["git", "ls-files", "-z"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: LIST_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (p.exitCode !== 0) return null;
  const out = p.stdout?.toString() ?? "";
  if (!out.trim()) return [];
  return out.split("\0").filter(Boolean).slice(0, MAX_LIST_FILES);
}

interface Slice {
  file: string;
  start: number;
  end: number;
}

/** Declared gates: a command the project already runs, and where it is declared. */
interface Gate {
  label: string;
  /** Citation only: the file and the kind of declaration a refusal names. */
  where: string;
  /**
   * Declaration identity. Gates that state the SAME declaration share a group,
   * and only a group member vouches for another: a script's name and its
   * command share one, so `--prod` written in the command vouches for `--prod`
   * in the row. A step among siblings — a Makefile recipe, a workflow `run:`
   * line — gets a group no sibling joins, because those share a `where` across
   * the whole file while stating nothing about each other. The group is part of
   * the contract every declaration kind answers for: a kind whose `where`
   * names a FILE must derive the group per declaration, because reusing the
   * file-wide `where` as the group lets one step's operands vouch for another
   * step's row — a refusal that loses a fact. A required field forces the
   * question at the call site; an optional flag defaults past it.
   */
  group: string;
}

function readTracked(repoDir: string, file: string): string | null {
  const p = join(repoDir, file);
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function skipPath(file: string): boolean {
  return file.split("/").some((seg) => SKIP_DIRS.has(seg));
}

function parseGates(repoDir: string, files: string[]): Gate[] {
  const gates: Gate[] = [];
  const add = (label: string, where: string, group: string) => {
    const n = norm(label);
    if (n.length >= 2 && n.length <= 80) gates.push({ label: n, where, group });
  };
  for (const file of files) {
    if (skipPath(file)) continue;
    const base = file.slice(file.lastIndexOf("/") + 1);
    const text =
      base === "package.json" ||
      base === "Makefile" ||
      base === "makefile" ||
      base === "justfile" ||
      /^\.github\/workflows\/.+\.ya?ml$/.test(file)
        ? readTracked(repoDir, file)
        : null;
    if (text === null) continue;
    if (base === "package.json") {
      try {
        const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
        for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
          const where = `${file} scripts.${name}`;
          add(name, where, where);
          if (typeof cmd === "string") add(cmd, where, where);
        }
      } catch {
        // An unparseable manifest is not evidence of absence.
      }
      continue;
    }
    if (base === "Makefile" || base === "makefile" || base === "justfile") {
      for (const line of text.split("\n")) {
        const target = /^([A-Za-z0-9_.%-]+)\s*:(?!=)/.exec(line);
        if (target?.[1]) {
          const where = `${file} target ${target[1]}`;
          add(target[1], where, where);
        }
        const recipe = /^\t+([^\s].*)$/.exec(line);
        if (recipe?.[1])
          add(recipe[1], `${file} recipe`, `${file} recipe ${norm(recipe[1])}`);
      }
      continue;
    }
    for (const line of text.split("\n")) {
      const run = /^\s*-?\s*run:\s*["']?(.+?)["']?\s*$/.exec(line);
      if (run?.[1]) add(run[1], `${file} run`, `${file} run ${norm(run[1])}`);
    }
  }
  return gates;
}

/** Commands a row states: the backticked spans, which is how this plugin writes them. */
function statedCommands(content: string): string[] {
  const spans: string[] = [];
  const re = /`([^`\n]{2,60})`/g;
  let m = re.exec(content);
  while (m) {
    const span = m[1]?.trim();
    if (span && /^[A-Za-z][A-Za-z0-9_.@:/-]*(?:[ =][^\s`]+)*$/.test(span))
      spans.push(span);
    m = re.exec(content);
  }
  return spans;
}

/** Strip the runner so `bun run test` and the script named `test` are the same thing. */
function runners(span: string): string[] {
  const forms = [norm(span)];
  const stripped = norm(span).replace(
    /^(?:bun(?:x| run)?|npm (?:run|exec)|pnpm (?:run|exec)|yarn|make|task)\s+/,
    "",
  );
  if (stripped && stripped !== forms[0]) forms.push(stripped);
  return forms;
}

/**
 * The labels that vouch for a declaration: every gate in its GROUP. A script
 * declaration states its name and its command together, so `--prod` written in
 * the command vouches for `--prod` in the row. The union is keyed on the group,
 * never on `where`: a step-kind `where` names a FILE — every recipe in a
 * Makefile, every `run:` in a workflow — and siblings state nothing about each
 * other, so each step's group holds only itself. Keying on `where` let a new
 * declaration kind inherit a file-wide union by forgetting a flag, and a
 * file-wide union vouches for a refusal with another step's operands.
 */
function vouchLabels(gate: Gate, gates: Gate[]): string[] {
  const out: string[] = [];
  for (const g of gates) if (g.group === gate.group) out.push(g.label);
  return out;
}

/**
 * What a span states around the command it names: the tokens left after the
 * runner vocabulary and the matched label, one candidate per span form in which
 * that label appears. An empty candidate is the bare invocation.
 */
function operandCandidates(span: string, gate: Gate): string[][] {
  const out: string[][] = [];
  for (const form of runners(span)) {
    const at = form.indexOf(gate.label);
    if (at < 0) continue;
    out.push(
      tokens(`${form.slice(0, at)} ${form.slice(at + gate.label.length)}`),
    );
  }
  return out;
}

/** Is `operand` a contiguous token run inside any vouching label? */
function contiguousIn(operand: string[], labels: string[]): boolean {
  for (const label of labels) {
    const decl = tokens(label);
    for (let i = 0; i + operand.length <= decl.length; i++) {
      if (operand.every((w, j) => decl[i + j] === w)) return true;
    }
  }
  return false;
}

/**
 * VETO 3: does every span add only a run the declaration states?
 *
 * Stripping the whole span before reading the residual hides what the span
 * carried: with `deploy: "deploy-tool publish"` declared, `npm run deploy --
 * --target canary` reduced to the same empty residual as the bare invocation,
 * and the canary target — the session's only fact — was refused with the
 * command it rode. Set membership of the span's words does not close that
 * either: `--target staging --fallback canary` declared against `--target
 * canary --fallback staging` has every word present and the pairing wrong, and
 * a flag reorder or a stripped value reaches the same hole.
 *
 * So the gate path asks the tree path's question — contiguity, not presence.
 * The operand must be a contiguous token run inside a vouching label; the empty
 * operand is the bare invocation, which the declaration states on its own.
 * Each span asks its OWN declarations: one shared label set let a second,
 * unrelated mention lend its operands to the first, and the candidate run and
 * the labels it settles against must come from the SAME declaration —
 * stripping one label and testing the remainder against another's command is
 * the shared lookup in a new coat.
 * Anything the check cannot establish — the label not located, values swapped,
 * flags reordered, an operand broken by a word the declaration omits — keeps
 * the row. Reordering valueless flags keeps too: order-irrelevance is not a
 * thing a token comparison can prove, a wrong keep costs a row, and a wrong
 * refusal costs a fact.
 */
function operandSettled(span: string, gate: Gate, gates: Gate[]): boolean {
  const candidates = operandCandidates(span, gate);
  const labels = vouchLabels(gate, gates);
  return candidates.some((o) => o.length === 0 || contiguousIn(o, labels));
}

// Matching is positional, never substring. A gate named `all` must not refuse a
// row that says `install all deps`, and `test` must not refuse a row about
// "the test suite". So a single-word gate (a script name, a make target) only
// matches the OPERAND position — the first token after the runner is stripped —
// and a multi-word gate (a declared command) matches whole.
//
// Every match is returned, not the first: which file `git ls-files` lists
// first is not evidence, and a span declared in a CI step AND in a manifest
// script rests on both. An empty result means the span states no declared
// command.
function gateHits(span: string, gates: Gate[]): Gate[] {
  const out: Gate[] = [];
  for (const form of runners(span)) {
    const first = form.split(" ")[0] ?? "";
    for (const g of gates) {
      if (out.includes(g)) continue;
      if (form === g.label) out.push(g);
      else if (!g.label.includes(" ") && first === g.label) out.push(g);
      else if (
        g.label.includes(" ") &&
        (form.startsWith(`${g.label} `) || form.endsWith(` ${g.label}`))
      )
        out.push(g);
    }
  }
  return out;
}

/**
 * The assertions in a normalised text: the fragments left after splitting on the
 * sentence boundaries, minus the ones that state nothing.
 *
 * "States nothing" is the FILLER test, not a length: a 16-character
 * cutoff dropped
 * `Never` from `Never \`npm run deploy\`.` and an empty list was then read as proof that
 * the whole candidate was restatable. A short fragment is where a prohibition, a
 * window or a number lives; punctuation and "ship with" are what a fragment has
 * to be before it is ignored.
 *
 * A split never falls inside a figure. Splitting `1.5` at its dot produced two
 * claims that each matched their own sentence and reassembled into a figure the
 * tree never states, and the same fragments let a claim end mid-number in the
 * tree. The boundary waits for `figureExtent`'s figure run to end — including
 * the sentence dot a figure ends on, which the splitter treats as run territory
 * even though the figure's canonical value excludes it
 * (`numericTokens("The cost is 11.")` is `["11"]`). A claim that
 * therefore spans a sentence boundary is fail-open: a longer claim is harder to
 * match, so the rule can only remove refusals.
 */
function claims(text: string): string[] {
  const out: string[] = [];
  for (const part of splitClaims(text)) {
    const c = part.trim();
    if (!c) continue;
    const words = c.split(/[^a-z0-9']+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.every((w) => FILLER.has(w))) continue;
    out.push(c);
  }
  return out;
}

/** The assertion boundaries, minus a `.` that sits inside a figure run. */
function splitClaims(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 46 && c !== 59 && c !== 58 && c !== 10) continue;
    if (c === 46 && figureExtent(text, i)) continue;
    parts.push(text.slice(from, i));
    from = i + 1;
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * Does a sentence that states one of `commands` also FORBID it? Judged on those
 * sentences alone: the manifest says a command exists, so "Never run `x`" is a
 * claim the manifest does not make, while a prohibition in an unrelated clause is
 * that clause's business and the claim check handles it.
 *
 * The bare words are here because `polaritySigns` reads `never` as a modifier
 * that needs a verb, and "Never `npm run deploy`." has the verb inside a code
 * span. A closed list, answering one closed question, over a decision that can
 * now only decline to refuse.
 */
function forbidsCommand(content: string, commands: string[]): boolean {
  for (const sentence of content.split(/[.;:\n]+/)) {
    if (!commands.some((c) => sentence.includes(c))) continue;
    if (
      negated(sentence) ||
      /\b(never|avoid\w*|prohibit\w*|forbid\w*)\b/i.test(sentence)
    )
      return true;
  }
  return false;
}

/**
 * Polarity-scope edges: `isBoundary` minus the newline. The haystack now keeps
 * newlines for the coverage test, and the polarity walk must step over them:
 * a heading's negation has to keep casting its shadow over the line under it,
 * exactly as it did when `norm()` erased newlines. This walk can only decline,
 * and re-scoping it would ADD refusals — the direction this file never moves.
 */
function isSentenceEdge(code: number): boolean {
  return code !== 10 && isBoundary(code);
}

/** The whole sentence around `start .. start+len`, with the offset it starts at. */
function sentenceSpan(
  text: string,
  start: number,
  len: number,
): { text: string; at: number } {
  let a = start;
  while (a > 0 && !isSentenceEdge(text.charCodeAt(a - 1))) a--;
  let b = start + len;
  while (b < text.length && !isSentenceEdge(text.charCodeAt(b))) b++;
  return { text: text.slice(a, b), at: a };
}

/**
 * VETO 1b: does this prefix WARN AGAINST the claim that follows?
 *
 * `Stop assuming the cache supports TTL expiration.` contains the affirmative
 * sentence `The cache supports TTL expiration.` as the object of `stop assuming`.
 * A substring test plus cue equality merges a warning with the claim it warns
 * against, because the cue list carries neither `stop` nor `drop` — and neither
 * does `polaritySigns`, so widening it the way an earlier round tried does not
 * catch this either. Measured on 05482ba: both `Stop assuming X` and `Drop the
 * assumption that X` matched `X` as restatable.
 *
 * The veto reads the words between the sentence start and the hit, not the whole
 * sentence, and that is what keeps it cheap in refusals. `The parser drops stale
 * entries.` states its claim and keeps its refusal, because `drops` there governs
 * `stale entries`, not a following assertion; the ambiguous verbs are therefore
 * veto words only when a claim noun follows them. Every veto declines to refuse,
 * which is the direction this file fails safe in.
 */
const WARNS_AGAINST = new RegExp(
  // One alternation, ONE shared tail. Written as three separate alternatives
  // each ending in `$`, only the last would be anchored and the first would
  // match any sentence that merely contains `stop` anywhere — measured, and it
  // cost the refusal from `The job stops at midnight and the cache supports TTL
  // expiration.`, which states its claim plainly.
  "(?:" +
    // A deterrent verb needs no framing: what follows is being warned against.
    "\\b(?:stop|stops|stopped|stopping|cease|ceases|ceased|quit|quits|quitting|beware|caution\\w*)\\b" +
    // An ordinary verb becomes a deterrent only with a claim noun behind it.
    "|\\b(?:drop|drops|dropped|dropping|discard\\w*|dismiss\\w*|reject\\w*|forget|forgets|forgot|forgetting|ignor\\w*|overlook\\w*)\\b\\s+(?:the|your|this|an|any)\\s+(?:assumption|assumptions|idea|ideas|notion|notions|belief|beliefs|thinking|fact)\\b" +
    // Claim verbs govern whatever follows them, framed or not.
    "|\\b(?:assume|assumes|assumed|assuming|believ\\w*|think|thinks|thought)\\b" +
    // Optional `that`, then nothing: the claim starts here.
    ")\\s*(?:that\\s*)?$",
  "i",
);

function warnsAgainst(prefix: string): boolean {
  return WARNS_AGAINST.test(prefix);
}

/**
 * Does a hit cover every figure it touches, whole? A clause ending at the `3`
 * of `3.12`, or starting at the `5` of `30.5`, cuts a figure in half, and the
 * half re-tokenizes as a whole figure the tree never states: `3` is not in a
 * README that says `Requires Python 3.12`, it is what slicing leaves behind.
 * Word boundaries do not settle this — `.` is a word character to the tokenizer
 * and a sentence boundary to the claim splitter, and the two disagree exactly
 * inside a number. So a hit is admitted only when no figure run crosses either
 * edge, which makes a half-figure unrepresentable rather than merely unvouched.
 * The edges are `figureExtent`'s, from `core/tokenize.ts` — the same definition
 * `numericTokens` compares with, so the boundary this veto admits and the set
 * the refusal vouches cannot disagree.
 */
function hitCoversFigures(hay: string, start: number, end: number): boolean {
  for (const pos of [start - 1, end]) {
    const run = figureExtent(hay, pos);
    if (run && (run.start < start || run.end > end)) return false;
  }
  return true;
}

/**
 * Where the tree states `clause` as its own words, in a sentence of the same
 * polarity. -1 means "not available".
 *
 * A bare `indexOf` matches INSIDE the opposite
 * assertion. With `We do not use tabs for indentation.` in the README, the
 * candidate `Use tabs for indentation.` was refused as available, so the store
 * would have held the reversal of the rule the gate had just read. A hit now
 * has to
 *   - begin and end on a word boundary: `use tabs` is not a hit inside
 *     `abuse tabs`; and
 *   - sit in a sentence that shares the clause's polarity. Negation the tree
 *     carries and the clause drops is a reversal, not a restatement; and
 *   - not be the object of a warning. `Stop assuming X.` states `X` only to
 *     reject it, and no polarity test of any breadth sees that (VETO 1b).
 * A reversed clause is not evidence of availability, and every uncertainty in
 * this file keeps the candidate.
 */
function findClause(hay: string, clause: string, start = 0): number {
  const reversed = cueNegated(clause);
  for (let from = start; ; ) {
    const i = hay.indexOf(clause, from);
    if (i < 0) return -1;
    const before = i > 0 ? hay.charCodeAt(i - 1) : 32;
    const after =
      i + clause.length < hay.length ? hay.charCodeAt(i + clause.length) : 32;
    const sentence = sentenceSpan(hay, i, clause.length);
    if (
      !/\w/.test(String.fromCharCode(before)) &&
      !/\w/.test(String.fromCharCode(after)) &&
      hitCoversFigures(hay, i, i + clause.length) &&
      cueNegated(sentence.text) === reversed &&
      // A later occurrence may state the claim plainly, so a vetoed hit is
      // skipped rather than ending the search.
      !warnsAgainst(hay.slice(sentence.at, i))
    )
      return i;
    from = i + 1;
  }
}

/**
 * Assertion edges for the coverage test: the boundaries `claims()` splits a
 * candidate on, MINUS the comma. An `if` or an `unless` before a comma scopes
 * over what follows it, so a row that keeps only the consequence has dropped
 * the operator that decided it, and the comma must not hide that from the
 * comparison. The polarity veto keeps the comma as an edge on purpose: it can
 * only decline, and re-scoping it there would move every polarity decision
 * in the file.
 */
function isAssertionEdge(code: number): boolean {
  return (
    code === 46 || // .
    code === 59 || // ;
    code === 58 || // :
    code === 10 || // newline
    code === 0 // the file joiner
  );
}

/** Does any word here carry a claim — anything outside FILLER? */
function statesClaim(text: string): boolean {
  return text.split(/[^a-z0-9']+/).some((w) => w !== "" && !FILLER.has(w));
}

/**
 * Does the matched region cover the WHOLE assertion the tree states, modulo
 * FILLER? Containment is a substring relation and a row's claim is never
 * longer than the tree's sentence, so containment alone licenses every row
 * that DROPS material scoping over the span it matched: the condition of
 * "route to the canary only when the flag is set", the frequency of "rebuild
 * weekly", the `not` of a prohibition whose cue the row replaced with one of
 * its own. A refusal on such a row destroys the rule the session brought.
 * The sentence around a hit was already computed and reduced to one polarity
 * bit; here the whole of it is compared instead: every tree word outside the
 * region must be FILLER, or the row states something the tree does not and
 * is kept. A region that ends on its own terminator stops the forward walk —
 * the claim consumed its sentence's final `.`, so the tree's next sentence is
 * a separate assertion, not dropped material.
 */
function coversAssertion(
  hay: string,
  region: { start: number; end: number },
): boolean {
  let a = region.start;
  while (a > 0 && !isAssertionEdge(hay.charCodeAt(a - 1))) a--;
  let b = region.end;
  if (!isAssertionEdge(hay.charCodeAt(region.end - 1))) {
    while (b < hay.length && !isAssertionEdge(hay.charCodeAt(b))) b++;
  }
  return (
    !statesClaim(hay.slice(a, region.start)) &&
    !statesClaim(hay.slice(region.end, b))
  );
}

/**
 * Is the text between two matched claims nothing but assertion punctuation and
 * whitespace? The file joiner breaks contiguity on purpose: two claims from two
 * files are not one statement.
 */
function gapIsPunctuation(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return false;
    if (isBoundary(c) || c === 32 || c === 9) continue;
    return false;
  }
  return true;
}

/**
 * The region where the tree states `clauses` as ONE contiguous assertion, or
 * null: each in the candidate's order, with nothing between one and the next
 * but assertion punctuation and whitespace. The region is part of the answer:
 * the figures a refusal vouches for are the ones the cited passage states.
 *
 * Matching every claim somewhere in the tree is not enough — two sentences can
 * conspire. With `Staging export pool: cobalt-workers.` and `Production export
 * pool: ask operations at rollout.` tracked, both halves of the candidate
 * `Production export pool: cobalt-workers.` exist, but the pairing is the
 * candidate's and not the tree's, and the pairing is the fact the session
 * brought. Reassembled figures fail the same way, one level down.
 *
 * Order is part of the claim: a later half found only BEFORE the earlier one is
 * not the tree stating it. The search takes the earliest admissible hit and
 * skips a hit the gap disqualifies instead of ending there, so every
 * uncertainty — including this check's own greediness — declines a refusal,
 * which is the direction this file fails safe in.
 */
function restatedContiguously(
  hay: string,
  clauses: string[],
): { start: number; end: number } | null {
  if (hay === "") return null;
  let prevEnd = -1;
  let cursor = 0;
  let start = -1;
  for (const clause of clauses) {
    let hit = -1;
    for (let from = cursor; ; ) {
      const i = findClause(hay, clause, from);
      if (i < 0) break;
      if (prevEnd < 0 || gapIsPunctuation(hay.slice(prevEnd, i))) {
        hit = i;
        break;
      }
      from = i + 1;
    }
    if (hit < 0) return null;
    if (start < 0) start = hit;
    cursor = hit + 1;
    prevEnd = hit + clause.length;
  }
  return { start, end: prevEnd };
}

export interface AvailabilityIndex {
  /** Null means "cannot tell, or cannot prove": the candidate is kept. */
  check(content: string): AvailabilityVerdict | null;
  /**
   * For evidence: what the tree scan actually read. `capped` means the byte
   * budget ran out before the tracked list did. It is telemetry only, never a
   * verdict input: both rules assert PRESENCE ("the tree states this"), so a
   * truncated scan can only lower the refusal rate, never raise a false refusal.
   */
  scanned(): {
    files: number;
    bytes: number;
    tracked: boolean;
    capped: boolean;
  };
}

/**
 * One index per capture pass: git is asked once, the byte budget is shared by
 * every candidate in the pass, and the gate declarations are read once.
 */
export function availabilityIndex(
  repoDir: string | undefined,
): AvailabilityIndex {
  if (!repoDir) {
    return {
      check: () => null,
      scanned: () => ({ files: 0, bytes: 0, tracked: false, capped: false }),
    };
  }
  const files = listed(repoDir);
  if (files === null) {
    return {
      check: () => null,
      scanned: () => ({ files: 0, bytes: 0, tracked: false, capped: false }),
    };
  }
  const gates = parseGates(repoDir, files);
  const ranked = [...files]
    .filter((f) => !skipPath(f) && TEXT_EXTENSIONS.has(extOf(f)))
    .sort((a, b) => {
      const pa = PRIORITY.indexOf(extOf(a));
      const pb = PRIORITY.indexOf(extOf(b));
      const ra = pa === -1 ? PRIORITY.length : pa;
      const rb = pb === -1 ? PRIORITY.length : pb;
      return ra - rb || (a < b ? -1 : 1);
    });

  let haystack = "";
  const slices: Slice[] = [];
  let bytes = 0;
  let loaded = 0;
  // Set only when a file is actually SKIPPED, which is what the field claims: a
  // final file that pushes the total past the cap sets nothing, because nothing
  // was left behind. `bytes` counts decoded characters, not octets on disk — the
  // budget is a work bound, not a disk measurement.
  let capped = false;
  for (const file of ranked) {
    if (bytes >= TOTAL_CAP) {
      capped = true;
      break;
    }
    const text = readTracked(repoDir, file);
    if (text === null) continue;
    const n = norm(text);
    if (!n) continue;
    const start = haystack.length;
    haystack += n + "\u0000";
    slices.push({ file, start, end: haystack.length });
    bytes += text.length;
    loaded++;
  }

  const fileAt = (offset: number): string => {
    for (const s of slices)
      if (offset >= s.start && offset < s.end) return s.file;
    return "?";
  };

  return {
    check(content: string): AvailabilityVerdict | null {
      // Matching PART of a candidate does not
      // establish the WHOLE fact is available. Both rules used to refuse on
      // one hit, which lost new facts riding a restated fragment — exactly
      // the rows this gate exists to preserve:
      //   - a README rule + "; Finance confirmed the supplier rate is 1900"
      //     refused on the old clause;
      //   - "Never run `npm run deploy` until finance confirms approval code
      //     BLUEBIRD" refused because the manifest declares `deploy`, although
      //     the restriction and the code appear nowhere.
      // A refusal requires EVERY assertion the candidate makes to be restatable.
      // A refusal demands a claim to restate. An empty candidate has none, and
      // `indexOf("")` succeeds everywhere: without this guard the vacuous hit
      // at the end of the haystack is read as evidence and the refusal cites
      // no file and no span. A candidate with nothing to restate is kept.
      const whole = normCandidate(content);
      if (whole === "") return null;
      const needed = claims(whole);
      if (needed.length === 0) needed.push(whole);
      // Evidence mirror of `whole` and of its first claim, scrubbed WHILE THE
      // TEXT STILL HAS ITS CASE. `norm()` lowercases, and the prefix scrubber in
      // store/secrets.ts matches `AKIA[A-Z0-9]{16}` case-sensitively, so a span
      // normalised before scrubbing keeps a fully recoverable access key: the
      // logged `akia1234567890abcdef` uppercases straight back to the secret
      //. Redacting `avail.matched` later cannot recover what
      // normalisation already destroyed, so this is the only place it can be
      // done. Verdict logic reads `needed`, never these.
      const safeWhole = normCandidate(redactSecrets(content));
      const safeFirst = claims(safeWhole)[0] ?? safeWhole;
      // A refusal here claims the tree states EVERY figure the candidate
      // states AND states the whole candidate as one contiguous assertion.
      // Neither follows from matching each claim somewhere: `claims()` splits
      // on `.` and `:` used to split `1.5 seconds` into `1` and `5`, and a label
      // from one line could be joined to a value from another; the splitter now
      // keeps a figure whole, so what remains to prove is that the tree states
      // the claims as ONE contiguous assertion.
      //
      // The figures are checked against the MATCHED REGION, not the whole
      // tree. `The budget is 1, 5 seconds of margin.` chains across its comma
      // and matches a row saying `1.5 seconds`; a `Node 1.5` in another file —
      // or another sentence of the same file, which is why the whole file is
      // not the scope either — is not the passage being cited, and cannot
      // vouch for the figure the refusal claims it states.
      const region = haystack ? restatedContiguously(haystack, needed) : null;
      if (
        region &&
        coversAssertion(haystack, region) &&
        figuresWithin(
          content,
          new Set(numericTokens(haystack.slice(region.start, region.end))),
        )
      ) {
        return {
          reason: "in_tracked_file",
          where: relative(repoDir, join(repoDir, fileAt(region.start))) || "?",
          matched: safeFirst.slice(0, 120),
        };
      }
      // Declared gate. A LENGTH test is never the question: a short
      // residual is not a restatement, so "`npm run deploy` wipes the
      // staging database." must not refuse against a manifest that says only
      // that `deploy` runs rsync. Nor may information be thrown away BEFORE
      // deciding:
      //   - every command span was stripped after ONE declared gate was found,
      //     so "Before `npm run deploy`, run `aws sso login --profile prod`."
      //     refused with the undeclared AWS prerequisite erased from the row;
      //   - an EMPTY claim list counted as proof, so "Never `npm run deploy`."
      //     refused with its only claim — `never` — dropped as too short.
      // A gate refusal needs all three, each positively established:
      //   1. every command span the row states is declared AS A RUN — the
      //      script exists, AND the operands it adds are a contiguous token
      //      run in the declaration. An undeclared span, or operands the
      //      declaration states only in another order or pairing, is a fact
      //      the tree does not hold, whatever the rest of the row says;
      //   2. what survives stripping them is nothing but FILLER — the bare
      //      mention "ship with X", which is what the manifest does declare; or
      //   3. otherwise, every assertion left in it is one the tracked files
      //      state themselves.
      const spans = statedCommands(content);
      const hits = spans.map((s) => gateHits(s, gates));
      if (hits.some((h) => h.length > 0)) {
        // VETOES. The manifest states that a command EXISTS. It does not
        // state that the command is safe, allowed, or finished, and it carries
        // no figure. So a sentence that forbids the command, or a number the
        // command does not carry, is a claim the declaration cannot answer.
        //
        // These REMOVE a refusal and never add one. A removed refusal costs one
        // redundant row; a refusal that should have been removed costs a fact
        // the store cannot rebuild. That asymmetry is the whole point of the
        // veto-only shape: the vocabulary never has to be perfect, because a
        // miss keeps the row instead of deleting it.
        if (forbidsCommand(content, spans)) return null;
        // VETOES 2 AND 3, per span and per declaration. A span settles
        // against ONE declaration that carries BOTH dimensions: every figure
        // the span states appears among the figures of that declaration's
        // group, and its operand is a contiguous token run inside the same
        // group. The two dimensions stay distinct checks — figures ask
        // set membership, operands ask contiguity and pairing, and collapsing
        // one into the other reopens the pairing hole the contiguity comment
        // above records. What changed is the unit: never one label chosen by
        // scan order, and never the union of two declarations that merely
        // both match the span — a row citing one command is not answered by
        // two commands' figures pooled together. A row that spells
        // `npm run deploy --replicas 3` against
        // `"deploy": "deploy-tool publish --replicas 3"` settles against the
        // deploy declaration, whose command carries the figure, instead of
        // the bare name, which carries none and kept the row for the wrong
        // reason. The comparison text is still the DECLARED command, never
        // the candidate's spans: a span carrying `--timeout 5000` would vouch
        // for its own figure, and the declaration, not the row, is what must
        // vouch for a number.
        const settledBy: Gate[][] = spans.map(() => []);
        for (let i = 0; i < spans.length; i++) {
          for (const g of hits[i]) {
            const known = new Set<string>();
            for (const label of vouchLabels(g, gates))
              for (const n of numericTokens(label)) known.add(n);
            if (!figuresWithin(spans[i], known)) continue;
            if (operandSettled(spans[i], g, gates)) settledBy[i].push(g);
          }
          // No declaration carries the span — undeclared, or operands or
          // figures the declaration does not state. The strip below removes
          // the ENTIRE span, so what the span carries has to be settled here
          // or it is erased before anything reads it.
          if (settledBy[i].length === 0) return null;
        }
        let residual = content;
        for (const span of spans) residual = residual.split(span).join(" ");
        const rest = claims(normCandidate(residual));
        const restRegion =
          rest.length === 0 ? null : restatedContiguously(haystack, rest);
        // The prose the declarations do not answer settles against the tree on
        // the same terms as the tracked path: the region must cover the whole
        // assertion, so a residual that drops a scoping operator keeps the row.
        if (
          rest.length === 0 ||
          (restRegion !== null && coversAssertion(haystack, restRegion))
        ) {
          // A figure outside every quoted command is prose, and prose settles
          // against the passage this refusal cites for it — the same region
          // the tracked path answers with. A figure no cited passage states is
          // a claim the tree does not make, and where there is no region at
          // all nothing vouched for the prose: both keep the row.
          const outside = numericTokens(residual);
          if (outside.length > 0) {
            if (restRegion === null) return null;
            const stated = new Set(
              numericTokens(haystack.slice(restRegion.start, restRegion.end)),
            );
            if (!outside.every((n) => stated.has(n))) return null;
          }
          // The refusal rested on the declarations that settled each span,
          // so it cites exactly those: naming one file for a row resting on
          // two is not evidence, and naming a declaration that settled
          // nothing sends the auditor to the wrong line.
          const cited: string[] = [];
          for (const s of settledBy)
            for (const g of s)
              if (!cited.includes(g.where)) cited.push(g.where);
          return {
            reason: "declared_gate",
            where: cited.join(", "),
            matched: safeWhole.slice(0, 120),
          };
        }
      }
      return null;
    },
    scanned: () => ({ files: loaded, bytes, tracked: true, capped }),
  };
}
