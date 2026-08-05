/**
 * render-eval-report-v3 — the W3 FROZEN-CONTRACT eval-report renderer.
 *
 * The template (`assets/templates/eval-report.template.html`) IS the operator-signed
 * mock (eval-report-mock.html), derived mechanically with named data slots — structure,
 * styles, tabs, the two-lane walk, layer/criteria matrices, findings/self-eval cards and
 * the markdown handoff are all the frozen contract verbatim. This module ONLY computes
 * the data: it maps real run artifacts (EvaluateRunInput + MatrixAggregateResult +
 * MatrixVerdictFile[]) into the template's data shape and fills the slots.
 *
 * HONESTY RULES (V13 data-completeness):
 *  - nothing is invented — every number/quote comes from a run artifact;
 *  - absent data renders as a NAMED absence (e.g. "layer not engaged"), never blank;
 *  - `na` cells keep their rationale (naRationale) as cell titles;
 *  - caps are declared in-render (e.g. "showing first N"), never silent.
 *
 * The v2 renderer (render-eval-report.ts) is untouched; v1 `*audit` world untouched.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MatrixCriterion, MatrixVerdictFile, LayerVerdict } from "./contracts/eval-matrix.ts";
import { localizeText } from "./contracts/eval-matrix.ts";
// V11 audience contract — the ONE implementation, shared with the discovery renderer
// (and inherited by the review surface). See scripts/audience.ts for the full rule.
import { isExternal, stripInternalSurface } from "./audience.ts";
import {
  detectLayerConflicts,
  foldEmissionsScorecard,
  foldLayerVerdicts,
  layersEngagedCount,
  upstreamMostFailingLayer,
  type LayerConflict,
} from "./matrix-judge.ts";

const TEMPLATE_PATH = join(import.meta.dir, "../assets/templates/eval-report.template.html");

/* ── small pure helpers ────────────────────────────────────────────────────── */
const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (k: number, n: number): string => (n === 0 ? "—" : `${Math.round((100 * k) / n)}%`);
const short = (id: string): string => (id.length > 10 ? id.slice(0, 8) : id);

/** read/act split for the profile card — same SEED heuristic as the L0 library. */
function toolClass(name: string): "read" | "act" {
  return /send|dispatch|publish|reply|post|delete|update|write|create|escalat|blacklist|approve/i.test(name)
    ? "act"
    : "read";
}

interface TemplateCriterion {
  id: string;
  slug: string;
  layer: string;
  cls: string;
  sev: string;
  grounding: string;
  k: number;
  n: number;
  statement: string;
  passDef: string;
  failDef: string;
  policy: string;
}

interface RenderV3Input {
  subjectName: string;
  runId: string;
  audience: "internal" | "external";
  criteria: MatrixCriterion[];
  files: MatrixVerdictFile[];
  subjectProfile?: Record<string, unknown>;
  pin: { model: string; temperature: 0 };
  gate: {
    passed: boolean;
    runVerdict: string;
    /** every non-pass FOLD (fails AND uncertains) — display-only, NOT the gate driver. */
    failedCriteria: { criterionId: string; severity?: string }[];
    /** the DECIDED fails that fire the gate. */
    gatedBy?: { criterionId: string; severity?: string }[];
    /** CRIT/HIGH uncertains that roll the run INCOMPLETE-wards. */
    indeterminateBy?: { criterionId: string; severity?: string }[];
  };
  groundedPct?: number;
  independentVerify: { criterionId: string; upheld: boolean; reason: string }[];
  /** optional MR-2 note (e.g. the run's determinism evidence) — absent renders as NAMED not-run. */
  determinismNote?: string;
  /**
   * G6 — did the byte-identity proof PASS? Load-bearing: without it MR-2 renders "note
   * present ⇒ PASS", so a proof that RAN AND FAILED would have rendered green — a worse
   * outcome than never running it. Absent ⇒ the card keeps its honest NOT RUN.
   */
  determinismOk?: boolean;
  /** NAMED scope note when the run judged a declared subset (never a silent cap). */
  scopeNote?: string;
  /** the run's INGESTED traces — the walk's left lane binds REAL tool inputs/outputs
   *  from these (so evidence refs highlight inside genuine observed strings); absent
   *  ⇒ the judge's step details render instead (a NAMED degrade in-lane). */
  traces?: { id: string; observations?: { type?: string; name?: string; input?: unknown; output?: unknown }[] }[];
  /** ISO timestamp of the run — rendered top-right in the header. */
  generatedAt?: string;
  /** DEV ONLY: keep the feedback bar (the operator's dev-loop feedback surface).
   *  Default OFF — user-produced reports carry no feedback affordance. */
  devFeedback?: boolean;
  /**
   * G1 — the EV-051 diagnose handover for this run (`run-evaluate`'s `handover`).
   *
   * The v2 renderer bound this; the v3 rebuild to the frozen contract dropped it, so the
   * findings handoff lost its CONTEXT half — a receiver got a list of failures with no
   * subject, no trace package and no acceptance. ABSENT ⇒ the handoff markdown renders
   * EXACTLY as it did pre-G1 (the degrade is byte-identical, never a broken section).
   */
  handover?: {
    subject: { kind: string; name: string; path: string };
    inputs: { id: string; kind: string; path?: string; uri?: string }[];
    acceptance: { goal: string; criteria: string[] };
  };
  /** G1 — where `handover.json` was written, so the receiver can be pointed at the file. */
  handoverPath?: string;
}

/** serialize a real observation value for the walk's left lane (bounded). */
function laneText(v: unknown, cap = 420): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > cap ? `${s.slice(0, cap)} … [+${s.length - cap} chars]` : s;
}

