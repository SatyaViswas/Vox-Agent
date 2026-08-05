/**
 * scripts/normalize/unitf-types.ts
 * VENDORED minimal copy of the Unified Trace Format (UniTF v0.1) record shape.
 * Type A — Pure Script (type definitions + one pure runtime guard — no I/O).
 *
 * WHY vendored, not imported:
 *   The canonical UniTF schema lives in `mutagent-tools/src/format/unitf.ts`
 *   (the CLI package). Diagnostics is a STANDALONE published skill and MUST NOT
 *   add a cross-package source import to `@mutagent/tools` — the migration
 *   boundary is JSONL on disk, not a TypeScript module edge (see
 *   ../../../mutagent-tools/references/MIGRATION-diagnostics-evaluator.md §6.1,
 *   "Circular import" risk row). So we copy the MINIMAL structural shape the
 *   projection adapter reads. This is a snapshot of UniTF v0.1; if the canonical
 *   schema bumps, this file is re-synced by hand (decoupled by design).
 *
 * This is a TYPE-only mirror (no @sinclair/typebox runtime schema) plus a single
 * cheap structural guard used by the reader to skip non-UniTF lines. Field names
 * and optionality match `unitf.ts` exactly so the JSONL contract stays lossless.
 */

/** The FROZEN UniTF contract version this vendored copy mirrors. */
export const UNITF_VERSION = "0.1" as const;

/** The manifest `format` marker that pairs with UNITF_VERSION. */
export const UNITF_MANIFEST_FORMAT = "unitf@0.1" as const;

/** UniTF source platforms (superset — a strict superset of diagnostics' own). */
export type UnitfSourcePlatform =
  | "langfuse"
  | "otel"
  | "claude-code"
  | "codex"
  | "pi"
  | "omp"
  | "local-ndjson"
  | "signoz"
  | "datadog"
  | "openobserve"
  | "braintrust";

export type UnitfSpanKind =
  | "llm"
  | "tool"
  | "retrieval"
  | "agent"
  | "event"
  | "span";

export type UnitfStatus = "ok" | "error" | "unknown";

export type UnitfRole =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "toolResult";

/** Token usage — preserves the cache + de-double-counted billed split. */
export interface UnitfTokens {
  input?: number;
  output?: number;
  total?: number;
  cachedInput?: number;
  cacheCreation?: number;
  billedInput?: number;
  billedOutput?: number;
}

/** A raw platform score (Langfuse-style). Left raw; consumers normalize. */
export interface UnitfScore {
  name: string;
  value?: number | string | boolean;
  comment?: string;
  dataType?: string;
}

/** OTel-aligned span — unifies transcript messages AND observations. */
export interface UnitfSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: UnitfSpanKind;
  startTime?: string;
  endTime?: string;
  latencyMs?: number;
  status: UnitfStatus;
  role?: UnitfRole;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  tokens?: UnitfTokens;
  costUsd?: number;
  attributes?: Record<string, unknown>;
}

export interface UnitfApiError {
  retryAttempt?: number;
  maxRetries?: number;
  timestamp?: string;
}

export interface UnitfCompactionEvent {
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
}

/** Optional, namespaced extension blocks — each consumer reads only its own. */
export interface UnitfExt {
  /** diagnostics W18 — GROUNDED prompt-cache detection. */
  cache?: {
    hitRate?: number;
    status?: "hit" | "miss" | "unknown";
  };
  /** diagnostics R-SELF-06 — provider-side telemetry. */
  provider?: {
    apiErrors?: UnitfApiError[];
    compactionEvents?: UnitfCompactionEvent[];
  };
  /** Entity/agent context (majority-voted identity, sampled prompt, tools). */
  agent?: {
    agentSetting?: string;
    isTeammate?: boolean;
    model?: string;
    systemPrompt?: string;
    toolInventory?: string[];
  };
  /** Eval fidelity + results (OPEN — results shape varies by metric). */
  eval?: {
    incomplete?: boolean;
    incompleteReason?: string;
    results?: unknown[];
  };
  /** Lossless escape hatch — the original source record. */
  raw?: unknown;
}

/** Derived convenience — NEVER authoritative (gates distrust derived fields). */
export interface UnitfComputed {
  hasError?: boolean;
  hasFeedback?: boolean;
  totalTokens?: number;
  durationMs?: number;
  messageCount?: number;
  toolCallCount?: number;
}

/** The canonical UniTF record (minimal vendored mirror). */
export interface UnifiedTrace {
  unitf_version: typeof UNITF_VERSION;
  traceId: string;
  sessionId?: string;
  parentSessionId?: string;
  agentId?: string;
  agentName?: string;
  skillId?: string;
  chainStepIndex?: number;
  sourcePlatform: UnitfSourcePlatform;
  sourceFormat?: string;
  startTime?: string;
  endTime?: string;
  latencyMs?: number;
  status: UnitfStatus;
  tokens?: UnitfTokens;
  costUsd?: number;
  tags?: string[];
  scores?: UnitfScore[];
  spans: UnitfSpan[];
  ext?: UnitfExt;
  computed?: UnitfComputed;
}

/**
 * TraceManifest v0.1 — minimal vendored mirror of the RESULT contract emitted
 * alongside every `--export` JSONL (canonical: mutagent-tools/src/format/
 * trace-manifest.ts). Only the fields the reader inspects are mirrored.
 */
export interface UnitfTraceManifest {
  manifest_version?: string;
  platform?: UnitfSourcePlatform;
  count?: number;
  truncated?: boolean;
  truncationReason?: string;
  jsonlPath?: string;
  format?: string;
  coverage?: {
    fetched: number;
    malformed?: number;
    deduped?: number;
  };
  warnings?: string[];
  producedAt?: string;
}

/**
 * Cheap structural guard — is this a UniTF record shape? Used by the JSONL reader
 * to SKIP (count as malformed) lines that parse as JSON but are not UniTF records.
 * Pure; never throws. Deliberately structural (not a full typebox check) — the
 * canonical validator lives in the CLI; this only needs to bound projection input.
 */
export function isUnifiedTraceLike(obj: unknown): obj is UnifiedTrace {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    o.unitf_version === UNITF_VERSION &&
    typeof o.traceId === "string" &&
    o.traceId.length > 0 &&
    typeof o.sourcePlatform === "string" &&
    typeof o.status === "string" &&
    Array.isArray(o.spans)
  );
}
