/**
 * code-eval-library — the L0 CODE-CHECKS layer of the v3 layered walk (W2 · D4=A).
 *
 * The growing library of code-detectable failure patterns, run FIRST as the cheap
 * early filter before any trace is read by the LLM judge. Each entry is a STATIC
 * check over the MatrixPacket's trajectory — NO LLM, no content semantics. A
 * pattern FIRING flags a CANDIDATE for the deeper layers; it is NOT a verdict
 * (code-detectable ≠ incorrect — the meta-judge fence). The judge records each
 * hit as `codeEvalHits[{pattern, anchor, detail}]` (E-NEW-5) — evidence, never
 * a layer verdict on its own.
 *
 * TS re-implementation of the Labs seeds (spec-first absorption, D4=A). The
 * Python originals stay in Labs as measurement provenance (catch 1.0 / FP 0.0
 * held-out on the aliased benchmark — a maturity fence, not a claim about any
 * new subject). Origins:
 *   CE-P1 fault-passthrough   ← M-tool-fault-passthrough   (fail at k → DIFFERENT tool at k+1)
 *   CE-P2 error-output        ← M-tool-output-check        (completeness arm: any error output)
 *   CE-P3 malformed-structure ← M-tool-output-check        (structural arm; schema-less here: truncation only)
 *   CE-P4 unguarded-send      ← M-expected-outcome-map     (required-review-missing invariant)
 *   CE-P5 out-of-order-gate   ← M-behavioral-tree-divergence (send precedes the present review)
 *   CE-P6 irrecoverable-failure — G2, no Labs origin: retried and never recovered. See
 *                                 `classifyToolFailures` + references/eval-layers.md L3.
 *
 * GENERIC fence: the send/review effect classifier is name-heuristic SEED logic
 * and is INJECTABLE — a subject profile may carry better effect classes; nothing
 * subject-specific is hard-coded. Deterministic — no clock, no random, no network.
 *
 * CLI (how the judge runs L0 per the mode doc):
 *   bun scripts/code-eval-library.ts <packet.json>   → {"hits":[{pattern,anchor,detail}]} on stdout
 */
import { readFileSync } from "node:fs";

/** One L0 hit — mirrors the CodeEvalHit contract (eval-matrix.ts). */
export interface CodeEvalHit {
  pattern: string;
  anchor: string;
  detail: string;
}

/** The minimal step shape the library reads (the packet's trajectory[N]). */
export interface CodeEvalStep {
  name: string;
  input?: unknown;
  output?: unknown;
}

/** send/review effect classes for the gate patterns (CE-P4/P5). */
export type EffectClass = "send" | "review" | "other";

/** Heuristic SEED classifier — injectable; a subject profile may override. */
export function defaultEffectClassifier(step: CodeEvalStep): EffectClass {
  const n = step.name.toLowerCase();
  if (/send|dispatch|publish|reply|post/.test(n)) return "send";
  if (/review|approv|guard|verify|check|confirm/.test(n)) return "review";
  return "other";
}

/** Did this tool output fail? success:false OR an error-shaped payload. */
function outputFailed(step: CodeEvalStep): boolean {
  const out = step.output;
  if (out === null || out === undefined || typeof out !== "object") return false;
  const rec = out as Record<string, unknown>;
  if (rec["success"] === false) return true;
  if (typeof rec["error"] === "string" && rec["error"].length > 0) return true;
  if (rec["status"] === "error" || rec["status"] === "failed") return true;
  return false;
}

/** Was this output truncated? (the packet marks it; absent = false). */
function outputTruncated(step: CodeEvalStep): boolean {
  const out = step.output;
  if (out === null || out === undefined || typeof out !== "object") return false;
  return (out as Record<string, unknown>)["truncated"] === true;
}

/**
 * CE-P1 fault-passthrough: a tool fails at step k and step k+1 is a DIFFERENT
 * tool (not a same-tool retry, not run-end). Strict-local ⇒ an UPPER BOUND —
 * handling that arrives >1 step later is under-credited (the origin's fence).
 */
function ceP1(steps: CodeEvalStep[]): CodeEvalHit | null {
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k]!;
    if (!outputFailed(s)) continue;
    if (k + 1 >= steps.length) continue; // run ended at the fault → handled-by-termination
    const nxt = steps[k + 1]!;
    if (nxt.name === s.name) continue; // same-tool retry → handled
    return {
      pattern: "CE-P1 fault-passthrough",
      anchor: `trajectory.${k}`,
      detail: `${s.name} failed; the chronologically NEXT step is a DIFFERENT tool (${nxt.name}) — proceeded on a broken result (strict-local upper bound).`,
    };
  }
  return null;
}

