/**
 * render-review-report-v3 — the W4 FROZEN-CONTRACT review-report renderer.
 *
 * The template (`assets/templates/review-report.template.html`) IS the operator-signed
 * mock (review-report-mock.html), derived mechanically by `scripts/release/
 * build-review-template.ts` with named data slots — the navigator matrix, the drill,
 * the right-rail verdict cards, the ruling controls, the keyboard bindings, the
 * >48-trace cluster idiom and the propagation trail are all the frozen contract
 * verbatim. This module ONLY computes the data: it maps real run artifacts
 * (MatrixCriterion[] + MatrixVerdictFile[] + the ingested traces) into the template's
 * data shape and fills the slots.
 *
 * WHAT THIS SURFACE IS. The third and last v3 report. Where `*evaluate` produces the
 * judge's verdicts and `*discover` produces the criteria, THIS surface is where a
 * human GRADES THE JUDGE: every judge verdict gets an Agree / Revise / Refute ruling
 * plus a why-note, and those rulings become the ground truth that `*validate` ingests
 * and the calibration loop consumes.
 *
 * HONESTY RULES (the same set the eval + discovery surfaces hold to):
 *  - nothing is invented — every number/quote comes from a run artifact;
 *  - absent data renders as a NAMED absence in words, never a blank and never a
 *    placeholder number. The propagation trail's validation delta is the sharp case:
 *    TPR/TNR/Rogan-Gladen CANNOT exist before `*validate` ingests these labels, so it
 *    renders as a named not-yet, not as the mock's invented ".92→.94";
 *  - caps are declared in-render, never silent.
 *
 * AUDIENCE — OPERATOR RULING 2026-07-26: THIS SURFACE HAS NO INTERNAL CONTENT.
 *
 * The eval report strips its ⑤ Self-Eval and the discovery report its ⑥ Methodology,
 * and both also strip clause 2 of the V11 contract (run id · pinned judge-model ·
 * gitignored artifact path). The review surface strips NEITHER:
 *   · clause 1 does not apply — the signed mock has no internal-only SECTION, and one
 *     was not invented so that a strip would have something to remove;
 *   · clause 2 does not apply either — the operator ruled this is "just a one-pager,
 *     no internal pieces" and that the run id, judge pin and artifact path "can be
 *     left". They are review provenance the reviewer needs, not client leakage.
 * The surface is intrinsically internal: grading the judge is the team's own job, so
 * there is no client audience to protect from it.
 *
 * `audience` therefore renders IDENTICALLY in both modes. The parameter is kept —
 * REQUIRED, not optional — for consistency with the other two renderers and for the
 * composer contract. It is deliberately NOT read here.
 *
 * THE TRIPWIRE. An inert audience switch is safe today and a trap tomorrow: if
 * internal content is ever added to this surface, nothing would strip it and no test
 * would notice. So the suite asserts the two renders are BYTE-IDENTICAL. The moment
 * anyone makes anything here audience-conditional, that test fails and forces the
 * question back to the operator instead of silently shipping a leak.
 *
 * If this surface ever does need a strip, use `scripts/audience.ts`
 * (`isExternal` · `cutBlock` · `stripInternalSurface`) rather than hand-rolling one —
 * it encodes cut-AFTER-slot-fill and the provably-unique-anchor rule. Note that
 * `stripInternalSurface` would currently THROW on this template (verified): it needs
 * both `FOOT_ANCHOR` and a `<s onclick="tab(N)">` entry, and this one-pager has
 * neither.
 *
 * The v1 `*review` UI (`build-review-ui.ts`) is UNTOUCHED and is written alongside as
 * `review-report.v2.html` by the run composer — the transition fallback, mirroring
 * run-evaluate's `writeRunReport` and the discovery composer.
 *
 * NOTE ON DUPLICATION. The criterion/trace mapping below is deliberately a sibling of
 * render-eval-report-v3's, not a shared import: those helpers are module-private
 * there, and this surface's trace shape genuinely diverges (it needs per-verdict card
 * KEYS for the ruling state, which the eval walk has no concept of). Extracting the
 * common core belongs with the already-planned `scripts/handoff-md.ts` extraction.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MatrixCriterion, MatrixVerdictFile, LayerVerdict } from "./contracts/eval-matrix.ts";
import { detectLayerConflicts, type LayerConflict } from "./matrix-judge.ts";
// the v1 `*review` annotation UI — imported to write the .v2.html transition
// fallback. That module is UNTOUCHED; this is a call, not a change.
import { renderReviewUi } from "./build-review-ui.ts";
import type { EvalTrace } from "./contracts/eval-types.ts";
import type { ReportSpec } from "./verify-render.ts";
import { renderRulingsBlock, type Ruling } from "./apply-rulings.ts";
import { DecisionKind, DecisionTargetKind } from "./decisions-store.ts";

const TEMPLATE_PATH = join(import.meta.dir, "../assets/templates/review-report.template.html");

/* ── the REVIEW surface's verification spec ────────────────────────────────────
 * Lives HERE, with the renderer, because it describes THIS surface's contract —
 * so the unit test, the run composer and any future sim check all assert the same
 * shape instead of each re-declaring it. The engine that consumes it
 * (`verify-render.ts`) is surface-agnostic and needs no change to host it.
 */
