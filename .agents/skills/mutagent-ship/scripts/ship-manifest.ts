import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

// ---------------------------------------------------------------------------
// ⑥ SHIP — the ShipManifestSchema (ship PRD §2).
//
// The durable per-ship record: authored at *ship step 2, updated (append-only
// status transitions + monitor checkpoints) through the run, immutable after a
// terminal status. Lives at `.mutagent/ship/runs/<ship-id>/ship-manifest.yaml`
// (unified artifact root, EV-REQ-058). The ship-REPORT is the shareable
// artifact; the manifest is the machine record.
//
// SHAPE vs COMPLETENESS split (same stance as config-schema.ts /
// handover-contract.ts): this schema enforces SHAPE + enums + the ≤30 watch cap
// + `rollback.policy: gated` + the installed-copy ⇒ `deploy.confirm =
// installed-confirmed` cross-field rule. RUN-TIME completeness (verdict
// freshness, credential resolution, the actual arrival of the
// installed-confirmation event) is the entry gate's / monitor's job, not the
// schema's.
//
// Design invariants (mirror handover-contract.ts): pure functions + a closed
// object at every level (additionalProperties:false) so an undeclared field is
// caught. Any timestamp/id/path is an INJECTED input — makeShipManifest is
// deterministic (same input ⇒ identical manifest), no clock, no random.
// ---------------------------------------------------------------------------

/** The FROZEN manifest version. Bump only via an explicit, reviewed migration. */
export const SHIP_MANIFEST_VERSION = "0.1.0" as const;

/** The hard cap on any watch window (ship PRD §7.1 — a longer watch belongs to
 * the future always-on triggers.ship monitor, KP-6). Schema-enforced. */
export const WATCH_WINDOW_CAP_MINUTES = 30 as const;

// ── Categorical constants (no magic strings) ────────────────────────────────

/** The sync-index subject classification (ship PRD §2 subject.kind). */
export const ShipSubjectKind = {
  Skill: "skill",
  Agent: "agent",
  SystemAgent: "system_agent",
} as const;
export type ShipSubjectKindValue =
  (typeof ShipSubjectKind)[keyof typeof ShipSubjectKind];

/** The FU-69 substrate axis. MVP ships `markdown`; the rest are reserved. */
export const ArtifactFormat = {
  Markdown: "markdown",
  Code: "code",
  PlatformConfig: "platform-config",
} as const;
export type ArtifactFormatValue =
  (typeof ArtifactFormat)[keyof typeof ArtifactFormat];

/** The MVP harness a markdown agent lives on (ship PRD §2 target.platform). */
export const ShipTargetPlatform = {
  ClaudeCode: "claude-code",
  Codex: "codex",
} as const;
export type ShipTargetPlatformValue =
  (typeof ShipTargetPlatform)[keyof typeof ShipTargetPlatform];

/** KP-3 deploy semantics: direct-load ⇒ merge is deploy; installed-copy ⇒ the
 * watch waits for an install-confirm event. */
export const DeploySemantics = {
  DirectLoad: "direct-load",
  InstalledCopy: "installed-copy",
} as const;
export type DeploySemanticsValue =
  (typeof DeploySemantics)[keyof typeof DeploySemantics];

/** KP-3 deploy-confirm signal: direct-load uses `merge`; installed-copy REQUIRES
 * `installed-confirmed` (enforced cross-field in validateShipManifest). */
export const DeployConfirm = {
  Merge: "merge",
  InstalledConfirmed: "installed-confirmed",
} as const;
export type DeployConfirmValue =
  (typeof DeployConfirm)[keyof typeof DeployConfirm];

/** KP-7 changelog source precedence: evaluate > build > git-log. */
export const ChangelogSource = {
  EvaluateReport: "evaluate-report",
  BuildReport: "build-report",
  GitLog: "git-log",
} as const;
export type ChangelogSourceValue =
  (typeof ChangelogSource)[keyof typeof ChangelogSource];

