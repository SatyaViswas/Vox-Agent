import { SourceAdapterId } from "../types.ts";
import type { SourceAdapter } from "../types.ts";

// Local-JSONL source adapter — the UniTF handover format read directly off disk
// (no per-platform fetch/normalize; see normalize/read-unitf.ts). No bespoke
// Tier-0 scanner — uses the generic scan (omitting `tier0Scan`), unchanged from
// the pre-registry fallback path.
export const localJsonlSourceAdapter: SourceAdapter = {
  id: SourceAdapterId.LocalJsonl,
  label: "Local JSONL (UniTF)",
  live: true,
};