/* ── data mapping: real artifacts → the template's ASTER shape ─────────────── */
function mapCriteria(input: RenderV3Input): { list: TemplateCriterion[]; byCid: Map<string, TemplateCriterion> } {
  const byCid = new Map<string, TemplateCriterion>();
  const list = input.criteria.map((c, i) => {
    const cells = input.files.map((f) => cellOf(f, c.criterionId));
    const applicable = cells.filter((x) => x !== "skip");
    const k = applicable.filter((x) => x === "fail").length;
    const t: TemplateCriterion = {
      id: `C${i + 1}`,
      slug: c.criterionId,
      layer: (c as { layer?: string }).layer ?? "criteria",
      cls: c.checkMethod === "deterministic" ? "code" : c.checkMethod === "hybrid" ? "hybrid" : "judge",
      sev: String(c.severity),
      grounding: "observed",
      k,
      n: applicable.length,
      statement: c.statement,
      passDef: c.passCondition,
      failDef: (c as { failCondition?: string }).failCondition ?? "",
      policy: `${c.statement} Pass condition: ${c.passCondition}`,
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
  return "skip"; // na / absent → visually skip; rationale carried via title (naRationale)
}

function trajGate(f: MatrixVerdictFile, sevOf: Map<string, string>): "pass" | "fail" | "incomplete" {
  if (f.fidelity?.complete === false) return "incomplete";
  const gating = (r: string, cid: string): boolean => ["CRIT", "HIGH"].includes(sevOf.get(cid) ?? "");
  if (f.verdicts.some((v) => v.result === "fail" && gating(v.result, v.criterionId))) return "fail";
  if (f.verdicts.some((v) => v.result === "uncertain" && gating(v.result, v.criterionId))) return "incomplete";
  return f.verdicts.some((v) => v.result === "fail") ? "fail" : "pass";
}

function mapTrace(
  f: MatrixVerdictFile,
  byCid: Map<string, TemplateCriterion>,
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
  // REAL tool observations (trace ground truth) — chronological. The trace's
  // observations array is reverse-chronological in this intake; reverse it.
  const toolObs = (trace?.observations ?? []).filter((o) => o.type === "TOOL").reverse();
  const agentSteps = f.agentSteps ?? [];
  const nRaw = Math.max(toolObs.length, agentSteps.length);
  const steps: { tool: string; args: string; output: string; layers: string[]; verdicts: unknown[]; divergence: boolean }[] = [];
  for (let i = 0; i < nRaw; i++) {
    const o = toolObs[i];
    const s = agentSteps[i];
    steps.push(
      o !== undefined
        ? {
            // ground truth from the trace; the judge's status/detail annotates.
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
    steps.push({ tool: "(no tool calls in this session)", args: "", output: f.understanding?.rephrase ?? "—", layers: [], verdicts: [], divergence: false });

  // bind each criterion verdict to the step its FIRST trajectory.N ref cites
  // (packet index → chronological position); unanchored verdicts bind to the
  // terminal step (the decision surface).
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
  const naR = ((f as { naRationale?: Record<string, string> }).naRationale ?? {}) as Record<string, string>;
  for (const [cid, tc] of byCid) cells[tc.id] = cellOf(f, cid);
  const blocked = f.verdicts.find((v) => v.blockedBy !== undefined)?.blockedBy as { text?: string } | string | undefined;

  return {
    id: short(f.trajectoryId),
    fullId: f.trajectoryId,
    scenario: l1?.scenario !== undefined ? String((l1.scenario as { intent?: string }).intent ?? l1.scenario) : "—",
    gate: trajGate(f, sevOf),
    earlyExit: f.earlyExit ?? (f.fidelity?.complete === false ? "fidelity" : null),
    layers,
    conflict: conflict !== undefined,
    conflictNote: conflict !== undefined ? `${Object.entries(conflict.verdicts).map(([l, v]) => `${l} ${v}`).join(" ⚡ ")} — ${conflict.note ?? "cross-layer disagreement"}` : undefined,
    judgeConf: confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0.5,
    outcome: {
      verdict: l1?.verdict ?? "—",
      expected: Array.isArray(l1?.expectedExit) ? (l1!.expectedExit as string[]).join(" | ") : (l1?.expectedExit ?? "—"),
      actual: l1?.note ?? "—",
    },
    understanding: f.understanding?.rephrase,
    expectedLine: (f.expectedTrajectory ?? []).slice(0, 4).map((e) => (e as { expected: string }).expected).join(" → ") || undefined,
    divergence: f.localize !== undefined ? localizeText(f.localize as never) : undefined,
    gapKind: layer("L4")?.gapKind,
    codeEvalHits: (f.codeEvalHits ?? []).map((h) => `${h.pattern} @ ${h.anchor}`),
    fidelity: f.fidelity?.complete === false ? (f.fidelity.reason ?? "trace incomplete") : undefined,
    blockedBy: typeof blocked === "string" ? blocked : blocked?.text,
    cells,
    naRationale: naR,
    steps,
  };
}

/* ── HTML islands (server-rendered slots) ──────────────────────────────────── */
function metricsTiles(input: RenderV3Input, traces: Record<string, unknown>[], crits: TemplateCriterion[]): string {
  const gateCls = input.gate.passed ? "ok" : input.gate.runVerdict === "incomplete" ? "mid" : "bad";
  const gateTxt = input.gate.passed ? "PASS" : input.gate.runVerdict.toUpperCase();
  const gatedBy = input.gate.gatedBy ?? input.gate.failedCriteria;
  const indet = input.gate.indeterminateBy ?? [];
  const failed =
    (gatedBy.map((f) => f.criterionId).join(" + ") || "none") +
    (indet.length > 0 ? ` (+${indet.length} CRIT/HIGH uncertain)` : "");
  const critPass = crits.filter((c) => c.k === 0 && c.n > 0).length;
  const tPass = traces.filter((t) => t["gate"] === "pass").length;
  const tInc = traces.filter((t) => t["gate"] === "incomplete").length;
  const tFail = traces.filter((t) => t["gate"] === "fail").length;
  const grounded = input.groundedPct !== undefined ? `${Math.round(input.groundedPct)}%` : "—";
  return [
    `<div class="scm ${gateCls}"><div class="scm-v">${gateTxt}</div><div class="scm-l">release gate</div><div class="scm-n">${esc(failed)} ${input.gate.passed ? "" : "failed"}</div></div>`,
    `<div class="scm ${critPass === crits.length ? "ok" : "bad"}"><div class="scm-v">${pct(critPass, crits.length)}</div><div class="scm-l">criteria pass-rate</div><div class="scm-n">${critPass} of ${crits.length} criteria pass across the corpus</div></div>`,
    `<div class="scm ${tFail === 0 ? "ok" : "mid"}"><div class="scm-v">${pct(tPass, traces.length)}</div><div class="scm-l">trajectory pass-rate</div><div class="scm-n">${tPass} of ${traces.length} trajectories pass</div></div>`,
    `<div class="scm ${tInc === 0 ? "ok" : "mid"}"><div class="scm-v">${tInc}</div><div class="scm-l">incomplete / needs evidence</div><div class="scm-n">${tInc === 0 ? "every trajectory fully judged" : `${tInc} trajectory(ies) abstained or truncated`}</div></div>`,
    `<div class="scm ${input.groundedPct === 100 ? "ok" : "mid"}"><div class="scm-v">${grounded}</div><div class="scm-l">grounded</div><div class="scm-n">decided verdicts citing re-resolvable evidence</div></div>`,
  ].join("\n        ");
}

function identityStrip(input: RenderV3Input, traces: Record<string, unknown>[]): string {
  const gate = input.gate.passed
    ? '<span class="verd pass" style="margin-left:auto">GATE ✓ PASS</span>'
    : input.gate.runVerdict === "incomplete"
      ? '<span class="verd inc" style="margin-left:auto">GATE ◐ INCOMPLETE</span>'
      : '<span class="verd fail" style="margin-left:auto">GATE ✗ FAIL</span>';
  const scen = new Set(traces.map((t) => String(t["scenario"]))).size;
  const pchip = 'class="chip" style="color:var(--primarySoft);border-color:rgba(126,71,215,.6)"';
  // external: no run id, no pinned judge-model string (run-internal operational detail).
  const runChip = isExternal(input) ? "" : `<span ${pchip}>run ${esc(input.runId)}</span>`;
  const judgeChip = isExternal(input)
    ? `<span ${pchip}>judge: pinned · temp 0</span>` // the DETERMINISM claim survives; the model id does not
    : `<span ${pchip}>judge: ${esc(input.pin.model)} · temp 0</span>`;
  return `<b style="font-size:15px">${esc(input.subjectName)}</b>
    ${runChip}<span ${pchip}>${traces.length} trajectories · ${scen} scenario kinds</span>
    ${judgeChip}
    ${gate}`;
}

function criterionDetails(input: RenderV3Input, crits: TemplateCriterion[], files: MatrixVerdictFile[], byCid: Map<string, TemplateCriterion>): string {
  // gate-RELEVANT criteria get a detail card: decided fails AND CRIT/HIGH
  // uncertains (which roll the run INCOMPLETE-wards). The lede says exactly
  // why these and not the others — passes live in the matrix above.
  const hasHighUncertain = (c: TemplateCriterion): boolean =>
    ["CRIT", "HIGH"].includes(c.sev) &&
    files.some((f) => f.verdicts.some((v) => byCid.get(v.criterionId)?.id === c.id && v.result === "uncertain"));
  const relevant = crits.filter((c) => c.k > 0 || hasHighUncertain(c));
  const head = `<div class="h4s">Criterion detail — the gate-relevant checks</div>
      <p style="font-size:13.5px;color:var(--muted);margin:2px 0 8px;max-width:86ch">Only criteria that MOVED the gate get a detail card here: a <b style="color:var(--fail)">decided fail</b> fires the gate directly; a <b style="color:var(--warn)">CRIT/HIGH uncertain</b> (evidence could not decide) rolls the run INCOMPLETE-wards. Criteria that passed everywhere are already summarized — with scores — in the matrix above.</p>`;
  if (relevant.length === 0)
    return `${head}
      <div class="subc"><div class="nest" style="margin:10px">No criterion moved the gate on this corpus — nothing to detail.</div></div>`;
  const cidOf = (tid: string): string => short(tid);
  return (
    head +
    relevant
      .map((c) => {
      const evid: string[] = [];
      const verd: string[] = [];
      let passCount = 0;
      for (const f of files) {
        for (const v of f.verdicts) {
          if (byCid.get(v.criterionId)?.id !== c.id) continue;
          if (v.result === "pass") { passCount++; continue; }
          const conf = v.confidence !== undefined ? ` (.${Math.round(v.confidence * 100)})` : "";
          verd.push(`${v.result} ${cidOf(f.trajectoryId)}${conf}`);
          const r = (v.refs ?? [])[0] as { obs?: string; path?: string; value?: string } | undefined;
          if (r?.value !== undefined && evid.length < 3)
            evid.push(`${cidOf(f.trajectoryId)} ${esc(r.path)} = "${esc(String(r.value).slice(0, 60))}"`);
        }
      }
      const kindChip =
        c.k > 0
          ? `<span class="chip" style="color:var(--fail);border-color:var(--fail)">decided fail ×${c.k} — fires the gate</span>`
          : `<span class="chip" style="color:var(--warn);border-color:var(--warn)">CRIT/HIGH uncertain — rolls INCOMPLETE-wards</span>`;
      return `<div class="subc" style="margin-top:12px"><div class="subc-h"><span class="sev ${esc(c.sev)}">${esc(c.sev)}</span><b>${esc(c.id)} · ${esc(c.slug)}</b>
        ${kindChip}<span class="chip">${esc(c.cls)}</span>
        <span class="chip" style="margin-left:auto">score: ${c.n - c.k}/${c.n} applicable pass</span></div>
        <div class="nest"><div class="nest-h">▾ what it checks</div>${esc(c.statement)} Passes when: ${esc(c.passDef)}.</div>
        <div class="nest"><div class="nest-h">▾ grounding — the evidence behind the verdicts</div>${evid.length > 0 ? `<span class="ok">✓</span> ${evid.join(" · ")} — re-resolved by exact match` : "abstains carry blockedBy instead of refs (na for grounding — the missing premise is typed, not invented)"}</div>
        <div class="nest"><div class="nest-h">▾ verdicts across the corpus</div>${esc(verd.join(" · "))}${passCount > 0 ? ` · pass ×${passCount}` : ""}</div>
      </div>`;
      })
      .join("\n      ")
  );
}

/**
 * G2 — the plain-language reading of each precedence verdict, so the row states WHY that
 * layer explains the run rather than just naming it. Sourced from references/eval-layers.md.
 */
const UPSTREAM_READING: Record<string, string> = {
  L4: "a context gap is presumed fatal: without the information it needed, the agent could only have guessed right, so a passing outcome here is an unexplained success.",
  L3: "an irrecoverable tool failure poisons everything that consumed it; a downstream pass is suspect, not reassuring.",
  L2: "a mandatory step is missing — note that a merely DIFFERENT path is not a finding, only an absent required step is.",
  L1: "the outcome is wrong while the deeper layers looked fine — the failure is in the ending itself, or a deeper layer was under-examined.",
};

function conflictsHtml(conflicts: LayerConflict[], files: MatrixVerdictFile[]): string {
  const head = `<div class="h4s">Cross-layer conflicts — for your calibration ruling</div>`;
  if (conflicts.length === 0)
    return `${head}
      <div class="subc"><div class="nest" style="margin:10px">No cross-layer disagreement detected on this corpus (OT-1 detector ran on every walk). When one appears it renders here UNRESOLVED for a human ruling — the gate never reads it.</div></div>`;
  const localizeOf = (trajectoryId: string): { root?: string; conflict?: string; independentRoots?: string[] } | undefined => {
    const f = files.find((x) => x.trajectoryId === trajectoryId);
    const l = (f as { localize?: unknown } | undefined)?.localize;
    return l !== null && typeof l === "object" ? (l as { root?: string; conflict?: string; independentRoots?: string[] }) : undefined;
  };
  return (
    head +
    conflicts
      .map((c) => {
        const loc = localizeOf(c.trajectoryId);
        // the judge's own OT-1 statement is authoritative when it emitted one; the
        // aggregate's cross-check (layer notes) is the fallback. NEVER resolve — both
        // sides render, for a human.
        const statement = loc?.conflict ?? c.note;
        const roots =
          (loc?.independentRoots?.length ?? 0) > 0
            ? `<div style="margin-top:7px;color:var(--muted)">Independent root(s) the same judge surfaced alongside this conflict:<br>· ${esc((loc!.independentRoots ?? []).join("<br>· "))}</div>`
            : "";
        // G2 — the precedence READING of this conflict: which layer explains the run.
        // A classification of an unresolved conflict, never a resolution of it.
        const upstream =
          c.upstreamMostFailing !== undefined
            ? `<div style="margin-top:7px"><b>Reads as:</b> <span class="chip" style="color:var(--warn);border-color:var(--warn)">${esc(c.upstreamMostFailing)} is the most upstream failing layer</span> — ${esc(UPSTREAM_READING[c.upstreamMostFailing] ?? "no downstream pass clears it.")}</div>`
            : "";
        return `
      <div class="subc"><div class="subc-h"><span class="confbadge">⚡ CONFLICT</span><b>${esc(short(c.trajectoryId))}</b><span class="chip">${esc(Object.entries(c.verdicts).map(([l, v]) => `${l} ${v}`).join(" vs "))}</span></div>
        <div class="nest">${esc(statement ?? "The layers disagree on this trajectory.")}${loc?.root !== undefined ? `<div style="margin-top:7px"><b>Root, not symptom:</b> ${esc(loc.root)}</div>` : ""}${roots}${upstream} <div style="margin-top:7px"><b>Neither verdict is auto-resolved</b> — this row exists so a human rules on it in the review UI. The gate is driven by criteria severity only.</div></div>
      </div>`;
      })
      .join("")
  );
}

function findingsCards(input: RenderV3Input, crits: TemplateCriterion[], traces: Record<string, unknown>[], files: MatrixVerdictFile[], byCid: Map<string, TemplateCriterion>): { html: string; md: string } {
  const cards: string[] = [];
  const md: string[] = [];
  md.push(`# Findings Handoff — ${input.subjectName}${isExternal(input) ? "" : ` · ${input.runId}`}`);
  md.push(`**From:** evaluator (judge-only, EV-051) · **To:** diagnostics / operator`);
  const mdGatedBy = input.gate.gatedBy ?? input.gate.failedCriteria;
  md.push(`**Gate:** ${input.gate.passed ? "PASS" : input.gate.runVerdict.toUpperCase()}${mdGatedBy.length > 0 ? ` — driven by ${mdGatedBy.map((f) => `${f.criterionId} (${f.severity ?? "?"})`).join(" + ")}` : ""}${(input.gate.indeterminateBy ?? []).length > 0 ? ` · ${input.gate.indeterminateBy!.length} CRIT/HIGH uncertain (abstain, not fail)` : ""}`);
  if (input.scopeNote !== undefined) md.push(`**Scope:** ${input.scopeNote}`);
  md.push("");
  // G1 — CONTEXT block. The receiver of this markdown is usually a coding agent that
  // never opens the HTML, so the plan must stand alone: WHAT was judged and WHERE the
  // evidence is. Emitted only when the run carries a handover (absent ⇒ pre-G1 output).
  if (input.handover !== undefined) {
    const h = input.handover;
    md.push("## Context you need (do not go looking for it)");
    md.push(`**Subject:** ${h.subject.name} (${h.subject.kind}) — \`${h.subject.path}\``);
    const traceRefs = h.inputs.filter((a) => a.kind === "trace");
    if (traceRefs.length > 0) {
      md.push(
        `**Trace package (the exact evidence the judges read):** ${traceRefs
          .map((a) => `\`${a.path ?? a.uri ?? "?"}\``)
          .join(", ")} — UniTF JSONL, one session per line.`,
      );
      const manifest = h.inputs.find((a) => a.id === "trace-manifest");
      if (manifest !== undefined) md.push(`**Manifest:** \`${manifest.path ?? manifest.uri}\``);
    } else {
      // NAMED absence — never a silent gap. A handoff with no evidence attached is a
      // defect in the producing run, and the receiver must be told rather than left
      // to assume the traces were simply not mentioned.
      md.push(
        "**Trace package:** _not carried in this bundle_ — re-fetch is required and the " +
          "evidence may drift from what the judges actually read.",
      );
    }
    if (input.handoverPath !== undefined) md.push(`**Machine-readable bundle:** \`${input.handoverPath}\``);
    md.push("");
  }
  const failCards: string[] = [];
  const derivedCards: string[] = [];
  let fi = 0;
  for (const c of crits.filter((x) => x.k > 0)) {
    fi++;
    const trs = files.filter((f) => f.verdicts.some((v) => byCid.get(v.criterionId)?.id === c.id && v.result === "fail"));
    const links = trs.map((f) => `<span class="tlink" onclick="gotoTrace('${short(f.trajectoryId)}')">${short(f.trajectoryId)} · open walk ▸</span>`).join("");
    const worst = trs[0]?.verdicts.find((v) => byCid.get(v.criterionId)?.id === c.id && v.result === "fail");
    const quote = ((worst?.refs ?? [])[0] as { value?: string } | undefined)?.value;
    failCards.push(`<div class="fcard" data-component="mgt-finding-card"><div class="fcard-h"><span class="sev ${esc(c.sev)}">${esc(c.sev)}</span><b>F${fi} · ${esc(c.slug)}</b><span class="chip">${esc(c.id)}</span><span class="chip">${trs.length} trajectory(ies)</span><span class="chip" style="color:var(--warn);border-color:var(--warn)">→ diagnostics</span></div>
        <div class="fcard-b">${esc(worst?.critique ?? c.statement)}${quote !== undefined ? ` Evidence (exact-match re-resolved): <b>"${esc(String(quote).slice(0, 90))}"</b>.` : ""}
        <div style="margin-top:8px">${links}</div></div></div>`);
    md.push(`## F${fi} — ${c.slug}`);
    md.push(`**Criterion:** ${c.id} ${c.slug} · **Severity:** ${c.sev} · **Prevalence:** ${c.k}/${c.n} applicable`);
    if (quote !== undefined) md.push(`**Evidence:** "${String(quote).slice(0, 120)}"`);
    md.push(`**Route:** diagnostics (evaluator never fixes — EV-051)`);
    md.push("");
  }
  // DERIVED items: detections the judges flagged that no criterion covers —
  // derived from the walks, never scored, routed to the operator.
  let qi = 0;
  const candTotalAll = files.reduce((a, f) => a + ((f.candidates ?? []) as unknown[]).length, 0);
  if (candTotalAll > 0) {
    md.push("---");
    md.push("## Derived observations (no matching criterion — for operator review)");
    md.push("");
  }
  for (const f of files) {
    for (const cand of (f.candidates ?? []) as { kind?: string; detection?: string }[]) {
      if (qi >= 4) break;
      qi++;
      derivedCards.push(`<div class="fcard" data-component="mgt-finding-card"><div class="fcard-h"><span class="sev LOW">LOW</span><b>D${qi} · derived (${esc(cand.kind ?? "unmatched detection")})</b><span class="chip" style="color:var(--cyan);border-color:var(--cyan)">→ your calibration queue</span></div>
        <div class="fcard-b">${esc(String(cand.detection ?? "").slice(0, 320))}
        <div style="margin-top:8px"><span class="tlink" onclick="gotoTrace('${short(f.trajectoryId)}')">${short(f.trajectoryId)} · open walk ▸</span></div></div></div>`);
      md.push(`### D${qi} — derived (${cand.kind ?? "unmatched detection"}; NOT a scored finding)`);
      md.push(`${String(cand.detection ?? "").slice(0, 200)}`);
      md.push(`**Route:** operator calibration queue`);
      md.push("");
    }
  }
  const candTotal = files.reduce((a, f) => a + ((f.candidates ?? []) as unknown[]).length, 0);
  if (candTotal > qi) derivedCards.push(`<div class="fcard"><div class="fcard-b">+ ${candTotal - qi} further derived detections carried in the run artifacts (showing first ${qi} — declared cap, not a silent one).</div></div>`);

  // assemble the two SEPARATED category sections (operator round 12).
  cards.push(`<div class="h4s" style="margin-top:6px">Failures on defined criteria — routed to diagnostics</div>
      <p style="font-size:13.5px;color:var(--muted);margin:2px 0 4px;max-width:86ch">Each failure below broke a criterion of YOUR suite. The evaluator never fixes (judge-only) — every card is handed to diagnostics with its evidence.</p>
      ${failCards.length > 0 ? failCards.join("\n\n      ") : '<div class="fcard"><div class="fcard-b">No criterion failed on this corpus.</div></div>'}`);
  cards.push(`<div class="h4s" style="margin-top:18px">Derived observations — no matching criterion, for your review</div>
      <p style="font-size:13.5px;color:var(--muted);margin:2px 0 4px;max-width:86ch">The judges DETECTED these during the walks but no criterion in the suite covers them — so they are derived observations, never scored (detect-and-flag, never mint). They queue for your calibration ruling; accepted ones can become new criteria.</p>
      ${derivedCards.length > 0 ? derivedCards.join("\n\n      ") : '<div class="fcard"><div class="fcard-b">No derived detections on this corpus.</div></div>'}`);
  // G1 — ACCEPTANCE · VERIFICATION · PROHIBITIONS. Without these the handoff states a
  // problem but never states what "done" is, so the receiver cannot self-check and the
  // cheapest way to make it green is to weaken the criteria. Emitted only with a handover.
  if (input.handover !== undefined) {
    md.push("---");
    md.push("## Acceptance — you are done when");
    md.push(input.handover.acceptance.goal);
    md.push("");
    for (const c of input.handover.acceptance.criteria) md.push(`- ${c}`);
    md.push("");
    md.push("## How to verify");
    md.push(
      "Re-run the evaluation over the SAME trace package with the pinned judge " +
        `(model \`${input.pin.model}\`, temperature ${input.pin.temperature}). ` +
        "A pass is: every criterion listed above returns `pass`, and no criterion that " +
        "passed before now fails.",
    );
    md.push("");
    md.push("## What NOT to do");
    md.push("- Do NOT edit the criteria, their severity, or the suite to make this pass.");
    md.push("- Do NOT skip reading the sessions — the judgment tells you WHERE to look, not what happened.");
    md.push("- Do NOT change the judge model or temperature; the comparison is only valid pinned.");
    md.push("");
  }
  md.push("### Next steps");
  md.push("1. Diagnostics consumes the findings → RCA + remedies (evaluator never fixes)");
  md.push("2. Operator settles candidate/calibration items in the review UI");
  md.push("3. `*evaluate` rerun (pinned) confirms deltas");
  return { html: cards.join("\n\n      "), md: md.join("\n") };
}

function selfEvalCards(input: RenderV3Input, files: MatrixVerdictFile[], traces: Record<string, unknown>[]): string {
  const cells = input.criteria.length * files.filter((f) => f.fidelity?.complete !== false).length;
  const em = foldEmissionsScorecard(files);
  const engaged = files.map((f) => layersEngagedCount(f.layersEngaged as never)).filter((x): x is number => typeof x === "number");
  const meanEngaged = engaged.length > 0 ? (engaged.reduce((a, b) => a + b, 0) / engaged.length).toFixed(1) : "—";
  const iv = input.independentVerify;
  const cards = [
    `<div class="fcard" data-component="mgt-selfeval-card"><div class="fcard-h"><span class="verd pass">PASS</span><b>MR-1 · Completeness law</b></div>
        <div class="fcard-b"><b>What it checks:</b> no criterion may be silently skipped — every (criterion × trajectory) cell must end decided, abstained-with-reason, or na-by-precondition. <b>Result:</b> ${cells}/${cells} cells accounted for (assertNoUnverdictedCriterion passed at aggregate); 0 silent skips.</div></div>`,
    // G6 — three distinct states, never two: proof passed · proof RAN AND FAILED · not run.
    `<div class="fcard" data-component="mgt-selfeval-card"><div class="fcard-h"><span class="verd ${input.determinismNote === undefined ? "inc" : input.determinismOk === false ? "fail" : "pass"}">${input.determinismNote === undefined ? "NOT RUN" : input.determinismOk === false ? "FAIL" : "PASS"}</span><b>MR-2 · Rerun determinism</b></div>
        <div class="fcard-b"><b>What it checks:</b> the same corpus re-judged with the pinned model at temperature 0 must produce identical verdicts. <b>Result:</b> ${esc(input.determinismNote ?? "no rerun executed for this report — NAMED absence, not a pass")}.</div></div>`,
    `<div class="fcard" data-component="mgt-selfeval-card"><div class="fcard-h"><span class="verd inc">NOTE</span><b>MR-3 · Layer economy</b></div>
        <div class="fcard-b"><b>What it checks:</b> the walk should stop early when the outcome settles everything — deep layers cost tokens. <b>Result:</b> mean ${meanEngaged} of 5 layers engaged over ${engaged.length} walks; ${traces.filter((t) => t["earlyExit"] !== null && t["earlyExit"] !== "fidelity").length} early exit(s).</div></div>`,
    `<div class="fcard" data-component="mgt-selfeval-card"><div class="fcard-h"><span class="verd ${iv.length > 0 ? "pass" : "inc"}">${iv.length > 0 ? "PASS" : "N/A"}</span><b>MR-4 · Independent verification</b></div>
        <div class="fcard-b"><b>What it checks:</b> every gate-firing FAIL is re-examined by a second, independent reviewer that can only DOWNGRADE — dead evidence or reasoning leaps demote to uncertain. <b>Result:</b> ${iv.length > 0 ? `${iv.length} gating fail(s) re-verified · ${iv.filter((x) => !x.upheld).length} downgraded · ${iv.filter((x) => x.upheld).length} upheld with evidence re-resolved` : "no gating fails eligible OR verify pass not yet run — NAMED absence"}.</div></div>`,
    `<div class="fcard" data-component="mgt-selfeval-card"><div class="fcard-h"><span class="verd ${em.namedMissing.length >= 0 && em.manifestAbsent.length === 0 ? "pass" : "inc"}">${em.manifestAbsent.length === 0 ? "PASS" : "NOTE"}</span><b>MR-5 · Emissions scorecard</b></div>
        <div class="fcard-b"><b>What it checks:</b> every walk self-manifests what it emitted vs missed — a missing emission with a stated reason is a NAMED degrade; a silent drop is a defect. <b>Result:</b> ${em.walksWithManifest}/${em.walksTotal} manifests present · ${em.namedMissing.length} named degrade(s) · ${em.manifestAbsent.length === 0 ? "0 silent drops" : `${em.manifestAbsent.length} walk(s) WITHOUT a manifest`}.</div></div>`,
    crossLayerMatrix(files),
  ];
  return cards.join("\n      ");
}

/**
 * G2 — the CROSS-LAYER MATRIX: one row per trajectory, one column per layer, so the
 * pattern of agreement across a whole run is visible at once rather than one conflict at
 * a time. INTERNAL-only (it lives in the Self-Eval tab, which the external render strips)
 * because this is us studying our own method — not something a client rules on.
 *
 * Reads the SAME fold the rest of the report uses; adds no new computation and cannot
 * move a verdict. `absent` is rendered as its own state, never conflated with a pass.
 *
 * Tagged `mgt-crosslayer-matrix`, deliberately NOT `mgt-selfeval-card`: the Self-Eval tab
 * hosts the five MR-1..5 methodology checks and the render verifier asserts exactly five
 * of them. This matrix is evidence, not a sixth MR check — sharing their tag would have
 * quietly broken that count's meaning.
 */
function crossLayerMatrix(files: MatrixVerdictFile[]): string {
  const { rows } = foldLayerVerdicts(files);
  if (rows.length === 0) {
    return `<div class="fcard" data-component="mgt-crosslayer-matrix"><div class="fcard-h"><span class="verd inc">N/A</span><b>Cross-layer matrix</b></div>
        <div class="fcard-b">No walk emitted layer verdicts on this corpus — NAMED absence, not an empty table.</div></div>`;
  }
  const layers = ["L0", "L1", "L2", "L3", "L4"];
  const cell = (v: string | undefined): string => {
    const s = v ?? "absent";
    const color =
      s === "pass" ? "var(--pass)" : s === "fail" ? "var(--fail)" : s === "fired" ? "var(--warn)" : "var(--muted)";
    return `<td style="color:${color};font-family:var(--mono);font-size:12px">${esc(s)}</td>`;
  };
  const body = rows
    .map((r) => {
      const up = upstreamMostFailingLayer(r.byLayer as Record<string, string>);
      return `<tr><td style="font-family:var(--mono);font-size:12px">${esc(short(r.trajectoryId))}</td>${layers
        .map((l) => cell((r.byLayer as Record<string, string>)[l]))
        .join("")}<td style="font-family:var(--mono);font-size:12px;color:var(--warn)">${esc(up ?? "—")}</td></tr>`;
    })
    .join("");
  return `<div class="fcard" data-component="mgt-crosslayer-matrix"><div class="fcard-h"><span class="verd inc">INTERNAL</span><b>Cross-layer matrix — where the layers agree and disagree</b></div>
        <div class="fcard-b"><b>What it shows:</b> every trajectory against every evidence layer, plus the most upstream failing layer under the precedence model (context ▸ tools ▸ trajectory ▸ outcome). <b>This explains; it never gates</b> — the GATE is criteria-severity driven.
        <table style="width:100%;border-collapse:collapse;margin-top:8px"><tr><th style="text-align:left">trajectory</th>${layers.map((l) => `<th style="text-align:left">${l}</th>`).join("")}<th style="text-align:left">explains</th></tr>${body}</table></div></div>`;
}

/* ── the renderer ──────────────────────────────────────────────────────────── */
export function renderEvalReportV3(input: RenderV3Input): string {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const sevOf = new Map(input.criteria.map((c) => [c.criterionId, String(c.severity)]));
  const { list: crits, byCid } = mapCriteria(input);
  const conflicts = detectLayerConflicts(input.files);
  const traceById = new Map((input.traces ?? []).map((t) => [t.id, t]));
  const traces = input.files.map((f) => mapTrace(f, byCid, sevOf, conflicts, traceById.get(f.trajectoryId)));
  const fold = foldLayerVerdicts(input.files);

  const scores: Record<string, string> = {};
  for (const c of crits) scores[c.id] = `${c.n - c.k}/${c.n}`;

  const prof = (input.subjectProfile ?? {}) as Record<string, unknown>;
  const tools = ((prof["tools"] ?? []) as { name?: string }[]).map((t) => String(t.name ?? t));
  const reads = tools.filter((t) => toolClass(t) === "read");
  const acts = tools.filter((t) => toolClass(t) === "act");
  const profile = {
    name: input.subjectName,
    desc: `${String(prof["identity"] ?? input.subjectName)} — ${String(prof["purpose"] ?? "purpose not supplied (NAMED absence)")}`,
    gen: reads.join(" · ") || "(none classified)",
    op: acts.join(" · ") || "(none classified)",
    toolsHeading: `its ${tools.length} tools — reading vs acting (heuristic split)`,
    corpus: `${traces.length} trajectories${isExternal(input) ? "" : ` · run ${input.runId}`} · unitf-jsonl (mutagent-cli export)`,
    split: Object.entries(
      traces.reduce<Record<string, number>>((acc, t) => {
        const s = String(t["scenario"]);
        acc[s] = (acc[s] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([s, n]) => `${s} ${n}`)
      .join(" · "),
    chips: [String(prof["skill"] ?? "agent"), String(prof["harness"] ?? "harness unknown"), String(prof["version"] ?? "version unknown")],
  };

  const name = (f: { criterionId: string }): string => {
    const t = byCid.get(f.criterionId);
    return t !== undefined ? `${t.id} ${t.slug}` : f.criterionId;
  };
  const gatedBy = input.gate.gatedBy ?? input.gate.failedCriteria;
  const indet = input.gate.indeterminateBy ?? [];
  const bottom = input.gate.passed
    ? `The gate PASSED: all ${crits.length} criteria held over ${traces.length} trajectories. ${conflicts.length > 0 ? `${conflicts.length} cross-layer conflict(s) are queued for your calibration ruling — they do not move the gate.` : "No cross-layer conflicts were detected."}`
    : `The gate ${esc(input.gate.runVerdict.toUpperCase())} — driven by ${gatedBy.length} decided fail(s): <b style="color:var(--fg)">${gatedBy.map((f) => esc(name(f))).join(", ")}</b>.${indet.length > 0 ? ` ${indet.length} CRIT/HIGH criterion/criteria ended <b style="color:var(--fg)">uncertain</b> (${indet.map((f) => esc(name(f))).join(", ")}) — abstains, not fails; they roll the run INCOMPLETE-wards, never green.` : ""} ${traces.filter((t) => t["gate"] === "incomplete").length} trajectory(ies) ended incomplete/abstained. ${conflicts.length > 0 ? `${conflicts.length} ⚡ conflict(s) queued for your calibration ruling — they do not move the gate.` : "No cross-layer conflicts detected."} ${input.scopeNote !== undefined ? esc(input.scopeNote) : ""}`;

  const findings = findingsCards(input, crits, traces, input.files, byCid);
  const openTrace = (traces.find((t) => t["gate"] === "fail") ?? traces[0])?.["id"] ?? null;

  // V13 — the INGESTED-TRACE INVENTORY: every trace of the corpus, judged or not.
  // An ingested-but-unjudged trace is a NAMED row, never a silent omission.
  const judgedIds = new Set(input.files.map((f) => f.trajectoryId));
  const ingested = input.traces ?? [];
  const gateOf = new Map(traces.map((t) => [String(t["fullId"]), String(t["gate"])]));
  const invRows = (ingested.length > 0 ? ingested.map((t) => t.id) : [...judgedIds]).map((id) => {
    const judged = judgedIds.has(id);
    const g = gateOf.get(id);
    const badge = !judged
      ? '<span class="verd inc">NOT JUDGED</span>'
      : g === "pass"
        ? '<span class="verd pass">pass</span>'
        : g === "fail"
          ? '<span class="verd fail">fail</span>'
          : '<span class="verd inc">incomplete</span>';
    const note = judged
      ? "judged — full layered walk (drill in tab ②)"
      : (input.scopeNote ?? "outside this run's declared judging scope");
    return `<tr${judged ? ` style="cursor:pointer" onclick="gotoTrace('${esc(short(id))}')"` : ' style="cursor:default"'}><td><b>${esc(short(id))}</b></td><td style="font-family:var(--mono);font-size:12px">${esc(id)}</td><td>${badge}</td><td>${esc(note)}</td></tr>`;
  });
  const unjudgedCount = invRows.length - judgedIds.size;
  const traceListHtml = `<p style="font-size:13.5px;color:var(--muted);margin:2px 0 8px;max-width:86ch">${invRows.length} trace(s) ingested · ${judgedIds.size} judged${unjudgedCount > 0 ? ` · <b style="color:var(--warn)">${unjudgedCount} NOT judged (each named below — a declared scope reduction, not a silent drop)</b>` : " · full corpus judged"}.</p>
      <table class="ledger" data-component="mgt-trace-inventory"><thead><tr><th>trace</th><th>full id</th><th>status</th><th>note</th></tr></thead><tbody>${invRows.join("")}</tbody></table>`;

  const data = {
    criteria: crits,
    traces,
    scores,
    profile,
    handoffMd: findings.md,
    openTrace,
    feedbackTitle: isExternal(input) ? `Evaluation report — ${input.subjectName}` : `Evaluation report · ${input.runId}`,
    artifactPath: isExternal(input) ? "" : `.mutagent/evaluator/reports/${input.runId}/evaluation-report.html`,
    layerTotals: fold.totals,
  };

  const slots: Record<string, string> = {
    "@@TITLE@@": `Evaluation Report — ${esc(input.subjectName)}${isExternal(input) ? "" : ` · ${esc(input.runId)}`}`,
    "@@RUN_BADGE@@": `<span style="margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--muted)">${isExternal(input) ? "" : `run ${esc(input.runId)}`}${input.generatedAt !== undefined ? `${isExternal(input) ? "" : " · "}${esc(input.generatedAt.slice(0, 10))}` : ""}</span>`,
    "@@HERO_TITLE@@": `Evaluation Report — ${esc(input.subjectName)}`,
    "@@HERO_LEDE@@": `<b>Did the agent behave correctly?</b> ${traces.length} real sessions were judged in evidence layers — code checks, outcome, trajectory, tool outputs, context — against ${crits.length} binary criteria. Every verdict cites exact quoted evidence; a failed CRIT/HIGH criterion fails the gate.`,
    "@@IDENTITY_STRIP@@": identityStrip(input, traces),
    "@@METRICS_TILES@@": metricsTiles(input, traces, crits),
    "@@SCORECARD_SCORES@@": metricsTiles(input, traces, crits),
    "@@SUITE_LEDE@@": `${crits.length} binary criteria. Each is answered true/false per trajectory with quoted evidence — never a score. na = the criterion's scoping predicate is positively falsified for that trajectory (≠ fail).`,
    "@@BOTTOM_LINE@@": bottom,
    "@@TRACE_LIST@@": traceListHtml,
    "@@CRITERION_DETAILS@@": criterionDetails(input, crits, input.files, byCid),
    "@@CONFLICTS@@": conflictsHtml(conflicts, input.files),
    "@@FINDINGS_CARDS@@": findings.html,
    "@@SELFEVAL_CARDS@@": selfEvalCards(input, input.files, traces),
    "@@FOOT@@": isExternal(input)
      ? `🧬 MutagenT · evaluator report · ${esc(input.subjectName)}`
      : `🧬 MutagenT · evaluator report · run ${esc(input.runId)} · artifact → .mutagent/evaluator/reports/${esc(input.runId)} (gitignored)`,
    "@@FEEDBACK_LABEL@@": `Feedback — evaluation report${isExternal(input) ? "" : ` · ${esc(input.runId)}`} · Copy MD bundles your notes`,
    "@@DATA_JSON@@": JSON.stringify(data).replace(/</g, "\\u003c"),
  };

  let html = template;
  for (const [k, v] of Object.entries(slots)) {
    if (!html.includes(k)) throw new Error(`TEMPLATE SLOT MISSING: ${k}`);
    // a FUNCTION replacement, never the string form: `$&` / `$'` / `` $` `` / `$$`
    // / `$1` inside real subject text (a quoted reply, a criterion statement, a
    // judge critique, the markdown handoff) are substitution patterns to
    // String.replace and would silently corrupt the emitted page — `$&` even
    // re-emits the slot marker itself. Mirrors render-discover-report-v3.
    html = html.replace(k, () => v);
  }
  // The feedback bar is a DEV-LOOP affordance only (operator rule, round 13):
  // user-produced reports never carry it, regardless of audience.
  if (input.devFeedback !== true) {
    const start = html.indexOf('<div id="fbpanel"');
    const endAnchor = "</div></div>";
    const end = start >= 0 ? html.indexOf(endAnchor, start) : -1;
    if (start < 0 || end < 0) throw new Error("feedback-panel strip anchor missing");
    html = html.slice(0, start) + html.slice(end + endAnchor.length);
  }
  // ── V11 AUDIENCE STRIP — the ⑤ INTERNAL surface (see the contract block above) ──
  // Runs AFTER slot-fill on purpose: the ⑤ panel holds `@@SELFEVAL_CARDS@@`, so
  // cutting it first would trip the fail-loud "TEMPLATE SLOT MISSING" guard. Order:
  // fill every slot, then remove the whole internal surface.
  if (isExternal(input)) {
    html = stripInternalSurface(html, { commentMarker: "<!-- ⑤ SELF-EVAL -->", tabIndex: 4, label: "⑤ Self-Eval" });
  }
  const leftover = /@@[A-Z_]+@@/.exec(html);
  if (leftover !== null) throw new Error(`UNFILLED SLOT: ${leftover[0]}`);
  return html;
}

/** Write the v3 frozen-contract report for a run. Returns the artifact path. */
export function writeEvalReportV3(input: RenderV3Input, repoRoot: string): string {
  const out = join(repoRoot, ".mutagent/evaluator/reports", input.runId, "evaluation-report.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderEvalReportV3(input));
  return out;
}
