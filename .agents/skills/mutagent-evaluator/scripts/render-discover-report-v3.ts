/**
 * render-discover-report-v3 — the W3 FROZEN-CONTRACT discovery-report renderer.
 *
 * The template (`assets/templates/discover-report.template.html`) IS the
 * operator-signed mock (discovery-report-mock.html), derived mechanically by
 * `scripts/release/build-discover-template.ts` with named data slots — structure,
 * styles, the six tabs, the funnel, the heat grid, the criterion cards, the
 * trace-peek and the adoption handoff are the frozen contract verbatim. This
 * module ONLY computes the data: it maps the REAL `*discover` artifacts
 * (MinedCriterion[] + TraceAnnotation[] + the leaf mining report + EvalTrace[] +
 * dataset candidates + living-suite provenance) into the template's `ASTER`
 * shape and fills the slots.
 *
 * HONESTY RULES (hard — mirrors render-eval-report-v3):
 *  - nothing is invented — every number comes from a run artifact;
 *  - what the run does NOT produce renders as a NAMED absence (the sampling-strategy
 *    census, the saturation curve, the per-trace 3-lens tagging), never a
 *    fabricated number and never a silent blank;
 *  - caps are declared in-render ("showing first N"), never silent;
 *  - the sibling-eval-report deep link renders ONLY when that artifact exists.
 *
 * The v2 renderer (render-discover-report.ts) is untouched, and so is the v1
 * `*audit` world.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiscoverCategory, DiscoverMiningReport } from "./aggregate-discover.ts";
import { writeDiscoverReportFromFiles, type DiscoverIo } from "./render-discover-report.ts";
import type { TraceAnnotation } from "./discover-criteria.ts";
import type { DatasetCase } from "./contracts/dataset.ts";
import {
  NearDuplicateStatus,
  type NearDuplicateDecision,
  type NearDuplicateFinding,
  type NearDuplicateLedger,
} from "./merge-criteria.ts";
import { OutcomeVerdict, type EvalTrace, type MinedCriterion } from "./contracts/eval-types.ts";
// V11 audience contract — the ONE implementation, shared with the eval renderer.
// This surface had NO audience concept at all, so its ⑥ Methodology [INT] tab
// always shipped. See scripts/audience.ts for the full rule.
import { isExternal, stripInternalSurface, type Audience } from "./audience.ts";
import { renderRulingsBlock, type Ruling } from "./apply-rulings.ts";
import { DecisionKind, DecisionTargetKind } from "./decisions-store.ts";

const TEMPLATE_PATH = join(import.meta.dir, "../assets/templates/discover-report.template.html");

/* ── small pure helpers ────────────────────────────────────────────────────── */
const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const num = (n: number): string => n.toLocaleString("en-US");
/**
 * Display ids are shortened for the frozen contract's narrow chips — ALL-OR-
 * NOTHING across the corpus. Two real traces must never collapse onto one label
 * (`t-healthy-1`/`t-healthy-2` → `t-health` would make the peek open the wrong
 * session), so a single collision keeps EVERY id full: a per-id decision yields
 * a mixed strip where `t-card-e` sits next to `t-refund-unguarded-01` and the
 * shortened ones have lost the very words that told them apart. Opaque run ids
 * (uuids/hashes) all shorten; semantic ids all stay whole.
 */
function buildIdMap(ids: string[]): Map<string, string> {
  const shortOf = (id: string): string => (id.length > 10 ? id.slice(0, 8) : id);
  const shortened = new Set(ids.map(shortOf));
  const collides = shortened.size !== new Set(ids).size;
  return new Map(ids.map((id) => [id, collides ? id : shortOf(id)]));
}
const disp = (map: Map<string, string>, id: string): string => map.get(id) ?? id;
/** a NAMED absence — the run did not produce this; say so, never fake it. */
const absent = (what: string, why: string): string =>
  `<div class="nest"><b>${esc(what)}: not recorded by this run</b> — NAMED absence. ${esc(why)}</div>`;

/** one `.bar` row of the frozen contract (label · proportional track · value). */
function bar(label: string, value: string, frac: number, cls = ""): string {
  const w = Math.max(0, Math.min(100, Math.round(frac * 100)));
  return `<div class="bar"><span class="lab">${esc(label)}</span><div class="tr"><div class="fill${cls ? ` ${cls}` : ""}" style="width:${w}%"></div></div><b>${esc(value)}</b></div>`;
}

/* ── the template's client-side data shape ─────────────────────────────────── */
interface TemplateCriterion {
  id: string;
  slug: string;
  layer: string;
  cls: string;
  sev: string;
  statement: string;
  passDef: string;
  failDef: string;
  k: number;
  n: number;
}

interface TemplateStep {
  tool: string;
  args: string;
  output: string;
  verdicts: { crit: string; verdict: string; ref: { obs: string; path: string; value: string } | null }[];
}

interface TemplateTrace {
  id: string;
  fullId: string;
  scenario: string;
  gate: string;
  outcome: { verdict: string; expected: string; actual: string };
  steps: TemplateStep[];
  divergence?: string;
}

export interface DiscoverV3Input {
  subjectName: string;
  runId: string;
  /**
   * V11 — who the render is FOR. `external` strips the ⑥ Methodology surface (panel,
   * tab-bar entry AND its HTML comment marker) plus run-internal detail (run ids, the
   * gitignored artifact path). Verdicts, evidence, criteria and the dataset stay.
   * ABSENT ⇒ `internal` (the safe default for a dev-loop render; a client render must
   * ASK for external rather than getting it by omission).
   */
  audience?: Audience;
  /** the mined criteria — `aggregateDiscover().criteria`. */
  criteria: MinedCriterion[];
  /** the joined per-(category × trace) annotations — `aggregateDiscover().annotations`. */
  annotations: TraceAnnotation[];
  /** the leaf mining report — the per-trace ✓/✗ labels + the emergent categories. */
  miningReport?: DiscoverMiningReport;
  /** the INGESTED traces — the peek lane's ground truth (tool observations). */
  traces?: EvalTrace[];
  /** `aggregateDiscover().datasetCandidates` — the proposed regression cases. */
  datasetCandidates?: DatasetCase[];
  /** the grown living suite's provenance (append-only delta). */
  suite?: { version: number; total: number; lastAppended: number };
  /**
   * criterion id → `new` | `reinforced`, judged against the suite as it stood
   * BEFORE this run (`aggregateDiscover().criterionStates`). ABSENT ⇒ the report
   * renders a NAMED absence rather than calling everything new — a re-run that
   * only reinforced existing criteria must never read as fresh discovery.
   */
  criterionStates?: Record<string, string>;
  /**
   * Near-duplicate pairs the merge deliberately did NOT collapse
   * (`aggregateDiscover().mergePlan.findings`) — surfaced for the reader to rule
   * on, because a silent merge of two criteria whose evidence disagrees would
   * misrepresent both. Superseded by `nearDuplicateLedger` when that is supplied
   * (the ledger is the durable view and includes pairs from EARLIER runs).
   */
  nearDuplicates?: NearDuplicateFinding[];
  /**
   * The DURABLE near-duplicate decision ledger
   * (`aggregateDiscover().nearDuplicateLedger`). Preferred over `nearDuplicates`:
   * it carries pairs surfaced in PREVIOUS runs that are still unruled, plus how
   * many runs each has recurred for — the "nothing forgotten" surface.
   */
  nearDuplicateLedger?: NearDuplicateLedger;
  /** size of the SOURCE corpus before sampling — absent ⇒ NAMED absence in the funnel. */
  corpusTotal?: number;
  /** per-strategy sampling census — absent ⇒ NAMED absence in tab ②. */
  samplingCensus?: { strategy: string; n: number }[];
  /** the saturation batches — absent ⇒ NAMED absence in tab ②. */
  saturation?: { window: string; newKinds: number }[];
  /** the corpus source label (e.g. "unitf-jsonl"). */
  source?: string;
  /** ISO timestamp of the run — rendered top-right in the header. */
  generatedAt?: string;
  /** deep link to the sibling evaluation report — set ONLY when that file exists. */
  evalReportHref?: string;
  /** DEV ONLY: keep the feedback bar. Default OFF — user reports carry no feedback bar. */
  devFeedback?: boolean;
  /**
   * G5 — proposals SUPPRESSED because the operator already ruled on the same rule, from
   * `criterion-identity.ts`. Rendered in a collapsed "previously rejected" band with the
   * ORIGINAL reason and the recurrence count.
   *
   * SUPPRESSED, NEVER HIDDEN. The whole point of showing them is that a rejection can be
   * wrong: if the same behaviour keeps recurring with stronger evidence, the operator must
   * be able to see that and change their mind. Dropping them silently would make a bad
   * rejection permanent — the exact failure the decisions store exists to prevent.
   * ABSENT ⇒ the band does not render at all (byte-identical to pre-G5).
   */
  suppressed?: {
    /** the proposal that was suppressed. */
    statement: string;
    /** the prior ruling it matched. */
    matchedId: string;
    /** the operator's original reason for rejecting it. */
    reason: string;
    /** how many runs have now surfaced this behaviour. */
    timesSeen?: number;
  }[];
}

