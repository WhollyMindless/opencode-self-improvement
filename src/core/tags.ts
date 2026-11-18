/** Auto-capture provenance, shared by capture and retrieval. */
export const AUTO_CAPTURE_TAG = "auto-capture";

/**
 * the working tree already states this fact, so the next session can read
 * it there. Captured from the availability check, which TAGS instead of
 * dropping: the original refusal rule rejected 30 of 1,166 real rows and 29
 * of those were wrong — so a wrong match costs a tag instead of a fact
 * (docs/adr/0008).
 *
 * Retrieval sorts these rows last within their score band: a restatement is the
 * first thing to give up budget when the block is full, and the last thing worth
 * a slot when it is not.
 */
export const RESTATABLE_TAG = "restatable";

/**
 * a capture candidate whose numeric claim was CHECKED against the working
 * tree and agreed. Absent on every other row, which is what makes the injected
 * `[unverified]` marker mean something rather than decorate everything.
 */
export const CODE_CHECKED_TAG = "code-checked";

// The legacy init stamp: a `context` row written by an older release's
// `/repo-init`. It is plugin bookkeeping that the stamp file replaced, so it is
// never a fact for a model to read. `src/init/stamp.ts` retires a row once its
// audit line confirms the migration; the tag keeps every other row — including
// one whose audit line is gone, which migration cannot reach — out of the
// prompt ( review).
export const INIT_STAMP_TAG = "init-stamp";

// The public write boundaries reserve this same tag.
export { USER_GUIDED_TAG } from "./guidance.ts";