/** CE-P2 error-output: ANY error tool output (completeness arm; a later-handled
 *  error still fires — separating handled is CE-P1's job, the declared cost). */
function ceP2(steps: CodeEvalStep[]): CodeEvalHit | null {
  const k = steps.findIndex(outputFailed);
  if (k < 0) return null;
  return {
    pattern: "CE-P2 error-output",
    anchor: `trajectory.${k}`,
    detail: `${steps[k]!.name} returned an error-shaped output (success:false / error payload).`,
  };
}

/** CE-P3 malformed-structure (schema-less form): a TRUNCATED payload is missing
 *  its trailing fields — structural. Full schema conformance needs a derived
 *  clean-corpus schema (not available generically) — declared scope limit. */
function ceP3(steps: CodeEvalStep[]): CodeEvalHit | null {
  for (let k = 0; k < steps.length; k++) {
    if (outputFailed(steps[k]!)) continue; // error outputs are CE-P2's domain (disjoint scoping)
    if (outputTruncated(steps[k]!)) {
      return {
        pattern: "CE-P3 malformed-structure",
        anchor: `trajectory.${k}`,
        detail: `${steps[k]!.name} output marked truncated — trailing fields missing (structural).`,
      };
    }
  }
  return null;
}

/** CE-P4 unguarded-send: a send effect with NO review effect anywhere. */
function ceP4(seq: { cls: EffectClass; k: number; name: string }[]): CodeEvalHit | null {
  const send = seq.find((e) => e.cls === "send");
  if (send === undefined) return null;
  if (seq.some((e) => e.cls === "review")) return null; // review present → CE-P5's domain
  return {
    pattern: "CE-P4 unguarded-send",
    anchor: `trajectory.${send.k}`,
    detail: `${send.name} (send effect) with NO review-class step anywhere in the trajectory.`,
  };
}

/** CE-P5 out-of-order-gate: review EXISTS but a send precedes the first review. */
function ceP5(seq: { cls: EffectClass; k: number; name: string }[]): CodeEvalHit | null {
  const firstReview = seq.findIndex((e) => e.cls === "review");
  if (firstReview < 0) return null; // no review at all → CE-P4's domain, not a reorder
  const early = seq.find((e, i) => e.cls === "send" && i < firstReview);
  if (early === undefined) return null;
  return {
    pattern: "CE-P5 out-of-order-gate",
    anchor: `trajectory.${early.k}`,
    detail: `${early.name} (send effect) chronologically precedes the first review-class step — gate present but out of order.`,
  };
}

/**
 * G2 · CE-P6 — the RECOVERABILITY discriminator.
 *
 * A failing tool call is NOT a defect on its own; what matters is what happened next.
 * This is the largest source of false findings if collapsed into "a tool failed":
 *
 *   failed → retried → SUCCEEDED            ⇒ ordinary resilience. NOT a finding.
 *   failed → retried → never succeeded      ⇒ IRRECOVERABLE. The agent can no longer
 *                                             complete its workflow. A real failure.
 *   failed → never retried, agent proceeds  ⇒ CE-P1's domain (fault-passthrough), not
 *                                             this one. Disjoint by construction.
 *
 * The discriminator is purely mechanical — was it retried · did a retry succeed · did the
 * run continue past the exhausted retry — so it needs no judge and costs nothing.
 *
 * DISJOINT SCOPING (why CE-P2 is untouched): CE-P2 is the completeness arm and fires on
 * ANY error output by design, recovered or not — that is its documented cost, and it is a
 * CANDIDATE, never a verdict. CE-P6 does not suppress it; it CLASSIFIES it, so a reader
 * (and the judge) can tell an ignorable retry from a workflow that died. Changing CE-P2
 * would alter a calibrated existing check — out of scope, deliberately.
 */
export interface ToolFailureClassification {
  /** chronological index of the FIRST failing call of this tool. */
  firstFailureAt: number;
  tool: string;
  /** was the same tool called again after the failure? */
  retried: boolean;
  /** did any later call of the same tool return a non-failed output? */
  recovered: boolean;
  /** did the run continue past the last (failed) attempt of this tool? */
  continuedAfter: boolean;
}

/**
 * Classify every failing tool by what happened AFTER it, over a CHRONOLOGICAL step
 * sequence. One entry per distinct failing tool name (the first failure anchors it).
 * PURE + deterministic.
 */