export const REVIEW_REPORT_SPEC: ReportSpec = {
  surface: "review-report-v3",
  dataGlobal: "window.ASTER",
  tabSelector: "#report > .tabs s", // no tab bar on this surface — matches nothing
  tabLabels: [],
  /**
   * DECLARED, not defaulted. Measured on the emitted template: 0 occurrences of
   * `onclick="tab(`. This surface is a single-page navigator + drill by design, so
   * the tab and panel checks have nothing to run against — and the engine requires
   * that to be STATED, because an empty list would otherwise skip the per-panel
   * named-absence check silently and the spec would pass vacuously.
   */
  tabless: true,
  panelless: true,
  internalOnlyTabs: [],
  internalOnlyPanels: [],
  panels: [],
  /**
   * EMPTY BY OPERATOR RULING (2026-07-26), not by oversight — see the AUDIENCE
   * section in this module's header. There is no internal-only material on this
   * surface, so there is nothing for an external render to strip. The real
   * guarantee is the byte-identity tripwire in the test suite.
   */
  internalMarkers: [],
  islands: [
    // server-rendered — the content is in the bytes
    { selector: '[data-component="mgt-report-hero"]', label: "report hero" },
    { selector: '[data-component="mgt-subject-profile"]', label: "subject card" },
    { selector: ".profgrid .pk", label: "subject-card fact labels", minCount: 3 },
    { selector: ".legend i", label: "navigator legend entries", minCount: 6 },
    // JS-filled hosts — must EXIST; their content is asserted via dataArrays
    { selector: '[data-component="mgt-trace-navigator"]', label: "trace-navigator host", jsFilled: true },
    { selector: '[data-component="mgt-propagation-trail"]', label: "propagation-trail host", jsFilled: true },
    { selector: '[data-component="mgt-trace-tooltip"]', label: "navigator tooltip host", jsFilled: true },
    { selector: "#tracehost", label: "trace-drill host", jsFilled: true },
  ],
  dataArrays: [
    { path: "criteria", label: "criteria (navigator rows + verdict-card definitions)" },
    { path: "traces", label: "traces (navigator columns + the drill)" },
  ],
  dataStrings: [
    { path: "handoffHead", label: "calibration handoff head" },
    { path: "calibrationMd", label: "calibration handoff CAL items" },
    { path: "feedbackTitle", label: "feedback title" },
  ],
};

/* ── small pure helpers ────────────────────────────────────────────────────── */
const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (id: string): string => (id.length > 10 ? id.slice(0, 8) : id);

/** read/act split for the subject card — the same SEED heuristic the eval report uses. */
function toolClass(name: string): "read" | "act" {
  return /send|dispatch|publish|reply|post|delete|update|write|create|escalat|blacklist|approve/i.test(name)
    ? "act"
    : "read";
}

interface ReviewCriterion {
  id: string;
  slug: string;
  layer: string;
  sev: string;
  statement: string;
  passDef: string;
  failDef: string;
}

interface ReviewStep {
  tool: string;
  args: string;
  output: string;
  layers: string[];
  verdicts: {
    crit: string;
    verdict: string;
    conf: number;
    critique: string;
    ref: { obs: string; path: string; value: string } | null;
  }[];
  divergence: boolean;
}

/** A calibration item in the diagnostics remedy-bundle shape. */
interface CalItem {
  id: string;
  title: string;
  trigger: string;
  changeType: string;
  describedChange: string;
  applyPlan: string[];
  verify: string[];
  acceptance: string;
}

export interface RenderReviewV3Input {
  subjectName: string;
  runId: string;
  audience: "internal" | "external";
  criteria: MatrixCriterion[];
  files: MatrixVerdictFile[];
  subjectProfile?: Record<string, unknown>;
  pin: { model: string; temperature: 0 };
  /** the run's INGESTED traces — supply the real tool observations so the drill's
   *  left lane shows genuine inputs/outputs; absent ⇒ the judge's step detail
   *  renders instead, as a NAMED degrade in-lane. */
  traces?: { id: string; observations?: { type?: string; name?: string; input?: unknown; output?: unknown }[] }[];
  /** ISO timestamp of the run — rendered top-right in the header. */
  generatedAt?: string;
  /** NAMED scope note when the review covers a declared subset (never a silent cap). */
  scopeNote?: string;
  /** the append-only feedback-store record this session will be written to. ABSENT ⇒
   *  the trail says so in words; it never invents a record id. */
  feedbackRecord?: { id: string; store?: string };
  /** a REAL prior validation delta, if `*validate` has already run against this suite.
   *  ABSENT ⇒ the trail names the absence — it is never a fabricated TPR/TNR. */
  validationDelta?: string;
  /** the living-suite version these criteria came from. */
  suiteVersion?: string;
  /** DEV ONLY: keep the feedback bar. Default OFF — produced reports carry none. */
  devFeedback?: boolean;
}

