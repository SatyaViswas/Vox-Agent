// ---------------------------------------------------------------------------
// mutagent-diagnostics source layer — the SHARED read-side transport (the
// symmetric twin of the write-side `TargetAdapter` in @mutagent/tools
// src/apply). One `SourceAdapter` interface, N adapters; the `source.platform`
// config field binds to an adapter id (see ./registry.ts getSourceAdapter).
//
// BEFORE this layer the per-platform read path was ad-hoc: tier0-scan.ts held a
// hard-coded `if (platform === "langfuse") … if (platform === "claude-code") …`
// dispatch with inline dynamic imports. A new trace source could not register
// declaratively — you edited the switch. This layer replaces that switch with a
// registry, mirroring the apply layer exactly:
//
//   apply (write side)                source (read side)
//   ──────────────────                ──────────────────
//   AdapterId (const)            ⇄    SourceAdapterId (const)
//   TargetAdapter (interface)    ⇄    SourceAdapter (interface)
//   registerTargetAdapter        ⇄    registerSourceAdapter
//   getTargetAdapter (throws)    ⇄    getSourceAdapter (throws)
//   listTargetAdapters           ⇄    listSourceAdapters
//   clearTargetAdapters          ⇄    clearSourceAdapters
//   registerBuiltinAdapters      ⇄    registerBuiltinSourceAdapters
//   apply.kind → adapterIdForKind ⇄   source.platform → id (1:1, identity)
//
// Asymmetry (intentional): the apply layer needs a binding.ts because `apply.kind`
// (4 config values) maps NON-1:1 onto adapter ids (code-pr AND markdown → worktree-pr;
// cloud-deploy → rest OR vendor). On the read side `source.platform` → adapter id is
// 1:1 (the id IS the platform literal), so no binding module is warranted — the
// registry key IS the platform. See references/source-adapter-contract.md.
// ---------------------------------------------------------------------------

import type { SourcePlatform, TraceMetadata } from "../normalize/trace.ts";
import type { Tier0Report, Tier0ScanConfig } from "../tier0-scan.ts";

/**
 * The source transports — `source.platform` binds directly to one of these ids
 * (1:1). Mirrors `AdapterId` in the apply layer. Declared as a const object (not
 * a bare union) so callers can reference `SourceAdapterId.Langfuse` symbolically
 * and so `listSourceAdapters()` / tests can enumerate the shipped set.
 */
export const SourceAdapterId = {
  /** Langfuse traces — explicit score + feedback + latency signals as first-class fields. */
  Langfuse: "langfuse",
  /** OpenTelemetry spans (incl. OpenObserve, ingested via the UniTF/local-jsonl handover). */
  Otel: "otel",
  /** Local JSONL export (the UniTF handover format) — read directly, no per-platform fetch. */
  LocalJsonl: "local-jsonl",
  /** Claude Code session transcripts — v0.3 apiErrors / compactionEvents extensions. */
  ClaudeCode: "claude-code",
  /** Codex session transcripts. */
  Codex: "codex",
} as const;

/** An adapter id === a `SourcePlatform` literal (the read-side ids are 1:1 with platforms). */
export type SourceAdapterIdValue = SourcePlatform;

/**
 * Optional per-platform Tier-0 enrichment capability. When an adapter provides
 * this, `runTier0ScanPlatformAware` dispatches a homogeneous batch here for signal
 * extraction tuned to the source's signal density (e.g. Langfuse LF-001 low-score
 * concentration, Claude-Code compaction clusters). When ABSENT, the generic
 * `runTier0Scan` runs — identical to the pre-registry fallback for otel /
 * local-jsonl / codex. Implementations should lazily `import()` their heavy scan
 * module (as the pre-registry dispatch did) so registration stays cheap + cycle-free.
 */
// eslint-disable-next-line no-unused-vars -- fn-type-alias param names (pkg convention, see setup/ensure-cli.ts)
export type Tier0ScanFn = (traces: TraceMetadata[], config: Tier0ScanConfig) => Tier0Report | Promise<Tier0Report>;

/**
 * The contract every source adapter implements — the read-side twin of
 * `TargetAdapter`. Adapters self-register through the registry (./index.ts).
 */
export interface SourceAdapter {
  /** The source platform this adapter serves — binds to config `source.platform`. */
  id: SourceAdapterIdValue;
  /** Human-readable label (onboarding pickers / diagnostics). */
  label: string;
  /** false for a SEAM stub (a source declared but not yet live); true when shipped. */
  live: boolean;
  /**
   * Optional per-platform Tier-0 scan. Present for platforms with a bespoke scanner
   * (langfuse, claude-code); absent for platforms that use the generic scan (otel,
   * local-jsonl, codex). Absence is a first-class, behavior-defining value — it
   * selects the generic path, NOT an error.
   */
  tier0Scan?: Tier0ScanFn;
}
