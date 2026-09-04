import type { SourceAdapter, SourceAdapterIdValue } from "./types.ts";

// ---------------------------------------------------------------------------
// Source-adapter registry (mirrors the apply-layer target-adapter registry in
// @mutagent/tools src/apply/registry.ts). Adapters self-register via ./index.ts
// (imported once). Kept tiny so the registration graph is obvious.
// ---------------------------------------------------------------------------

const REGISTRY = new Map<SourceAdapterIdValue, SourceAdapter>();

export function registerSourceAdapter(adapter: SourceAdapter): void {
  REGISTRY.set(adapter.id, adapter);
}

/**
 * Resolve an adapter, THROWING a clear error (with the registered set) when the
 * source is unknown. Use this for the strict binding path where an unregistered
 * `source.platform` is a hard error.
 */
export function getSourceAdapter(id: SourceAdapterIdValue): SourceAdapter {
  const a = REGISTRY.get(id);
  if (!a) {
    const known = [...REGISTRY.keys()].sort().join(", ") || "(none registered)";
    throw new Error(`no source adapter registered for id '${id}'. Registered: ${known}.`);
  }
  return a;
}

/**
 * Resolve an adapter, or `undefined` when unknown. Use this for the tolerant
 * dispatch path (tier0-scan) that must FALL BACK to the generic scan for an
 * unregistered / mixed-platform batch rather than throw.
 */
export function tryGetSourceAdapter(id: SourceAdapterIdValue): SourceAdapter | undefined {
  return REGISTRY.get(id);
}

export function listSourceAdapters(): SourceAdapter[] {
  return [...REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Test/reset seam. */
export function clearSourceAdapters(): void {
  REGISTRY.clear();
}
