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
const FILLER = new Set([
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
 * VETO 2: a figure the matched DECLARATION does not carry.
 *
 * `core/tokenize.ts` states the rule and `store/tombstones/tombstone.ts`
 * measures it on this repo's own data: a correction scores HIGHER than an honest
 * rewording, so overlap alone cannot separate "the same fact again" from "the
 * fact has changed". On the declared-command path the manifest states only that
 * a command exists, so any number the row asserts has to be in the DECLARED
 * command — `gate.label` — or the row is new. The comparison text is never the
 * candidate's own spans: a row whose command span carries a flag value
 * (`--timeout 5000`) would supply the figure that clears its own veto, and the
 * declaration, not the row, is what must vouch for the number.
 * `numericTokens` keeps dotted numbers whole, so versions and addresses are
 * single figures and cannot be assembled out of separate integers.
 */
function introducesNewNumber(text: string, matched: string): boolean {
  const known = new Set(numericTokens(matched));
  for (const n of numericTokens(text)) if (!known.has(n)) return true;
  return false;
}

/**
 * True when every figure `text` states appears in `known` as a whole token —
 * the veto-2 rule aimed at the whole tracked-file haystack instead of one
 * declaration. `claims()` splits on `.` as well as `,`, so a figure the tree
 * never states (`1.5`, `1.4.3`, `10.20.30.40`) can otherwise reassemble from
 * fragments of separate sentences (`1 second`, `5 seconds`) and ride the
 * refusal; a corrected figure is the transport class, the row the store
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
 * emphasis and backticks, and runs of whitespace. This is verbatim modulo
 * formatting, and the evidence line says so rather than claiming fuzzy matching.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
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
  where: string;
  /**
   * True for a step among siblings — a Makefile recipe, a workflow `run:` line.
   * Those share one `where` across the whole file while stating nothing about
   * each other, so the label is all the declaration it has.
   */
  solo?: boolean;
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
  const add = (label: string, where: string, solo = false) => {
    const n = norm(label);
    if (n.length >= 2 && n.length <= 80) gates.push({ label: n, where, solo });
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
          add(name, `${file} scripts.${name}`);
          if (typeof cmd === "string") add(cmd, `${file} scripts.${name}`);
        }
      } catch {
        // An unparseable manifest is not evidence of absence.
      }
      continue;
    }
    if (base === "Makefile" || base === "makefile" || base === "justfile") {
      for (const line of text.split("\n")) {
        const target = /^([A-Za-z0-9_.%-]+)\s*:(?!=)/.exec(line);
        if (target?.[1]) add(target[1], `${file} target ${target[1]}`);
        const recipe = /^\t+([^\s].*)$/.exec(line);
        if (recipe?.[1]) add(recipe[1], `${file} recipe`, true);
      }
      continue;
    }
    for (const line of text.split("\n")) {
      const run = /^\s*-?\s*run:\s*["']?(.+?)["']?\s*$/.exec(line);
      if (run?.[1]) add(run[1], `${file} run`, true);
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
 * The labels that vouch for a declaration: the matched one, plus those sharing
 * its `where` when that `where` names ONE command. A script declaration states
 * its name and its command together, so `--prod` written in the command vouches
 * for `--prod` in the row. A step-kind `where` names a FILE — every recipe in a
 * Makefile, every `run:` in a workflow — and siblings state nothing about each
 * other, so there the matched label alone vouches.
 */
function vouchLabels(gate: Gate, gates: Gate[]): string[] {
  const out: string[] = [];
  for (const g of gates) {
    if (g.where !== gate.where) continue;
    if (gate.solo && g.label !== gate.label) continue;
    out.push(g.label);
  }
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
 * Anything the check cannot establish — the label not located, values swapped,
 * flags reordered, an operand broken by a word the declaration omits — keeps
 * the row. Reordering valueless flags keeps too: order-irrelevance is not a
 * thing a token comparison can prove, a wrong keep costs a row, and a wrong
 * refusal costs a fact.
 */
function operandsDeclared(spans: string[], gate: Gate, gates: Gate[]): boolean {
  for (const span of spans) {
    const matched = gateHit([span], gates) ?? gate;
    // Each span vouches with its OWN declaration. One shared label set let a
    // second, unrelated mention lend its operands to the first: with `build:
    // "compiler"` and `deploy: "deploy-tool publish --target staging …"`, the
    // row `Run \`npm run deploy\`. Run \`npm run build -- --target staging\`.`
    // checked the build operand against the deploy command, which happens to
    // contain it, and the bare deploy mention hid the build information.
    const candidates = operandCandidates(span, matched);
    if (candidates.length === 0) return false;
    const labels = vouchLabels(matched, gates);
    if (!candidates.some((o) => o.length === 0 || contiguousIn(o, labels)))
      return false;
  }
  return true;
}

// Matching is positional, never substring. A gate named `all` must not refuse a
// row that says `install all deps`, and `test` must not refuse a row about
// "the test suite". So a single-word gate (a script name, a make target) only
// matches the OPERAND position — the first token after the runner is stripped —
// and a multi-word gate (a declared command) matches whole.
function gateHit(spans: string[], gates: Gate[]): Gate | null {
  for (const span of spans) {
    for (const form of runners(span)) {
      const first = form.split(" ")[0] ?? "";
      for (const g of gates) {
        if (form === g.label) return g;
        if (!g.label.includes(" ") && first === g.label) return g;
        if (
          g.label.includes(" ") &&
          (form.startsWith(`${g.label} `) || form.endsWith(` ${g.label}`))
        )
          return g;
      }
    }
  }
  return null;
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
 */
function claims(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[.;:,\n]/)) {
    const c = part.trim();
    if (!c) continue;
    const words = c.split(/[^a-z0-9']+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.every((w) => FILLER.has(w))) continue;
    out.push(c);
  }
  return out;
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

/** The whole sentence around `start .. start+len`, with the offset it starts at. */
function sentenceSpan(
  text: string,
  start: number,
  len: number,
): { text: string; at: number } {
  let a = start;
  while (a > 0 && !isBoundary(text.charCodeAt(a - 1))) a--;
  let b = start + len;
  while (b < text.length && !isBoundary(text.charCodeAt(b))) b++;
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
 * True when the tree states `clauses` as ONE contiguous assertion: each in the
 * candidate's order, with nothing between one and the next but assertion
 * punctuation and whitespace.
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
function restatedContiguously(hay: string, clauses: string[]): boolean {
  if (hay === "") return false;
  let prevEnd = -1;
  let cursor = 0;
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
    if (hit < 0) return false;
    cursor = hit + 1;
    prevEnd = hit + clause.length;
  }
  return true;
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

  // Every figure the tracked tree states, as whole tokens, computed once per
  // pass: a refusal on the text path must not go out while the candidate
  // carries a figure the tree never states as one.
  const hayFigures = new Set(numericTokens(haystack));

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
      const whole = norm(content);
      const needed = claims(whole);
      if (needed.length === 0) needed.push(whole);
      const first = needed[0] ?? whole;
      // Evidence mirror of `whole` and `first`, scrubbed WHILE THE TEXT STILL HAS
      // ITS CASE. `norm()` lowercases, and the prefix scrubber in
      // store/secrets.ts matches `AKIA[A-Z0-9]{16}` case-sensitively, so a span
      // normalised before scrubbing keeps a fully recoverable access key: the
      // logged `akia1234567890abcdef` uppercases straight back to the secret
      //. Redacting `avail.matched` later cannot recover what
      // normalisation already destroyed, so this is the only place it can be
      // done. Verdict logic reads `needed`/`first`, never these.
      const safeWhole = norm(redactSecrets(content));
      const safeFirst = claims(safeWhole)[0] ?? safeWhole;
      // A refusal here claims the tree states EVERY figure the candidate
      // states AND states the whole candidate as one contiguous assertion.
      // Neither follows from matching each claim somewhere: `claims()` splits
      // on `.` and `:`, so `1.5 seconds` arrives as `1` and `5`, and a label
      // from one line can be joined to a value from another.
      if (
        haystack &&
        figuresWithin(content, hayFigures) &&
        restatedContiguously(haystack, needed)
      ) {
        return {
          reason: "in_tracked_file",
          where:
            relative(
              repoDir,
              join(repoDir, fileAt(findClause(haystack, first))),
            ) || "?",
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
      const gate = gateHit(spans, gates);
      if (gate) {
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
        // The comparison text is the DECLARED command, never the candidate's
        // spans: a span carrying `--timeout 5000` would vouch for its own
        // figure, and the manifest states no such number.
        if (introducesNewNumber(content, gate.label)) return null;
        // The strip below removes the ENTIRE span, so what the span carries has
        // to be settled here or it is erased before anything reads it.
        if (!operandsDeclared(spans, gate, gates)) return null;
        const undeclared = spans.some((s) => gateHit([s], gates) === null);
        let residual = content;
        for (const span of spans) residual = residual.split(span).join(" ");
        const rest = claims(norm(residual));
        if (
          !undeclared &&
          (rest.length === 0 || restatedContiguously(haystack, rest))
        ) {
          return {
            reason: "declared_gate",
            where: gate.where,
            matched: safeWhole.slice(0, 120),
          };
        }
      }
      return null;
    },
    scanned: () => ({ files: loaded, bytes, tracked: true, capped }),
  };
}