/** Watch baseline mode (ship PRD §7.3): `none` ⇒ cold subject → signals-only. */
export const BaselineMode = {
  PreShipWindow: "pre-ship-window",
  None: "none",
} as const;
export type BaselineModeValue =
  (typeof BaselineMode)[keyof typeof BaselineMode];

/** The 3 legal trace-acquisition paths (ship PRD §6.3). */
export const Acquisition = {
  HelixPrefetch: "helix-prefetch",
  DiscoverDispatch: "discover-dispatch",
  StandaloneArtifact: "standalone-artifact",
} as const;
export type AcquisitionValue = (typeof Acquisition)[keyof typeof Acquisition];

/** KP-5 refinement pre-grant (mechanical classes pre-granted at *ship time). */
export const RefinementPreGrant = {
  None: "none",
  Mechanical: "mechanical",
} as const;
export type RefinementPreGrantValue =
  (typeof RefinementPreGrant)[keyof typeof RefinementPreGrant];

/**
 * The ship-run status lifecycle (ship PRD §2). `history[]` is the append-only
 * transition log; `status` is the current terminal-or-transient state.
 */
export const ShipStatus = {
  Authored: "authored",
  PrOpen: "pr-open",
  CiRed: "ci-red",
  Refining: "refining",
  CiGreen: "ci-green",
  Merged: "merged",
  AwaitingInstall: "awaiting-install",
  Watching: "watching",
  Shipped: "shipped",
  RegressionFlagged: "regression-flagged",
  RolledBack: "rolled-back",
  Escalated: "escalated",
  Aborted: "aborted",
} as const;
export type ShipStatusValue = (typeof ShipStatus)[keyof typeof ShipStatus];

// ── Small helpers ────────────────────────────────────────────────────────────
// Build a closed enum union from a `{ Key: "value" }` const object while
// PRESERVING the literal value union in the inferred Static type (so e.g.
// `ShipManifest["status"]` is `ShipStatusValue`, not a widened `string`).
const literalUnion = <T extends Record<string, string>>(o: T) =>
  Type.Union((Object.values(o) as T[keyof T][]).map((v) => Type.Literal(v)));
const closed = <P extends Parameters<typeof Type.Object>[0]>(props: P) =>
  Type.Object(props, { additionalProperties: false });

// ── Nested schemas (closed at every level) ──────────────────────────────────

const SubjectSchema = closed({
  name: Type.String({ minLength: 1 }), // resolved from the *sync topology — never freehand
  kind: literalUnion(ShipSubjectKind),
  artifact_format: literalUnion(ArtifactFormat), // FU-69 substrate axis (markdown for the MVP)
  path: Type.String({ minLength: 1 }), // repo-relative subject root
  commit: Type.String({ minLength: 1 }), // the sha the evaluate verdict was issued against
});

const TargetSchema = closed({
  platform: literalUnion(ShipTargetPlatform),
  repo: Type.String({ minLength: 1 }), // <owner>/<repo> — from config global.targets[]
  default_branch: Type.String({ minLength: 1 }),
  deploy_semantics: literalUnion(DeploySemantics),
});

const DeploySchema = closed({
  confirm: literalUnion(DeployConfirm),
  // ISO stamp written when the installed-confirmation event arrives (installed-copy only).
  installed_confirmed_at: Type.String(), // may be "" until it arrives
  confirmed_by: Type.String(), // operator id / detected-marker source — the audit trail
});

const ChangelogSchema = closed({
  source: literalUnion(ChangelogSource),
  source_ref: Type.String(), // ArtifactRef path (e.g. the evaluate report); "" when git-log
});

const PrSchema = closed({
  number: Type.Integer({ minimum: 0 }),
  url: Type.String(),
  branch: Type.String({ minLength: 1 }), // ship/<ship-id>
  merge_sha: Type.String(), // written at merge; the *rollback revert target
});

const BaselineSchema = closed({
  mode: literalUnion(BaselineMode),
  window_minutes: Type.Integer({ minimum: 1, maximum: WATCH_WINDOW_CAP_MINUTES }),
});

