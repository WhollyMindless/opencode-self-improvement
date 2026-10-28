// Global test-isolation net (#149).
//
// The plugin keeps identity in module globals: the ambient session/call state
// (src/state.ts) and the session -> repository map that entry binding fills
// (src/repokey.ts, #127). Both outlive a test FILE, so any file that binds a
// session and does not release it silently changes the next file's write stamp
// and read scope — a failure that depends purely on which file the runner ran
// first. Per-file resets keep missing one (#149 is the third instance).
//
// Clearing both registries after every test makes file order irrelevant. A
// file that needs identity sets it in its own beforeEach (or per test), which
// is what the existing suites already do; nothing may rely on identity
// surviving a test boundary.
import { afterEach } from "bun:test";
import { resetSessionScopes } from "../src/repokey.ts";
import { resetState } from "../src/state.ts";

afterEach(() => {
  resetState();
  resetSessionScopes();
});
