// The cost-claim discipline, enforced rather than hoped for.
//
// Three numbers were published and corrected inside one day, because a metric
// that silently undercounts by 93% still produces a plausible number and a
// plausible number gets quoted. "Be more careful" is not a fix. These checks
// run in CI on every push and cost nothing.
//
// The published numbers live in `bench/claims.json`. Each claim carries its id,
// n, seat, metric, estimator and the issue that records the run, so a claim
// missing one of those fails here before it can reach the README. The README
// must still quote every number the data file lists: prose can be rewritten
// freely while the facts stay pinned, and a third result means editing the data
// file first, which is where the n, seat and metric are demanded.
//
// What stays bound to the README's wording is the prohibitions, because a
// prohibition is a statement about wording: no dollar figure, no token-saving
// sentence, and the word "cheaper" only where an n, a seat and a metric share
// the line. Those match the words a claim can wear, not the table syntax it
// happens to sit in. They are word-matching, not evidence-checking: a claim
// phrased in a shape none of these patterns knows still passes, and the honest
// answer to that is the section's own "What is not claimed here" paragraph.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

interface Claim {
  id: string;
  status: string;
  label: string;
  claim: string;
  n: string;
  seat: string;
  measurement: string;
  estimator: string;
  resolution?: string;
  record: string;
  mustAppear: string[];
}

interface Retracted {
  id: string;
  figures: string[];
  why: string;
  record: string;
}

interface ClaimsFile {
  about: string;
  metric: { definition: string; cache: string };
  rules: string[];
  claims: Claim[];
  retracted: Retracted[];
}

const README = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8");
const LINES = README.split("\n");
const DATA = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "bench", "claims.json"), "utf8"),
) as ClaimsFile;
const PUBLISHED = DATA.claims.filter((c) => c.status === "published");

/**
 * Every markdown file a number could be published in: the README plus anything
 * under `docs/`. A prohibition that guards one file while the prose around it
 * moves to another leaves an unguarded place to publish a claim, which is the
 * exact way a documentation reorganisation weakens a check without touching it.
 */
interface Doc {
  name: string;
  text: string;
  lines: string[];
  /** True for lines inside a ``` fence; the fence lines themselves count. */
  fenced: boolean[];
}

function markdownDocs(): Doc[] {
  const root = join(import.meta.dir, "..", "..");
  const paths = [join(root, "README.md")];
  const walk = (dir: string): void => {
    // A missing docs/ is caught by the coverage check below, not by a
    // filesystem error: "the scan silently guards one file" must fail as a
    // claim, not as a stack trace.
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md")) paths.push(p);
    }
  };
  walk(join(root, "docs"));
  return paths.map((p) => {
    const text = readFileSync(p, "utf8");
    const lines = text.split("\n");
    let open = false;
    const fenced = lines.map((l) => {
      if (l.trimStart().startsWith("```")) {
        open = !open;
        return true;
      }
      return open;
    });
    // Forward slashes on every platform: the coverage check and the failure
    // messages compare these names as paths, and `relative` yields backslashes
    // on Windows, where "docs\file.md" would match neither "docs/" nor a link.
    const name = relative(root, p).split(sep).join("/");
    return { name, text, lines, fenced };
  });
}

const DOCS = markdownDocs();

/** The section's own lines, up to the next `## ` heading. */
function section(heading: string): string[] {
  const start = LINES.findIndex((l) => l.startsWith(heading));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of LINES.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    out.push(line);
  }
  return out;
}

const WORTH = section("## What memory is worth, measured");

