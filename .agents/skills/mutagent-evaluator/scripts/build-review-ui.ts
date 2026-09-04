/**
 * scripts/build-review-ui.ts — EV-045 `*review` annotation-UI renderer (Type A — DATA/template only).
 * ---------------------------------------------------------------------------
 * The Code-only half of the `*review` Hybrid (operation-inventory): a
 * DETERMINISTIC HTML template (like `render-report.ts`) that emits a
 * browser-based human-annotation interface + a labels-persistence merge. The
 * HITL half — a human clicking Pass/Fail/Defer in the browser — is the LLM-only
 * piece (`references/build-review-interface.md`).
 *
 * What it produces (build-review-interface.md):
 *   - one trace per screen, rendered in human-readable native form (escaped +
 *     collapsible), full trace accessible, color-coded by role;
 *   - binary Pass/Fail + a Defer button + a free-text notes field;
 *   - keyboard shortcuts (arrows · 1/2/D · U · Cmd+S · Cmd+Enter);
 *   - auto-save on every action (localStorage) + a labels export;
 *   - a trace counter + jump-to-id + labeled/unlabeled counts.
 *
 * EV-3 — the review screen used to dump each whole session as a FLAT sibling
 * list of collapsible steps (10,254 step-blocks / up to 1,686 per card in the
 * real run → unreviewable). This renderer now ALSO ports the eval report's
 * step<->criterion SIDE-BY-SIDE view onto review (the SAME extracted render
 * functions — `report-fragments.ts`), with (a) criterion-scoped fragments (show
 * only the steps a criterion examined, rendered by the REUSED `sideBySide`),
 * (b) a VIRTUALIZED / windowed scroll so a 1,686-step card scrolls instead of
 * walling the DOM, and (c) pre-labelled evidence steps (the steps a criterion's
 * refs already identify). Activated ONLY when `opts.sideBySide` carries a
 * per-trace bundle; without it the legacy flat review is unchanged.
 *
 * Austerity: holds NO judge prompt, makes NO pass/fail decision (the HUMAN
 * decides). DETERMINISTIC: `renderReviewUi(traces, opts)` is byte-identical for
 * the same input — NO clock / random / network in the generator. The browser
 * stamps `labeledAt` at save time; the deterministic `mergeLabels` only
 * round-trips + dedups by traceId. Labels validate against `HumanLabel`
 * (`contracts/validation.ts`) → consumed by `*validate`.
 *
 * Subject-agnostic (EV-002): the subject name + any badges come from the caller
 * (the subject profile), never hard-coded.
 */
import type {
  CriterionVerdict,
  DiscoveryAssumption,
  DiscoveryRef,
  EvalTrace,
  OutcomeVerdictValue,
  TraceObservation,
  VerdictBlock,
} from "./contracts/eval-types.ts";
import { type HumanLabel } from "./contracts/validation.ts";
import {
  REVIEW_SIDE_BY_SIDE_DEPS_JS,
  SIDE_BY_SIDE_FRAGMENT_JS,
  STEP_ROW_FRAGMENT_JS,
} from "./report-fragments.ts";

/**
 * GA — the judge's adjudication for ONE trace, surfaced on the review screen so
 * the human can see WHY the judge decided/abstained and feed the calibration
 * loop (verify / eliminate the surfaced assumption). A compact projection of the
 * folded `CriterionVerdict` — refs / assumptions / blockedBy carried with NO drop.
 */
export interface ReviewAdjudication {
  criterionId: string;
  result: OutcomeVerdictValue;
  critique?: string;
  refs?: DiscoveryRef[];
  assumptions?: DiscoveryAssumption[];
  blockedBy?: VerdictBlock;
}

// ── HTML escape (sanitize rendered content — no raw LLM HTML reaches the DOM) ─
/** Escape into HTML text. Null-guarded (never throws on undefined). */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON for a `<script>` inline injection — `<` escaped so no `</script>` breakout. */
function jsonInject(v: unknown): string {
  return JSON.stringify(v ?? null).replace(/</g, "\\u003c");
}

// ── EV-3 side-by-side data model (per-trace) ─────────────────────────────────

/** One agent step in the side-by-side lane (mirrors the eval report's AgentStep). */
export interface ReviewStep {
  n: number | string;
  tool?: string;
  status?: string;
  detail?: string;
  /** the observation id the criterion refs bind to (`ref.obs === step.obs`). */
  obs?: string;
}

/** One judge-walk step (optional — most review bundles carry none). */
export interface ReviewJudgeStep {
  kind: string;
  text?: string;
  ref?: unknown;
  anchor?: number | null;
}

/**
 * EV-3 — the per-trace SIDE-BY-SIDE bundle: the agent steps on the left, the
 * per-criterion verdicts (with refs) that examined them on the right. Shaped to
 * be consumed BOTH by the virtualized windowed renderer AND (criterion-scoped)
 * by the REUSED `sideBySide` render fn from `report-fragments.ts`.
 */
