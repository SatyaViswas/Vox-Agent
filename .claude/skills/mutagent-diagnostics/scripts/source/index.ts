import { registerSourceAdapter, clearSourceAdapters } from "./registry.ts";
import { langfuseSourceAdapter } from "./adapters/langfuse.ts";
import { otelSourceAdapter } from "./adapters/otel.ts";
import { localJsonlSourceAdapter } from "./adapters/local-jsonl.ts";
import { claudeCodeSourceAdapter } from "./adapters/claude-code.ts";
import { codexSourceAdapter } from "./adapters/codex.ts";

// ---------------------------------------------------------------------------
// Source-adapter registration entry point (mirrors apply/index.ts
// registerBuiltinAdapters). The five shipped sources register declaratively
// here; adding a source = drop an adapter file + one line below (+ the
// SourcePlatform literal in normalize/trace.ts & config/schema.ts). No consumer
// switch to edit — see references/source-adapter-contract.md.
// ---------------------------------------------------------------------------

/** Register the shipped source adapters (idempotent — clears then registers). */
export function registerBuiltinSourceAdapters(): void {
  clearSourceAdapters();
  registerSourceAdapter(langfuseSourceAdapter);
  registerSourceAdapter(otelSourceAdapter);
  registerSourceAdapter(localJsonlSourceAdapter);
  registerSourceAdapter(claudeCodeSourceAdapter);
  registerSourceAdapter(codexSourceAdapter);
}

let _builtinsRegistered = false;

/**
 * Ensure the shipped adapters are registered EXACTLY once. Library callers (e.g.
 * tier0-scan's platform-aware dispatch) invoke this instead of
 * registerBuiltinSourceAdapters so a caller-registered custom/fake adapter is not
 * clobbered on every scan. Tests reset via clearSourceAdapters() +
 * resetBuiltinSourceAdaptersForTest().
 */
export function ensureBuiltinSourceAdapters(): void {
  if (_builtinsRegistered) return;
  registerBuiltinSourceAdapters();
  _builtinsRegistered = true;
}

/** Test seam — reset the ensure-once latch so a suite can re-exercise registration. */
export function resetBuiltinSourceAdaptersForTest(): void {
  _builtinsRegistered = false;
}

export type { SourceAdapter, SourceAdapterIdValue } from "./types.ts";
export { SourceAdapterId } from "./types.ts";
export {
  registerSourceAdapter,
  getSourceAdapter,
  tryGetSourceAdapter,
  listSourceAdapters,
  clearSourceAdapters,
} from "./registry.ts";
