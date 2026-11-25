// The arrived-lost rule as a pure predicate, kept out of capture.test.ts so a
// pin can run it without booting a host. The printed start rate in that file
// is honest only while this rule matches the one the status parser uses: of
// the arrivals an `auto_capture_seen` line records, only `discard=none` owes a
// pass — `cooldown` and `no_sid` carry their own attribution — and an
// `auto_capture_skipped` line accounts for the arrival it follows. The genuine
// loss is the remaining shape: a proceeding arrival with neither outcome after
// it. It is the only thing the counter exists to expose; counting the other
// three inflates the very rate this retry is required to print truthfully.
import { type Fields, parseLine } from "../../src/core/logfmt/format.ts";

/** Counts lines whose parsed fields satisfy `keep`. Unparseable lines are noise. */
function countWhere(lines: string[], keep: (f: Fields) => boolean): number {
  let n = 0;
  for (const line of lines) {
    const f = parseLine(line);
    if (f !== null && keep(f)) n++;
  }
  return n;
}

/**
 * True when the evidence gained since `before` holds an arrival that owes a
 * pass and nothing that accounts for it: a new `auto_capture_seen` with
 * `discard=none`, and no new `auto_capture_start` and no new
 * `auto_capture_skipped` since. Field-level checks on the parsed line — like
 * `captureHealth` in src/status/metrics.ts, which this mirrors — so text that
 * merely quotes these values inside another field cannot move the count.
 */
export function arrivedLostBetween(before: string[], after: string[]): boolean {
  const proceeding = (f: Fields) =>
    f.ev === "auto_capture_seen" && String(f.discard ?? "") === "none";
  const started = (f: Fields) => f.ev === "auto_capture_start";
  const skipped = (f: Fields) => f.ev === "auto_capture_skipped";
  return (
    countWhere(after, proceeding) > countWhere(before, proceeding) &&
    countWhere(after, started) === countWhere(before, started) &&
    countWhere(after, skipped) === countWhere(before, skipped)
  );
}