describe("the claim file is data the suite can rely on", () => {
  test("every published claim names its n, seat, metric, estimator and record", () => {
    const missing: string[] = [];
    for (const c of DATA.claims) {
      for (const field of [
        "id",
        "status",
        "label",
        "claim",
        "n",
        "seat",
        "measurement",
        "estimator",
        "record",
      ] as const) {
        if (!c[field]?.trim()) missing.push(`${c.id || "<no id>"}.${field}`);
      }
      if (!/^https?:\/\//.test(c.record))
        missing.push(`${c.id}.record is not a link`);
    }
    expect(missing).toEqual([]);
  });

  test("ids are unique, so a retired claim is edited and not duplicated", () => {
    const ids = DATA.claims.map((c) => c.id);
    expect(ids.filter((v, i) => ids.indexOf(v) !== i)).toEqual([]);
  });

  test("every claim lists at least one string the README must carry", () => {
    const empty = DATA.claims.filter((c) => c.mustAppear.length === 0);
    expect(empty.map((c) => c.id)).toEqual([]);
    const blank = DATA.claims.flatMap((c) =>
      c.mustAppear.filter((s) => !s.trim()).map((s) => `${c.id}: "${s}"`),
    );
    expect(blank).toEqual([]);
  });

  test("a retracted figure names the record that retracted it", () => {
    const bad = DATA.retracted
      .filter((r) => !r.why.trim() || !/^https?:\/\//.test(r.record))
      .map((r) => r.id);
    expect(bad).toEqual([]);
  });
});

describe("the effectiveness section quotes every published claim", () => {
  test("the section exists", () => {
    expect(WORTH.length).toBeGreaterThan(5);
  });

  for (const claim of PUBLISHED) {
    test(`${claim.id}: the numbers it publishes are in the section`, () => {
      const text = WORTH.join("\n");
      expect(text).toContain(claim.label);
      expect(text).toContain(claim.n);
      for (const token of claim.mustAppear) expect(text).toContain(token);
    });
  }

  test("every seat the data file names appears in the section", () => {
    // Without a seat these are adjectives, not measurements.
    const text = WORTH.join("\n");
    for (const seat of new Set(PUBLISHED.map((c) => c.seat)))
      expect(text).toContain(seat);
  });

  test("the result rows are exactly the published claims", () => {
    const rows = WORTH.filter((l) =>
      new RegExp(
        `^\\|\\s*\\*\\*(${PUBLISHED.map((c) => c.label).join("|")})\\.\\*\\*`,
      ).test(l.trimStart()),
    );
    expect(rows.length).toBe(PUBLISHED.length);
    // Claim-shaped content, not markdown syntax: a table row survives a leading
    // space or a `|-` prefix, and a third result smuggled in as a bold
    // paragraph is just as much a third result. Only the section's own
    // scaffolding paragraphs are exempt.
    const scaffolding = [
      /^\*\*The metric\.\*\*/,
      /^\*\*What is not claimed here\.\*\*/,
    ];
    const claimShaped = WORTH.filter((l) => {
      const t = l.trimStart();
      // A table row that is not a separator: separators hold only | : - and space.
      if (/^\|/.test(t) && !/^\|[\s:|-]+$/.test(t)) return true;
      if (/^\*\*[^*]+\.\*\*/.test(t) && !scaffolding.some((r) => r.test(t)))
        return true;
      return false;
    });
    // The table header plus one row per published claim. Nothing else.
    expect(claimShaped.length).toBe(PUBLISHED.length + 1);
  });
});

describe("no cost claim the corrected metric cannot support", () => {
  test("the scan covers the docs as well as the README", () => {
    // The prose this check guards is no longer in one file. If the walk ever
    // stops finding it, the prohibitions would pass by scanning nothing.
    expect(DOCS.some((d) => d.name === "README.md")).toBe(true);
    expect(
      DOCS.filter((d) => d.name.startsWith("docs/")).length,
    ).toBeGreaterThan(5);
  });

  test("no dollar figure in any published markdown", () => {
    // A local seat has no cache price. Any dollar figure in this repository's
    // prose is either hosted-provider-measured (none exists) or invented. The
    // word spellings count too — "1.20 USD", "two dollars" and "＄5" are dollar
    // figures — while fenced code (a shell `$1`) and an explicit denial of
    // money are not.
    const money = /\$\s?\d|＄\s?\d|\bUSD\b|\bdollars?\b|\bcents?\b/i;
    const denial = /\bno\b[^.]*\bdollar|\bnot\b[^.]*\bdollar|\bno\b[^.]*\bUSD/i;
    const hits = DOCS.flatMap((d) =>
      d.lines
        .map((l, i) =>
          !d.fenced[i] && money.test(l) && !denial.test(l)
            ? `${d.name}:${i + 1}: ${l.slice(0, 80)}`
            : null,
        )
        .filter((x): x is string => x !== null),
    );
    expect(hits).toEqual([]);
  });

  test("no sentence asserts a token saving", () => {
    // Every phrasing a saving claim can wear, on one line or split across a
    // bullet and its sub-bullets: "30% fewer tokens", "30% reduction in
    // tokens", "2× fewer tokens", "cuts token use by 30%", "saves an estimated
    // 1,000 tokens", "1,000 tokens avoided". An explicit denial ("No tokens
    // saved here.") states the rule, not a claim, and passes.
    const saving =
      /(?:\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s*×)\s*(?:fewer|less|cheaper|reduction|drop|saving)s?\b[^.]{0,20}\btokens?\b|(?:cuts?|reduces?|lowers?|drops?|saves?)\b[^.]{0,40}\btokens?\b[^.]{0,20}\bby\s+\d|saves?\b[^.]{0,40}[\d,.]+\s+tokens?\b|tokens?\s+(?:saved|reduced|avoided|eliminated)/i;
    const negation = /\b(?:no|not|never|zero)\b/i;
    const hits: string[] = [];
    const indentOf = (l: string) => l.length - l.trimStart().length;
    for (const d of DOCS) {
      d.lines.forEach((line, i) => {
        if (d.fenced[i]) return;
        let text = line;
        const indent = indentOf(line);
        for (let j = i + 1; j < d.lines.length && !d.fenced[j]; j++) {
          if (d.lines[j].trim() === "") break;
          if (indentOf(d.lines[j]) <= indent) break;
          text += " " + d.lines[j];
        }
        const m = text.match(saving);
        if (m && !negation.test(text.slice(0, m.index)))
          hits.push(`${d.name}:${i + 1}: ${line.slice(0, 80)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  test("a percentage is never attached to tokens without saying bytes", () => {
    // "12.3% fewer characters" is a byte measurement and must stay labelled as
    // one: bytes on a deterministic workload are not tokens and not a bill.
    const hits = DOCS.flatMap((d) =>
      d.lines
        .map((l, i) =>
          /\d+(?:\.\d+)?%\s*(?:fewer|less)\b/.test(l) &&
          /token/i.test(l) &&
          !/not tokens|bytes/i.test(l)
            ? `${d.name}:${i + 1}: ${l.slice(0, 80)}`
            : null,
        )
        .filter((x): x is string => x !== null),
    );
    expect(hits).toEqual([]);
  });

  test("a figure retracted in the data file never comes back", () => {
    // Each of these was published and withdrawn. The data file keeps them so
    // the withdrawal is a check and not a memory — in any file, not just the
    // one that was corrected.
    const hits: string[] = [];
    for (const d of DOCS)
      for (const r of DATA.retracted)
        for (const figure of r.figures)
          if (d.text.includes(figure))
            hits.push(`${d.name}: ${r.id} ${figure}`);
    expect(hits).toEqual([]);
  });
});

describe("the word cheaper carries its evidence", () => {
  // The rules list is allowed to NAME the words it bans; that is the only
  // exemption, and it is bounded by the rules block's own extent — the heading
  // plus the bullet block that follows it — so a line parked just past the
  // block cannot hide in a fixed nine-line window. A document without that
  // block gets no exemption at all.
  function rulesBlock(doc: Doc): [number, number] | null {
    const start = doc.lines.findIndex((l) =>
      l.includes("**Rules for any cost claim"),
    );
    if (start < 0) return null;
    let i = start + 1;
    while (i < doc.lines.length && doc.lines[i].trim() === "") i++;
    let end = i - 1;
    while (i < doc.lines.length && doc.lines[i].trim() !== "") {
      end = i;
      i++;
    }
    return [start, end];
  }

  test("the rules list exists in the README, so the exemption has an anchor", () => {
    expect(
      rulesBlock(DOCS.find((d) => d.name === "README.md")!),
    ).not.toBeNull();
  });

  test("every other line with 'cheaper' names an n, a seat and a metric", () => {
    const offenders: string[] = [];
    for (const d of DOCS) {
      const block = rulesBlock(d);
      d.lines.forEach((line, i) => {
        if (!/cheaper/i.test(line)) return;
        if (block && i >= block[0] && i <= block[1]) return;
        const hasN = /\bn\s*[=≥>]\s*\d|n=\d+\s*pairs|\dn\b.{0,20}pairs/i.test(
          line,
        );
        const hasSeat = /seat|evo\/|llama|hosted provider/i.test(line);
        const hasMetric =
          /work\s*=|generation|uncached|cache read|metric/i.test(line);
        if (!(hasN && hasSeat && hasMetric))
          offenders.push(`${d.name}:${i + 1}: ${line.slice(0, 80)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("the rules are written down where contributors hit them", () => {
  for (const rule of DATA.rules) {
    test(`the section states: ${rule}`, () => {
      expect(WORTH.join("\n")).toContain(rule);
    });
  }

  test("the resolution label is stated on the row it qualifies", () => {
    // Pinned to the result row: the label may not survive only in the rules
    // bullet while the row quietly becomes "10% resolution".
    for (const claim of PUBLISHED) {
      const resolution = claim.resolution;
      if (!resolution) continue;
      const row =
        WORTH.find((l) =>
          new RegExp(`^\\|\\s*\\*\\*${claim.label}\\.\\*\\*`).test(l),
        ) ?? "";
      expect(row).toContain(resolution);
    }
  });

  test("the corrected metric is defined in words, not implied", () => {
    expect(WORTH.join("\n")).toContain(DATA.metric.definition);
  });
});
