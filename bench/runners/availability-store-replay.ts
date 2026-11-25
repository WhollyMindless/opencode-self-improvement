import { parseArgs } from "node:util";
import {
  type AvailabilityVerdict,
  availabilityIndex,
  DEFAULT_SCAN_BUDGET,
} from "../../src/capture/available.ts";
import { loadAll, malformedCount } from "../../src/store/files/load.ts";
import { redactSecrets } from "../../src/store/secrets.ts";

const EXCERPT_LENGTH = 80;
const USAGE =
  "Usage: bun run bench:availability-replay [repo] [--scan-budget N] [--full-content]";

async function replay(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "scan-budget": { type: "string" },
      "full-content": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    console.log(
      `Reads the configured store (OPENCODE_MEMORY_DIR if set). The default scan budget is ${DEFAULT_SCAN_BUDGET} and counts decoded characters. Keep row output local.`,
    );
    return;
  }
  if (positionals.length > 1) throw new Error("expected one repository");

  const cap = values["scan-budget"];
  const scanBudget = cap === undefined ? DEFAULT_SCAN_BUDGET : Number(cap);
  if (
    (cap !== undefined && !/^\d+$/.test(cap)) ||
    !Number.isSafeInteger(scanBudget) ||
    scanBudget < 1
  ) {
    throw new Error("invalid scan budget");
  }

  const git = Bun.spawnSync(
    [
      "git",
      "-C",
      positionals[0] ?? process.cwd(),
      "rev-parse",
      "--show-toplevel",
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 5000 },
  );
  if (git.exitCode !== 0) throw new Error("unreadable repository");
  const repo = git.stdout.toString().replace(/\r?\n$/, "");
  const index = availabilityIndex(repo, scanBudget);
  const { files, bytes, tracked, capped } = index.scanned();
  if (!tracked) throw new Error("repository scan failed");

  const rows = await loadAll({ readOnly: true });
  const refusals: Record<AvailabilityVerdict["reason"], number> = {
    in_tracked_file: 0,
    declared_gate: 0,
  };
  console.log(
    `population=loaded_unblocked_rows rows=${rows.length} includes_superseded=true malformed_timestamps=${malformedCount()}`,
  );
  for (const [i, row] of rows.entries()) {
    const verdict = index.check(row.content);
    if (!verdict) continue;
    refusals[verdict.reason]++;
    const content = redactSecrets(row.content);
    const excerpt =
      values["full-content"] || content.length <= EXCERPT_LENGTH
        ? content
        : `${content.slice(0, EXCERPT_LENGTH)}…`;
    console.log(
      `row=${i + 1} reason=${verdict.reason} ${JSON.stringify(excerpt)}`,
    );
  }

  const corpus = `files=${files} bytes=${bytes} capped=${capped} budget=${scanBudget} budget_units=decoded_characters`;
  const refused = refusals.in_tracked_file + refusals.declared_gate;
  const rate = rows.length
    ? `${((100 * refused) / rows.length).toFixed(2)}%`
    : "n/a";
  console.log(
    `refused=${refused}/${rows.length} rate=${rate} ${corpus} in_tracked_file=${refusals.in_tracked_file} declared_gate=${refusals.declared_gate}`,
  );
}

try {
  await replay();
} catch {
  // Local paths or row contents can appear in parser and I/O errors.
  console.error(
    `Replay failed. Check the repository, store, and arguments.\n${USAGE}`,
  );
  process.exitCode = 2;
}