/** serialize a real observation value for the drill's left lane (bounded, declared). */
function laneText(v: unknown, cap = 420): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > cap ? `${s.slice(0, cap)} … [+${s.length - cap} chars]` : s;
}

/* ── data mapping ──────────────────────────────────────────────────────────── */
function mapCriteria(input: RenderReviewV3Input): { list: ReviewCriterion[]; byCid: Map<string, ReviewCriterion> } {
  const byCid = new Map<string, ReviewCriterion>();
  const list = input.criteria.map((c, i) => {
    const t: ReviewCriterion = {
      id: `C${i + 1}`,
      slug: c.criterionId,
      layer: (c as { layer?: string }).layer ?? "criteria",
      sev: String(c.severity),
      statement: c.statement,
      passDef: c.passCondition,
      failDef: (c as { failCondition?: string }).failCondition ?? "",
    };
    byCid.set(c.criterionId, t);
    return t;
  });
  return { list, byCid };
}

function cellOf(f: MatrixVerdictFile, cid: string): "pass" | "fail" | "uncertain" | "skip" {
  const dm = (f.denseMap ?? {}) as Record<string, string>;
  const v = dm[cid] ?? f.verdicts.find((x) => x.criterionId === cid)?.result;
  if (v === "pass" || v === "fail" || v === "uncertain") return v;
  return "skip";
}

function trajGate(f: MatrixVerdictFile, sevOf: Map<string, string>): "pass" | "fail" | "incomplete" {
  if (f.fidelity?.complete === false) return "incomplete";
  const gating = (cid: string): boolean => ["CRIT", "HIGH"].includes(sevOf.get(cid) ?? "");
  if (f.verdicts.some((v) => v.result === "fail" && gating(v.criterionId))) return "fail";
  if (f.verdicts.some((v) => v.result === "uncertain" && gating(v.criterionId))) return "incomplete";
  return f.verdicts.some((v) => v.result === "fail") ? "fail" : "pass";
}