const WatchSchema = closed({
  window_minutes: Type.Integer({ minimum: 1, maximum: WATCH_WINDOW_CAP_MINUTES }), // ≤30 (schema-enforced)
  opens_on: Type.Literal("deploy-confirm"), // NEVER at bare merge for installed-copy (KP-3)
  baseline: BaselineSchema,
  source_platform: Type.String(), // config global.sources[] role-resolved id
  acquisition: literalUnion(Acquisition),
});

const RollbackSchema = closed({
  // The ONLY legal value — the field exists to make the invariant grep-able (INV-SHIP-5).
  policy: Type.Literal("gated"),
  revert_target: Type.String(), // pr.merge_sha
  recommendation: Type.Union([Type.Null(), Type.String()]),
});

const EvidenceSchema = closed({
  evaluate_verdict: Type.String({ minLength: 1 }), // REQUIRED — the entry-gate proof
  build_report: Type.Union([Type.Null(), Type.String()]),
  trace_manifests: Type.Array(Type.String()), // baseline + watch TraceManifest paths
  ci_timeline: Type.String(), // .mutagent/ship/runs/<ship-id>/monitor-state.json
});

const RefinementSchema = closed({
  pre_grant: literalUnion(RefinementPreGrant), // KP-5 (default none)
  grant_revoked: Type.Boolean(), // flips true the moment a refinement touches non-mechanical surface
});

const HistoryEntrySchema = closed({
  status: literalUnion(ShipStatus),
  at: Type.String({ minLength: 1 }), // INJECTED ISO stamp
  by: Type.String({ minLength: 1 }),
  note: Type.String(),
});

/** The full ship-manifest contract. Closed object — undeclared fields rejected. */
export const ShipManifestSchema = closed({
  manifest_version: Type.Literal(SHIP_MANIFEST_VERSION),
  ship_id: Type.String({ minLength: 1 }), // ship-<subject>-<shortid> — the run dir namespace key
  subject: SubjectSchema,
  target: TargetSchema,
  deploy: DeploySchema,
  changelog: ChangelogSchema,
  pr: PrSchema,
  watch: WatchSchema,
  rollback: RollbackSchema,
  evidence: EvidenceSchema,
  refinement: RefinementSchema,
  status: literalUnion(ShipStatus),
  history: Type.Array(HistoryEntrySchema),
});
export type ShipManifest = Static<typeof ShipManifestSchema>;

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** Human-readable error strings (path: message), empty when ok. */
  errors: string[];
}

const ShipManifestChecker = TypeCompiler.Compile(ShipManifestSchema);

/**
 * Validate a candidate ship-manifest.
 *
 * Two floors:
 *   1. STRUCTURAL — the compiled TypeBox checker (missing / wrong-typed /
 *      out-of-enum / non-frozen-version / undeclared-extra fields, AND the ≤30
 *      watch cap via the Integer `maximum`).
 *   2. SEMANTIC (cross-field TypeBox alone cannot express):
 *      a. installed-copy ⇒ `deploy.confirm === installed-confirmed` (KP-3 — an
 *         installed-copy target must never open its watch at bare merge).
 *      b. belt-and-braces watch-cap check (defends even if the schema literal drifts).
 *
 * Pure: no I/O, no clock. Never throws — a non-object input yields ok:false.
 */