export interface ReviewSideBySide {
  agentSteps: ReviewStep[];
  /** the per-criterion verdicts for this trace (refs bind them to the steps). */
  criterionVerdicts: CriterionVerdict[];
  judgeSteps?: ReviewJudgeStep[];
  context?: { harness?: string; scenario?: string; exitStates?: string };
  health?: { contextGathered?: boolean; grounded?: number; assumed?: number; stoppedAtSymptom?: boolean };
  verdict?: string;
  route?: string;
  res?: string;
  localize?: string;
  input?: string;
  /** analyzer-identified evidence obs ids — steps to PRE-LABEL as evidence. */
  evidenceObs?: string[];
  // pass-through for `sideBySide`'s optional bands (rendered when present).
  subjectProfile?: unknown;
  understanding?: unknown;
  expectedTrajectory?: unknown;
}

/** Criterion metadata for the method tag (`C[id].m` → CODE/JUDGE/HYBRID). */
export interface ReviewCriterionMeta {
  n?: string;
  m?: string;
}

export interface ReviewUiOptions {
  /** subject display name for the header badge (from the subject profile). */
  subjectName?: string;
  /** page title (defaults to a subject-agnostic label). */
  title?: string;
  /**
   * GA — the judge's adjudication per traceId (refs · assumptions · blockedBy ·
   * result). When present, each trace card surfaces the GA panel + verify/
   * eliminate capture. OPTIONAL — absent ⇒ the legacy label-only review screen.
   */
  adjudications?: Record<string, ReviewAdjudication>;
  /**
   * EV-3 — the per-trace side-by-side bundle (agent steps + per-criterion
   * verdicts). When present for a trace, the card renders the criterion-scoped,
   * virtualized step<->criterion view. OPTIONAL — absent ⇒ legacy flat review.
   */
  sideBySide?: Record<string, ReviewSideBySide>;
  /** criterion metadata (id → {n,m}) for the CODE/JUDGE/HYBRID method tag. */
  criteriaMeta?: Record<string, ReviewCriterionMeta>;
}

// ── per-trace native-format render (server-side, deterministic) ──────────────

/** Pretty-print an observation's payload as escaped, collapsible JSON. */
function renderObservation(o: TraceObservation, i: number): string {
  const kind = o.type === "TOOL" ? "tool" : esc(o.type);
  const name = esc(o.name ?? o.type);
  const payload = (() => {
    try {
      return esc(JSON.stringify({ input: o.input, output: o.output }, null, 2));
    } catch {
      return esc(String(o.output ?? ""));
    }
  })();
  return (
    `<details class="obs obs-${kind}">` +
    `<summary><span class="obs-idx">#${i + 1}</span> <code>${name}</code></summary>` +
    `<pre class="obs-body">${payload}</pre>` +
    `</details>`
  );
}

/** GA — render the judge's adjudication panel + verify/eliminate calibration
 *  capture for one trace. Surfaces refs · assumptions · blockedBy. */
function renderAdjudicationPanel(adj: ReviewAdjudication): string {
  const resultLabel = adj.result === "uncertain" ? "indeterminate" : adj.result;
  const refs =
    adj.refs && adj.refs.length > 0
      ? `<div class="ga-row"><span class="ga-k">refs</span> <code>${esc(
          adj.refs.map((r) => `${r.obs}${r.path ? "/" + r.path : ""}: "${r.value}"`).join(" · "),
        )}</code></div>`
      : "";
  const blockedBy =
    adj.blockedBy !== undefined
      ? `<div class="ga-row"><span class="ga-k">blocked by</span> <span class="badge meta">${esc(
          adj.blockedBy.kind,
        )}</span> ${esc(adj.blockedBy.text)}</div>`
      : "";
  // each surfaced assumption gets verify / eliminate calibration buttons.
  const assumptions =
    adj.assumptions && adj.assumptions.length > 0
      ? `<div class="ga-row"><span class="ga-k">assumptions</span><ul class="ga-assumptions">` +
        adj.assumptions
          .map(
            (a, ai) =>
              `<li>${esc(a.text)} <span class="badge meta">${esc(a.status)}</span>${
                a.kind !== undefined ? ` <span class="badge meta">${esc(a.kind)}</span>` : ""
              } ` +
              `<button class="calib verify" data-ai="${ai}" data-action="verify">Verify ✓</button> ` +
              `<button class="calib eliminate" data-ai="${ai}" data-action="eliminate">Eliminate ✗</button></li>`,
          )
          .join("") +
        `</ul></div>`
      : "";
  return (
    `<div class="ga-panel" data-criterion="${esc(adj.criterionId)}">` +
    `<div class="ga-head">judge adjudication: <span class="badge verdict-${esc(resultLabel)}">${esc(
      resultLabel,
    )}</span> <code>${esc(adj.criterionId)}</code></div>` +
    (adj.critique ? `<div class="ga-row"><span class="ga-k">critique</span> ${esc(adj.critique)}</div>` : "") +
    refs +
    assumptions +
    blockedBy +
    `</div>`
  );
}

/**
 * EV-3 — the side-by-side MOUNT for one trace. The card carries an empty mount
 * div (data-trace-id) that the client controller fills with the criterion-scoped,
 * virtualized step<->criterion view. Server emits only the shell (deterministic);
 * the heavy step DOM is windowed at runtime so a 1,686-step card never walls.
 */