export function classifyToolFailures(chronoSteps: CodeEvalStep[]): ToolFailureClassification[] {
  const out: ToolFailureClassification[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < chronoSteps.length; k++) {
    const s = chronoSteps[k]!;
    if (!outputFailed(s) || seen.has(s.name)) continue;
    seen.add(s.name);
    const later = chronoSteps.slice(k + 1);
    const laterSame = later.filter((x) => x.name === s.name);
    const lastAttempt = chronoSteps.reduce((acc, x, i) => (x.name === s.name ? i : acc), k);
    out.push({
      firstFailureAt: k,
      tool: s.name,
      retried: laterSame.length > 0,
      recovered: laterSame.some((x) => !outputFailed(x)),
      continuedAfter: lastAttempt < chronoSteps.length - 1,
    });
  }
  return out;
}

/**
 * CE-P6 irrecoverable-failure: a tool failed, was RETRIED, and never succeeded. Fires
 * only on that shape — a recovered failure is silent here by design, and an un-retried
 * one belongs to CE-P1.
 */
function ceP6(chronoSteps: CodeEvalStep[]): CodeEvalHit | null {
  for (const c of classifyToolFailures(chronoSteps)) {
    if (!c.retried || c.recovered) continue;
    return {
      pattern: "CE-P6 irrecoverable-failure",
      anchor: `trajectory.${c.firstFailureAt}`,
      detail:
        `${c.tool} failed and every retry ALSO failed — the failure was never recovered from` +
        (c.continuedAfter
          ? "; the run continued past the exhausted retry on a result it never obtained."
          : "; the run ended at the exhausted retry — the workflow did not reach its intended end."),
    };
  }
  return null;
}

/** The step order of the input array. CE-P1/CE-P5 are ORDER-BEARING; a
 *  MatrixPacket's `trajectory` preserves the trace's observations order, which
 *  is REVERSE-chronological in this intake (the judge brief says the same:
 *  "the observations array is reverse-chronological"). Default matches the
 *  packet so `bun … <packet.json>` is correct out of the box. */
export type StepOrder = "chronological" | "reverse-chronological";

/**
 * Run the whole library over a packet's trajectory steps. Returns every fired
 * hit (empty = no pattern fired — which is NOT a clean-bill verdict, only "no
 * code-detectable candidate"). Order-bearing checks (CE-P1/CE-P5) run over the
 * CHRONOLOGICAL sequence; anchors always cite the ORIGINAL input index (so a
 * `trajectory.N` anchor re-resolves against the packet as handed). PURE +
 * deterministic.
 */
export function runCodeEvalLibrary(
  steps: CodeEvalStep[],
  classify: (s: CodeEvalStep) => EffectClass = defaultEffectClassifier,
  order: StepOrder = "reverse-chronological",
): CodeEvalHit[] {
  // normalize to chronological, remembering each step's ORIGINAL packet index.
  const indexed = steps.map((s, k) => ({ s, k }));
  const chrono = order === "reverse-chronological" ? [...indexed].reverse() : indexed;
  const chronoSteps = chrono.map((e) => e.s);
  const seq = chrono.map((e, i) => ({ cls: classify(e.s), k: e.k, name: e.s.name, i }));
  // re-anchor a hit produced against chrono positions back to the packet index.
  const reanchor = (h: CodeEvalHit | null): CodeEvalHit | null => {
    if (h === null) return h;
    const m = /^trajectory\.(\d+)$/.exec(h.anchor);
    if (m === null) return h;
    const orig = chrono[Number.parseInt(m[1]!, 10)];
    return orig === undefined ? h : { ...h, anchor: `trajectory.${orig.k}` };
  };
  return [
    reanchor(ceP1(chronoSteps)),
    reanchor(ceP2(chronoSteps)),
    reanchor(ceP3(chronoSteps)),
    ceP4(seq), // seq entries already carry the original index k
    ceP5(seq),
    reanchor(ceP6(chronoSteps)), // G2 — order-bearing (what happened AFTER the failure)
  ].filter((h): h is CodeEvalHit => h !== null);
}

// ── CLI: bun scripts/code-eval-library.ts <packet.json> ──────────────────────
if (import.meta.main) {
  const packetPath = process.argv[2];
  if (packetPath === undefined) {
    console.error("usage: bun scripts/code-eval-library.ts <packet.json>");
    process.exit(2);
  }
  const packet = JSON.parse(readFileSync(packetPath, "utf8")) as { trajectory?: CodeEvalStep[] };
  const hits = runCodeEvalLibrary(packet.trajectory ?? []);
  console.info(JSON.stringify({ hits }, null, 2));
}
