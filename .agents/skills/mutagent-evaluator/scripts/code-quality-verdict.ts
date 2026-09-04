/**
 * scripts/code-quality-verdict.ts — the CODE-QUALITY judge mode (Wave-2 W2I1).
 * ---------------------------------------------------------------------------
 * A JUDGE mode that scores a CODE subject's QUALITY (the amended/scaffolded
 * implementation of a `code`-kind subject) and emits a binary PASS/FAIL quality
 * verdict with a critique-before-verdict per criterion. It is the (b) half of the
 * ⑤ OPTIMIZE loop's code-target BOTH-gate: "converged" for a `code` subject = the
 * subject's OWN test suite green (a deterministic gate the session records as
 * `testsGreen`) AND this code-quality verdict PASSes. Neither alone converges.
 *
 * DISTINCT FROM `code-eval.ts`. That file is the DETERMINISTIC code-track primitive
 * library (presence/string-equality/... over an EvalTrace — no LLM, byte-identical).
 * This file is an LLM JUDGE mode: it scores the irreducibly-subjective quality of a
 * code implementation (spec-faithfulness, maintainability, error-handling, ...) that
 * a deterministic primitive cannot decide.
 *
 * INVARIANTS (consistent with the existing evaluator cell):
 *   - JUDGE-ONLY (EV-051). It scores; it NEVER fixes. Failures route to the ⑤ loop's
 *     ai-engineer amend (via the loop, not from here).
 *   - HOST-RUNTIME. Under the DEFAULT agent-dispatch substrate the authoritative
 *     rubric lives in the evaluator agent def (`#mode-judge-code-quality`), and the
 *     verdict comes from a dispatched subagent — this file's prompt is the
 *     provider-callable MIRROR for the OPTIONAL in-house / export substrate (same
 *     operator-named exception as judge-prompt-template.ts). No provider key on the
 *     default path.
 *   - PINNED model + temperature 0 (C-PIN). `runCodeQualityJudge` THROWS if the pin
 *     is not (modelId present AND temperature === 0) — reruns must be byte-identical.
 *   - PURE renderer + a thin injected-seam run wrapper. No clock, no random, no
 *     network; the LLM call is the injected `JudgeInvoke` seam so tests drive it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseCritiqueVerdict, type JudgeInvoke } from "./determine-outcome.ts";
import type { JudgePin } from "./build-evals.ts";
import type { CritiqueVerdict } from "./contracts/eval-types.ts";

/** Severity of a code-quality criterion — gates the aggregate (CRIT/HIGH block). */
export const CodeQualitySeverity = {
  Critical: "critical",
  High: "high",
  Medium: "medium",
} as const;
export type CodeQualitySeverityValue =
  (typeof CodeQualitySeverity)[keyof typeof CodeQualitySeverity];

/** One binary code-quality criterion the judge scores. */
export interface CodeQualityCriterion {
  /** Stable id (byte-identity key + report anchor). */
  id: string;
  /** The one-line binary statement the judge decides pass/fail on. */
  statement: string;
  /** What a PASS looks like (concrete, so the judge is not guessing). */
  passDefinition: string;
  /** What a FAIL looks like. */
  failDefinition: string;
  /** Gating weight — a `fail`/`uncertain` on a CRIT/HIGH criterion blocks the gate. */
  severity: CodeQualitySeverityValue;
}

/**
 * ⚠️ FLAGGED-FOR-OPERATOR-SIGN-OFF (Wave-2 W2I1). The DRAFT default set of acceptance
 * criteria that define "code quality-pass" BEYOND tests-green.
 *
 * The rubric itself now lives in `../assets/code-quality-criteria.yaml` — a versioned,
 * operator-editable ARTIFACT — so the criteria + severities can be tuned WITHOUT a code
 * change (FU-61.1). This module only LOADS and VALIDATES it; the shape/aggregation stay
 * in code. Ids/statements/severities are unchanged from the original inline set.
 *
 * Aggregation (also FLAGGED, still in code): severity-gated — a `fail` OR `uncertain`
 * on any CRITICAL/HIGH criterion blocks the quality-pass; MEDIUM is advisory.
 *
 * Fail-loud: a malformed/missing rubric THROWS at import. There is no silent fallback —
 * a broken rubric must never quietly degrade the gate.
 */
const CODE_QUALITY_CRITERIA_PATH = fileURLToPath(
  new URL("../assets/code-quality-criteria.yaml", import.meta.url),
);