function mapTrace(
  f: MatrixVerdictFile,
  byCid: Map<string, ReviewCriterion>,
  sevOf: Map<string, string>,
  conflicts: LayerConflict[],
  trace?: { observations?: { type?: string; name?: string; input?: unknown; output?: unknown }[] },
): Record<string, unknown> {
  const lvs = (f.layerVerdicts ?? []) as LayerVerdict[];
  const layer = (L: string): LayerVerdict | undefined => lvs.find((x) => x.layer === L);
  const layers: Record<string, string> = {};
  for (const L of ["L0", "L1", "L2", "L3", "L4"]) {
    const v = layer(L)?.verdict;
    layers[L] = v === "skipped" ? "skip" : (v ?? "skip");
  }
  const l1 = layer("L1");

  // REAL tool observations are ground truth; this intake stores them
  // reverse-chronologically, so reverse to reading order.
  const toolObs = (trace?.observations ?? []).filter((o) => o.type === "TOOL").reverse();
  const agentSteps = f.agentSteps ?? [];
  const nRaw = Math.max(toolObs.length, agentSteps.length);
  const steps: ReviewStep[] = [];
  for (let i = 0; i < nRaw; i++) {
    const o = toolObs[i];
    const s = agentSteps[i];
    steps.push(
      o !== undefined
        ? {
            tool: o.name ?? s?.tool ?? "(unnamed tool)",
            args: laneText(o.input, 160) + (s?.status !== undefined ? `  [${s.status}]` : ""),
            output: laneText(o.output),
            layers: [],
            verdicts: [],
            divergence: false,
          }
        : {
            tool: s?.tool ?? "(no tool call)",
            args: s?.status !== undefined ? `[${s.status}]` : "",
            output: s?.detail ?? "(no detail emitted)",
            layers: [],
            verdicts: [],
            divergence: false,
          },
    );
  }
  if (steps.length === 0)
    steps.push({
      tool: "(no tool calls in this session)",
      args: "",
      output: f.understanding?.rephrase ?? "(no session summary was emitted)",
      layers: [],
      verdicts: [],
      divergence: false,
    });

  // bind each criterion verdict to the step its FIRST trajectory.N ref cites;
  // unanchored verdicts bind to the terminal step (the decision surface).
  const nSteps = steps.length;
  for (const v of f.verdicts) {
    const tc = byCid.get(v.criterionId);
    let pos = nSteps - 1;
    for (const r of (v.refs ?? []) as { path?: string }[]) {
      const m = /^trajectory[.[](\d+)/.exec(r.path ?? "");
      if (m !== null) {
        const packetIdx = Number.parseInt(m[1]!, 10);
        pos = Math.min(Math.max(nSteps - 1 - packetIdx, 0), nSteps - 1);
        break;
      }
    }
    const ref0 = (v.refs ?? [])[0] as { obs?: string; path?: string; value?: string } | undefined;
    steps[pos]!.verdicts.push({
      crit: tc?.id ?? v.criterionId,
      verdict: v.result,
      conf: v.confidence ?? 0.5,
      critique: v.critique,
      ref: ref0 !== undefined ? { obs: short(ref0.obs ?? ""), path: ref0.path ?? "", value: ref0.value ?? "" } : null,
    });
    if (v.result === "fail") steps[pos]!.divergence = true;
  }

  const confs = f.verdicts.map((v) => v.confidence).filter((x): x is number => typeof x === "number");
  const conflict = conflicts.find((c) => c.trajectoryId === f.trajectoryId);
  const cells: Record<string, string> = {};
  for (const [cid, tc] of byCid) cells[tc.id] = cellOf(f, cid);
  const blocked = f.verdicts.find((v) => v.blockedBy !== undefined)?.blockedBy as { text?: string } | string | undefined;

  // the cards that ADJUDICATE a cross-layer conflict: the non-pass verdicts on this
  // trajectory carry the disputed judgment, so ruling on them settles the conflict.
  // Named from the real bound cards — never a hard-coded criterion pair.
  const conflictCards: string[] = [];
  let conflictKey: string | null = null;
  if (conflict !== undefined) {
    steps.forEach((s, six) => {
      s.verdicts.forEach((vd, vix) => {
        if (vd.verdict === "pass") return;
        if (!conflictCards.includes(vd.crit)) conflictCards.push(vd.crit);
        conflictKey ??= `${short(f.trajectoryId)}·s${six}·v${vix}`;
      });
    });
  }

  return {
    id: short(f.trajectoryId),
    fullId: f.trajectoryId,
    scenario: l1?.scenario !== undefined ? String((l1.scenario as { intent?: string }).intent ?? l1.scenario) : "—",
    gate: trajGate(f, sevOf),
    layers,
    conflict: conflict !== undefined,
    conflictNote:
      conflict !== undefined
        ? `${Object.entries(conflict.verdicts).map(([l, v]) => `${l} ${v}`).join(" ⚡ ")} — ${
            ((): string => {
              // the judge's own OT-1 statement (localize.conflict) is authoritative when
              // emitted; the aggregate's cross-check is the fallback. NEVER resolve.
              const l = (f as { localize?: unknown }).localize;
              const loc = l !== null && typeof l === "object" ? (l as { conflict?: string; root?: string; independentRoots?: string[] }) : undefined;
              const base = loc?.conflict ?? conflict.note ?? "cross-layer disagreement";
              const roots = (loc?.independentRoots?.length ?? 0) > 0 ? ` · independent root: ${loc!.independentRoots!.join(" · ")}` : "";
              return base + roots;
            })()
          }`
        : undefined,
    conflictCards,
    conflictKey,
    judgeConf: confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0.5,
    outcome: {
      verdict: l1?.verdict ?? "—",
      expected: Array.isArray(l1?.expectedExit) ? (l1!.expectedExit as string[]).join(" | ") : (l1?.expectedExit ?? "—"),
      actual: l1?.note ?? "—",
    },
    divergence: undefined,
    gapKind: layer("L4")?.gapKind,
    fidelity: f.fidelity?.complete === false ? (f.fidelity.reason ?? "trace incomplete") : undefined,
    blockedBy: typeof blocked === "string" ? blocked : blocked?.text,
    cells,
    steps,
  };
}

/* ── the CALIBRATION HANDOFF (diagnostics remedy-bundle shape) ──────────────── */
/**
 * Derive CAL-N items from REAL run artifacts. Every item names the artifact that
 * triggered it; nothing is proposed without a trigger, and no item invents the fix
 * WORDING — the described change states what must be decided and leaves the decision
 * to the operator, because the evaluator judges and never fixes (EV-051).
 */
function calibrationItems(
  input: RenderReviewV3Input,
  crits: ReviewCriterion[],
  byCid: Map<string, ReviewCriterion>,
  conflicts: LayerConflict[],
): CalItem[] {
  const items: CalItem[] = [];
  const rec = input.feedbackRecord?.id ?? "this review session";

  // (1) ABSTAINS — a criterion the evidence could not decide is a definition problem,
  //     not a subject problem. The open question is quoted verbatim from blockedBy.
  for (const c of crits) {
    const abstains: { traj: string; question: string }[] = [];
    for (const f of input.files) {
      for (const v of f.verdicts) {
        if (byCid.get(v.criterionId)?.id !== c.id || v.result !== "uncertain") continue;
        const b = v.blockedBy as { text?: string } | string | undefined;
        abstains.push({
          traj: short(f.trajectoryId),
          question: (typeof b === "string" ? b : b?.text) ?? "no open question was recorded with the abstain",
        });
      }
    }
    if (abstains.length === 0) continue;
    items.push({
      id: `CAL-${items.length + 1}`,
      title: `Revise criterion ${c.id} (${c.slug}) — ${abstains.length} abstain(s)`,
      trigger: `${abstains.length} undecided verdict(s) on ${c.id} ${c.slug} — ${abstains.map((a) => `${a.traj}: "${a.question}"`).join(" · ")}${input.feedbackRecord !== undefined ? ` + reviewer rulings in ${rec}` : ""}`,
      changeType: "criterion-revision (provenance-preserving, no silent delete)",
      describedChange: `The criterion's pass/fail definition does not resolve the open question above, so the judge correctly abstained rather than guessing. Settle that question in the definition — or split the ambiguous case into its own criterion. The exact wording is the operator's ruling: the evaluator judges and never fixes, so no replacement text is proposed here.`,
      applyPlan: [
        `[edit] living-suite entry ${c.slug}${input.suiteVersion !== undefined ? ` (suite ${input.suiteVersion})` : ""} — append a revision carrying provenance ${rec}`,
      ],
      verify: [
        "`*validate` rerun with the merged labels.json — TPR/TNR + Rogan-Gladen delta recorded",
        "`*evaluate` rerun (pinned, temp 0) — the abstaining trajectories come back decided",
      ],
      acceptance: `The ${abstains.length} case(s) above become decidable (no abstain) without flipping any currently-decided verdict.`,
    });
  }

  // (2) CROSS-LAYER CONFLICTS — code never resolves these; a human ruling does.
  //     ONE item covering all of them, not one per conflict: they share a single
  //     change type, apply plan and acceptance, so N near-identical proposals would
  //     be noise rather than signal (observed: six of them on a 12-trace corpus made
  //     the calibration queue unreadable). Every trajectory is still named.
  if (conflicts.length > 0) {
    const trajs = conflicts.map((c) => short(c.trajectoryId));
    items.push({
      id: `CAL-${items.length + 1}`,
      title: `Adjudicate ${conflicts.length} ⚡ layer conflict(s)`,
      trigger: conflicts
        .map(
          (cf) =>
            `${short(cf.trajectoryId)} — ${Object.entries(cf.verdicts).map(([l, v]) => `${l} ${v}`).join(" vs ")}${cf.note !== undefined ? ` (${cf.note})` : ""}`,
        )
        .join(" · "),
      changeType: "conflict-adjudication (human ruling; the gate never reads it)",
      describedChange:
        "On each trajectory above, two evidence layers reached opposite conclusions. Nothing auto-resolves it: the reviewer's Agree/Revise/Refute on that trajectory's verdict cards IS the adjudication, and it is recorded in the conflict ledger.",
      applyPlan: [`[record] conflict ledger entries for ${trajs.join(", ")} — each reviewer ruling attached, with provenance ${rec}`],
      verify: ["`*evaluate` rerun (pinned) — confirm each ledger entry clears or the conflict reproduces"],
      acceptance: `All ${conflicts.length} trajectory(ies) carry an explicit human ruling instead of an unresolved ⚡.`,
    });
  }

  // (3) LOW-CONFIDENCE DECIDED VERDICTS — decided, but weakly. A judge rubric/few-shot
  //     concern rather than a criterion-definition one.
  const LOW = 0.7;
  for (const c of crits) {
    const weak: string[] = [];
    for (const f of input.files) {
      for (const v of f.verdicts) {
        if (byCid.get(v.criterionId)?.id !== c.id) continue;
        if (v.result !== "pass" && v.result !== "fail") continue;
        if (typeof v.confidence === "number" && v.confidence < LOW) weak.push(`${short(f.trajectoryId)} (.${Math.round(v.confidence * 100)})`);
      }
    }
    if (weak.length === 0) continue;
    items.push({
      id: `CAL-${items.length + 1}`,
      title: `Strengthen the judge rubric for ${c.id} (${c.slug}) — ${weak.length} low-confidence verdict(s)`,
      trigger: `decided-but-weak verdicts below confidence .${Math.round(LOW * 100)} on ${c.id} ${c.slug} — ${weak.join(" · ")}`,
      changeType: "judge few-shot / rubric addition (TRAIN split only)",
      describedChange:
        "These verdicts were decided, so they do not move the gate — but the judge was near its decision boundary, which is where drift starts. Add the reviewer-confirmed cases as exemplars for this criterion's judge task. TRAIN split only, so the validation labels stay untouched.",
      applyPlan: [`[edit] ${c.slug} judge task few-shots — add the reviewer-AGREED cases above as exemplars`],
      verify: [
        "byte-identity check on unrelated criteria (pinned rerun) — no collateral movement",
        "`*validate` — this criterion's TPR does not regress on the validation labels",
      ],
      acceptance: `${c.id} decides these cases above .${Math.round(LOW * 100)} confidence with no regression elsewhere.`,
    });
  }

  return items;
}

/** Render the CAL items as the markdown remedy bundle (server-side, real data). */
function calibrationMd(items: CalItem[]): string {
  if (items.length === 0)
    return [
      "## Calibration items",
      "",
      "- **none derivable from this run** — no verdict abstained, no cross-layer conflict was detected, and no decided verdict fell below the low-confidence threshold. There is no trigger to propose a change from. The reviewer's rulings below are still recorded and still feed `*validate`.",
      "",
    ].join("\n");
  const out: string[] = [];
  for (const it of items) {
    out.push(`## ${it.id} — ${it.title}`);
    out.push(`**Trigger:** ${it.trigger}`);
    out.push(`**Change type:** ${it.changeType}`);
    out.push(`### Described change`);
    out.push(it.describedChange);
    out.push(`### Apply plan`);
    for (const p of it.applyPlan) out.push(`- ${p}`);
    out.push(`**Verify:**`);
    for (const v of it.verify) out.push(`- ${v}`);
    out.push(`**Acceptance:** ${it.acceptance}`);
    out.push("");
  }
  return out.join("\n");
}

/**
 * G4 — the RULINGS block for a review: one ruling per calibration item, so the reviewer's
 * decision lands in the durable store instead of evaporating with the page.
 *
 * Pre-filled to `accept` and stated as such in the block: a calibration item is only
 * raised when the run itself produced a trigger, so accepting is the common case and the
 * reviewer edits the exceptions. Pre-filling to reject would let an unedited paste
 * silently tombstone every item the run surfaced.
 */
function reviewRulingsMd(runId: string, items: CalItem[]): string {
  const rulings: Ruling[] = items.map((it) => ({
    target: it.id,
    kind: DecisionKind.Accept,
    targetKind: DecisionTargetKind.Verdict,
    statement: `${it.title} — ${it.describedChange}`,
  }));
  return renderRulingsBlock({ runId, surface: "review", rulings });
}

/* ── HTML islands (server-rendered slots) ──────────────────────────────────── */
function subjectCard(input: RenderReviewV3Input, traces: Record<string, unknown>[], crits: ReviewCriterion[]): string {
  const prof = (input.subjectProfile ?? {}) as Record<string, unknown>;
  const tools = ((prof["tools"] ?? []) as { name?: string }[]).map((t) => String(t.name ?? t));
  const reads = tools.filter((t) => toolClass(t) === "read");
  const acts = tools.filter((t) => toolClass(t) === "act");
  const chips = [String(prof["skill"] ?? "agent"), String(prof["harness"] ?? "harness unknown"), String(prof["version"] ?? "version unknown")];
  const identity = String(prof["identity"] ?? input.subjectName);
  const purpose = String(prof["purpose"] ?? "purpose not supplied by the subject profile (NAMED absence)");
  const scenarios = [...new Set(traces.map((t) => String(t["scenario"])))];

  const toolsCell =
    tools.length === 0
      ? `<div class="pv">no tool inventory in the subject profile — the drill still shows every tool call the traces actually recorded (NAMED absence, not an empty toolset)</div>`
      : `<div class="pv">
      <span style="color:var(--cyan);font-size:12.5px">reads data:</span><br>
      ${reads.length > 0 ? reads.map((t) => `<span class="toolb read">${esc(t)}</span>`).join("") : '<span class="toolb read">(none classified)</span>'}<br>
      <span style="color:var(--warn);font-size:12.5px">acts on the world:</span><br>
      ${acts.length > 0 ? acts.map((t) => `<span class="toolb act">${esc(t)}</span>`).join("") : '<span class="toolb act">(none classified)</span>'}</div>`;

  // AUDIENCE: the determinism CLAIM survives externally; the model identifier does not.
  const judgeLine = `judge: ${esc(input.pin.model)} · temp ${input.pin.temperature}`;
  const suite = input.suiteVersion !== undefined ? `living-suite ${esc(input.suiteVersion)}` : "living-suite (version not recorded)";

  return `<div class="profgrid" data-component="mgt-subject-profile">
    <div><div class="pk">the subject being reviewed</div><div class="pv"><b>${esc(input.subjectName)}</b> — ${esc(identity)}: ${esc(purpose)}
      <br>${chips.map((c, i) => `<span class="idc ${["k", "m", "f"][i % 3]}">${esc(c)}</span>`).join("")}</div></div>
    <div><div class="pk">its ${tools.length} tools — reading vs acting</div>${toolsCell}</div>
    <div><div class="pk">what this run judged</div><div class="pv"><b id="profcorpus">${traces.length} traces</b>${input.generatedAt !== undefined ? ` · ${esc(input.generatedAt.slice(0, 10))}` : ""} · unitf-jsonl export
      <br>${scenarios.length > 0 ? esc(scenarios.join(" · ")) : "scenario kinds not recorded on these trajectories"}
      <br><span style="font-size:12.5px;color:var(--dim)">suite: ${suite} (${crits.length} criteria) · ${judgeLine} · your rulings recalibrate THIS judge</span></div></div>
  </div>`;
}

function heroMeta(input: RenderReviewV3Input, traces: Record<string, unknown>[], verdictTotal: number): string {
  const runChip = `<span class="chip" style="color:var(--primarySoft);border-color:rgba(126,71,215,.6)">run ${esc(input.runId)}</span>`;
  const scope = input.scopeNote !== undefined ? `<span class="chip" style="color:var(--warn);border-color:var(--warn)">scope: ${esc(input.scopeNote)}</span>` : "";
  return `${runChip}<span class="chip" id="herocount">${traces.length} sessions · ${verdictTotal} judge verdicts to review</span>
    <span class="chip">keys: 1 pass · 2 fail · D defer · ←/→ switch trace</span>${scope}`;
}

/* ── the renderer ──────────────────────────────────────────────────────────── */
export function renderReviewReportV3(input: RenderReviewV3Input): string {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const sevOf = new Map(input.criteria.map((c) => [c.criterionId, String(c.severity)]));
  const { list: crits, byCid } = mapCriteria(input);
  const conflicts = detectLayerConflicts(input.files);
  const traceById = new Map((input.traces ?? []).map((t) => [t.id, t]));
  const traces = input.files.map((f) => mapTrace(f, byCid, sevOf, conflicts, traceById.get(f.trajectoryId)));

  const verdictTotal = traces.reduce(
    (a, t) => a + (t["steps"] as ReviewStep[]).reduce((b, s) => b + s.verdicts.length, 0),
    0,
  );
  const scenarios = [...new Set(traces.map((t) => String(t["scenario"])))];
  const openTrace = (traces.find((t) => t["gate"] === "fail") ?? traces[0])?.["id"] ?? null;

  const calItems = calibrationItems(input, crits, byCid, conflicts);

  const head: string[] = [];
  head.push(`# Calibration Handoff — ${input.subjectName} · ${input.runId}`);
  head.push(`**From:** human review session · **To:** evaluator calibration agent`);
  head.push(
    `**Corpus:** ${traces.length} trajectory(ies) · ${crits.length} criteria · ${verdictTotal} judge verdicts offered for review`,
  );
  if (input.feedbackRecord !== undefined) head.push(`**Record:** ${input.feedbackRecord.id} (append-only feedback store)`);
  else head.push(`**Record:** no append-only feedback store is configured for this run — this session is browser-held until one is`);
  if (input.scopeNote !== undefined) head.push(`**Scope:** ${input.scopeNote}`);

  const data = {
    criteria: crits,
    traces,
    scenarios,
    openTrace,
    handoffHead: head.join("\n"),
    calibrationMd: calibrationMd(calItems),
    // G4 — the copy-paste rulings block, emitted UNCONDITIONALLY.
    //
    // NOT audience-gated, unlike the discover surface. The review report carries a
    // standing operator ruling that audience is a NO-OP here — internal and external
    // renders must be BYTE-IDENTICAL, pinned by a tripwire test. The review report IS the
    // operator's own surface; there is no client variant of it to protect. Gating this
    // broke that tripwire, which is precisely what the tripwire is for.
    rulingsMd: reviewRulingsMd(input.runId, calItems),
    calItems: calItems.map((c) => ({ id: c.id, title: c.title })),
    conflicts: traces
      .filter((t) => t["conflict"] === true)
      .map((t) => ({
        trace: String(t["id"]),
        key: t["conflictKey"] ?? "",
        crit: (t["conflictCards"] as string[]).join(" + ") || "(no bound verdict card)",
        note: String(t["conflictNote"] ?? "cross-layer disagreement"),
      })),
    // AUDIENCE: the store PATH is a gitignored artifact path — internal only. The
    // record ID itself is the provenance the reviewer needs and survives.
    feedbackRecord: input.feedbackRecord ?? null,
    validationDelta: input.validationDelta ?? null,
    feedbackTitle: `Review report · ${input.runId}`,
    artifactPath: `.mutagent/evaluator/reports/${input.runId}/review-report.html`,
  };

  const slots: Record<string, string> = {
    "@@TITLE@@": `Review &amp; Calibration — ${esc(input.subjectName)} · ${esc(input.runId)}`,
    "@@HEADER_RIGHT@@": `<span style="margin-left:12px;font-family:var(--mono);font-size:11.5px;color:var(--muted)">run ${esc(input.runId)}${input.generatedAt !== undefined ? ` · ${esc(input.generatedAt.slice(0, 10))}` : ""}</span>`,
    "@@HERO_TITLE@@": `Review &amp; Calibration — ${esc(input.subjectName)}`,
    "@@HERO_LEDE@@": `<b>You grade the judge.</b> ${traces.length} session(s) below were already scored automatically against ${crits.length} binary criteria. Your job: open a trace, read what the agent did, and for each of the ${verdictTotal} judge verdicts rule <b>Agree</b>, <b>Revise</b>, or <b>Refute</b>. Your rulings become the ground truth that recalibrates the judges — accuracy statistics, criterion revisions, conflict adjudications. Nothing changes until you submit.`,
    "@@HERO_META@@": heroMeta(input, traces, verdictTotal),
    "@@SUBJECT_CARD@@": subjectCard(input, traces, crits),
    "@@FOOT@@": `🧬 MutagenT · evaluator review UI · run ${esc(input.runId)} · artifact → .mutagent/evaluator/reports/${esc(input.runId)} (gitignored) · labels.json is a monotonic superset → *validate`,
    "@@FEEDBACK_LABEL@@": `Feedback — review report · ${esc(input.runId)} · Copy MD bundles your label state + notes`,
    "@@DATA_JSON@@": JSON.stringify(data).replace(/</g, "\\u003c"),
  };

  let html = template;
  for (const [k, v] of Object.entries(slots)) {
    if (!html.includes(k)) throw new Error(`TEMPLATE SLOT MISSING: ${k}`);
    // a FUNCTION replacement, never the string form: `$&` / `$'` / `` $` `` / `$$` /
    // `$1` inside real subject text (a quoted reply, a criterion statement, a judge
    // critique, the markdown handoff) are substitution patterns to String.replace and
    // would silently corrupt the emitted page — `$&` even re-emits the slot marker.
    html = html.replace(k, () => v);
  }
  // The feedback bar is a DEV-LOOP affordance only (report rule §2): user-produced
  // reports never carry it, regardless of audience.
  if (input.devFeedback !== true) {
    const start = html.indexOf('<div id="fbpanel"');
    const endAnchor = "</div></div>";
    const end = start >= 0 ? html.indexOf(endAnchor, start) : -1;
    if (start < 0 || end < 0) throw new Error("feedback-panel strip anchor missing");
    html = html.slice(0, start) + html.slice(end + endAnchor.length);
  }
  // ── V11 AUDIENCE ──
  // Clause 1 of the contract (strip the internal methodology SURFACE) has no
  // counterpart here: the signed review mock carries no ⑤/⑥-style internal section,
  // and one is not invented so that a strip has something to remove. Clause 2 —
  // run-internal operational detail — is handled at the point of emission above
  // (run-id chips, the pinned judge-model string, the gitignored artifact paths),
  // which is why there is no post-fill cut on this surface.
  const leftover = /@@[A-Z_]+@@/.exec(html);
  if (leftover !== null) throw new Error(`UNFILLED SLOT: ${leftover[0]}`);
  return html;
}

/** Write the v3 frozen-contract review report for a run. Returns the artifact path. */
export function writeReviewReportV3(input: RenderReviewV3Input, repoRoot: string): string {
  const out = join(repoRoot, ".mutagent/evaluator/reports", input.runId, "review-report.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReviewReportV3(input));
  return out;
}

/**
 * The W4 review RUN composer — the analogue of run-evaluate's `writeRunReport` and
 * the discovery composer. Writes BOTH:
 *   - `review-report.html`     → the PRODUCTION frozen-contract v3 render
 *   - `review-report.v2.html`  → the previous `*review` annotation UI
 *     (`renderReviewUi`, EV-045), kept as the transition fallback so nothing the
 *     operator relied on disappears in one step. That module is UNTOUCHED — it is
 *     imported and called, never modified.
 * Returns the production path and the fallback path (`null` when no fallback was
 * written — a NAMED absence, not a silently missing file).
 *
 * The v2 UI consumes `EvalTrace[]`, which the v3 surface does not otherwise need.
 * Supply `evalTraces` to get the fallback; omit it and only the production report
 * is written, with `fallback: null` saying so.
 */
export function writeReviewRunReportV3(
  input: RenderReviewV3Input,
  repoRoot: string,
  evalTraces?: EvalTrace[],
): { report: string; fallback: string | null } {
  const dir = join(repoRoot, ".mutagent/evaluator/reports", input.runId);
  mkdirSync(dir, { recursive: true });
  const report = join(dir, "review-report.html");
  writeFileSync(report, renderReviewReportV3(input));
  if (evalTraces === undefined || evalTraces.length === 0) return { report, fallback: null };
  const fallback = join(dir, "review-report.v2.html");
  writeFileSync(fallback, renderReviewUi(evalTraces, { title: `Review — ${input.subjectName}` }));
  return { report, fallback: existsSync(fallback) ? fallback : null };
}
