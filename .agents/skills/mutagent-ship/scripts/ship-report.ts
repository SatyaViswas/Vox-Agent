import type { ShipManifest } from "./ship-manifest.ts";
import type { ShipMonitorState } from "./ci-fsm.ts";
import type { RegressionVerdict, RollbackRecommendation } from "./watch.ts";

// ---------------------------------------------------------------------------
// ⑥ SHIP — the ship-report + 🏁 Final Status rendering (ship PRD §8 + §3, P3).
//
// The ship-report is the OUT-always shareable artifact (§8):
//   .mutagent/ship/runs/<ship-id>/ship-report.{md,html}
//   — CI timeline · refinement ledger · deploy-confirm · watch verdict + signal
//     table · every evidence link. (The manifest is the machine record; the
//     report is what a human reads.)
//
// The 🏁 Final Status is the standing house convention (§3 / feedback_pr_final
// _status_comment): every ship PR gets a CLOSING comment at terminal status —
// Decisions + WHYs. The ship-monitor supplies the data; the parent posts it.
//
// PURE: injected manifest + monitor checkpoint + watch verdict in, rendered
// strings out. No clock, no I/O — deterministic (same inputs ⇒ byte-identical
// report), so the artifact is testable without fs mocking. Leak-safe by
// construction (§3): paths + refs only, never raw trace content.
// ---------------------------------------------------------------------------

const mdEscape = (s: string): string => s.replace(/\|/g, "\\|");
const htmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface ShipReportInput {
  manifest: ShipManifest;
  /** The ship-monitor checkpoint (CI timeline + refinement ledger + grant + FSM). */
  monitorState?: ShipMonitorState;
  /** The post-deploy watch verdict (absent when the run never reached the watch). */
  verdict?: RegressionVerdict;
  /** The §6.4 recommendation record (present only on a flagged regression). */
  recommendation?: RollbackRecommendation;
  /** The parent-emitted ④ DIAGNOSE HandoverBundle path (on regression). */
  diagnoseHandoffRef?: string;
  /** The revert PR ref (present only after a *rollback). */
  revertPrRef?: string;
}

// ── shared derivations ───────────────────────────────────────────────────────

function watchVerdictLine(input: ShipReportInput): string {
  const v = input.verdict;
  if (v === undefined) return "not reached (run did not open a watch window)";
  if (!v.flagged) return `CLEAN (mode \`${v.mode}\`)`;
  const signals = v.firedSignals.map((f) => f.signal).join(", ");
  return `REGRESSION flagged at interval ${v.flaggedAtInterval} (mode \`${v.mode}\`) — signals: ${signals}`;
}

interface DecisionRow {
  decision: string;
  choice: string;
  why: string;
}