function renderSbsMount(traceId: string): string {
  return (
    `<div class="role role-sbs"><h4>Step ‖ Criterion — side-by-side (virtualized)</h4>` +
    `<div class="sbs-mount" data-trace-id="${esc(traceId)}">` +
    `<div class="sbs-boot">loading side-by-side…</div>` +
    `</div></div>`
  );
}

/**
 * Render one trace as a card (native format: escaped text, collapsible tool
 * observations, color-coded role borders, full trace accessible). All cards are
 * emitted; the client shows exactly one at a time. When a GA adjudication is
 * supplied for the trace, the judge panel + verify/eliminate capture is surfaced.
 * When a side-by-side bundle is supplied, the criterion-scoped virtualized
 * step<->criterion view is mounted.
 */
function renderTraceCard(
  trace: EvalTrace,
  index: number,
  subjectName: string,
  adj?: ReviewAdjudication,
  hasSbs = false,
): string {
  const prompt = esc(trace.input?.prompt ?? "");
  const response = esc(trace.output?.response ?? "");
  const obs = trace.observations.map(renderObservation).join("");
  const toolCount = trace.observations.filter((o) => o.type === "TOOL").length;
  const panel = adj !== undefined ? renderAdjudicationPanel(adj) : "";
  const sbs = hasSbs ? renderSbsMount(trace.id) : "";
  return (
    `<section class="trace-card" data-index="${index}" data-trace-id="${esc(trace.id)}" hidden>` +
    `<div class="card-head">` +
    `<span class="badge subject">${esc(subjectName)}</span>` +
    `<span class="badge tid">${esc(trace.id)}</span>` +
    `<span class="badge meta">${toolCount} tool call(s)</span>` +
    `</div>` +
    `<div class="role role-user"><h4>Input</h4><pre>${prompt}</pre></div>` +
    sbs +
    `<div class="role role-tool"><h4>Trace (${trace.observations.length} step(s))</h4>${obs || "<em>no observations</em>"}</div>` +
    `<div class="role role-assistant"><h4>Output</h4><pre>${response}</pre></div>` +
    panel +
    `</section>`
  );
}

// ── EV-3 derive: build a per-trace side-by-side bundle from a trace + verdicts ─

/**
 * Derive a `ReviewSideBySide` from a trace + its per-criterion verdicts. PURE /
 * deterministic. Synthesizes agent steps from the trace observations (n · tool ·
 * detail · obs) and pre-labels the evidence obs ids the verdict refs cite. When
 * `agentSteps` are supplied directly (already-projected judge steps), they win.
 */
export function deriveReviewSideBySide(
  trace: EvalTrace,
  verdicts: CriterionVerdict[],
  extra: Partial<ReviewSideBySide> = {},
): ReviewSideBySide {
  const agentSteps: ReviewStep[] =
    extra.agentSteps ??
    trace.observations.map((o, i) => {
      const obsId = (o as { id?: string }).id;
      let detail = "";
      try {
        detail = JSON.stringify(o.output ?? o.input ?? {});
      } catch {
        detail = String(o.output ?? "");
      }
      return {
        n: i + 1,
        tool: o.name ?? o.type,
        status: o.type === "TOOL" ? "" : String(o.type),
        detail: detail.length > 240 ? detail.slice(0, 240) + "…" : detail,
        obs: obsId,
      };
    });
  // evidence obs = every obs id a verdict ref cites (analyzer-identified).
  const evidence = new Set<string>(extra.evidenceObs ?? []);
  for (const v of verdicts) for (const r of v.refs ?? []) if (r.obs) evidence.add(String(r.obs));
  return {
    agentSteps,
    criterionVerdicts: verdicts,
    input: extra.input ?? trace.input?.prompt,
    verdict: extra.verdict,
    route: extra.route,
    res: extra.res,
    localize: extra.localize,
    context: extra.context,
    health: extra.health,
    judgeSteps: extra.judgeSteps,
    evidenceObs: [...evidence],
    subjectProfile: extra.subjectProfile,
    understanding: extra.understanding,
    expectedTrajectory: extra.expectedTrajectory,
  };
}

// ── the deterministic HTML document ──────────────────────────────────────────

