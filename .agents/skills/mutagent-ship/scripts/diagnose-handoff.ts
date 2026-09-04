// ---------------------------------------------------------------------------
// ⑥ SHIP — the ④ DIAGNOSE handoff (ship PRD §8 OUT-on-regression, P3).
//
// On a flagged watch window the parent emits a HandoverBundle{adl_stage: diagnose}
// carrying the regression evidence to ④ DIAGNOSE — "exactly what its intake
// already eats: a UniTF pair, plus ship provenance" (§8). This module is the PURE
// builder for that bundle.
//
// STANDALONE + SYMBIOSIS (load-bearing): a shipped skill MUST NOT import another
// skill's / the orchestrator's source. The frozen HandoverBundle contract lives in
// mutagent-orchestrator/scripts/handover-contract.ts (v0.2.0, #1202); SHIP MIRRORS
// its vocabulary BY CONVENTION here — same field names, same frozen version, same
// closed shape — never a cross-package import. The orchestrator's
// validateHandoverBundle remains the AUTHORITY at the dispatch boundary; this
// builder produces a bundle that satisfies it (the parent validates before routing).
//
// Deterministic: no clock, no random. `produced_at` is INJECTED (§ handover-contract
// determinism rule) so the same regression yields a byte-identical bundle.
// ---------------------------------------------------------------------------

/** The frozen HandoverBundle version — MIRRORED from handover-contract.ts (#1202). */
export const HANDOVER_BUNDLE_VERSION = "0.2.0" as const;

/** The routed ADL stage this bundle carries (SHIP → DIAGNOSE). */
export const DIAGNOSE_STAGE = "diagnose" as const;

/** Subject kinds — mirrored from the frozen SubjectKind (`code` dropped in v0.2.0). */
export type HandoverSubjectKind = "skill" | "agent";
/** The additive substrate axis — mirrored from the frozen ArtifactFormat. */
export type HandoverArtifactFormat = "markdown" | "code" | "platform-config";

/** The artifact kinds crossing the boundary — mirrored from the frozen ArtifactKind. */
export const HandoverArtifactKind = {
  Trace: "trace",
  Findings: "findings",
  Report: "report",
  Config: "config",
} as const;

export interface HandoverArtifactRef {
  id: string;
  kind: string;
  /** Relative path (determinism: never absolute). */
  path: string;
}

export interface DiagnoseHandoverBundle {
  bundle_version: typeof HANDOVER_BUNDLE_VERSION;
  adl_stage: typeof DIAGNOSE_STAGE;
  subject: {
    kind: HandoverSubjectKind;
    artifactFormat?: HandoverArtifactFormat;
    name: string;
    path: string;
  };
  intent: { command: string; utterance?: string };
  inputs: HandoverArtifactRef[];
  context_pack: { rules: string[]; memory: string[]; partial_loads: { path: string; reason: string }[] };
  acceptance: { goal: string; criteria: string[] };
  provenance: { produced_by: string; produced_at: string };
  escalation_policy: "escalate" | "abort" | "proceed";
}

export interface DiagnoseHandoverInput {
  shipId: string;
  subject: {
    kind: HandoverSubjectKind;
    name: string;
    path: string;
    artifactFormat?: HandoverArtifactFormat;
  };
  /** The flagged UniTF pair — the regression traces + their manifest (§8). */
  regressionTraces: { jsonlPath: string; manifestPath: string };
  /** The §6.4 rollback-recommendation record path (the evidence spine). */
  recommendationRef: string;
  /** The ship-manifest path (ship provenance). */
  shipManifestRef: string;
  /** The signals that fired — surfaced in the acceptance criteria for DIAGNOSE. */
  flaggedSignals: string[];
  /** INJECTED ISO stamp + producer id (never self-generated — determinism). */
  producedAt: string;
  producedBy?: string;
  utterance?: string;
}

/**
 * Build the ④ DIAGNOSE handover from a flagged ship run (§8). Pure + deterministic.
 * `inputs[]` enumerates exactly the regression evidence — the UniTF JSONL + its
 * TraceManifest (kind `trace`), the rollback-recommendation record (kind
 * `findings`), and the ship-manifest (kind `config`) — so a downstream leak audit
 * sees precisely what crossed the boundary. The acceptance goal names the
 * regression; the criteria carry the fired signals so DIAGNOSE knows what to
 * root-cause. THROWS if the required trace pair is missing (an evidence-free
 * DIAGNOSE handoff would defeat the boundary — fail-loud).
 */
export function makeDiagnoseHandover(input: DiagnoseHandoverInput): DiagnoseHandoverBundle {
  if (!input.regressionTraces.jsonlPath || !input.regressionTraces.manifestPath) {
    throw new Error(
      "makeDiagnoseHandover: the regression UniTF pair (jsonlPath + manifestPath) is required — " +
        "DIAGNOSE eats a trace pair; an evidence-free handoff is refused (§8)",
    );
  }

  const subject: DiagnoseHandoverBundle["subject"] = {
    kind: input.subject.kind,
    name: input.subject.name,
    path: input.subject.path,
  };
  if (input.subject.artifactFormat !== undefined) subject.artifactFormat = input.subject.artifactFormat;

  const intent: DiagnoseHandoverBundle["intent"] = { command: "*ship" };
  if (input.utterance !== undefined) intent.utterance = input.utterance;

  return {
    bundle_version: HANDOVER_BUNDLE_VERSION,
    adl_stage: DIAGNOSE_STAGE,
    subject,
    intent,
    inputs: [
      { id: "regression-traces", kind: HandoverArtifactKind.Trace, path: input.regressionTraces.jsonlPath },
      { id: "regression-trace-manifest", kind: HandoverArtifactKind.Trace, path: input.regressionTraces.manifestPath },
      { id: "rollback-recommendation", kind: HandoverArtifactKind.Findings, path: input.recommendationRef },
      { id: "ship-manifest", kind: HandoverArtifactKind.Config, path: input.shipManifestRef },
    ],
    context_pack: { rules: [], memory: [], partial_loads: [] },
    acceptance: {
      goal: `Root-cause the post-deploy regression flagged on ship \`${input.shipId}\``,
      criteria: [
        "Identify the root cause of the flagged regression from the attached UniTF traces",
        `Account for the fired signals: ${input.flaggedSignals.join(", ") || "(none named)"}`,
        "Rollback is mitigation, not diagnosis — the regression still needs a root cause (§1.3 step 4)",
      ],
    },
    provenance: {
      produced_by: input.producedBy ?? "mutagent-ship",
      produced_at: input.producedAt,
    },
    // A regression is an escalation-worthy handoff; DIAGNOSE decides remediation.
    escalation_policy: "escalate",
  };
}