/* ── data mapping: real artifacts → the template's ASTER shape ─────────────── */

/** `prevalence` is an honest "k/n sampled" string; parse it, never invent it. */
function parsePrevalence(p: string, fallbackK: number): { k: number; n: number } {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(p);
  if (m !== null) return { k: Number.parseInt(m[1]!, 10), n: Number.parseInt(m[2]!, 10) };
  return { k: fallbackK, n: fallbackK };
}

function mapCriteria(criteria: MinedCriterion[]): TemplateCriterion[] {
  return criteria.map((c, i) => {
    const { k, n } = parsePrevalence(c.discovery.evidence.prevalence, c.supportCount);
    const cls =
      c.metadata.check_method === "deterministic" ? "code" : c.metadata.check_method === "hybrid" ? "hybrid" : "judge";
    // `statement` is the binary "Pass = …" sentence. The card already prints it in
    // full under "The check", so restating it verbatim as the pass definition just
    // says the same thing twice. A SEPARATE pass wording only exists if the mined
    // statement carried one; otherwise the absence is NAMED, never padded out.
    const passDef = c.statement.replace(/^\s*pass\s*=\s*/i, "").trim();
    const restates = passDef.length === 0 || c.statement.includes(passDef);
    // `discovery.targets` is auto-derived as "the '<id>' behavior/failure mode"
    // whenever the leaf authored no distinct target, which nests the criterion's
    // own name back into its fail definition ("… the guarded failure mode is
    // 'the X behavior/failure mode'"). Quote it only when it genuinely differs.
    const targets = c.discovery.targets;
    const derivedTarget = targets === `the '${c.id}' behavior/failure mode`;
    return {
      id: `C${i + 1}`,
      slug: c.id,
      layer: c.metadata.level,
      cls,
      sev: c.metadata.severity,
      statement: c.statement,
      passDef: restates
        ? "exactly the condition stated above — this run mined one binary statement; no separate pass wording was authored"
        : passDef,
      failDef: derivedTarget
        ? "the session does not satisfy that condition"
        : `the session does not satisfy that condition — the guarded failure mode is "${targets}"`,
      k,
      n,
    };
  });
}

/** serialize a real observation value for the peek lane (bounded, cap declared). */
function laneText(v: unknown, cap = 400): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > cap ? `${s.slice(0, cap)} … [+${s.length - cap} chars]` : s;
}

interface LabelMeta {
  verdict: string;
  firstThingWrong: string;
}

function mapTraces(
  input: DiscoverV3Input,
  crits: TemplateCriterion[],
  labels: Map<string, LabelMeta>,
  idMap: Map<string, string>,
): TemplateTrace[] {
  const bySlug = new Map(crits.map((c) => [c.slug, c]));
  // criterion ← trace bindings come from the JOINED annotations (category === criterion id).
  const annByTrace = new Map<string, TraceAnnotation[]>();
  for (const a of input.annotations) {
    const list = annByTrace.get(a.traceId) ?? [];
    list.push(a);
    annByTrace.set(a.traceId, list);
  }
  const traceById = new Map((input.traces ?? []).map((t) => [t.id, t]));
  // every trace the run READ gets a row: labelled traces first, then any ingested
  // trace without a label (named as unread rather than silently dropped).
  const ids = [...new Set([...labels.keys(), ...traceById.keys()])];

  return ids.map((id) => {
    const t = traceById.get(id);
    const meta = labels.get(id);
    const verdict = meta?.verdict ?? "unread";
    const gate =
      t?.incomplete === true || verdict === OutcomeVerdict.Uncertain
        ? "incomplete"
        : verdict === OutcomeVerdict.Fail
          ? "fail"
          : verdict === OutcomeVerdict.Pass
            ? "pass"
            : "incomplete";

    // REAL tool observations — the intake stores them reverse-chronologically.
    const toolObs = (t?.observations ?? []).filter((o) => o.type === "TOOL").reverse();
    // an observation that carried no input/output renders a NAMED absence, never
    // a silent blank (the peek must not imply "called with nothing").
    const steps: TemplateStep[] = toolObs.map((o) => ({
      tool: o.name ?? "(unnamed tool)",
      args: laneText(o.input, 160) || "(no input recorded on this observation)",
      output: laneText(o.output) || "(no output recorded on this observation)",
      verdicts: [],
    }));
    if (steps.length === 0)
      steps.push({
        tool: t === undefined ? "(trace body not carried into this report)" : "(no tool calls in this session)",
        output: laneText(t?.output?.response) || "—",
        args: "",
        verdicts: [],
      });

    // bind the criterion verdicts onto the terminal step (the decision surface):
    // *discover labels a SESSION, not a step, so there is no per-step anchor to claim.
    const last = steps[steps.length - 1]!;
    for (const a of annByTrace.get(id) ?? []) {
      const tc = a.category !== undefined ? bySlug.get(a.category) : undefined;
      if (tc === undefined) continue;
      if (a.label === OutcomeVerdict.Pass) continue; // the criterion did not fire here
      const r = (a.refs ?? [])[0];
      last.verdicts.push({
        crit: tc.id,
        verdict: a.label === OutcomeVerdict.Uncertain ? "uncertain" : "fail",
        ref: r !== undefined ? { obs: disp(idMap, r.obs), path: r.path, value: r.value } : null,
      });
    }

    const firstWrong = meta?.firstThingWrong ?? "";
    const failed = verdict === OutcomeVerdict.Fail || verdict === OutcomeVerdict.Uncertain;
    return {
      id: disp(idMap, id),
      fullId: id,
      scenario: t?.name ?? "(no scenario label recorded on the trace)",
      gate,
      outcome: {
        verdict: verdict === OutcomeVerdict.Pass ? "pass" : verdict === OutcomeVerdict.Fail ? "fail" : verdict,
        expected: failed
          ? "(no expected-exit is modeled by *discover — the outcome layer belongs to *evaluate)"
          : "no first-thing-wrong found by the determiner",
        actual: firstWrong.length > 0 ? firstWrong : "(no first-thing-wrong text recorded)",
      },
      steps,
      ...(failed && firstWrong.length > 0 ? { divergence: firstWrong } : {}),
    };
  });
}

/* ── HTML islands (server-rendered slots) ──────────────────────────────────── */

/**
 * EV-051 — a mined criterion carrying `fix_or_eval: "fixable->diagnostics"` is a
 * FIX handed to diagnostics, NOT an eval to adopt. It is mined, named and shown
 * in the cluster table, but it never enters the ④ "add these checks" catalog.
 */
const isRouted = (c: MinedCriterion): boolean =>
  c.discovery.fix_or_eval === "fixable->diagnostics" || c.flag === "fixable";

/* ── NEW · REINFORCED · MERGED — the redundancy story ──────────────────────── */

/** The three states a reader must be able to tell apart at a glance. */
interface RedundancyTally {
  /** minted by this run (id not in the pre-run suite). */
  fresh: number;
  /** already in the suite; this run attached further evidence. */
  reinforced: number;
  /** criteria that absorbed ≥1 near-duplicate. */
  merged: number;
  /** total ids folded away by those merges. */
  absorbed: number;
  /** OPEN near-duplicate questions awaiting a human ruling (durable). */
  pending: number;
  /** whether the run supplied per-criterion states at all (else NAMED absence). */
  stated: boolean;
}

function tallyRedundancy(input: DiscoverV3Input, criteria: MinedCriterion[]): RedundancyTally {
  const states = input.criterionStates;
  const merged = criteria.filter((c) => (c.mergedFrom ?? []).length > 0);
  const ledger = input.nearDuplicateLedger;
  return {
    fresh: states !== undefined ? criteria.filter((c) => states[c.id] === "new").length : 0,
    reinforced: states !== undefined ? criteria.filter((c) => states[c.id] === "reinforced").length : 0,
    merged: merged.length,
    absorbed: merged.reduce((n, c) => n + (c.mergedFrom ?? []).length, 0),
    pending:
      ledger !== undefined
        ? ledger.decisions.filter((d) => d.status === NearDuplicateStatus.Pending).length
        : (input.nearDuplicates ?? []).length,
    stated: states !== undefined,
  };
}

/** the state chip for one criterion — NEW / REINFORCED (+ MERGED when it absorbed). */
function stateChips(input: DiscoverV3Input, c: MinedCriterion): string {
  const out: string[] = [];
  const st = input.criterionStates?.[c.id];
  if (st === "new") out.push(`<span class="gb" style="color:var(--pass);background:var(--pass-bg)">NEW</span>`);
  else if (st === "reinforced")
    out.push(`<span class="gb" style="color:var(--primarySoft);background:rgba(126,71,215,.18)">REINFORCED</span>`);
  const from = c.mergedFrom ?? [];
  if (from.length > 0)
    out.push(
      `<span class="gb" style="color:var(--cyan);background:rgba(69,184,204,.16)">MERGED ←&nbsp;${esc(from.join(", "))}</span>`,
    );
  return out.join(" ");
}