/** The Decisions + WHYs rows shared by the report + the 🏁 Final Status (§3). */
export function deriveDecisionRows(input: ShipReportInput): DecisionRow[] {
  const m = input.manifest;
  const ms = input.monitorState;
  const rows: DecisionRow[] = [];

  // Refinement attempts (what each fixed; whether the pre-grant held or was revoked).
  const ledger = ms?.refinement_ledger ?? [];
  if (ledger.length > 0) {
    const revoked = ms?.grant.grant_revoked === true;
    rows.push({
      decision: "CI refinement",
      choice: `${ledger.length} attempt(s): ${ledger.map((e) => `#${e.n} ${e.class}${e.within_grant ? "✓grant" : "⋅gated"}`).join(", ")}`,
      why: revoked
        ? "mechanical fixes; the pre-grant was AUTO-REVOKED after a non-mechanical touch (KP-5 §4.4)"
        : ms?.grant.pre_grant === "mechanical"
          ? "mechanical-only fixes within the standing pre-grant (KP-5)"
          : "mechanical-only fixes, each explicitly gated (no pre-grant)",
    });
  } else {
    rows.push({ decision: "CI refinement", choice: "none", why: "CI was green without refinement, or the run stopped before CI" });
  }

  // Merge decision (from FSM state / status).
  const merged = m.pr.merge_sha !== "";
  rows.push({
    decision: "Merge gate",
    choice: merged ? `merged (${m.pr.merge_sha})` : "not merged",
    why: "operator-gated merge (INV-SHIP-2/3 — apply ≠ deploy; the merge is the deploy for a direct-load target)",
  });

  // Deploy-confirm mode (KP-3).
  rows.push({
    decision: "Deploy-confirm",
    choice: `${m.deploy.confirm} (${m.target.deploy_semantics})`,
    why:
      m.target.deploy_semantics === "installed-copy"
        ? "installed-copy — the watch opened only on the installed-confirmation event, never at bare merge (KP-3)"
        : "direct-load — the merge IS the deploy; the watch opened immediately (KP-3)",
  });

  // Watch verdict.
  rows.push({
    decision: "Watch verdict",
    choice: watchVerdictLine(input),
    why: `window ${m.watch.window_minutes}m · baseline \`${m.watch.baseline.mode}\`${m.watch.baseline.mode === "none" ? " (cold subject — signals-only, §7.3)" : ""}`,
  });

  // On regression: recommendation + DIAGNOSE handoff.
  if (input.verdict?.flagged) {
    rows.push({
      decision: "Regression handoff",
      choice: `recommendation + ④ DIAGNOSE handoff${input.diagnoseHandoffRef ? ` (${input.diagnoseHandoffRef})` : ""}`,
      why: "a rollback was RECOMMENDED (evidence-linked, §6.4) and the flagged traces were handed to DIAGNOSE; NEVER auto-rolled-back (INV-SHIP-5)",
    });
  }

  // Rolled-back: cross-link the revert PR.
  if (input.revertPrRef) {
    rows.push({
      decision: "Rollback",
      choice: `revert PR ${input.revertPrRef}`,
      why: "operator-gated revert-PR (git revert of the ship merge) — opened, never auto-merged (INV-SHIP-5)",
    });
  }

  return rows;
}

// ── the ship-report (markdown) ───────────────────────────────────────────────

/** Render the OUT-always ship-report as markdown (§8) — the shareable artifact. */
export function renderShipReportMarkdown(input: ShipReportInput): string {
  const m = input.manifest;
  const ms = input.monitorState;

  const ciRows =
    (ms?.ci_timeline ?? []).length > 0
      ? (ms?.ci_timeline ?? []).map((c) => `| \`${mdEscape(c.check)}\` | ${mdEscape(c.conclusion)} | ${c.at} |`).join("\n")
      : "| _(no CI observations recorded)_ | — | — |";

  const ledgerRows =
    (ms?.refinement_ledger ?? []).length > 0
      ? (ms?.refinement_ledger ?? [])
          .map(
            (e) =>
              `| ${e.n} | \`${e.class}\` | ${e.files_touched.map((f) => `\`${mdEscape(f)}\``).join(", ") || "—"} | ${e.push_sha || "—"} | ${e.result} | ${e.within_grant ? "✓" : "gated"} |`,
          )
          .join("\n")
      : "| _(no refinement attempts)_ | — | — | — | — | — |";

  const signalRows =
    input.verdict?.flagged && input.verdict.firedSignals.length > 0
      ? input.verdict.firedSignals
          .map((f) => `| \`${f.signal}\` | ${f.watchValue} | ${f.baselineValue} | ${f.delta ?? "—"} | tick ${f.firedAtInterval} |`)
          .join("\n")
      : "| _(no signals fired — clean window)_ | — | — | — | — |";

  const evidenceLinks = [
    `- **Evaluate verdict**: \`${m.evidence.evaluate_verdict}\``,
    `- **Build report**: ${m.evidence.build_report ? `\`${m.evidence.build_report}\`` : "_(none)_"}`,
    `- **CI timeline (monitor-state)**: \`${m.evidence.ci_timeline}\``,
    `- **Trace manifests**: ${m.evidence.trace_manifests.length > 0 ? m.evidence.trace_manifests.map((t) => `\`${mdEscape(t)}\``).join(", ") : "_(none — watch did not run)_"}`,
    input.recommendation ? `- **Rollback recommendation**: \`${m.rollback.recommendation ?? "(record)"}\`` : "- **Rollback recommendation**: _(none — clean ship)_",
    input.diagnoseHandoffRef ? `- **④ DIAGNOSE handoff**: \`${mdEscape(input.diagnoseHandoffRef)}\`` : "",
    input.revertPrRef ? `- **Revert PR**: ${mdEscape(input.revertPrRef)}` : "",
  ].filter((l) => l !== "");

  const decisionRows = deriveDecisionRows(input)
    .map((r) => `| ${mdEscape(r.decision)} | ${mdEscape(r.choice)} | ${mdEscape(r.why)} |`)
    .join("\n");

  return [
    `# ⑥ SHIP report — ${m.ship_id}`,
    "",
    `**Subject:** \`${m.subject.name}\` [${m.subject.kind} · ${m.subject.artifact_format}] @ \`${m.subject.commit}\``,
    `**Target:** ${m.target.platform} · \`${m.target.repo}\` · ${m.target.deploy_semantics}`,
    `**Status:** \`${m.status}\`${ms ? ` · FSM \`${ms.fsm_state}\`` : ""}`,
    `**PR:** ${m.pr.number > 0 ? `#${m.pr.number} ${m.pr.url}` : "(not opened)"} [\`${m.pr.branch}\`]`,
    "",
    "## CI timeline",
    "",
    "| Check | Conclusion | At |",
    "|---|---|---|",
    ciRows,
    "",
    "## Refinement ledger",
    "",
    `Grant: \`${ms?.grant.pre_grant ?? "none"}\`${ms?.grant.grant_revoked ? " · **REVOKED**" : ""} · attempts ${ms?.refinement_attempts ?? 0}`,
    "",
    "| # | Class | Files | Push | Result | In-grant |",
    "|---|---|---|---|---|---|",
    ledgerRows,
    "",
    "## Deploy-confirm",
    "",
    `\`${m.deploy.confirm}\` (${m.target.deploy_semantics})${m.deploy.installed_confirmed_at ? ` · confirmed ${m.deploy.installed_confirmed_at} by ${m.deploy.confirmed_by}` : ""}`,
    "",
    "## Watch verdict",
    "",
    watchVerdictLine(input),
    "",
    "| Signal | Watch | Baseline | Δ | Fired |",
    "|---|---|---|---|---|",
    signalRows,
    "",
    "## Evidence links",
    "",
    ...evidenceLinks,
    "",
    "## Decisions",
    "",
    "| Decision | Choice | Why |",
    "|---|---|---|",
    decisionRows,
    "",
  ].join("\n");
}

