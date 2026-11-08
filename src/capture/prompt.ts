// prompt — split from src/capture.ts (#168 domain restructure). Declaration bodies are unchanged.
// Opt-in auto-capture parsing, prompt, and lag helpers. Host access and model
// calls live in src/index.ts. Every candidate that leaves this module flows
// through runWriteGate in index.ts: capture NEVER writes memories directly,
// so dupes/stale/canonical rules keep the moat (same as model-authored writes).
// All parsing functions are TOTAL: any malformed input yields [] / "" / null,
// never a throw.
import { TYPES } from "../core/types.ts";
import { redactSecrets } from "../store/secrets.ts";

export interface CaptureCandidate {
  type: string;
  scope: string;
  content: string;
  status?: "open" | "settled";
  /** Retrieval keywords (#40): indexed by the store, never rendered. */
  kw?: string[];
  /** Literal true only when the user stated the fact, not agent inference. */
  guided?: boolean;
}

// Keywords are the vocabulary bridge for the strict-paraphrase wall, mined from
// the transcript the model just saw. Cap and shape mirror the store's own
// limits; the store normalises again at write, so this only has to stay
// junk-proof (capture.ts never imports the store — it stays dependency-free).
export const CAPTURE_KEYWORD_CAP = 8;

export const CAPTURE_KEYWORD_CHARS = 48;

// Prompt for the cheap capture model. The output contract is a bare JSON
// array so parseCandidates can trust it; anything else parses to [].
//
// `userProse` keeps the session's brief OUT of the work block. Measured on the
// fixture that reproduces #329: brief mixed into one undifferentiated block,
// the model stores it back as a durable `preference`; work block alone, zero
// framing rows — but also zero real preferences, because "we use bun here, not
// npm" lives in the same prose. So the prose is kept, labelled for what it is.
export function buildCapturePrompt(
  transcript: string,
  max = 3,
  userProse = "",
): string {
  const prose = redactSecrets(userProse).trim();
  return [
    "You mine one coding-agent session transcript for durable memories worth keeping across future sessions.",
    "",
    `Output ONLY a JSON array of at most ${max} objects (a fenced json block is fine), each:`,
    '{"type": "...", "scope": "...", "content": "...", "status": "...", "kw": ["...", "..."], "guided": true}',
    "",
    "Rules:",
    `- type: one of ${TYPES.join(", ")}.`,
    "- scope: short area name (e.g. auth, api, build).",
    '- status: "open" for a live planning thread; otherwise "settled".',
    "- content: one self-contained fact, 20-600 characters, useful in a NEW session.",
    "- kw: 3-5 search keywords for how a DIFFERENT session would ask for this — synonyms and alternate names, other verb forms, the literal command or file name. They are indexed for retrieval and never shown to a model. Omit (or []) when the content already uses those words.",
    "- guided: true ONLY when the user STATED this fact in their own words — a value, rate, number, rule or correction that appears in a user: line or the REQUESTS block. Omit guided for anything the agent discovered by itself.",
    "- Keep: decisions made, working commands, user preferences, blockers hit, durable context, conventions.",
    "- Skip: anything derivable from the code or git history, small talk, and details that only mattered inside this conversation.",
    ...(prose
      ? [
          // The brief is its own block, so the rule about it is its own too.
          '- The REQUESTS block is what the user asked for in THIS session. Most of it scopes the current job and expires with it. Mine a `preference` from it ONLY when it names a tool, package, format or convention that outlives the task ("we use bun here", "no semicolons"); never from wording that scopes this job ("only touch src/", "do not create tests").',
        ]
      : []),
    // Permission to emit fewer rows is what bounds deliberation. On the
    // reproducing fixture the same seat went 1,095 -> 3,084 completion tokens
    // and 19.7s -> 63.2s with this line removed, and the same rows out. It
    // also stops one instruction arriving as the same fact under three scope
    // names, which the store's 0.9 overlap floor does not see once the
    // wording differs.
    "- Few is better than full. If two candidates say the same thing about the same area, keep the one carrying the specific number, path, or command and drop the other. Never emit the same fact twice under different scope names.",
    "- If nothing is worth remembering, output [ ].",
    "",
    ...(prose
      ? [
          "Session work (what the agent did — this is the evidence):",
          redactSecrets(transcript),
          "",
          "REQUESTS (the user's brief for this session; constraints of THIS task, mostly not durable):",
          prose,
        ]
      : ["Transcript:", redactSecrets(transcript)]),
  ].join("\n");
}
