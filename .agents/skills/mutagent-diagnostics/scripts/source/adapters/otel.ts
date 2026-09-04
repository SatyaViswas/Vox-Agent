import { SourceAdapterId } from "../types.ts";
import type { SourceAdapter } from "../types.ts";

// OpenTelemetry source adapter (also the transport for OpenObserve, ingested via
// the UniTF/local-jsonl handover). No bespoke Tier-0 scanner — OTel batches use
// the generic scan (omitting `tier0Scan` selects the generic path), preserving
// the exact pre-registry behavior where only langfuse/claude-code had a branch.
export const otelSourceAdapter: SourceAdapter = {
  id: SourceAdapterId.Otel,
  label: "OpenTelemetry",
  live: true,
};