/**
 * The PENDING near-duplicate decisions — the fourth state, alongside NEW /
 * REINFORCED / MERGED. These are pairs a guard refused to merge because merging
 * could misrepresent them, and they are DURABLE: recorded in the suite data with
 * a stable identity, so closing this report does not lose them and the next run
 * does not re-raise them as fresh discoveries.
 *
 * Prefers the ledger (which includes still-unruled pairs from EARLIER runs) and
 * falls back to this run's findings when only those were supplied.
 */
function pendingSection(input: DiscoverV3Input): string {
  const ledger = input.nearDuplicateLedger;
  const fromLedger: NearDuplicateDecision[] =
    ledger !== undefined ? ledger.decisions.filter((d) => d.status === NearDuplicateStatus.Pending) : [];
  // fallback shape when only this run's findings were passed (no durable ledger).
  const rows: {
    pair: string;
    similarity: number;
    guard: string;
    detail: string;
    sides: NearDuplicateFinding["sides"];
    times: number | null;
  }[] =
    ledger !== undefined
      ? fromLedger.map((d) => ({
          pair: `${d.pair[0]} ~ ${d.pair[1]}`,
          similarity: d.similarity,
          guard: d.guardSummary,
          detail: d.detail,
          sides: d.sides,
          times: d.timesSurfaced,
        }))
      : (input.nearDuplicates ?? []).map((f) => ({
          pair: `${f.a} ~ ${f.b}`,
          similarity: f.similarity,
          guard: f.guardSummary,
          detail: f.detail,
          sides: f.sides,
          times: null,
        }));

  if (rows.length === 0) {
    return ledger === undefined && (input.nearDuplicates ?? []).length === 0
      ? `<div style="font-family:var(--mono);font-size:12.5px;color:var(--primarySoft);margin:20px 0 8px">Open near-duplicate questions</div>
      <div class="nest">None. No pair of criteria was similar enough to raise a question this run.</div>`
      : "";
  }

  const out: string[] = [];
  out.push(
    `<div style="font-family:var(--mono);font-size:12.5px;color:var(--warn);margin:22px 0 8px">⚖ PENDING — open near-duplicate questions (${rows.length}) · your call, not the tool's</div>`,
  );
  out.push(
    `<p style="font-size:14px;color:var(--muted);margin:4px 0 10px;max-width:88ch">These pairs read alike, but a deterministic guard found a reason that merging them would MISREPRESENT the evidence. <b style="color:var(--fg)">Both criteria are kept and both are live</b> — nothing was collapsed and nothing was thrown away. Each row is a question only a human can settle, and it is <b style="color:var(--fg)">stored with the suite</b>, so it survives you closing this page and will not be re-raised as a new discovery next run.</p>`,
  );

  const cells = rows.map((r) => {
    const [x, y] = r.sides;
    const side = (s: NearDuplicateFinding["sides"][0]): string =>
      `<div style="margin:2px 0"><b>${esc(s.id)}</b> — “${esc(s.statement)}”<br><span style="color:var(--dim)">${esc(s.prevalence)} · ${s.refs.length} ref(s) · ${esc(s.traceIds.slice(0, 4).join(", "))}${s.traceIds.length > 4 ? ` +${s.traceIds.length - 4} more` : ""}</span></div>`;
    return `<tr><td><b>${esc(r.pair)}</b>${r.times !== null && r.times > 1 ? `<br><span class="gb" style="color:var(--warn);background:var(--warn-bg)">seen in ${r.times} runs</span>` : ""}</td><td>${Math.round(r.similarity * 100)}%</td><td><b>${esc(r.guard)}</b></td><td>${side(x)}${side(y)}</td></tr>`;
  });
  out.push(`<table class="ct"><tr><th>open question</th><th>wording overlap</th><th>what makes them different</th><th>both checks, verbatim — and the evidence behind each</th></tr>
        ${cells.join("\n        ")}
      </table>`);
  out.push(
    `<div class="nest">Ruling on these is the <b>calibration loop</b>'s job (review → validate → calibrate) — <b>that loop is NOT built yet</b>, so nothing in this skill acts on a ruling today. This report records the questions and the evidence to answer them; applying an answer is a NAMED not-yet-wired surface, not an implied capability.</div>`,
  );
  return out.join("\n      ");
}

/**
 * Tab ③'s redundancy block: what was collapsed, what was deliberately KEPT
 * apart, and why. This is the surface that lets a reader see the recommendations
 * are not restatements of each other.
 */
function redundancySection(input: DiscoverV3Input, criteria: MinedCriterion[], t: RedundancyTally): string {
  const out: string[] = [];
  out.push(
    `<div style="font-family:var(--mono);font-size:12.5px;color:var(--primarySoft);margin:24px 0 8px">Redundancy control — is this list restating itself?</div>`,
  );

  if (!t.stated) {
    out.push(
      absent(
        "new-vs-reinforced split",
        "This render was given no per-criterion state, so it cannot say which criteria are newly discovered and which already existed and merely gained evidence. The merge record below is still exact.",
      ),
    );
  }

  const mergedCriteria = criteria.filter((c) => (c.mergedFrom ?? []).length > 0);
  if (mergedCriteria.length > 0) {
    const rows = mergedCriteria.map((c) => {
      const from = c.mergedFrom ?? [];
      return `<tr><td><b>${esc(c.id)}</b></td><td>${esc(from.join(" · "))}</td><td>${from.length}</td><td>${esc(
        c.discovery.evidence.prevalence,
      )} · ${c.discovery.evidence.refs.length} ref(s)</td></tr>`;
    });
    out.push(`<table class="ct"><tr><th>surviving criterion</th><th>merged from (absorbed ids)</th><th>n</th><th>evidence after merge</th></tr>
        ${rows.join("\n        ")}
      </table>`);
    out.push(
      `<div class="nest"><b>${t.absorbed} duplicate id(s) folded into ${t.merged} criteri${t.merged === 1 ? "on" : "a"}</b> — the FIRST-SEEN id survives; every absorbed id is kept as a live alias so an older report or dataset recipe naming it still resolves. Evidence refs were UNIONED and the prevalence k/n RECOMPUTED over the combined trace set, never string-added. Nothing was discarded.</div>`,
    );
  } else {
    out.push(
      `<div class="nest">No two mined criteria were near-duplicates of each other in this run — the merge ran and found nothing to collapse (this is a real result, not a skipped step).</div>`,
    );
  }

  out.push(pendingSection(input));
  out.push(
    `<div class="nest">How the merge decides: deterministic token overlap of the binary statements (no LLM, no clock — the same batch always merges the same way), and a merge only proceeds when every guard clears. Similarity alone is never sufficient: "includes the account number" and "excludes the account number" overlap 60%, which is why the guards, not the score, hold the line.</div>`,
  );
  return out.join("\n      ");
}

interface Counts {
  corpus: number | undefined;
  sampled: number;
  read: number;
  pass: number;
  fail: number;
  uncertain: number;
  unread: number;
  clusters: number;
  routed: number;
  dropped: number;
  observed: number;
}

function samplingSection(input: DiscoverV3Input, c: Counts): string {
  const src = input.source ?? "the configured source (kind not recorded)";
  const out: string[] = [];
  out.push(`<div class="intro">
        <h4>Where the traces came from</h4>
        <p>${esc(input.subjectName)} sessions were read from <b>${esc(src)}</b> — the corpus is handed over to this skill
        (the evaluator never fetches). ${c.corpus !== undefined ? `The source corpus holds <b>${num(c.corpus)} sessions</b>; ` : ""}<b>${num(c.sampled)} session(s)</b>
        entered this discovery run and <b>${num(c.read)}</b> were deep-read by the determiner.</p>
      </div>`);

  out.push(`<div class="h4s">How we chose what to read</div>`);
  if (input.samplingCensus !== undefined && input.samplingCensus.length > 0) {
    const max = Math.max(...input.samplingCensus.map((s) => s.n), 1);
    out.push(
      `<p style="font-size:14px;color:var(--muted);margin:4px 0 12px;max-width:84ch">Each strategy hunts a different kind of interesting session; together they keep the mined criteria from skewing to one failure shape.</p>`,
    );
    for (const s of input.samplingCensus) out.push(bar(s.strategy, String(s.n), s.n / max));
  } else {
    out.push(
      absent(
        "sampling strategy census",
        "This run received its trace batch already selected, so no per-strategy selection census was written. The batch actually read is fully accounted for below.",
      ),
    );
  }

  out.push(`<div class="h4s">Success/failure balance of what we read</div>
      <p style="font-size:14px;color:var(--muted);margin:4px 0 10px;max-width:84ch">Failures teach what breaks; successes teach what "correct" looks like — including restraint criteria (things the agent rightly did NOT do).</p>`);
  const readMax = Math.max(c.read, 1);
  out.push(bar("agent succeeded ✓", String(c.pass), c.pass / readMax, "g"));
  out.push(bar("agent failed ✗", String(c.fail), c.fail / readMax, "r"));
  if (c.uncertain > 0) out.push(bar("undecided ?", String(c.uncertain), c.uncertain / readMax, "c"));
  if (c.unread > 0) out.push(bar("sampled, not deep-read", String(c.unread), c.unread / readMax));

  out.push(`<div class="h4s">When we stopped reading — saturation</div>`);
  if (input.saturation !== undefined && input.saturation.length > 0) {
    const max = Math.max(...input.saturation.map((s) => s.newKinds), 1);
    for (const s of input.saturation) out.push(bar(s.window, `${s.newKinds} new`, s.newKinds / max));
  } else {
    out.push(
      absent(
        "saturation curve",
        "No batch-by-batch new-failure-kind curve was recorded for this run, so no stopping point can be claimed. The whole handed-over batch was read.",
      ),
    );
  }
  return out.join("\n      ");
}

