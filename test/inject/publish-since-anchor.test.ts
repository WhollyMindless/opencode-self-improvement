// The anchored retry in writeAtomic renames only while the destination still
// matches the `since` identity taken before the caller's read. If an
// out-of-band writer appends into the destination DURING the retry window,
// the premise of our publish is gone: the retry must abort with the original
// error, not publish a now-stale copy over the row the immediate failure
// preserved. POSIX renames never fail on reader contention, hence the
// Windows gate; the red leg is windows-latest CI.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity, writeAtomic } from "../../src/core/logfmt/publish.ts";
import { removeStore } from "../helpers/remove-store.ts";

const skip = process.platform !== "win32";

describe.skipIf(skip)(
  "anchored publish under Windows reader contention",
  () => {
    let root: string;
    let holds: number[] = [];

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "osi-since-"));
    });
    afterEach(() => {
      for (const fd of holds) closeSync(fd);
      holds = [];
      removeStore(root);
    });

    test("a destination touched mid-window aborts the retry; the foreign row survives", async () => {
      const file = join(root, "2026-01-01.logfmt");
      writeFileSync(file, "ts=2026-01-01T00:00:00.000Z a=1\n");
      const since = await fileIdentity(file);

      // A reader handle blocks the destination's replacement but not appends —
      // the exact Windows state the retry window exists for.
      holds.push(openSync(file, "r"));
      const ours = writeAtomic(
        file,
        "ts=2026-01-01T00:00:00.000Z a=2\n",
        since,
      );
      // Attach the outcome handler NOW. The correct behaviour is to reject
      // during the waits below, and an awaited-later rejection is an unhandled
      // one: Bun tears the fixture down mid-test and the leak lands on the
      // next test's shared state.
      const settled = ours.then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const }),
      );

      // The first rename fails on the handle; append out of band inside the
      // window so the identity check on the next pass sees a moved file.
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(file, "ts=2026-01-01T00:00:00.100Z foreign=1\n", {
        flag: "a",
      });
      await new Promise((r) => setTimeout(r, 100));
      closeSync(holds.pop()!);

      expect((await settled).ok).toBe(false);
      const text = readFileSync(file, "utf8");
      expect(text).toInclude("foreign=1"); // the retry must NOT bury the append
      expect(text).not.toInclude("a=2"); // and our stale copy must not land
      expect(existsSync(file)).toBe(true);
    });

    test("control: an untouched destination lets the anchored retry land", async () => {
      const file = join(root, "2026-01-02.logfmt");
      writeFileSync(file, "ts=2026-01-02T00:00:00.000Z a=1\n");
      const since = await fileIdentity(file);
      holds.push(openSync(file, "r"));
      const ours = writeAtomic(
        file,
        "ts=2026-01-02T00:00:00.000Z a=2\n",
        since,
      );
      const settled = ours.then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const }),
      );
      await new Promise((r) => setTimeout(r, 150));
      closeSync(holds.pop()!); // the blocker was a bare reader: retry lands
      expect((await settled).ok).toBe(true);
      expect(readFileSync(file, "utf8")).toInclude("a=2");
    });
  },
);
