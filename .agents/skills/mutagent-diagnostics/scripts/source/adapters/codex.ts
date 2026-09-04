import { SourceAdapterId } from "../types.ts";
import type { SourceAdapter } from "../types.ts";

// Codex source adapter — Codex session transcripts. No bespoke Tier-0 scanner;
// uses the generic scan (omitting `tier0Scan`), unchanged from the pre-registry
// fallback path (Codex never had a per-platform Tier-0 branch).
export const codexSourceAdapter: SourceAdapter = {
  id: SourceAdapterId.Codex,
  label: "Codex",
  live: true,
};