function walkSection(
  input: DiscoverV3Input,
  crits: TemplateCriterion[],
  c: Counts,
  evalCriteria: MinedCriterion[],
  tally: RedundancyTally,
): string {
  const out: string[] = [];
  // the discriminator this run ACTUALLY records per failure is the failure CLASS
  // (behavioral vs infra) — the mock's 3 detect lenses are not a recorded field.
  const cls = new Map<string, number>();
  for (const a of input.annotations) {
    if (a.label === OutcomeVerdict.Pass) continue;
    const k = a.failureClass ?? "unclassified";
    cls.set(k, (cls.get(k) ?? 0) + 1);
  }
  out.push(
    `<div style="font-family:var(--mono);font-size:12.5px;color:var(--primarySoft);margin:4px 0 8px">Failure-class split (over the ${c.fail + c.uncertain} failed/undecided session(s))</div>`,
  );
  if (cls.size > 0) {
    const max = Math.max(...cls.values(), 1);
    const fill: Record<string, string> = { behavioral: "r", infra: "c", unclassified: "" };
    for (const [k, n] of [...cls.entries()].sort((a, b) => b[1] - a[1]))
      out.push(bar(`${k} findings`, String(n), n / max, fill[k] ?? ""));
  } else {
    out.push(absent("failure-class split", "No failed/undecided session carried a category annotation in this run."));
  }
  out.push(
    absent(
      "per-trace detect-lens tagging (drift · tool-output · missing-context)",
      "The leaf mining report records a failure CLASS per category, not a lens per trace — the split above is the discriminator this run genuinely recorded.",
    ),
  );

  out.push(
    `<div style="font-family:var(--mono);font-size:12.5px;color:var(--primarySoft);margin:24px 0 8px">Emergent clusters (${c.clusters}) → criteria (${crits.length}) + routed (${c.routed}) + dropped (${c.dropped})</div>`,
  );
  const cats = input.miningReport?.categories ?? [];
  if (cats.length > 0) {
    const bySlug = new Map(crits.map((x) => [x.slug, x]));
    const rows = cats.map((cat: DiscoverCategory) => {
      const tc = bySlug.get(cat.name);
      const mined = input.criteria.find((x) => x.id === cat.name);
      // a cluster whose id was ABSORBED by the merge did not vanish — say where it went.
      const absorbedBy = input.criteria.find((x) => (x.mergedFrom ?? []).includes(cat.name));
      const became =
        tc !== undefined
          ? `${esc(tc.id)} ${esc(tc.slug)} <span class="gb ${esc(mined?.discovery.evidence.grounding === "observed" ? "observed" : "inferred")}">${esc(mined?.discovery.evidence.grounding ?? "observed")}</span> ${mined !== undefined ? stateChips(input, mined) : ""}`
          : absorbedBy !== undefined
            ? `<span style="color:var(--cyan)">merged into <b>${esc(absorbedBy.id)}</b></span> — same behaviour under a second name; its evidence rides on that criterion`
            : mined !== undefined
            ? `<span style="color:var(--warn)">→ diagnostics (EV-051) — mined, then routed as a FIX; deliberately NOT in the ④ catalog</span>`
            : cat.fixOrEval === "fixable"
              ? `<span style="color:var(--warn)">→ diagnostics (infra, not eval-worthy — EV-051)</span>`
              : `<span style="color:var(--dim)">dropped — no criterion minted</span>`;
      return `<tr><td><b>${esc(cat.name)}</b></td><td>${cat.exampleTraceIds.length}</td><td>${esc(cat.class)}</td><td>${became}</td></tr>`;
    });
    out.push(
      `<table class="ct"><tr><th>cluster</th><th>n</th><th>class</th><th>became</th></tr>\n        ${rows.join("\n        ")}\n      </table>`,
    );
  } else {
    out.push(
      absent(
        "emergent cluster table",
        "No leaf mining report was supplied to this render, so the per-category clustering cannot be shown; the criteria below still carry their own evidence.",
      ),
    );
  }
  out.push(
    `<div class="nest">emergent-only guard: categories come from the leaf mining report's OWN clustering — the engine seeds no pre-defined category list (deriveCriteria groups by the emitted category name).</div>`,
  );
  if (c.routed > 0)
    out.push(
      `<div class="nest"><b>${c.routed} mined criteri${c.routed === 1 ? "on carries" : "a carry"} the fixable→diagnostics flag</b> — named here on purpose and deliberately ABSENT from the ④ catalog. EV-051: the evaluator judges and routes, it never adopts a fix as an eval.</div>`,
    );
  out.push(redundancySection(input, evalCriteria, tally));
  return out.join("\n      ");
}

function layerCoverage(
  evalCriteria: MinedCriterion[],
  crits: TemplateCriterion[],
  t: RedundancyTally,
): string {
  const byLayer = new Map<string, number>();
  for (const c of crits) byLayer.set(c.layer, (byLayer.get(c.layer) ?? 0) + 1);
  // the redundancy read comes FIRST — it is the question a reader asks of a
  // recommendation list before they read any single card.
  const state: string[] = [];
  if (t.stated) {
    state.push(
      `<i style="border-color:var(--pass);color:var(--pass)">NEW this run <b style="color:var(--pass)">${t.fresh}</b></i>`,
    );
    state.push(
      `<i style="border-color:rgba(126,71,215,.6);color:var(--primarySoft)">REINFORCED <b style="color:var(--primarySoft)">${t.reinforced}</b></i>`,
    );
  } else {
    state.push(`<i>new-vs-reinforced split <b>not recorded by this run</b> — NAMED absence</i>`);
  }
  state.push(
    t.merged > 0
      ? `<i style="border-color:var(--cyan);color:var(--cyan)">MERGED near-duplicates <b style="color:var(--cyan)">${t.merged}</b> (absorbed ${t.absorbed} duplicate id${t.absorbed === 1 ? "" : "s"})</i>`
      : `<i>near-duplicates merged <b>0</b> — no criterion restated another</i>`,
  );
  if (t.pending > 0)
    state.push(
      `<i style="border-color:var(--warn);color:var(--warn)">PENDING your ruling <b style="color:var(--warn)">${t.pending}</b> (kept apart, kept open — tab ③)</i>`,
    );
  const codeish = evalCriteria.filter(
    (c) => c.metadata.check_method === "deterministic" || c.metadata.check_method === "hybrid",
  );
  const chips = [...byLayer.entries()].map(([l, n]) => `<i>${esc(l)} <b>${n}</b></i>`);
  if (chips.length === 0) chips.push(`<i>no criterion carries an evidence level — NAMED absence</i>`);
  const code =
    codeish.length > 0
      ? `<i style="border-color:var(--cyan);color:var(--cyan)">+ code-checkable candidates <b style="color:var(--cyan)">${codeish.length}</b> (${esc(codeish.map((c) => c.id).slice(0, 3).join(" · "))}${codeish.length > 3 ? ` +${codeish.length - 3} more` : ""} → deterministic/hybrid check_method)</i>`
      : `<i>code-checkable candidates <b>0</b> — every mined criterion routed to the judge track</i>`;
  return `<i>how this list relates to the suite you already have:</i>
        ${state.join("")}
        <i>checks discovered per evidence layer:</i>
        ${chips.join("")}
        ${code}`;
}