export function validateShipManifest(obj: unknown): ValidationResult {
  const errors: string[] = [];

  if (!ShipManifestChecker.Check(obj)) {
    for (const e of ShipManifestChecker.Errors(obj)) {
      errors.push(`${e.path === "" ? "/" : e.path}: ${e.message}`);
    }
  }

  const m = (obj ?? {}) as Record<string, unknown>;
  const target = (m.target ?? {}) as Record<string, unknown>;
  const deploy = (m.deploy ?? {}) as Record<string, unknown>;
  if (
    target.deploy_semantics === DeploySemantics.InstalledCopy &&
    deploy.confirm !== DeployConfirm.InstalledConfirmed
  ) {
    errors.push(
      "/deploy/confirm: an installed-copy target REQUIRES deploy.confirm = " +
        "'installed-confirmed' (KP-3 — the watch must not open at bare merge)",
    );
  }

  const watch = (m.watch ?? {}) as Record<string, unknown>;
  const win = watch.window_minutes;
  if (typeof win === "number" && win > WATCH_WINDOW_CAP_MINUTES) {
    errors.push(
      `/watch/window_minutes: ${win} exceeds the hard cap of ${WATCH_WINDOW_CAP_MINUTES} (ship PRD §7.1)`,
    );
  }

  return { ok: errors.length === 0, errors };
}

// ── Builder ───────────────────────────────────────────────────────────────

/**
 * Input to makeShipManifest. `manifest_version` is NOT accepted — the builder
 * stamps the frozen constant. Everything a *ship step-2 author supplies is
 * INJECTED; the builder never generates an id, timestamp, or sha. Optional
 * collections default to empty and pr/deploy/merge fields default to their
 * "not-yet" empty-string form (they are written later in the run).
 */
export interface ShipManifestInput {
  ship_id: string;
  subject: Static<typeof SubjectSchema>;
  target: Static<typeof TargetSchema>;
  changelog: Static<typeof ChangelogSchema>;
  /** The entry-gate proof — the evaluate GATE=PASS verdict ArtifactRef path (REQUIRED). */
  evaluate_verdict: string;
  branch: string; // ship/<ship-id>
  ci_timeline: string; // monitor-state.json path
  /** Optional overrides (else schema-sane defaults). */
  watch?: Partial<Static<typeof WatchSchema>> & { baseline?: Partial<Static<typeof BaselineSchema>> };
  refinement_pre_grant?: RefinementPreGrantValue;
  build_report?: string | null;
  source_platform?: string;
  status?: ShipStatusValue;
}

/**
 * Assemble a ship-manifest from injected input. Pure + deterministic. The
 * `deploy.confirm` default is DERIVED from the target's deploy semantics so the
 * cross-field invariant holds by construction: direct-load ⇒ `merge`,
 * installed-copy ⇒ `installed-confirmed`.
 */
export function makeShipManifest(input: ShipManifestInput): ShipManifest {
  const semantics = input.target.deploy_semantics;
  const confirm =
    semantics === DeploySemantics.InstalledCopy
      ? DeployConfirm.InstalledConfirmed
      : DeployConfirm.Merge;

  const watchWindow = input.watch?.window_minutes ?? 5;
  const baselineWindow = input.watch?.baseline?.window_minutes ?? watchWindow;

  return {
    manifest_version: SHIP_MANIFEST_VERSION,
    ship_id: input.ship_id,
    subject: input.subject,
    target: input.target,
    deploy: {
      confirm,
      installed_confirmed_at: "",
      confirmed_by: "",
    },
    changelog: input.changelog,
    pr: { number: 0, url: "", branch: input.branch, merge_sha: "" },
    watch: {
      window_minutes: watchWindow,
      opens_on: "deploy-confirm",
      baseline: {
        mode: input.watch?.baseline?.mode ?? BaselineMode.PreShipWindow,
        window_minutes: baselineWindow,
      },
      source_platform: input.source_platform ?? input.watch?.source_platform ?? "",
      acquisition: input.watch?.acquisition ?? Acquisition.HelixPrefetch,
    },
    rollback: {
      policy: "gated",
      revert_target: "pr.merge_sha",
      recommendation: null,
    },
    evidence: {
      evaluate_verdict: input.evaluate_verdict,
      build_report: input.build_report ?? null,
      trace_manifests: [],
      ci_timeline: input.ci_timeline,
    },
    refinement: {
      pre_grant: input.refinement_pre_grant ?? RefinementPreGrant.None,
      grant_revoked: false,
    },
    status: input.status ?? ShipStatus.Authored,
    history: [],
  };
}
