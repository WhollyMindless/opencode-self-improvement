import { describe, expect, test } from "bun:test";
import {
  corroboratedKeyword,
  guidedAttestation,
  ledgerText,
  statesValue,
  withholdUngroundedGuidance,
} from "../../src/capture/attest.ts";

describe("ledger attestation", () => {
  test("the ledger renders tool, command and target, and skips junk", () => {
    expect(
      ledgerText([
        { tool: "Bash", cmd: "Bun Test", arg: "src/App.test.ts" },
        null as never,
        { tool: 1 } as never,
        { tool: "  " },
        { tool: "read" },
      ]),
    ).toBe("bash bun test src/app.test.ts read");
  });
  test("tool output never enters the haystack", () => {
    const ledger = ledgerText([{ tool: "read", arg: "src/pricing.ts" }]);
    expect(ledger).not.toContain("docs");
    expect(ledger).not.toContain("stale");
  });
  test("a term must match a whole word or path segment", () => {
    const ledger = ledgerText([{ tool: "bash", cmd: "bun run lint" }]);
    expect(corroboratedKeyword(["run"], ledger)).toBe("run");
    expect(corroboratedKeyword(["un"], ledger)).toBeNull();
    expect(corroboratedKeyword(["lin"], ledger)).toBeNull();
    expect(corroboratedKeyword(["bun-run"], ledger)).toBeNull();
    const paths = ledgerText([{ tool: "read", arg: "src/pricing_test.ts" }]);
    expect(corroboratedKeyword(["test"], paths)).toBeNull();
    expect(corroboratedKeyword(["pricing_test"], paths)).toBe("pricing_test");
  });
  test("short keywords and an empty ledger attest nothing", () => {
    expect(corroboratedKeyword(["go"], "go test ./go")).toBeNull();
    expect(corroboratedKeyword(["bun"], "")).toBeNull();
    expect(corroboratedKeyword([], "bun test")).toBeNull();
    expect(corroboratedKeyword(undefined, "bun test")).toBeNull();
    expect(corroboratedKeyword([7 as never], "bun test")).toBeNull();
  });
  test("a stated number is a value", () => {
    expect(statesValue("the rate is 8.25 percent")).toBe(true);
    expect(statesValue("trust the code over the docs")).toBe(false);
  });
  test("a guided row is kept on a value, a ledger hit, or nothing to check", () => {
    const base = {
      type: "preference",
      scope: "docs",
      content: "Documentation may contain stale behavior claims.",
    };
    expect(
      guidedAttestation(
        { ...base, guided: true, original: "The rate is 8.25 percent." },
        "",
      ),
    ).toEqual({ attested: true, via: "value" });
    expect(
      guidedAttestation(
        { ...base, guided: true, kw: ["bun", "npm"] },
        ledgerText([{ tool: "bash", cmd: "bun test" }]),
      ),
    ).toEqual({ attested: true, via: "ledger" });
    expect(
      guidedAttestation({ ...base, guided: true, claim: "8.25" }, ""),
    ).toEqual({ attested: true, via: "value" });
    expect(guidedAttestation({ ...base, guided: true }, "bun test")).toEqual({
      attested: true,
      via: "undecidable",
    });
    expect(
      guidedAttestation({ ...base, guided: true, kw: ["docs"] }, ""),
    ).toEqual({ attested: true, via: "undecidable" });
    expect(guidedAttestation({ ...base, kw: ["bun"] }, "bun test")).toEqual({
      attested: true,
      via: "undecidable",
    });
  });
  test("a guided row naming nothing the session used is refused", () => {
    expect(
      guidedAttestation(
        {
          type: "preference",
          scope: "docs",
          content:
            "In this repository, src module invariants are authoritative over docs/ARCHITECTURE.md.",
          guided: true,
          original: "Trust the code's invariants over the docs.",
          kw: ["docs", "ARCHITECTURE.md", "stale"],
        },
        ledgerText([
          { tool: "read", arg: "src/pricing.ts" },
          { tool: "bash", cmd: "bun test", arg: "src/pricing.test.ts" },
        ]),
      ),
    ).toEqual({ attested: false });
  });
  test("withholding clears the grant and its fields, and keeps the prose", () => {
    const refused = {
      type: "preference",
      scope: "docs",
      content: "Documentation may contain stale behavior claims.",
      guided: true,
      original: "Trust the code over the docs.",
      ref: "ARCHITECTURE",
      claim: "stale",
      klass: "behavior" as const,
      kw: ["docs"],
    };
    const kept = {
      type: "context",
      scope: "pricing",
      content: "The sales tax rate is 8.25 percent.",
      guided: true,
      original: "The sales tax rate is 8.25 percent.",
    };
    const rows = withholdUngroundedGuidance([refused, kept], "bun test");
    expect(rows).toBe(1);
    expect(refused.guided).toBe(false);
    expect(refused.original).toBeUndefined();
    expect(refused.ref).toBeUndefined();
    expect(refused.claim).toBeUndefined();
    expect(refused.klass).toBeUndefined();
    expect(refused.content).toBe(
      "Documentation may contain stale behavior claims.",
    );
    expect(kept.guided).toBe(true);
    expect(kept.original).toBe("The sales tax rate is 8.25 percent.");
  });
  test("junk input yields no refusals", () => {
    expect(withholdUngroundedGuidance([], "")).toBe(0);
    expect(
      withholdUngroundedGuidance(
        [{ type: "context", scope: "a", content: "x", kw: [null as never] }],
        "",
      ),
    ).toBe(0);
  });
});