function datasetSection(
  input: DiscoverV3Input,
  labels: Map<string, LabelMeta>,
  idMap: Map<string, string>,
  c: Counts,
  evalCount: number,
): string {
  const out: string[] = [];
  const cases = input.datasetCandidates ?? [];
  const CAP = 25;
  if (cases.length > 0) {
    const rows = cases.slice(0, CAP).map((cs) => {
      const origin = cs.originTraceId;
      const meta = origin !== undefined ? labels.get(origin) : undefined;
      const judged =
        meta?.verdict === OutcomeVerdict.Fail
          ? `<span class="sev CRIT" style="background:var(--fail-bg);color:var(--fail)">✗ FAILED</span>`
          : meta?.verdict === OutcomeVerdict.Uncertain
            ? `<span class="sev HIGH" style="background:var(--warn-bg);color:var(--warn)">? UNDECIDED</span>`
            : meta?.verdict === OutcomeVerdict.Pass
              ? `<span class="sev LOW">✓ passed</span>`
              : `<span class="sev LOW">(label not carried)</span>`;
      const originCell =
        origin !== undefined
          ? `<span class="origin" onclick="peekTrace(event,'${esc(disp(idMap, origin))}')">${esc(disp(idMap, origin))} ▸</span>`
          : "<i>(synthetic — no origin trace)</i>";
      const happened =
        meta !== undefined && meta.firstThingWrong.length > 0
          ? esc(meta.firstThingWrong)
          : "<i>no first-thing-wrong text recorded for this origin session — NAMED absence</i>";
      // the selector's own wording already fills the LAST column — repeating it
      // here turned the widest column into a duplicate of the narrowest one.
      const prevents =
        cs.rationale !== undefined && cs.rationale.length > 0
          ? esc(cs.rationale)
          : `<i>no authored rationale — this case was picked deterministically by the selector named in the last column; the judgment of what it prevents is not written by this run</i>`;
      const recipe = Object.entries(cs.tuple as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(" · ");
      return `<tr><td>${originCell}</td><td>${judged}</td><td>${happened}</td><td>${prevents}</td><td>${esc(recipe) || "<i>(no tuple recorded)</i>"}</td><td>${esc(cs.selectedBy ?? "—")}</td></tr>`;
    });
    out.push(`<table class="ct"><tr><th>origin</th><th>judged as</th><th>what happened in the origin session</th><th>what the test case will represent &amp; prevent</th><th>case recipe — the ingredients the synthetic case combines</th><th>selected by</th></tr>
        ${rows.join("\n        ")}
      </table>`);
    if (cases.length > CAP)
      out.push(
        `<div class="nest">showing the first ${CAP} of ${cases.length} candidate cases — a DECLARED cap; the full set rides in <b>dataset-candidates.json</b>.</div>`,
      );
  } else {
    out.push(
      absent(
        "regression-case candidates",
        "No ✗/undecided session in this batch carried a replayable input, so no regression case could be distilled.",
      ),
    );
  }
  out.push(
    `<div style="font-family:var(--mono);font-size:12.5px;color:var(--primarySoft);margin:24px 0 8px">Living-suite delta (append-only)</div>`,
  );
  const s = input.suite;
  // the suite grows by EVERY mined criterion — including the ones routed to
  // diagnostics. Naming the split stops "+N appended" from reading as "N evals".
  const split =
    c.routed > 0 ? ` — ${evalCount} eval-worthy + ${c.routed} routed to diagnostics (both kept, with provenance)` : "";
  out.push(
    s !== undefined
      ? `<div class="row"><span class="ok">+${s.lastAppended}</span> criteria appended${esc(split)} · suite total ${s.total} · version ${s.version} · monotonic-growth assert ✓ (growLivingSuite is append-only)</div>`
      : absent("living-suite delta", "No suite provenance was passed to this render — the append-only growth cannot be claimed."),
  );
  return out.join("\n      ");
}

function methodologySection(
  input: DiscoverV3Input,
  crits: TemplateCriterion[],
  c: Counts,
  labels: Map<string, LabelMeta>,
  idMap: Map<string, string>,
): string {
  const src = input.source ?? "(source kind not recorded)";
  const mono = (t: string, mt = 24): string =>
    `<div style="font-family:var(--mono);font-size:12.5px;color:var(--primarySoft);margin:${mt}px 0 8px">${t}</div>`;
  const rows: string[] = [
    `<tr><td>1</td><td>collect representative traces</td><td>${c.corpus !== undefined ? `${num(c.corpus)} in the source corpus; ` : ""}${num(c.sampled)} handed over via ${esc(src)} (the skill never fetches)</td><td>corpus bound by role from config sources</td></tr>`,
    `<tr><td>2</td><td>sample for deep read</td><td>${input.samplingCensus !== undefined ? `${input.samplingCensus.length} strategies (tab ②)` : "<b>no selection census recorded</b> — NAMED absence (tab ②)"}</td><td>${num(c.read)} deep-read</td></tr>`,
    `<tr><td>3</td><td>determine outcome per trace</td><td>#mode-discover leaf subagents, host runtime, pinned temperature 0</td><td>${c.pass} ✓ · ${c.fail} ✗${c.uncertain > 0 ? ` · ${c.uncertain} ?` : ""}</td></tr>`,
    `<tr><td>4</td><td>classify each failure</td><td>failure CLASS per category (behavioral vs infra); the 3-lens per-trace tagging is a NAMED absence (tab ③)</td><td>${c.fail + c.uncertain} failure read(s) classified</td></tr>`,
    `<tr><td>5</td><td>cluster emergent categories</td><td>categories come from the leaf mining report's own clustering — no pre-seeded list</td><td>${c.clusters} cluster(s)</td></tr>`,
    `<tr><td>6</td><td>fix-worthy vs eval-worthy</td><td>EV-051: <b>fixable</b> categories are routed to diagnostics, never minted as evals</td><td>${crits.length} criteri${crits.length === 1 ? "on" : "a"} + ${c.routed} routed${c.dropped > 0 ? ` + ${c.dropped} dropped` : ""}</td></tr>`,
    `<tr><td>7</td><td>iterate to saturation</td><td>${input.saturation !== undefined ? "saturation curve recorded (tab ②)" : "<b>no saturation curve recorded</b> — NAMED absence; the whole handed-over batch was read"}</td><td>${c.unread === 0 ? "batch fully read" : `${c.unread} sampled session(s) not deep-read`}</td></tr>`,
  ];

  // one WORKED example — composed ONLY from fields the run actually recorded.
  const failing = input.annotations.find((a) => a.label === OutcomeVerdict.Fail);
  const worked =
    failing !== undefined
      ? (() => {
          const meta = labels.get(failing.traceId);
          const ref = (failing.refs ?? [])[0];
          const tc = crits.find((x) => x.slug === failing.category);
          return `<div class="nest" style="font-family:var(--font);font-size:14px;line-height:1.65">
        <b>${esc(disp(idMap, failing.traceId))}.</b> Determiner verdict: <b>✗ fail</b>. First thing wrong: ${esc(meta?.firstThingWrong ?? failing.note ?? "(not recorded)")}
        Failure class: ${esc(failing.failureClass ?? "unclassified")}. ${ref !== undefined ? `Ref bound: <b>${esc(ref.obs)}</b> ${esc(ref.path)} = "${esc(String(ref.value).slice(0, 120))}" (re-resolved by exact match ✓).` : "No structured ref was cited for this trace — the criterion's grounding rests on its other refs."}
        Cluster: <b>${esc(failing.category ?? "(uncategorized)")}</b>. Emitted → ${tc !== undefined ? `<b>${esc(tc.id)} ${esc(tc.slug)}</b>, severity ${esc(tc.sev)}, checked by ${esc(tc.cls)}, layer ${esc(tc.layer)}` : "no criterion (routed or dropped)"}.
      </div>`;
        })()
      : absent("worked trace read", "No ✗-labelled session with an annotation is present in this run.");

  const observedPct = crits.length > 0 ? Math.round((100 * c.observed) / crits.length) : 0;
  return `${mono("Process as executed — the 7-step error analysis, this run", 6)}
      <table class="ct"><tr><th>#</th><th>step</th><th>this run</th><th>outcome</th></tr>
        ${rows.join("\n        ")}
      </table>

      ${mono("Provenance — which machinery produced which number")}
      <table class="ct"><tr><th>figure</th><th>producer</th><th>kind</th></tr>
        <tr><td>funnel + heat counts (①)</td><td>render-discover-report-v3 over aggregateDiscover() output</td><td>deterministic fold</td></tr>
        <tr><td>read balance (②)</td><td>per-trace determiner verdict files (#mode-discover leaves)</td><td>LLM judge (pinned, temp 0)</td></tr>
        <tr><td>cluster map (③)</td><td>leaf mining report categories · parseDiscoverAnnotations join</td><td>LLM clustering + deterministic join</td></tr>
        <tr><td>criterion cards (④)</td><td>deriveMinedCriteria (§5b metadata + §5c DR-2) · parseMinedCriterion evidence gate</td><td>deterministic fold of judge output</td></tr>
        <tr><td>dataset candidates (⑤)</td><td>collectDatasetCandidates → deriveRegressionCases (EV-052 selectors)</td><td>deterministic selectors</td></tr>
        <tr><td>living-suite Δ (⑤)</td><td>growLivingSuite — appendOnly + assertMonotonicGrowth</td><td>deterministic, append-only</td></tr>
      </table>

      ${mono("Proof of work — one fully worked trace read")}
      ${worked}

      ${mono("Self-checks and honest gaps")}
      <div class="row"><span class="ok">P1</span> evidence-first gate: every mined criterion re-validated through parseMinedCriterion (OBSERVED ⇒ refs ∧ k&gt;0) — ${c.observed}/${crits.length} observed (${observedPct}%)</div>
      <div class="row"><span class="ok">P2</span> judge-only (EV-051): ${c.routed} mined criteri${c.routed === 1 ? "on" : "a"} flagged fixable→diagnostics and kept OUT of the ④ catalog — this skill fixes nothing</div>
      <div class="row"><span class="ok">P3</span> determinism: the AGGREGATE fold is pure (no clock/random/network) — the same verdict files re-render byte-identically</div>
      <div class="row"><span class="w">G1</span> gap: ${num(c.read)} session(s) deep-read in a single batch — criteria are ${esc(input.subjectName)}-specific until a second-batch transfer check</div>
      ${input.samplingCensus === undefined ? `<div class="row"><span class="w">G2</span> gap: no sampling-strategy census — selection bias of the handed-over batch cannot be audited from this artifact</div>` : ""}
      ${input.saturation === undefined ? `<div class="row"><span class="w">G3</span> gap: no saturation curve — this run cannot claim the discovery reached saturation</div>` : ""}`;
}

/** the adoption handoff markdown — the mock's shape, this run's real content. */
function adoptionMd(input: DiscoverV3Input, crits: TemplateCriterion[], c: Counts): string {
  const L: string[] = [];
  L.push(`# Eval Adoption Handoff — ${input.subjectName}${isExternal(input) ? "" : ` · ${input.runId}`}`);
  L.push(`**From:** discovery run · **To:** operator / eval-suite maintainer`);
  L.push(
    `**Deliverable:** ${crits.length} binary criteria + ${(input.datasetCandidates ?? []).length} regression-case candidate(s) + ${c.routed} diagnostics route(s)`,
  );
  L.push("");
  const bySlug = new Map(input.criteria.map((m) => [m.id, m]));
  for (const t of crits) {
    const m = bySlug.get(t.slug);
    if (m === undefined) continue;
    const st = input.criterionStates?.[m.id];
    const from = m.mergedFrom ?? [];
    const badge = [
      st === "new" ? "NEW" : st === "reinforced" ? "REINFORCED (already in your suite; gained evidence this run)" : null,
      from.length > 0 ? `MERGED from ${from.join(", ")} (those ids still resolve to this criterion)` : null,
    ].filter((x) => x !== null);
    L.push(`## ${t.id} — ${t.slug}`);
    if (badge.length > 0) L.push(`**Status:** ${badge.join(" · ")}`);
    L.push(`**Check:** ${t.statement}`);
    L.push(
      `**Layer:** ${t.layer} · **Checked by:** ${t.cls} · **Severity:** ${t.sev} · **Gates:** ${t.sev === "CRIT" || t.sev === "HIGH" ? "YES" : "no (advisory)"}`,
    );
    L.push(`**Guards against:** ${m.discovery.targets}`);
    L.push(`**Why it matters:** ${m.discovery.why_problem}`);
    L.push(
      `**Evidence:** ${m.discovery.evidence.grounding} · prevalence ${m.discovery.evidence.prevalence} · ${m.discovery.evidence.refs.length} structured ref(s)`,
    );
    L.push("");
  }
  L.push("## Routed to diagnostics (NOT evals — EV-051)");
  const routed = input.criteria.filter(isRouted);
  L.push(
    routed.length > 0
      ? routed.map((x) => `- ${x.id} — ${x.discovery.targets} (mined, routed as a fix; never adopted as an eval)`).join("\n")
      : "- none in this run",
  );
  L.push("");
  // PENDING travels with the handoff — the questions must not be trapped in the
  // HTML, since this markdown is what gets pasted into an issue or a review.
  const pending =
    input.nearDuplicateLedger !== undefined
      ? input.nearDuplicateLedger.decisions.filter((d) => d.status === NearDuplicateStatus.Pending)
      : [];
  L.push("## Open near-duplicate questions (PENDING your ruling)");
  if (pending.length > 0) {
    for (const d of pending) {
      L.push(
        `- **${d.pair[0]} ~ ${d.pair[1]}** — ${Math.round(d.similarity * 100)}% wording overlap, kept apart (${d.guardSummary})${d.timesSurfaced > 1 ? ` · seen in ${d.timesSurfaced} runs` : ""}`,
      );
      for (const s of d.sides) L.push(`    - \`${s.id}\`: "${s.statement}" (${s.prevalence}, ${s.refs.length} ref(s))`);
    }
    L.push("");
    L.push(
      "  Both criteria in each pair are LIVE — nothing was merged or dropped. These are stored with the suite and stay open until ruled on.",
    );
  } else if (input.nearDuplicateLedger !== undefined) {
    L.push("- none open");
  } else {
    L.push("- not recorded by this run — NAMED absence (no near-duplicate ledger was passed to this render)");
  }
  L.push("");
  // G5 — proposals suppressed because the operator already ruled on the same rule.
  // Travels in the MARKDOWN, not only the HTML: this is what gets pasted into an issue,
  // and a suppression the reader cannot see is indistinguishable from a proposal that was
  // never made.
  if ((input.suppressed ?? []).length > 0) {
    L.push("## Previously rejected — suppressed, not hidden");
    L.push(
      "These behaviours were found again this run, but you have already ruled on the same rule. " +
        "They are listed rather than dropped so that a rejection you now disagree with can be revisited — " +
        "a silent drop would make a wrong rejection permanent.",
    );
    L.push("");
    for (const s of input.suppressed ?? []) {
      L.push(
        `- "${s.statement}" — matches \`${s.matchedId}\`, rejected: ${s.reason}` +
          (s.timesSeen !== undefined && s.timesSeen > 1 ? ` · seen again in ${s.timesSeen} runs` : ""),
      );
    }
    L.push("");
  }
  L.push("### Next steps");
  L.push("1. Approve criteria → living suite append (provenance kept)");
  L.push("2. `*build-dataset` from the candidate recipes");
  L.push("3. `*evaluate` with the grown suite (pinned) → baseline scorecard");
  return L.join("\n");
}

/**
 * G4 — the RULINGS block for this discovery run: one accept/reject line per proposal,
 * pre-filled to `accept`, wrapped in the self-contained instruction the receiver needs.
 *
 * Pre-filling to accept is deliberate and stated in the block: a discovery run only
 * proposes what its evidence supports, so accept is the common case and the operator edits
 * the exceptions. The alternative — pre-filling to reject — would make an unedited paste
 * silently tombstone the whole run's findings, which is the worst possible default.
 *
 * The statement rides on EVERY ruling, not just rejects, because a reject without one is
 * refused by the parser: a tombstone is matched by meaning, and without its statement it
 * silently stops preventing the rediscovery it exists for.
 */
function rulingsBlockMd(input: DiscoverV3Input, crits: TemplateCriterion[]): string {
  const byId = new Map(input.criteria.map((m) => [m.id, m]));
  const rulings = crits
    .map((t) => byId.get(t.slug))
    .filter((m): m is MinedCriterion => m !== undefined)
    .map((m): Ruling => ({
      target: m.id,
      kind: DecisionKind.Accept,
      targetKind: DecisionTargetKind.Criterion,
      statement: m.statement,
    }));
  // open near-duplicate questions are rulings too — the pair either IS one check or is not.
  for (const d of (input.nearDuplicateLedger?.decisions ?? []).filter(
    (x) => x.status === NearDuplicateStatus.Pending,
  )) {
    rulings.push({
      target: d.id,
      kind: DecisionKind.Accept,
      targetKind: DecisionTargetKind.NearDuplicatePair,
      statement: `${d.pair[0]} ~ ${d.pair[1]} — ${d.guardSummary}`,
    });
  }
  return renderRulingsBlock({ runId: input.runId, surface: "discover", rulings });
}

/* ── the renderer ──────────────────────────────────────────────────────────── */
export function renderDiscoverReportV3(input: DiscoverV3Input): string {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  // EV-051 split: only eval-worthy criteria are RECOMMENDED (the ④ catalog); the
  // routed ones stay visible in the cluster table + counts, never in the catalog.
  const evalCriteria = input.criteria.filter((c) => !isRouted(c));
  const routedCriteria = input.criteria.filter(isRouted);
  const crits = mapCriteria(evalCriteria);
  const tally = tallyRedundancy(input, evalCriteria);

  // per-trace labels — the leaf mining report is the canonical ✓/✗ record.
  const labels = new Map<string, LabelMeta>();
  for (const l of input.miningReport?.labels ?? [])
    labels.set(l.traceId, { verdict: l.verdict, firstThingWrong: l.firstThingWrong });
  // annotations cover traces a category referenced; they never overwrite a label.
  for (const a of input.annotations)
    if (!labels.has(a.traceId)) labels.set(a.traceId, { verdict: a.label, firstThingWrong: a.note ?? "" });

  const idMap = buildIdMap([...new Set([...labels.keys(), ...(input.traces ?? []).map((t) => t.id)])]);
  const traces = mapTraces(input, crits, labels, idMap);
  const vals = [...labels.values()];
  const pass = vals.filter((v) => v.verdict === OutcomeVerdict.Pass).length;
  const fail = vals.filter((v) => v.verdict === OutcomeVerdict.Fail).length;
  const uncertain = vals.filter((v) => v.verdict === OutcomeVerdict.Uncertain).length;
  const sampled = Math.max(labels.size, (input.traces ?? []).length);
  const cats = input.miningReport?.categories ?? [];
  const counts: Counts = {
    corpus: input.corpusTotal,
    sampled,
    read: labels.size,
    pass,
    fail,
    uncertain,
    unread: Math.max(0, sampled - labels.size),
    clusters: cats.length > 0 ? cats.length : new Set(input.criteria.map((x) => x.id)).size,
    routed: routedCriteria.length,
    // a cluster that minted NO criterion at all (neither eval nor routed).
    dropped: cats.filter((x) => !input.criteria.some((m) => m.id === x.name)).length,
    observed: evalCriteria.filter((x) => x.discovery.evidence.grounding === "observed").length,
  };

  const heat = { readp: pass, readf: fail + uncertain, samp: counts.unread };
  const funnelStages: [string, string, string][] = [
    [
      "corpus",
      counts.corpus !== undefined ? num(counts.corpus) : num(sampled),
      counts.corpus !== undefined ? `all ${esc(input.source ?? "source")} traces` : "source corpus size not recorded",
    ],
    ["sampled", num(sampled), "handed to *discover"],
    ["deep-read", num(counts.read), `✓${pass} / ✗${fail}${uncertain > 0 ? ` / ?${uncertain}` : ""}`],
    ["clusters", num(counts.clusters), cats.length > 0 ? "emergent" : "from mined criteria"],
    ["criteria", num(crits.length), `binary · ${counts.observed} observed`],
    ["→ diagnostics", num(counts.routed), "EV-051 routed (not evals)"],
  ];

  const clusters: Record<string, string> = {};
  for (const t of crits) clusters[t.id] = t.slug;

  const data = {
    criteria: crits,
    traces,
    clusters,
    funnelStages,
    heat,
    adoptionMd: adoptionMd(input, crits, counts),
    // G4 — the copy-paste rulings block: a self-contained instruction, payload inside.
    // INTERNAL ONLY. Ruling on proposals is the operator's calibration surface, not
    // something a client acts on, and the block necessarily carries the run id — which the
    // external audience contract forbids. Emitting it externally was caught by the
    // existing run-id leak check, which is exactly what that check is for.
    rulingsMd: isExternal(input) ? "" : rulingsBlockMd(input, crits),
    ...(input.evalReportHref !== undefined ? { evalReportHref: input.evalReportHref } : {}),
    feedbackTitle: isExternal(input) ? `Discovery report — ${input.subjectName}` : `Discovery report · ${input.runId}`,
    artifactPath: isExternal(input) ? "" : `.mutagent/evaluator/reports/${input.runId}/discovery-report.html`,
  };

  const gatesCount = crits.filter((x) => x.sev === "CRIT" || x.sev === "HIGH").length;
  const pchip = 'class="chip" style="color:var(--primarySoft);border-color:rgba(126,71,215,.6)"';
  const slots: Record<string, string> = {
    "@@TITLE@@": `Discovery Report — ${esc(input.subjectName)}${isExternal(input) ? "" : ` · ${esc(input.runId)}`}`,
    "@@HEADER_RIGHT@@": `<span style="margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--muted)">${isExternal(input) ? "" : `run ${esc(input.runId)}`}${input.generatedAt !== undefined ? `${isExternal(input) ? "" : " · "}${esc(input.generatedAt.slice(0, 10))}` : ""}</span>`,
    "@@HERO_TITLE@@": `Discovery Report — ${esc(input.subjectName)}`,
    "@@HERO_LEDE@@": `<b>Which evals should you add?</b> ${num(counts.read)} real session(s) of ${esc(input.subjectName)} were deep-read, every failure was traced to its first thing wrong, and <b>${crits.length} binary criteri${crits.length === 1 ? "on" : "a"}</b> ${counts.observed === crits.length ? "— all evidence-backed —" : `(${counts.observed} evidence-backed)`} were mined, plus ${(input.datasetCandidates ?? []).length} regression-case candidate(s) and ${counts.routed} infrastructure finding(s) routed to diagnostics. This report shows the criteria AND the proof of how they were found.`,
    "@@IDENTITY_STRIP@@": `<b style="font-size:15px">${esc(input.subjectName)}</b>
    ${isExternal(input) ? "" : `<span ${pchip}>run ${esc(input.runId)}</span>`}<span ${pchip}>source: ${esc(input.source ?? "not recorded")} · ${num(sampled)} trace(s)</span>
    <span ${pchip}>${counts.read} deep-read · ${counts.clusters} cluster(s)</span>
    <span class="chip" style="margin-left:auto;color:var(--pass);border-color:var(--pass)">${crits.length} criteri${crits.length === 1 ? "on" : "a"} discovered</span>`,
    "@@OVERVIEW_INTRO@@": `${esc(input.subjectName)}'s real sessions were mined for <b>evaluation criteria</b> — the binary checks this report recommends you add. Each read session was judged ✓/✗ by a pinned determiner, failures were clustered into emergent categories, and only checks backed by <b>quoted evidence from real sessions</b> were minted. The pipeline below is the whole story left to right.`,
    "@@HEAT_HEADING@@": `The sampled corpus at a glance — ${num(sampled)} session(s), one cell each`,
    "@@HEAT_LEGEND@@": `<i><span class="sw" style="background:rgba(67,195,154,.55)"></span><b style="color:var(--fg)">${pass}</b>&nbsp;deep-read · succeeded</i>
          <i><span class="sw" style="background:rgba(224,102,102,.6)"></span><b style="color:var(--fg)">${fail + uncertain}</b>&nbsp;deep-read · failed or undecided → produced the criteria</i>
          <i><span class="sw" style="background:rgba(126,71,215,.45)"></span><b style="color:var(--fg)">${counts.unread}</b>&nbsp;sampled, not deep-read</i>`,
    "@@KPI@@": `<i class="p">criteria recommended <b>${crits.length}</b></i><i class="pass">evidence-backed <b>${counts.observed}/${crits.length}</b></i><i>evidence layers covered <b>${new Set(crits.map((x) => x.layer)).size}</b></i>
        <i class="warn">infra issues → diagnostics <b>${counts.routed}</b></i><i>regression cases proposed <b>${(input.datasetCandidates ?? []).length}</b></i><i>living-suite growth <b>+${input.suite?.lastAppended ?? crits.length} entries</b></i>
        ${tally.stated ? `<i class="pass">new this run <b>${tally.fresh}</b></i><i class="p">reinforced existing <b>${tally.reinforced}</b></i>` : `<i>new vs reinforced <b>not recorded</b></i>`}<i>near-duplicates merged <b>${tally.merged}</b></i>${tally.pending > 0 ? `<i class="warn">open near-dup questions <b>${tally.pending}</b></i>` : ""}`,
    "@@BOTTOM_LINE@@": `Bottom line for the AI engineer: <b style="color:var(--fg)">add the ${crits.length} criteri${crits.length === 1 ? "on" : "a"} in tab ④</b> — ${counts.observed === crits.length ? "every one was seen failing in a real session" : `${counts.observed} of ${crits.length} were seen failing in a real session (the rest are inferred guards and say so on their card)`}, and ${gatesCount === 1 ? "1 of them gates" : `${gatesCount} of them gate`} a release (CRIT/HIGH). ${counts.routed > 0 ? `A further ${counts.routed} mined criteri${counts.routed === 1 ? "on was" : "a were"} flagged fixable→diagnostics and handed over as a FIX rather than adopted as an eval (EV-051 — this skill judges, it never fixes); ${counts.routed === 1 ? "it is" : "they are"} named in tab ③.` : "No mined criterion was flagged fixable — every one is eval-worthy."} ${tally.stated ? `Of the ${crits.length}, <b style="color:var(--fg)">${tally.fresh} ${tally.fresh === 1 ? "is" : "are"} new</b> and ${tally.reinforced} already existed in your suite and only gained evidence here.` : ""}${tally.merged > 0 ? ` <b style="color:var(--fg)">${tally.absorbed} duplicate id${tally.absorbed === 1 ? "" : "s"}</b> ${tally.absorbed === 1 ? "was" : "were"} merged away, so no two recommendations below restate one another (tab ③ shows what merged into what).` : ""}${tally.pending > 0 ? ` <b style="color:var(--warn)">${tally.pending} look-alike pair${tally.pending === 1 ? "" : "s"} need${tally.pending === 1 ? "s" : ""} your ruling</b> — kept apart because merging them could misrepresent the evidence; both checks stay live and the question is stored, not just drawn (tab ③).` : ""}`,
    "@@SAMPLING_SECTION@@": samplingSection(input, counts),
    "@@WALK_SECTION@@": walkSection(input, crits, counts, evalCriteria, tally),
    "@@CATALOG_COUNT@@": `${crits.length} discovered criteri${crits.length === 1 ? "on" : "a"}${tally.stated ? ` · ${tally.fresh} new · ${tally.reinforced} reinforced` : ""}${tally.merged > 0 ? ` · ${tally.merged} merged` : ""} · evidence + rationale`,
    "@@LAYER_COVERAGE@@": layerCoverage(evalCriteria, crits, tally),
    "@@DATASET_SECTION@@": datasetSection(input, labels, idMap, counts, crits.length),
    "@@METHODOLOGY_SECTION@@": methodologySection(input, crits, counts, labels, idMap),
    "@@FOOT@@": isExternal(input)
      ? `🧬 MutagenT · evaluator discovery report · ${esc(input.subjectName)}`
      : `🧬 MutagenT · evaluator discovery report · run ${esc(input.runId)} · artifact → .mutagent/evaluator/reports/${esc(input.runId)} (gitignored)`,
    "@@FEEDBACK_LABEL@@": `Feedback — discovery report${isExternal(input) ? "" : ` · ${esc(input.runId)}`} · Copy MD bundles your notes`,
    "@@DATA_JSON@@": JSON.stringify(data).replace(/</g, "\\u003c"),
  };

  let html = template;
  for (const [k, v] of Object.entries(slots)) {
    if (!html.includes(k)) throw new Error(`TEMPLATE SLOT MISSING: ${k}`);
    // a FUNCTION replacement, never the string form: `$&` / `$'` / "$$" inside
    // real subject text (a quoted reply, a criterion statement) are substitution
    // patterns to String.replace and would silently corrupt the emitted page.
    html = html.replace(k, () => v);
  }
  // The feedback bar is a DEV-LOOP affordance only: user-produced reports never
  // carry it (same rule as the eval report, operator round 13).
  if (input.devFeedback !== true) {
    const start = html.indexOf('<div id="fbpanel"');
    const endAnchor = "</div></div>";
    const end = start >= 0 ? html.indexOf(endAnchor, start) : -1;
    if (start < 0 || end < 0) throw new Error("feedback-panel strip anchor missing");
    html = html.slice(0, start) + html.slice(end + endAnchor.length);
  }
  // ── V11 AUDIENCE STRIP — the ⑥ INTERNAL methodology surface ──
  // Runs AFTER slot-fill on purpose: the ⑥ panel holds `@@METHODOLOGY_SECTION@@`, so
  // cutting it first would trip the fail-loud "UNFILLED SLOT" guard below. ⑥ is the
  // LAST tab, so removing index 5 leaves the remaining indices contiguous and the
  // template's index-based `tab()` switcher keeps working.
  if (isExternal(input)) {
    html = stripInternalSurface(html, { commentMarker: "<!-- ⑥ METHODOLOGY -->", tabIndex: 5, label: "⑥ Methodology" });
  }
  const leftover = /@@[A-Z_]+@@/.exec(html);
  if (leftover !== null) throw new Error(`UNFILLED SLOT: ${leftover[0]}`);
  return html;
}

/**
 * Write the v3 frozen-contract discovery report for a run. The sibling
 * evaluation-report deep link is wired ONLY when that artifact actually exists
 * next to this one (an absent sibling renders no link, never a dead one).
 * Returns the artifact path.
 */
export function writeDiscoverReportV3(input: DiscoverV3Input, repoRoot: string): string {
  const dir = join(repoRoot, ".mutagent/evaluator/reports", input.runId);
  const out = join(dir, "discovery-report.html");
  mkdirSync(dirname(out), { recursive: true });
  const sibling = join(dir, "evaluation-report.html");
  const withLink: DiscoverV3Input =
    input.evalReportHref === undefined && existsSync(sibling)
      ? { ...input, evalReportHref: "evaluation-report.html" }
      : input;
  writeFileSync(out, renderDiscoverReportV3(withLink));
  return out;
}

/** the run-dir data the v3 report needs; anything not supplied is read from disk. */
export type DiscoverRunData = Partial<
  Pick<
    DiscoverV3Input,
    | "criteria"
    | "annotations"
    | "miningReport"
    | "traces"
    | "datasetCandidates"
    | "suite"
    | "corpusTotal"
    | "samplingCensus"
    | "saturation"
    | "criterionStates"
    | "nearDuplicates"
    | "nearDuplicateLedger"
  >
>;

function readJson<T>(io: DiscoverIo, path: string): T | null {
  try {
    return JSON.parse(io.readFile(path)) as T;
  } catch {
    return null;
  }
}

/**
 * The W3 discover RUN composer — the analogue of run-evaluate's `writeRunReport`.
 * Given a run DIR it writes BOTH reports:
 *   - `discovery-report.html`     → the PRODUCTION frozen-contract v3 render
 *   - `discovery-report.v2.html`  → the previous renderer's output, kept as the
 *                                   transition fallback (v2 module untouched)
 * Returns the PRODUCTION path.
 *
 * The AGGREGATE caller should pass what it already holds in memory (`data`); every
 * field it omits is read from the run dir when present, and each genuinely-absent
 * companion becomes a NAMED absence in the report — never a fabricated number.
 * `criteria.json` is the one hard requirement (fail-loud).
 */
export function writeDiscoverRunReportV3(
  args: {
    dir: string;
    runId: string;
    subjectName: string;
    subjectSource?: string;
    generatedAt?: string;
    devFeedback?: boolean;
  },
  io: DiscoverIo,
  data: DiscoverRunData = {},
): string {
  const { dir } = args;
  const p = (name: string): string => join(dir, name);

  // v2 fallback FIRST — the previous renderer, byte-for-byte, at the .v2 path.
  writeDiscoverReportFromFiles(
    {
      criteriaPath: p("criteria.json"),
      outPath: p("discovery-report.v2.html"),
      groundingPath: p("grounding-check.json"),
      triagePath: p("triage-summary.json"),
      verdictsDir: p("verdicts"),
      datasetPath: p("dataset-candidates.json"),
      profilePath: p("subject-profile.json"),
      subjectName: args.subjectName,
      ...(args.subjectSource !== undefined ? { subjectSource: args.subjectSource } : {}),
      ...(args.generatedAt !== undefined ? { generatedAt: args.generatedAt } : {}),
    },
    io,
  );

  const criteria = data.criteria ?? readJson<MinedCriterion[]>(io, p("criteria.json"));
  if (criteria === null) throw new Error(`writeDiscoverRunReportV3: criteria.json unreadable at ${p("criteria.json")}`);
  // the leaf mining report lives at `discover/<batch_id>.json` (agent contract);
  // absent ⇒ the cluster table renders as a NAMED absence, never invented rows.
  let mining = data.miningReport ?? null;
  if (mining === null && io.readDir !== undefined) {
    try {
      const batch = io.readDir(p("discover")).find((f) => f.endsWith(".json"));
      if (batch !== undefined) mining = readJson<DiscoverMiningReport>(io, join(p("discover"), batch));
    } catch {
      mining = null;
    }
  }

  const input: DiscoverV3Input = {
    subjectName: args.subjectName,
    runId: args.runId,
    criteria,
    annotations: data.annotations ?? readJson<TraceAnnotation[]>(io, p("annotations.json")) ?? [],
    ...(mining !== null ? { miningReport: mining } : {}),
    traces: data.traces ?? readJson<EvalTrace[]>(io, p("traces.json")) ?? [],
    datasetCandidates: data.datasetCandidates ?? readJson<DatasetCase[]>(io, p("dataset-candidates.json")) ?? [],
    ...(data.suite !== undefined ? { suite: data.suite } : {}),
    // absent ⇒ the redundancy strip renders a NAMED absence; it never guesses
    // that everything is new (a reinforcing re-run would read as fresh discovery).
    ...(data.criterionStates !== undefined ? { criterionStates: data.criterionStates } : {}),
    ...(data.nearDuplicates !== undefined ? { nearDuplicates: data.nearDuplicates } : {}),
    ...(data.nearDuplicateLedger !== undefined ? { nearDuplicateLedger: data.nearDuplicateLedger } : {}),
    ...(data.corpusTotal !== undefined ? { corpusTotal: data.corpusTotal } : {}),
    ...(data.samplingCensus !== undefined ? { samplingCensus: data.samplingCensus } : {}),
    ...(data.saturation !== undefined ? { saturation: data.saturation } : {}),
    ...(args.subjectSource !== undefined ? { source: args.subjectSource } : {}),
    ...(args.generatedAt !== undefined ? { generatedAt: args.generatedAt } : {}),
    ...(args.devFeedback !== undefined ? { devFeedback: args.devFeedback } : {}),
  };
  // the sibling eval-report link renders ONLY when that artifact really exists.
  let sibling = false;
  try {
    io.readFile(p("evaluation-report.html"));
    sibling = true;
  } catch {
    sibling = false;
  }
  const out = p("discovery-report.html");
  io.writeFile(out, renderDiscoverReportV3(sibling ? { ...input, evalReportHref: "evaluation-report.html" } : input));
  return out;
}