// Brand: the unified MutagenT design-system — SHARP corners (radius 0), SUBTLE
// non-black surfaces (purple is an ACCENT only), TONED status, NO glow. Tokens
// mirror @mutagent/templates/design-system/tokens.css (self-contained inline copy;
// the review UI is a standalone HTML doc with no bundled brand-asset read).
const STYLE = `
:root{--bg:#0a0a12;--surf:#14141d;--surf-2:#1a1a25;--fg:#d6dbe6;--fg-strong:#eef1f6;--mut:#8a8698;--dim:#6b6878;--bd:rgba(255,255,255,.09);--bstr:rgba(255,255,255,.16);--pass:#43c39a;--fail:#e06666;--defer:#e8a64d;--warn:#e8a64d;--cyan:#45b8cc;--user:#45b8cc;--tool:#7E47D7;--asst:#43c39a;--primary-soft:#a986e8;--fs:'Space Grotesk',system-ui,-apple-system,sans-serif;--fm:'IBM Plex Mono',ui-monospace,monospace;--fs-sm:12px;--fs-xs:11px;--fs-2xs:10px}
*{box-sizing:border-box;border-radius:0}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--fs)}
header{position:sticky;top:0;background:var(--surf);border-bottom:1px solid var(--bstr);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:10}
header strong{color:var(--fg-strong)}
main{padding:16px;max-width:1180px;margin:0 auto}
.badge{display:inline-block;padding:2px 8px;background:var(--surf-2);border:1px solid var(--bd);font-size:12px;font-family:var(--fm)}
.badge.subject{background:var(--surf-2);border-color:var(--bstr)}.badge.tid{font-family:var(--fm)}
.role{border-left:3px solid var(--bd);padding:4px 12px;margin:10px 0}
.role-user{border-color:var(--user)}.role-tool{border-color:var(--tool)}.role-assistant{border-color:var(--asst)}.role-sbs{border-color:var(--primary-soft)}
.role h4{margin:4px 0;color:var(--mut);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em;font-family:var(--fm)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--surf);border:1px solid var(--bd);padding:10px;margin:4px 0;font-family:var(--fm)}
details.obs{margin:4px 0;border:1px solid var(--bd);padding:4px 8px;background:var(--surf-2)}
details.obs-tool{border-left:3px solid var(--tool)}
summary{cursor:pointer}.obs-idx{color:var(--mut)}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{background:var(--surf-2);color:var(--fg);border:1px solid var(--bd);padding:6px 12px;cursor:pointer;font-size:13px;font-family:var(--fs)}
button:hover{border-color:var(--mut)}
button.pass{border-color:var(--pass)}button.pass.active{background:var(--pass);color:#0a0a12}
button.fail{border-color:var(--fail)}button.fail.active{background:var(--fail);color:#0a0a12}
button.defer{border-color:var(--defer)}button.defer.active{background:var(--defer);color:#0a0a12}
textarea{width:100%;min-height:54px;background:var(--surf);color:var(--fg);border:1px solid var(--bd);padding:8px;margin-top:8px;font:13px/1.4 var(--fm)}
.counter{color:var(--mut)}.kbd{font-family:var(--fm);color:var(--mut);font-size:11px}
input[type=text]{background:var(--surf);color:var(--fg);border:1px solid var(--bd);padding:5px 8px;width:140px;font-family:var(--fm)}
.ga-panel{border:1px solid var(--bd);border-left:3px solid var(--tool);padding:8px 12px;margin:10px 0;background:var(--surf-2)}
.ga-head{font-weight:600;margin-bottom:4px}.ga-row{margin:4px 0}.ga-k{color:var(--mut);text-transform:uppercase;font-size:11px;letter-spacing:.04em;margin-right:6px;font-family:var(--fm)}
.ga-assumptions{margin:4px 0;padding-left:18px}
.badge.verdict-pass{border-color:var(--pass);color:var(--pass)}.badge.verdict-fail{border-color:var(--fail);color:var(--fail)}.badge.verdict-indeterminate{border-color:var(--defer);color:var(--defer)}
button.calib{padding:2px 8px;font-size:11px}button.calib.verify.active{background:var(--pass);color:#0a0a12}button.calib.eliminate.active{background:var(--fail);color:#0a0a12}
/* EV-3 — side-by-side (criterion-scoped, virtualized, evidence-highlighted) */
.sbs-mount{border:1px solid var(--bd);background:var(--surf-2);padding:8px}
.sbs-boot{color:var(--mut);font-family:var(--fm);font-size:12px;padding:8px}
.sbs-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.sbs-chip{padding:3px 9px;font-size:12px;font-family:var(--fm);background:var(--surf);border:1px solid var(--bd);color:var(--fg)}
.sbs-chip.on{border-color:var(--primary-soft);color:var(--fg-strong);background:var(--surf-2)}
.lanehdr{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;padding:5px 6px;border-bottom:1px solid var(--bstr);color:var(--mut);font-family:var(--fm);font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.lanehdr .x{text-align:center}.lanehdr .j{text-align:left}
.sbs-scroll{height:440px;overflow:auto;position:relative;border:1px solid var(--bd);background:var(--surf)}
.sbs-sizer{position:relative;width:100%}
.sbs-window{position:absolute;left:0;right:0;top:0;will-change:transform}
.srow{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;border-bottom:1px solid var(--bd);overflow:hidden;padding:2px 0}
.srow.evidence{background:rgba(126,71,215,.10);border-left:3px solid var(--primary-soft)}
.step-l,.step-r{overflow:auto;padding:4px 8px}
.step-l .evb,.step-r .evb{font-family:var(--fm);font-size:11px}
.step-l .top{display:flex;gap:6px;align-items:center}
.step-l .tool{color:var(--fg-strong)}.step-l .st{color:var(--warn)}
.step-l .det{color:var(--mut);margin-top:2px;word-break:break-word}
.node{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:34px}
.node .n{font-family:var(--fm);font-size:11px;color:var(--mut);border:1px solid var(--bd);padding:0 5px}
.node .ln{flex:1;width:1px;background:var(--bd);min-height:6px}
.jcov{border:1px solid var(--bd);border-left:3px solid var(--bd);padding:4px 7px;margin:3px 0;background:var(--surf-2)}
.jcov.pass{border-left-color:var(--pass)}.jcov.fail{border-left-color:var(--fail)}.jcov.uncertain,.jcov.indeterminate{border-left-color:var(--warn)}
.jcov-h{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:2px}
.cvb{font-family:var(--fm);font-size:10px;text-transform:uppercase;letter-spacing:.03em;padding:0 5px;border:1px solid var(--bstr)}
.cvb.pass{color:var(--pass);border-color:var(--pass)}.cvb.fail{color:var(--fail);border-color:var(--fail)}.cvb.uncertain,.cvb.indeterminate{color:var(--warn);border-color:var(--warn)}.cvb.na{color:var(--dim)}
.jm{font-family:var(--fm);font-size:9px;padding:0 4px;border:1px solid var(--bd);color:var(--mut)}.jm.code{color:var(--cyan);border-color:var(--cyan)}
.jcid{font-family:var(--fm);font-size:11px;color:var(--fg-strong)}
.jcrit{font-size:12px;color:var(--fg);line-height:1.45}
.cvrefs{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.cvref{font-family:var(--fm);font-size:10px;color:var(--cyan);border:1px solid var(--bd);padding:0 4px;word-break:break-all}
.jstep{font-family:var(--fm);font-size:11px;color:var(--fg);padding:2px 0}.jstep.noexam{color:var(--dim)}
.jstep .k{color:var(--primary-soft);margin-right:5px}.jstep .ref{color:var(--cyan)}
.dim{color:var(--dim)}
.sbs-meta{color:var(--mut);font-family:var(--fm);font-size:11px;margin-top:6px}
.sbs-full{margin-top:8px}.sbs-hint{color:var(--mut);font-family:var(--fm);font-size:11px;padding:6px}
.sbs-fulldet{border:1px solid var(--bd);background:var(--surf);padding:6px 8px}
.sbs-fulldet summary{color:var(--primary-soft);font-family:var(--fm);font-size:12px}
/* the reused sideBySide fragment renders a drillbox — give its bands legible defaults */
.drillbox{padding:6px 2px}.drillbox .mono{font-family:var(--fm)}
.drillbox .chip{font-family:var(--fm);font-size:11px;border:1px solid var(--bd);padding:0 6px;margin:0 4px}
.drillbox .verd{font-family:var(--fm);font-size:11px;padding:0 6px;border:1px solid var(--bstr)}.drillbox .verd.fail{color:var(--fail);border-color:var(--fail)}.drillbox .verd.pass{color:var(--pass);border-color:var(--pass)}.drillbox .verd.inc{color:var(--warn);border-color:var(--warn)}
.drillbox .ctx,.drillbox .band{border:1px solid var(--bd);padding:6px 8px;margin:6px 0;background:var(--surf-2)}
.drillbox .ctx-h,.drillbox .bh{color:var(--mut);font-family:var(--fm);font-size:11px;text-transform:uppercase;letter-spacing:.03em;margin-bottom:4px}
.drillbox .ctx-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.drillbox .ctx-c .l{color:var(--dim);font-family:var(--fm);font-size:10px;text-transform:uppercase}.drillbox .ctx-c .v{color:var(--fg)}
.drillbox .grid2{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;margin-top:6px}
.drillbox .health{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}.drillbox .hc{border:1px solid var(--bd);padding:3px 8px;font-family:var(--fm);font-size:11px}.drillbox .hc .v.good{color:var(--pass)}.drillbox .hc .v.warn{color:var(--warn)}
.cvblock .cvbody{display:flex;flex-direction:column;gap:5px}.cvrow{border:1px solid var(--bd);border-left:3px solid var(--bd);padding:5px 7px;background:var(--surf)}.cvrow.pass{border-left-color:var(--pass)}.cvrow.fail{border-left-color:var(--fail)}.cvrow.uncertain,.cvrow.indeterminate{border-left-color:var(--warn)}
.cvh{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:2px}.cvid{font-family:var(--fm);color:var(--fg-strong);font-size:11px}.cvconf{font-family:var(--fm);font-size:10px;color:var(--dim);margin-left:auto}.cvcrit{font-size:12px}.cvcrit.dim{color:var(--dim)}
.routing{display:flex;gap:6px;align-items:center;margin:4px 0;font-family:var(--fm);font-size:11px}.re-rephrase,.re-ul,.re-rat,.why-note{font-size:12px}.whychain .jstep{font-size:11px}
`;

