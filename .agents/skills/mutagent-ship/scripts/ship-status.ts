import type { ShipManifest, ShipStatusValue } from "./ship-manifest.ts";

// ---------------------------------------------------------------------------
// ⑥ SHIP — the *ship-status read surface (ship PRD §1.2).
//
// A read-only state view: FSM state · CI timeline · deploy-confirm · watch
// countdown · signal deltas for one ship (or a newest-first list of all runs).
// Never mutates; never gates; NEVER re-polls CI or re-fetches traces — the
// artifacts on disk are the ONLY source (PRD §1.2 step 2).
//
// PURE by design: these functions take already-parsed manifests (+ optional
// monitor-state) and return a view model / rendered block. The fs read (walking
// `.mutagent/ship/runs/*`) is the thin CLI/skill layer's job — documented in
// SKILL.md — so the model is unit-testable without fs mocking (same stance as
// dispatch.ts / gate.ts: pure core, injected data).
// ---------------------------------------------------------------------------

/** The transient statuses (a run still in flight); everything else is terminal. */
const TERMINAL_STATUSES: ReadonlySet<ShipStatusValue> = new Set<ShipStatusValue>([
  "shipped",
  "rolled-back",
  "escalated",
  "aborted",
]);

/** Optional monitor checkpoint (P2/P3 — absent in the P1 spine). Read-only. */
export interface MonitorState {
  /** Appended CI-check observations (the CI timeline). */
  ci_timeline?: { check: string; conclusion: string; at: string }[];
  /** Refinement attempts taken (n/N), for the ledger read. */
  refinement_attempts?: number;
}

export interface ShipStatusView {
  shipId: string;
  status: ShipStatusValue;
  terminal: boolean;
  subject: { name: string; kind: string; commit: string };
  target: { platform: string; repo: string; deploySemantics: string };
  pr: { number: number; url: string; branch: string; mergeSha: string };
  deployConfirm: { mode: string; confirmedAt: string; confirmedBy: string };
  watch: { windowMinutes: number; baselineMode: string; opensOn: string };
  evidence: { evaluateVerdict: string; buildReport: string | null; ciTimeline: string };
  /** CI observations from the monitor checkpoint (empty in the P1 spine). */
  ciTimeline: { check: string; conclusion: string; at: string }[];
  refinementAttempts: number;
}

/**
 * Build the read-only status view for ONE ship from its manifest (+ optional
 * monitor-state checkpoint). Pure — disk data in, view model out. In the P1
 * spine the monitor-state is absent, so the CI timeline / refinement fields are
 * empty; the manifest still yields the FSM state + PR + deploy-confirm view.
 */
export function buildShipStatusView(
  manifest: ShipManifest,
  monitorState?: MonitorState,
): ShipStatusView {
  return {
    shipId: manifest.ship_id,
    status: manifest.status,
    terminal: TERMINAL_STATUSES.has(manifest.status),
    subject: {
      name: manifest.subject.name,
      kind: manifest.subject.kind,
      commit: manifest.subject.commit,
    },
    target: {
      platform: manifest.target.platform,
      repo: manifest.target.repo,
      deploySemantics: manifest.target.deploy_semantics,
    },
    pr: {
      number: manifest.pr.number,
      url: manifest.pr.url,
      branch: manifest.pr.branch,
      mergeSha: manifest.pr.merge_sha,
    },
    deployConfirm: {
      mode: manifest.deploy.confirm,
      confirmedAt: manifest.deploy.installed_confirmed_at,
      confirmedBy: manifest.deploy.confirmed_by,
    },
    watch: {
      windowMinutes: manifest.watch.window_minutes,
      baselineMode: manifest.watch.baseline.mode,
      opensOn: manifest.watch.opens_on,
    },
    evidence: {
      evaluateVerdict: manifest.evidence.evaluate_verdict,
      buildReport: manifest.evidence.build_report,
      ciTimeline: manifest.evidence.ci_timeline,
    },
    ciTimeline: monitorState?.ci_timeline ?? [],
    refinementAttempts: monitorState?.refinement_attempts ?? 0,
  };
}

/** One run row for the list surface (`*ship-status` with no id). */
export interface ShipRunInput {
  shipId: string;
  manifest: ShipManifest;
  /** INJECTED mtime (epoch ms) — the fs read supplies it; the sort is deterministic. */
  mtime: number;
}

export interface ShipRunSummary {
  shipId: string;
  status: ShipStatusValue;
  subject: string;
  mtime: number;
}

/**
 * Index all runs newest-first (PRD §1.2 — `*ship-status` with no id lists
 * `.mutagent/ship/runs/*` by mtime). Pure; ties break on shipId for a stable,
 * deterministic order (no clock).
 */
export function listShipRuns(runs: ShipRunInput[]): ShipRunSummary[] {
  return [...runs]
    .sort((a, b) => (b.mtime - a.mtime) || a.shipId.localeCompare(b.shipId))
    .map((r) => ({
      shipId: r.shipId,
      status: r.manifest.status,
      subject: r.manifest.subject.name,
      mtime: r.mtime,
    }));
}

/** Render a single-ship status as a dashboard-style text block (Helix look). */
export function renderShipStatusView(v: ShipStatusView): string {
  const lines = [
    `=== ⑥ SHIP status — ${v.shipId} ===`,
    `state:    ${v.status}${v.terminal ? " (terminal)" : ""}`,
    `subject:  ${v.subject.name} [${v.subject.kind}] @ ${v.subject.commit}`,
    `target:   ${v.target.platform} · ${v.target.repo} · ${v.target.deploySemantics}`,
    `pr:       ${v.pr.number > 0 ? `#${v.pr.number} ${v.pr.url}` : "(not opened)"} [${v.pr.branch}]`,
    `deploy:   confirm=${v.deployConfirm.mode}${v.deployConfirm.confirmedAt ? ` at ${v.deployConfirm.confirmedAt}` : ""}`,
    `watch:    ${v.watch.windowMinutes}m · baseline ${v.watch.baselineMode} · opens_on ${v.watch.opensOn}`,
    `evidence: verdict=${v.evidence.evaluateVerdict}`,
  ];
  if (v.ciTimeline.length > 0) {
    lines.push(`ci:       ${v.ciTimeline.map((c) => `${c.check}=${c.conclusion}`).join(" · ")}`);
    lines.push(`refine:   ${v.refinementAttempts} attempt(s)`);
  }
  return lines.join("\n");
}

/** Render the newest-first list of ship runs as a compact text table. */
export function renderShipRunsList(runs: ShipRunSummary[]): string {
  if (runs.length === 0) return "=== ⑥ SHIP runs === (none)";
  const rows = runs.map((r) => `  ${r.shipId}  [${r.status}]  ${r.subject}`);
  return ["=== ⑥ SHIP runs (newest first) ===", ...rows].join("\n");
}
