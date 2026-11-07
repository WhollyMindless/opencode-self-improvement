// Shared provenance tags that more than one module must agree on. The store
// itself treats tags as opaque strings; these two have CODE attached — the
// capture side writes them, the injection side ranks on them — so the literal
// lives here once, never in two copies that can drift.

/** Row mined from auto-capture (written by src/capture/runtime.ts). */
export const AUTO_CAPTURE_TAG = "auto-capture";

/**
 * Hint channel (#335): the fact was STATED BY THE USER — a value, rate, rule
 * or correction in the human's own words — not derived by the agent. Human
 * guidance is the highest-trust class the capture path can see, and lexical
 * ranking cannot find it: a task prompt about "the injected bug" shares zero
 * vocabulary with "the sales tax rate is 8.25%". Injection therefore rides
 * these rows regardless of overlap (capped, newest-first); recall/pull stays
 * query-driven.
 */
export const USER_GUIDED_TAG = "user-guided";
