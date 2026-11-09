// run — split from src/init.ts (#168 domain restructure). Declaration bodies are unchanged.
// Repository init: re-derive build/test command memories through the write gate
// and store an init stamp keyed on git HEAD. Deterministic (no model calls):
// manifests are parsed locally and every write goes through the 4-gate pipeline
// with the `trusted` flag (plugin-authored bookkeeping, not model claims).
// Degrades gracefully when git is absent, so install-from-scratch still writes
// script memories. The codebase-memory graph integration was removed (#231).
import { basename } from "node:path";
import { loadAll } from "../store/files/load.ts";
import { markSuperseded } from "../store/files/supersede.ts";
import {
  isVisibleTo,
  readerFromSid,
  type Reader,
} from "../store/model/visibility.ts";
import { runWriteGate, type GateContext } from "../gate/gate.ts";
import { captureEvidenceContext, record } from "../evidence/record.ts";
import { writeEvidence, hasGateCheck } from "../capture/triggers.ts";
import { writeTarget } from "../identity/repokey.ts";
import { quarantineCandidate } from "../store/quarantine/quarantine.ts";
import { getCurrent } from "../core/state.ts";
import {
  type ScriptRecord,
  detectScripts,
  gitHead,
  gitRootOf,
} from "./detect.ts";

export interface InitArgs {
  liveRoot: string;
  force?: boolean;
  // The calling session (#127): rows this writes are stamped for the CALLER,
  // resolved after runInit's own awaits (git probing) rather than from the
  // ambient current, which a concurrent session may have moved.
  sessionID?: string;
}

export interface InitSummary {
  scope: string;
  root: string;
  head: string;
  scripts: ScriptRecord[];
  stampTs?: string;
  skipped: boolean;
  written: number;
  collapsed: number;
  blocked: number;
  /** Written rows whose write_promoted audit line fell (#155 review). */
  unaudited?: number;
}

export interface InitStamp {
  ts: string;
  head: string;
}

export async function initStamp(
  scope: string,
  sid?: string,
  reader: Reader = readerFromSid(sid),
): Promise<InitStamp | null> {
  // Scope is a basename, so two different repos can share one
  // ("api" next to "api", a fork beside its upstream). Visibility filtering
  // makes each repo see only its own stamp — basename collisions no longer
  // alias init state between repos. The reader comes from the CALLER's
  // session, not from the global current after this await (#127).
  const mems = (await loadAll()).filter(
    (m) => !m.superseded_by && isVisibleTo(m, reader),
  );
  for (const m of mems) {
    if (m.type !== "context" || m.scope !== scope) continue;
    if (!m.tags?.some((t) => t === "init-stamp")) continue;
    const head = /head=([^ ,]+)/.exec(m.content)?.[1] ?? "-";
    return { ts: m.ts, head };
  }
  return null;
}

export async function runInit(args: InitArgs): Promise<InitSummary> {
  const reader = readerFromSid(args.sessionID);
  const writeAt = writeTarget(args.sessionID ?? getCurrent().sid);
  const evidenceContext = captureEvidenceContext(args.sessionID);
  const root = await gitRootOf(args.liveRoot);
  const scope = basename(root) || basename(args.liveRoot);
  const head = await gitHead(root);
  const force = Boolean(args.force);

  const gateCtx: GateContext = {
    liveRoot: root,
    reader,
    writeAt,
    evidenceContext,
    ...writeEvidence(args.sessionID ?? getCurrent().sid),
    hasGateCheck: hasGateCheck(args.sessionID ?? getCurrent().sid),
    // Stamps land on the caller's session even though runInit awaits git
    // probing before the gate writes (#127 / #121's write-side root cause).
    sessionID: args.sessionID,
    trusted: true,
  };

  const prior = await initStamp(scope, args.sessionID, reader);
  if (prior && !force && prior.head === head) {
    await record(
      "init_skip",
      { scope, head, since: prior.ts },
      false,
      args.sessionID,
      evidenceContext,
    );
    return {
      scope,
      root,
      head,
      scripts: [],
      stampTs: prior.ts,
      skipped: true,
      written: 0,
      collapsed: 0,
      blocked: 0,
    };
  }

  await record(
    "init_start",
    { scope, head, force },
    false,
    args.sessionID,
    evidenceContext,
  );

  const scripts = await detectScripts(root);

  let written = 0;
  let collapsed = 0;
  let blocked = 0;
  // Promoted rows whose write_promoted audit line fell (#155 review: the
  // fault must be visible to every writer, bookkeeping included).
  let unaudited = 0;
  for (const s of scripts) {
    const content = `${scope} ${s.key} command: run "${s.cmd}" from the repo root (${s.source}).`;
    // Auto-capture and import both screen their candidate for injection-shaped
    // text; init's rows are external text too — the scope is the checkout
    // directory basename and the command comes from the manifest — so they get
    // the same scan (#302). A match is still stored, tagged `quarantine`, and
    // withheld from recall and injection.
    const outcome = await runWriteGate(
      quarantineCandidate({
        type: "pattern",
        scope,
        content,
        tags: ["init", s.source],
      }),
      gateCtx,
    );
    if (outcome.action === "promoted") {
      written++;
      if (outcome.evidenceError !== undefined) unaudited++;
    } else if (outcome.action === "collapsed") collapsed++;
    else blocked++;
  }

  const stampContent = `Init stamp: repo=${scope}, head=${head}, scripts=${scripts.length}`;
  const stampOutcome = await runWriteGate(
    // Same screen as the script rows: the stamp interpolates the directory
    // basename, so an injection-shaped checkout name matches here too. Withheld
    // from recall, still readable by initStamp(), so idempotency is unaffected.
    quarantineCandidate({
      type: "context",
      scope,
      content: stampContent,
      tags: ["init-stamp"],
    }),
    gateCtx,
  );
  const stampTs = stampOutcome.ts ?? prior?.ts;
  if (stampOutcome.action === "promoted" && prior && stampOutcome.ts) {
    await markSuperseded(prior.ts, {
      superseded_by: stampOutcome.ts,
      reason: "init",
    });
  }
  if (
    stampOutcome.action === "promoted" &&
    stampOutcome.evidenceError !== undefined
  )
    unaudited++;

  await record(
    "init_complete",
    {
      scope,
      head,
      force,
      scripts: scripts.length,
      written,
      collapsed,
      blocked,
      unaudited,
      stamp: stampTs ?? "-",
    },
    false,
    args.sessionID,
    evidenceContext,
  );

  return {
    scope,
    root,
    head,
    scripts,
    stampTs,
    skipped: false,
    written,
    collapsed,
    blocked,
    unaudited,
  };
}