/**
 * The client controller: nav, label state (localStorage auto-save), keyboard
 * shortcuts, counter, jump-to-id, labels export. Embedded verbatim — it carries
 * NO trace data (the cards are server-rendered) and NO subject specifics. The
 * `STORAGE_KEY` is parameterized by a stable subject key so multiple subjects'
 * labels don't collide in one browser.
 *
 * EV-3 — when side-by-side data (`SBS`) is injected, the controller ALSO mounts
 * the criterion-scoped, virtualized step<->criterion view per card (lazily, on
 * first show), reusing the extracted `sideBySide` fn for the scoped fragment.
 */
function clientScript(storageKey: string, sbsJson: string, critJson: string): string {
  return `
const STORAGE_KEY=${JSON.stringify(storageKey)};
const CALIB_KEY=STORAGE_KEY+':calibration';
const SBS=${sbsJson},C=${critJson},RES={};
const cards=[...document.querySelectorAll('.trace-card')];
const ids=cards.map(c=>c.dataset.traceId);
let cur=0;
function loadLabels(){try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}catch{return {}}}
function saveLabels(m){localStorage.setItem(STORAGE_KEY,JSON.stringify(m))}
// GA — calibration capture (verify/eliminate) lives in a SEPARATE store so the
// human-labels.json export stays HumanLabel-schema-clean (no smuggled fields).
function loadCalib(){try{return JSON.parse(localStorage.getItem(CALIB_KEY)||'{}')}catch{return {}}}
function saveCalib(m){localStorage.setItem(CALIB_KEY,JSON.stringify(m))}
let calib=loadCalib();
let labels=loadLabels();
let history=[];
// ── EV-3 side-by-side deps + extracted render fns + virtualization mirror ──
${REVIEW_SIDE_BY_SIDE_DEPS_JS}
${SIDE_BY_SIDE_FRAGMENT_JS}
${STEP_ROW_FRAGMENT_JS}
var SBS_ROW_H=112,SBS_OVERSCAN=6;
function sbsStepsFor(d,scope){
  var steps=d.agentSteps||[];
  if(scope==='all')return steps;
  var v=(d.criterionVerdicts||[]).filter(function(x){return x.criterionId===scope;});
  return steps.filter(function(a){return stepExaminedByR(a,v);});
}
function sbsEvidence(a,d){
  if(d.evidenceObs&&a.obs&&d.evidenceObs.indexOf(String(a.obs))>=0)return true;
  return stepExaminedByR(a,d.criterionVerdicts||[]);
}
function sbsChipBar(d){
  var steps=d.agentSteps||[];var ev=steps.filter(function(a){return sbsEvidence(a,d);}).length;
  var chips='<button class="sbs-chip on" data-scope="all">All · '+steps.length+' steps · '+ev+' evidence</button>';
  (d.criterionVerdicts||[]).forEach(function(v){
    var n=sbsStepsFor(d,v.criterionId).length;var res=v.result||'na';var disp=res==='uncertain'?'indeterminate':res;
    chips+='<button class="sbs-chip" data-scope="'+esc(v.criterionId)+'" title="'+esc(v.critique||'')+'"><span class="cvb '+esc(res)+'">'+esc(disp)+'</span> '+esc(v.criterionId)+' · '+n+'</button>';
  });
  return '<div class="sbs-chips">'+chips+'</div>';
}
function renderSbsWindow(mount){
  var d=mount._d,scope=mount._scope;var steps=sbsStepsFor(d,scope);
  var scroll=mount.querySelector('.sbs-scroll'),sizer=mount.querySelector('.sbs-sizer'),win=mount.querySelector('.sbs-window');
  var cvAll=scope==='all'?(d.criterionVerdicts||[]):(d.criterionVerdicts||[]).filter(function(x){return x.criterionId===scope;});
  sizer.style.height=(steps.length*SBS_ROW_H)+'px';
  var top=scroll.scrollTop,h=scroll.clientHeight||440;
  var start=Math.max(0,Math.floor(top/SBS_ROW_H)-SBS_OVERSCAN);
  var count=Math.ceil(h/SBS_ROW_H)+SBS_OVERSCAN*2;var end=Math.min(steps.length,start+count);
  var html='';
  for(var i=start;i<end;i++){var a=steps[i];html+='<div class="srow'+(sbsEvidence(a,d)?' evidence':'')+'" data-step="'+esc(a.n)+'" style="height:'+SBS_ROW_H+'px">'+stepRowInnerR(a,cvAll,d.judgeSteps)+'</div>';}
  win.style.transform='translateY('+(start*SBS_ROW_H)+'px)';win.innerHTML=html;
  var meta=mount.querySelector('.sbs-meta');
  if(meta)meta.textContent=steps.length+' step(s) in scope · '+(steps.length?(end-start):0)+' in DOM (rows '+(steps.length?start+1:0)+'–'+end+') · virtualized window';
}
function renderSbsFull(mount){
  var d=mount._d,scope=mount._scope,full=mount.querySelector('.sbs-full');if(!full)return;
  if(scope==='all'){full.innerHTML='<div class="sbs-hint">Pick a criterion chip above to open its full side-by-side fragment (reused eval-report renderer).</div>';return;}
  var v=(d.criterionVerdicts||[]).filter(function(x){return x.criterionId===scope;});
  var steps=sbsStepsFor(d,scope);var dScoped={};for(var k in d)dScoped[k]=d[k];
  dScoped.agentSteps=steps;dScoped.criterionVerdicts=v;dScoped.traceId=mount.getAttribute('data-trace-id');
  full.innerHTML='<details class="sbs-fulldet" open><summary>criterion-scoped fragment · '+esc(scope)+' · '+steps.length+' step(s) (reused sideBySide)</summary>'+sideBySide(dScoped)+'</details>';
}
function mountSbs(mount){
  if(mount._wired)return;var tid=mount.getAttribute('data-trace-id');var d=SBS[tid];
  if(!d){mount.innerHTML='<div class="sbs-hint">no side-by-side data for this trace.</div>';mount._wired=true;return;}
  mount._d=d;mount._scope='all';mount._wired=true;
  mount.innerHTML=sbsChipBar(d)+
    '<div class="lanehdr"><div class="a">agent step — what it did</div><div class="x">#</div><div class="j">criteria that examined this step</div></div>'+
    '<div class="sbs-scroll"><div class="sbs-sizer"><div class="sbs-window"></div></div></div>'+
    '<div class="sbs-meta"></div><div class="sbs-full"></div>';
  var scroll=mount.querySelector('.sbs-scroll');
  scroll.addEventListener('scroll',function(){renderSbsWindow(mount);});
  mount.querySelectorAll('.sbs-chip').forEach(function(ch){ch.addEventListener('click',function(){
    mount.querySelectorAll('.sbs-chip').forEach(function(x){x.classList.remove('on');});ch.classList.add('on');
    mount._scope=ch.getAttribute('data-scope');scroll.scrollTop=0;renderSbsWindow(mount);renderSbsFull(mount);
  });});
  renderSbsWindow(mount);renderSbsFull(mount);
}
function sbsOnShow(i){var card=cards[i];if(!card)return;var m=card.querySelector('.sbs-mount');if(m)try{mountSbs(m);}catch(e){}}
function show(i){
  if(i<0)i=0;if(i>=cards.length)i=cards.length-1;cur=i;
  cards.forEach((c,k)=>c.hidden=k!==i);
  const id=ids[i];const rec=labels[id]||{};
  document.querySelectorAll('.verdict').forEach(b=>b.classList.toggle('active',b.dataset.v===rec.label));
  document.getElementById('notes').value=rec.notes||'';
  document.getElementById('jump').value=id;
  updateCounter();
  sbsOnShow(i);
}
function updateCounter(){
  const done=ids.filter(id=>labels[id]&&labels[id].label).length;
  const remaining=ids.length-done;
  document.getElementById('counter').textContent=(cur+1)+' of '+ids.length+' — '+done+' labeled, '+remaining+' remaining';
}
function setLabel(v){
  const id=ids[cur];
  const prev=labels[id]?{...labels[id]}:null;history.push({id,prev});
  labels[id]={traceId:id,label:v,notes:document.getElementById('notes').value,labeledAt:new Date().toISOString()};
  saveLabels(labels);show(cur); // auto-save on every action
}
function setNotes(){
  const id=ids[cur];const rec=labels[id]||{traceId:id};
  rec.notes=document.getElementById('notes').value;rec.labeledAt=new Date().toISOString();
  labels[id]=rec;saveLabels(labels); // auto-save notes too
}
function undo(){const h=history.pop();if(!h)return;if(h.prev)labels[h.id]=h.prev;else delete labels[h.id];saveLabels(labels);show(cur)}
function jumpTo(id){const i=ids.indexOf(id.trim());if(i>=0)show(i)}
function exportLabels(){
  const arr=Object.values(labels);
  const blob=new Blob([JSON.stringify(arr,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='human-labels.json';a.click();
}
// GA — capture a verify/eliminate calibration decision on a surfaced assumption.
function setCalib(traceId,criterionId,ai,action){
  const key=traceId+'#'+criterionId+'#'+ai;
  calib[key]={traceId,criterionId,assumptionIndex:Number(ai),action,decidedAt:new Date().toISOString()};
  saveCalib(calib);
}
function exportCalib(){
  const arr=Object.values(calib);
  const blob=new Blob([JSON.stringify(arr,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='calibration.json';a.click();
}
document.querySelectorAll('.calib').forEach(b=>b.addEventListener('click',()=>{
  const card=b.closest('.trace-card');const panel=b.closest('.ga-panel');
  setCalib(card.dataset.traceId,panel?panel.dataset.criterion:'',b.dataset.ai,b.dataset.action);
  b.classList.add('active');
}));
document.querySelectorAll('.verdict').forEach(b=>b.addEventListener('click',()=>setLabel(b.dataset.v)));
document.getElementById('notes').addEventListener('input',setNotes);
document.getElementById('prev').addEventListener('click',()=>show(cur-1));
document.getElementById('next').addEventListener('click',()=>show(cur+1));
document.getElementById('undo').addEventListener('click',undo);
document.getElementById('export').addEventListener('click',exportLabels);
{const ce=document.getElementById('export-calib');if(ce)ce.addEventListener('click',exportCalib);}
document.getElementById('jump').addEventListener('change',e=>jumpTo(e.target.value));
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT'){
    if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){setNotes();show(cur+1);e.preventDefault()}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){saveLabels(labels);e.preventDefault()}
    return;
  }
  if(e.key==='ArrowRight')show(cur+1);
  else if(e.key==='ArrowLeft')show(cur-1);
  else if(e.key==='1')setLabel('pass');
  else if(e.key==='2')setLabel('fail');
  else if(e.key.toLowerCase()==='d')setLabel('defer');
  else if(e.key.toLowerCase()==='u')undo();
  else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){saveLabels(labels);e.preventDefault()}
  else if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){show(cur+1);e.preventDefault()}
});
show(0);
`;
}

