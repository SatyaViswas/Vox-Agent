# Source-Adapter Contract — adding a trace source

> Authority: `scripts/source/` (the read-side transport layer). This is the
> symmetric twin of the write-side `TargetAdapter` contract in
> `@mutagent/tools` `src/apply/` (see `adapter-strategy.md` Q4/DC-5).

## Why this exists

Before Item #7 the per-platform read path was **ad-hoc**: `scripts/tier0-scan.ts`
held a hard-coded `if (platform === "langfuse") … if (platform === "claude-code") …`
dispatch with inline dynamic imports. Adding a source meant editing that switch.

Now sources register **declaratively** through a registry that mirrors the apply
layer exactly:

| apply (write side, `@mutagent/tools/src/apply`) | source (read side, `scripts/source`) |
| --- | --- |
| `AdapterId` (const) | `SourceAdapterId` (const) |
| `TargetAdapter` (interface) | `SourceAdapter` (interface) |
| `registerTargetAdapter` / `getTargetAdapter` (throws) / `listTargetAdapters` / `clearTargetAdapters` | `registerSourceAdapter` / `getSourceAdapter` (throws) / `listSourceAdapters` / `clearSourceAdapters` |
| `registerBuiltinAdapters()` | `registerBuiltinSourceAdapters()` |
| `apply.kind` → `adapterIdForKind()` (binding.ts, **N:1**) | `source.platform` → adapter id (**1:1, identity — no binding module**) |

**The one intentional asymmetry**: the apply layer needs a `binding.ts` because
`apply.kind` (4 config values) maps *non-1:1* onto adapter ids (`code-pr` **and**
`markdown` → `worktree-pr`; `cloud-deploy` → `rest` **or** `vendor-cli`). On the
read side `source.platform` → adapter id is **1:1** — the registry key *is* the
platform literal — so there is no binding module (it would be an identity
function). Everything else is a direct mirror.

## The interface

```ts
// scripts/source/types.ts
export interface SourceAdapter {
  id: SourceAdapterIdValue;   // === a SourcePlatform literal; binds to config source.platform
  label: string;              // human label (onboarding pickers)
  live: boolean;              // false = declared SEAM stub, true = shipped
  tier0Scan?: Tier0ScanFn;    // OPTIONAL per-platform Tier-0 enrichment
}
```

`tier0Scan` is **optional and behavior-defining by its absence**:

- **present** (langfuse, claude-code) → `runTier0ScanPlatformAware` dispatches a
  homogeneous batch to it for signal extraction tuned to that source
  (e.g. Langfuse `LF-001` low-score-concentration, Claude-Code compaction clusters).
- **absent** (otel, local-jsonl, codex) → the generic `runTier0Scan` runs. This is
  identical to the pre-registry fallback where only langfuse/claude-code had a branch.

Implementations should **lazily `import()`** their heavy scan module (as the
pre-registry dispatch did) so registering the adapter set stays cheap and there is
no eval-time import cycle with `tier0-scan.ts`.

## How to add a NEW source

1. **Extend the platform literal** in both:
   - `scripts/normalize/trace.ts` → `SourcePlatform` union
   - `scripts/config/schema.ts` → `SourcePlatformSchema`
2. **Add the adapter id** to `SourceAdapterId` in `scripts/source/types.ts`.
3. **Drop an adapter file** at `scripts/source/adapters/<platform>.ts`:
   ```ts
   import { SourceAdapterId } from "../types.ts";
   import type { SourceAdapter } from "../types.ts";
   export const myPlatformSourceAdapter: SourceAdapter = {
     id: SourceAdapterId.MyPlatform,
     label: "My Platform",
     live: true,
     // OPTIONAL — only if the platform warrants a bespoke Tier-0 scanner:
     // async tier0Scan(traces, config) {
     //   const mod = await import("../../tier0/my-platform.ts");
     //   return mod.runMyPlatformTier0(traces, config);
     // },
   };
   ```
4. **Register it** — add one line to `registerBuiltinSourceAdapters()` in
   `scripts/source/index.ts`. **No consumer switch to edit.**
5. **(Read side)** add `references/source-platforms/<platform>.md` (CLI manual +
   filters + credential setup) and, if you fetch+normalize rather than read a
   UniTF handover, `scripts/normalize/platforms/<platform>.ts` — per
   `adapter-strategy.md` Q1/Q6.
6. **(Optional)** add `scripts/tier0/<platform>.ts` with a
   `run<Platform>Tier0(traces, config)` scanner, wired via `tier0Scan` above.

## Resolution semantics

- `getSourceAdapter(id)` — **throws** a clear error (naming the registered set)
  when the source is unknown. Use on the strict binding path.
- `tryGetSourceAdapter(id)` — returns `undefined` (never throws). Used by
  `tier0-scan.ts` so a mixed-platform / unregistered batch **falls back to the
  generic scan** instead of throwing.
- `ensureBuiltinSourceAdapters()` — registers the shipped set exactly once and
  never clobbers a caller-registered custom/fake adapter (library-safe).
