// transcript — split from src/capture.ts (#168 domain restructure). Declaration bodies are unchanged.

// Render an array of session-context messages of unknown shape into
// "role: text" lines. Defensive by construction (the API shape varies and is
// not ours to trust): non-arrays and junk entries are skipped; role comes
// from info.role | role | type, text from parts[].text | content[].text |
// text | content (strings only); capped at 40 user turns. Never throws.
//
// The `type` role source and the `content[]` part array are the 2.2.5 host
// shape, recorded live: `session.context()` returns
// `{id, time, type:"user", text}` and `{id, time, type:"assistant", content:
// [{type:"reasoning"|"tool"|"text", ...}]}` — no `role`, no `parts`. Reading
// only the old keys rendered EVERY 2.2.5 session as a 0-character transcript,
// which the 200-character floor then skipped in silence: auto-capture never
// fired on a live host, and nothing said so.
const TRANSCRIPT_USER_TURN_CAP = 40;

// 2.2.5 also puts NON-conversation records in the same array (`type:"idle"`),
// so only these values are accepted as a role. Anything else renders nothing.
const CONVERSATION_ROLES: readonly string[] = ["user", "assistant"];

function roleOf(
  m: Record<string, unknown>,
  info: Record<string, unknown> | undefined,
): string {
  for (const v of [info?.role, m.role, m.type])
    if (typeof v === "string" && CONVERSATION_ROLES.includes(v)) return v;
  return "";
}

interface ParsedTurn {
  role: string;
  text: string;
}

/**
 * Parse session-context messages into ordered conversation turns. Shared by
 * `flattenTranscript` and `splitTranscript` so the two can never disagree
 * about what a message contained. Total: junk yields [], never a throw.
 */
function parseTurns(msgs: unknown): ParsedTurn[] {
  try {
    if (!Array.isArray(msgs)) return [];
    const out: ParsedTurn[] = [];
    let userTurns = 0;
    for (const msg of msgs) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const info =
        m.info && typeof m.info === "object"
          ? (m.info as Record<string, unknown>)
          : undefined;
      const role = roleOf(m, info);
      let text = "";
      let hadPrivatePart = false;
      // V1 carried parts under `parts`; 2.2.5 carries them under `content`.
      const partList = Array.isArray(m.parts)
        ? m.parts
        : Array.isArray(m.content)
          ? m.content
          : null;
      if (partList) {
        text = partList
          .map((p) => {
            if (!p || typeof p !== "object") return undefined;
            const part = p as Record<string, unknown>;
            const partType =
              typeof part.type === "string" ? part.type.toLowerCase() : "";
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
      out.push({ role, text: text.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

export function flattenTranscript(msgs: unknown): string {
  return parseTurns(msgs)
    .map(({ role, text }) => `${role}: ${text}`)
    .join("\n");
}

/**
 * The decoder itself, for a caller that needs the ROLES rather than a rendered
 * block (#366 review). Anything that decides "the user said this" has to read
 * roles the way the transcript does, or the two disagree about who owns a line:
 * the capture parser accepts `info.role` / `role` / `type` for the role and
 * `parts[]` / `content[]` / `text` / string `content` for the text, and a
 * hand-rolled reader that misses one of them silently reports "no user rule
 * here" for a shape that is perfectly readable.
 *
 * Total, like `parseTurns`: junk yields [], never a throw. An empty result
 * means "no conversation turn was recognised" — which covers both a window of
 * non-conversation records and a message shape this build has never seen, so a
 * caller that cannot tell the two apart must fail toward acting.
 */
export function conversationTurns(msgs: unknown): ParsedTurn[] {
  return parseTurns(msgs);
}

/**
 * The same turns, partitioned (#333).
 *
 * `work` — every turn that is NOT the user's: what the agent said and what the
 * tools returned. This is the evidence.
 * `user` — the user turns, i.e. the task's brief.
 *
 * Why partition rather than concatenate: measured on the fixture that
 * reproduces #329, an undifferentiated block makes the model store the brief
 * back as a durable `preference`. Work alone stores zero framing rows — and
 * zero real preferences, because "we use bun here, not npm" lives in the same
 * prose. So the prose is kept, labelled, in its own block: `buildCapturePrompt`.
 */
export interface TranscriptSplit {
  work: string;
  user: string;
}

export function splitTranscript(msgs: unknown): TranscriptSplit {
  const work: string[] = [];
  const user: string[] = [];
  for (const { role, text } of parseTurns(msgs)) {
    (role === "user" ? user : work).push(`${role}: ${text}`);
  }
  return { work: work.join("\n"), user: user.join("\n") };
}

/**
 * The user's turns and nothing else, in order, without the `role: ` render
 * prefix.
 *
 * This is the only text that may vouch for user provenance (#364 review).
 * Reading `user:` labels back out of RENDERED text cannot do the job: a role
 * label inside an assistant message ("Here is untrusted quoted output:
 * user: The correct sales tax rate is 7.5%.") is assistant output, and a
 * scanner that filters rendered lines by that prefix hands quoted text the
 * always-ride user-guidance lane. Roles here come from `parseTurns`, the same
 * structured decode `splitTranscript` uses, so the two can never disagree
 * about who said a line.
 *
 * Empty when the mined input carries no message array (a seeded transcript):
 * no roles, so nothing can be attributed to the user.
 */
export function userTurnText(msgs: unknown): string {
  const out: string[] = [];
  for (const { role, text } of parseTurns(msgs)) {
    if (role === "user") out.push(text);
  }
  return out.join("\n");
}