/**
 * Render the full annotation HTML document. DETERMINISTIC — byte-identical for
 * the same (traces, opts). The embedded client script carries the controls; the
 * trace cards are server-rendered (native format, escaped). Subject-agnostic.
 */
export function renderReviewUi(traces: EvalTrace[], opts: ReviewUiOptions = {}): string {
  const subjectName = opts.subjectName ?? "subject";
  const title = opts.title ?? `Trace review — ${subjectName}`;
  // stable storage key so labels namespace per subject (no clock/random).
  const storageKey = `mutagent-evaluator:review:${subjectName}`;
  const adj = opts.adjudications ?? {};
  const sbs = opts.sideBySide ?? {};
  const criteriaMeta = opts.criteriaMeta ?? {};
  const cards = traces
    .map((t, i) => renderTraceCard(t, i, subjectName, adj[t.id], sbs[t.id] !== undefined))
    .join("");
  const empty = traces.length === 0 ? `<p><em>No traces to review.</em></p>` : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
    `<header><strong>${esc(title)}</strong>` +
    `<span id="counter" class="counter"></span>` +
    `<span class="controls">` +
    `<button id="prev">◀ Prev</button><button id="next">Next ▶</button>` +
    `<button class="verdict pass" data-v="pass">Pass</button>` +
    `<button class="verdict fail" data-v="fail">Fail</button>` +
    `<button class="verdict defer" data-v="defer">Defer</button>` +
    `<button id="undo">Undo</button>` +
    `<input type="text" id="jump" placeholder="jump to trace id" aria-label="jump to trace id">` +
    `<button id="export">Download labels</button>` +
    `<button id="export-calib">Download calibration</button>` +
    `<span class="kbd">← → nav · 1 Pass · 2 Fail · D Defer · U Undo · ⌘S Save · ⌘⏎ Save&amp;Next</span>` +
    `</span></header>` +
    `<main>${empty}${cards}<textarea id="notes" placeholder="notes — what went wrong / right"></textarea></main>` +
    `<script>${clientScript(storageKey, jsonInject(sbs), jsonInject(criteriaMeta))}</script></body></html>`
  );
}