const VALID_SEVERITIES: readonly string[] = Object.values(CodeQualitySeverity);

/** Parse + validate the rubric artifact. PURE given the file; THROWS on any defect. */
export function parseCodeQualityCriteria(raw: string, source = CODE_QUALITY_CRITERIA_PATH): readonly CodeQualityCriterion[] {
  // NOTE: a function DECLARATION (not a const arrow) so TS narrows through the
  // never-returning calls below — control-flow analysis requires this form.
  function bad(msg: string): never {
    throw new Error(`code-quality rubric invalid (${source}): ${msg}`);
  }
  const doc = parseYaml(raw) as { version?: unknown; criteria?: unknown } | null;
  if (doc === null || typeof doc !== "object") bad("not a YAML mapping");
  if (typeof doc.version !== "number") bad("`version` must be a number");
  if (!Array.isArray(doc.criteria) || doc.criteria.length === 0) bad("`criteria` must be a non-empty list");

  const seen = new Set<string>();
  const out = (doc.criteria as unknown[]).map((c, i) => {
    const at = `criteria[${i}]`;
    if (c === null || typeof c !== "object") return bad(`${at} is not a mapping`);
    const r = c as Record<string, unknown>;
    for (const k of ["id", "statement", "passDefinition", "failDefinition", "severity"]) {
      if (typeof r[k] !== "string" || (r[k] as string).trim() === "") bad(`${at}.${k} must be a non-empty string`);
    }
    const id = r.id as string;
    if (seen.has(id)) bad(`${at}.id "${id}" is duplicated`);
    seen.add(id);
    if (!VALID_SEVERITIES.includes(r.severity as string)) {
      bad(`${at}.severity "${String(r.severity)}" must be one of ${VALID_SEVERITIES.join(" | ")}`);
    }
    return {
      id,
      statement: r.statement as string,
      passDefinition: r.passDefinition as string,
      failDefinition: r.failDefinition as string,
      severity: r.severity as CodeQualitySeverityValue,
    } satisfies CodeQualityCriterion;
  });
  return Object.freeze(out);
}

export const DEFAULT_CODE_QUALITY_CRITERIA: readonly CodeQualityCriterion[] =
  parseCodeQualityCriteria(readFileSync(CODE_QUALITY_CRITERIA_PATH, "utf8"));

/** The code subject under quality review (minimal, subject-agnostic). */
export interface CodeQualitySubject {
  /** Subject id (spec_id / target name) — provenance only. */
  subjectId: string;
  /** The target framework/harness the impl was built into (context for the judge). */
  framework: string;
  /** A compact summary of the agentspec DEFINITION the impl must realize (the SSoT). */
  specSummary: string;
  /** The applied change under review — the amend diff, or the scaffold summary. */
  appliedChange: string;
  /**
   * The diagnosed root-cause / remedy locus this change was meant to address (feeds
   * Q2). Empty for a fresh scaffold with no prior diagnosis.
   */
  diagnosisLocus?: string;
}

/** One criterion's judged result (critique-before-verdict, binary). */
export interface CodeQualityCriterionVerdict {
  criterionId: string;
  severity: CodeQualitySeverityValue;
  result: CritiqueVerdict["result"]; // pass | fail | uncertain
  critique: string;
  confidence: number;
}

/** The aggregated code-quality verdict for one subject. */
export interface CodeQualityVerdict {
  subjectId: string;
  /** The binary quality gate — the (b) half of the ⑤ code-target BOTH-gate. */
  pass: boolean;
  perCriterion: CodeQualityCriterionVerdict[];
  /** C-PIN provenance stamped on the verdict (byte-identity guarantee). */
  pinned: JudgePin;
}

/**
 * Render the code-quality judge prompt for ONE criterion — the provider-callable
 * mirror of the `#mode-judge-code-quality` rubric. Critique-BEFORE-verdict, strictly
 * BINARY (no Likert), judge-only. No decision is made here.
 */