// ── the ship-report (html) ───────────────────────────────────────────────────

/**
 * Render the ship-report as a minimal self-contained HTML doc (§8). Not a design
 * artifact — a plain, styleless, leak-safe rendering of the same sections so the
 * report is viewable in a browser. Deterministic; escapes all injected text.
 */
export function renderShipReportHtml(input: ShipReportInput): string {
  const m = input.manifest;
  const md = renderShipReportMarkdown(input);
  // Embed the markdown verbatim in a <pre> — a faithful, escaped, dependency-free
  // rendering (no external markdown lib; the .md is the canonical form).
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>SHIP report — ${htmlEscape(m.ship_id)}</title>`,
    "<style>body{font:14px/1.5 ui-monospace,monospace;max-width:60rem;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;word-break:break-word}</style>",
    "</head><body>",
    `<pre>${htmlEscape(md)}</pre>`,
    "</body></html>",
    "",
  ].join("\n");
}

// ── the 🏁 Final Status PR comment (§3) ──────────────────────────────────────

/**
 * Render the closing 🏁 Final Status PR comment (§3 convention / feedback_pr_final
 * _status_comment): Decisions + WHYs. The parent posts this at terminal status;
 * the monitor supplies the data. Deterministic + leak-safe.
 */
export function renderFinalStatusComment(input: ShipReportInput): string {
  const rows = deriveDecisionRows(input)
    .map((r) => `| ${mdEscape(r.decision)} | ${mdEscape(r.choice)} | ${mdEscape(r.why)} |`)
    .join("\n");

  return [
    "## 🏁 Final Status",
    "",
    `Ship \`${input.manifest.ship_id}\` — terminal status \`${input.manifest.status}\`.`,
    "",
    "| Decision | Choice | Why |",
    "|---|---|---|",
    rows,
    "",
    "_Rendered from the ship-manifest + monitor checkpoint — the machine record is the manifest; this is the shareable audit. Nothing here auto-acted (INV-SHIP-5)._",
    "",
  ].join("\n");
}
