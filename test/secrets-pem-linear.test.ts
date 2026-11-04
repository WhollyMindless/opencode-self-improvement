// Contract (#290): PEM redaction must pair BEGIN and END markers in one
// linear pass. The old single lazy regex re-scanned to end-of-input at every
// unmatched BEGIN, so a large tool output of repeated BEGIN lines with no END
// line stalled afterTool for seconds per megabyte. The rewrite must stay
// byte-identical to the old regex on paired, unpaired, nested and adjacent
// marker shapes, and must complete on the adversarial input in milliseconds.
import { expect, test } from "bun:test";
import { redactSecrets, REDACTED_SECRET } from "../src/store/secrets.ts";

// The pre-#290 implementation, kept here as the equivalence oracle.
const OLD_BLOCK =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g;
function oldRedact(text: string): string {
  return text.replace(OLD_BLOCK, REDACTED_SECRET);
}

const KEY = "TUlJRVp4SUJBQUtDQVFFQWZha2UtYm9keS1saW5l";

const CASES: Array<[string, string]> = [
  [
    "plain pair",
    `a\n-----BEGIN PRIVATE KEY-----\n${KEY}\n-----END PRIVATE KEY-----\nb`,
  ],
  [
    "labeled pair",
    `-----BEGIN RSA PRIVATE KEY-----\n${KEY}\n-----END RSA PRIVATE KEY-----`,
  ],
  [
    "multi-label pair",
    `-----BEGIN RSA EC PRIVATE KEY-----\nx\n-----END RSA EC PRIVATE KEY-----`,
  ],
  ["adjacent pair", "-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----"],
  [
    "two pairs",
    `-----BEGIN PRIVATE KEY-----\n${KEY}\n-----END PRIVATE KEY-----mid-----BEGIN RSA PRIVATE KEY-----\n${KEY}\n-----END RSA PRIVATE KEY-----`,
  ],
  ["BEGIN without END stays", "-----BEGIN PRIVATE KEY-----\n" + KEY],
  ["END without BEGIN stays", "-----END PRIVATE KEY-----\n" + KEY],
  [
    "BEGIN then END only",
    `-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----`,
  ],
  [
    "two BEGIN one END",
    `-----BEGIN PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\n${KEY}\n-----END RSA PRIVATE KEY-----`,
  ],
  [
    "one BEGIN two END",
    `-----BEGIN PRIVATE KEY-----\n${KEY}\n-----END PRIVATE KEY-----\n-----END RSA PRIVATE KEY-----`,
  ],
  [
    "lowercase stays",
    "-----begin private key-----\nx\n-----end private key-----",
  ],
  [
    "truncated marker stays",
    "-----BEGIN PRIVATE KEY----\nx\n-----END PRIVATE KEY-----",
  ],
  [
    "long label run with END",
    `-----BEGIN ${"A ".repeat(200)}PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----`,
  ],
  ["many BEGIN no END (small)", "-----BEGIN PRIVATE KEY-----\n".repeat(200)],
  [
    "many BEGIN then END",
    "-----BEGIN PRIVATE KEY-----\n".repeat(50) + `-----END PRIVATE KEY-----`,
  ],
  [
    "END inside long BEGIN span",
    `-----BEGIN ${"A ".repeat(50)}PRIVATE KEY-----\n-----END PRIVATE KEY-----`,
  ],
  ["no markers", "ordinary tool output with nothing sensitive"],
  ["empty", ""],
];

for (const [name, input] of CASES) {
  test(`PEM redaction matches the old regex: ${name}`, () => {
    expect(redactSecrets(input)).toBe(oldRedact(input));
  });
}

test("PEM pair is redacted, surrounding text survives", () => {
  const out = redactSecrets(
    `head -----BEGIN PRIVATE KEY-----\n${KEY}\n-----END PRIVATE KEY----- tail`,
  );
  expect(out).toBe(`head ${REDACTED_SECRET} tail`);
});

test("BEGIN-without-END input is redacted in linear time (#290)", () => {
  // 2.8M chars of BEGIN lines, no END line — the ticket's worst case.
  // Measured on the merge-base: 103,000 ms and growing quadratically
  // (6,828 ms at 700k chars, 26,356 ms at 1.4M). Linear here: tens of ms.
  const input = "-----BEGIN PRIVATE KEY-----\n".repeat(100_000);
  const t0 = performance.now();
  const out = redactSecrets(input);
  const ms = performance.now() - t0;
  expect(out).toBe(input);
  expect(ms).toBeLessThan(5_000);
});