export function buildCodeQualityPrompt(
  criterion: CodeQualityCriterion,
  subject: CodeQualitySubject,
): { system: string; user: string } {
  const system = [
    "You are a BINARY Pass/Fail code-QUALITY judge for ONE criterion of a CODE",
    "subject (an agent/tooling implementation). Judge exactly this criterion and",
    "nothing else. You are a JUDGE ONLY — you NEVER propose or write a fix.",
    "",
    "Quality is assessed BEYOND the subject's test suite (tests-green is a separate",
    "deterministic gate). Judge the code as written against the criterion.",
    "",
    `Criterion (${criterion.id}, severity ${criterion.severity}): ${criterion.statement}`,
    criterion.passDefinition,
    criterion.failDefinition,
    "",
    "Outcomes are strictly BINARY: pass or fail (use uncertain ONLY when the change",
    "genuinely lacks the evidence to decide). NO Likert scales, NO 1-5 / letter",
    "grades, NO partial credit.",
    "",
    "Output STRICT JSON with the critique BEFORE the verdict (reason first, then",
    "commit):",
    '{ "critique": "<evidence-citing assessment>", "result": "pass"|"fail"|"uncertain",',
    '  "confidence": <0..1> }',
  ].join("\n");

  const user = [
    `Subject: ${subject.subjectId}  ·  target framework: ${subject.framework}`,
    "",
    "Agentspec definition the implementation must realize (the SSoT):",
    subject.specSummary,
    "",
    subject.diagnosisLocus !== undefined && subject.diagnosisLocus.length > 0
      ? `Diagnosed root-cause / remedy locus (for the addresses-diagnosis check):\n${subject.diagnosisLocus}\n`
      : "",
    "Applied change under review (diff or scaffold summary):",
    subject.appliedChange,
  ]
    .filter((l) => l !== "")
    .join("\n");

  return { system, user };
}

/**
 * The PURE aggregation: severity-gate the per-criterion verdicts into ONE binary
 * quality-pass. FLAGGED default rule — a `fail` OR `uncertain` on any CRITICAL/HIGH
 * criterion blocks the pass; MEDIUM is advisory (never blocks). Deterministic.
 */
export function codeQualityGatePass(
  perCriterion: readonly CodeQualityCriterionVerdict[],
): boolean {
  for (const v of perCriterion) {
    const gating =
      v.severity === CodeQualitySeverity.Critical || v.severity === CodeQualitySeverity.High;
    if (gating && v.result !== "pass") return false;
  }
  return true;
}

/**
 * Run the code-quality judge over the criteria set under a PINNED model. THROWS if
 * the pin is not (modelId present AND temperature === 0) — C-PIN (byte-identical
 * reruns). Renders each criterion → the injected `JudgeInvoke` seam → parses
 * (critique-before-verdict) → severity-gated aggregate. Under the DEFAULT
 * agent-dispatch substrate the verdicts instead come from a dispatched
 * `#mode-judge-code-quality` subagent (verdict files) and this wrapper is not used.
 * Deterministic given (subject, judge, pin, criteria).
 */
export async function runCodeQualityJudge(
  subject: CodeQualitySubject,
  judge: JudgeInvoke,
  pin: JudgePin,
  criteria: readonly CodeQualityCriterion[] = DEFAULT_CODE_QUALITY_CRITERIA,
): Promise<CodeQualityVerdict> {
  if (typeof pin.modelId !== "string" || pin.modelId.length === 0) {
    throw new Error(
      "runCodeQualityJudge: judge is not pinned (missing modelId). MODEL INTENT IS " +
        "SACRED — a non-pinned judge can never produce a verdict (C-PIN).",
    );
  }
  if (pin.temperature !== 0) {
    throw new Error(
      `runCodeQualityJudge: judge temperature=${pin.temperature} (!= 0) — not pinned. ` +
        "MODEL INTENT IS SACRED: reruns must be byte-identical (C-PIN); refusing.",
    );
  }
  if (criteria.length === 0) {
    throw new Error(
      "runCodeQualityJudge: empty criteria set — a code-quality verdict with no " +
        "criteria would vacuously pass (a false-green). Refusing.",
    );
  }

  const perCriterion: CodeQualityCriterionVerdict[] = [];
  for (const criterion of criteria) {
    const { system, user } = buildCodeQualityPrompt(criterion, subject);
    const raw = await judge(system, user);
    const v = parseCritiqueVerdict(raw);
    perCriterion.push({
      criterionId: criterion.id,
      severity: criterion.severity,
      result: v.result,
      critique: v.critique,
      confidence: v.confidence,
    });
  }

  return {
    subjectId: subject.subjectId,
    pass: codeQualityGatePass(perCriterion),
    perCriterion,
    pinned: { modelId: pin.modelId, temperature: pin.temperature },
  };
}