// ── labels persistence merge (deterministic — the script's only state op) ────

/**
 * Merge incoming labels into existing, deduped by traceId, LAST-WRITE-WINS
 * (incoming overrides existing for the same trace). DETERMINISTIC: result is
 * sorted by traceId so re-merges are byte-identical (no clock/random). This is
 * the persistence the script owns; the browser EXPORTS labels, this folds them
 * into the canonical labels file `*validate` reads.
 */
export function mergeLabels(existing: HumanLabel[], incoming: HumanLabel[]): HumanLabel[] {
  const byId = new Map<string, HumanLabel>();
  for (const l of existing) byId.set(l.traceId, l);
  for (const l of incoming) byId.set(l.traceId, l); // incoming wins
  return [...byId.values()].sort((a, b) => a.traceId.localeCompare(b.traceId));
}

export interface LabelStats {
  total: number;
  labeled: number;
  unlabeled: number;
  pass: number;
  fail: number;
  defer: number;
}

/**
 * Count labels against a trace universe. `deferred` labels count as "labeled"
 * for progress but are NOT pass/fail ground truth (excluded from TPR/TNR by
 * `*validate`). PURE.
 */
export function labelStats(traceIds: string[], labels: HumanLabel[]): LabelStats {
  const byId = new Map(labels.map((l) => [l.traceId, l]));
  let pass = 0;
  let fail = 0;
  let defer = 0;
  let labeled = 0;
  for (const id of traceIds) {
    const l = byId.get(id);
    if (l === undefined) continue;
    labeled++;
    if (l.label === "pass") pass++;
    else if (l.label === "fail") fail++;
    else if (l.label === "defer") defer++;
  }
  return { total: traceIds.length, labeled, unlabeled: traceIds.length - labeled, pass, fail, defer };
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
//
// bun scripts/build-review-ui.ts <input.json> [out.html]
// Reads { traces, subjectName?, title?, adjudications?, sideBySide?, criteriaMeta? }
// and writes the review HTML. This is the production caller the `*review`
// command's parent Bash invokes (references/build-review-interface.md).
declare const Bun: { argv: string[] } | undefined;

interface ReviewCliInput extends ReviewUiOptions {
  traces: EvalTrace[];
}

async function main(): Promise<void> {
  const argv = typeof Bun !== "undefined" ? Bun.argv.slice(2) : process.argv.slice(2);
  const [inputPath, outArg] = argv;
  if (!inputPath) {
    console.error("usage: build-review-ui.ts <input.json> [out.html]");
    process.exit(2);
    return;
  }
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as ReviewCliInput;
  const { traces, ...opts } = input;
  const outPath = outArg ?? "review.html";
  mkdirSync(dirname(outPath) || ".", { recursive: true });
  writeFileSync(outPath, renderReviewUi(traces ?? [], opts));
  console.info(`review UI written: ${outPath} (${(traces ?? []).length} trace(s))`);
  process.exit(0);
}

const isMain =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { main?: boolean }).main === true;
if (isMain) {
  void main();
}
