import { SourceAdapterId } from "../types.ts";
import type { SourceAdapter } from "../types.ts";

// Claude Code source adapter. The bespoke Tier-0 scanner (v0.3 apiErrors /
// compactionEvents / teammate-ratio patterns) lives in tier0/claude-code.ts and
// is loaded LAZILY — mirroring the pre-registry dynamic import. runClaudeCodeTier0
// takes no config, so the `config` param of the Tier0Scan signature is omitted here
// (TypeScript permits an implementation with fewer params than its type).
export const claudeCodeSourceAdapter: SourceAdapter = {
  id: SourceAdapterId.ClaudeCode,
  label: "Claude Code",
  live: true,
  async tier0Scan(traces) {
    const mod = await import("../../tier0/claude-code.ts");
    return mod.runClaudeCodeTier0(traces);
  },
};
