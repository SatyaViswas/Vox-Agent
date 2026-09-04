import { SourceAdapterId } from "../types.ts";
import type { SourceAdapter } from "../types.ts";

// Langfuse source adapter. The bespoke Tier-0 scanner (LF-001 low-score
// concentration + config-honoring IQR latency fence) lives in tier0/langfuse.ts;
// it is loaded LAZILY here — exactly as the pre-registry `dispatchPlatformTier0`
// did — so (a) registering the adapter set is cheap and (b) there is no eval-time
// import cycle (tier0/langfuse.ts imports iqrUpperFence from tier0-scan.ts).
export const langfuseSourceAdapter: SourceAdapter = {
  id: SourceAdapterId.Langfuse,
  label: "Langfuse",
  live: true,
  async tier0Scan(traces, config) {
    const mod = await import("../../tier0/langfuse.ts");
    return mod.runLangfuseTier0(traces, config);
  },
};
