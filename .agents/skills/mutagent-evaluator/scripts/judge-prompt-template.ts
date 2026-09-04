/**
 * scripts/judge-prompt-template.ts — EV-050 judge-PROMPT renderer + in-house/export run wrappers.
 * ---------------------------------------------------------------------------
 * The ONE place a judge prompt is rendered into a provider-callable string. This
 * is the operator-named **exception** to the script-austerity rule: "a script
 * that EXTRACTS/EXPORTS a custom LLM-as-judge PROMPT artifact (for the user's
 * CI/framework, EV-050) is fine — that's templating, not skill-triggered
 * judging." It exists for exactly two consumers:
 *
 *   (1) the OPTIONAL **in-house** provider substrate (`judge-provider.ts` →
 *       @langchain/google-genai) — it has no subagent, so it MUST carry the
 *       rendered prompt to call the model;
 *   (2) **user-framework export** (Vitest / promptfoo / Braintrust) — emit the
 *       judge prompt as an artifact for the user's own CI.
 *
 * **The DEFAULT agent-dispatch path NEVER imports this file.** Under
 * agent-dispatch the AUTHORITATIVE judging rubric lives in the subagent defs
 * (`assets/agents/{error-analyst,eval-judge,eval-matrix-judge}.md`); the host
 * runtime reasons from the def + the DATA packet, and the verdict file is keyed
 * by task DATA (trajectory id / criterion id), not by a rendered prompt. The
 * prose below is a MIRROR of those defs for the provider path — the defs are the
 * source of truth; keep them in lockstep.
 *
 * `determine-outcome.ts` + `build-evals.ts` are therefore slimmed to Type-A DATA
 * only (signals · parse · assemble · spec · split · leakage-guard). The
 * LLM-wrapper run functions (`determineOutcome` / `runJudge`) live HERE because
 * they call the injected `JudgeInvoke` seam.
 */
import {
  extractOutcomeSignals,
  parseCritiqueVerdict,
  type JudgeInvoke,
} from "./determine-outcome.ts";
import type { JudgePin } from "./build-evals.ts";
import type { SubjectProfile } from "./contracts/eval-matrix.ts";
import type {
  CriterionVerdict,
  EvalTrace,
  JudgeSpec,
  OutcomeResult,
  OutcomeSignals,
  SubjectVocab,
} from "./contracts/eval-types.ts";

function promptOf(trace: EvalTrace): string {
  return typeof trace.input?.prompt === "string" ? trace.input.prompt : "";
}

// ── Determiner (EV-042) prompt — MIRRORS assets/agents/error-analyst.md ──────

/**
 * EV-1 — the compact SUBJECT FRAME the determiner reads so it derives THIS subject's
 * expected outcome (identity · purpose · tools + reversibility), instead of judging
 * against a hardcoded email-agent signal block. Trajectory-LIGHT by design — it never
 * carries the full step-by-step trajectory (that is the per-criterion judge's job).
 */
export interface SubjectFrame {
  identity: string;
  purpose: string;
  tools: string[];
  toolReversibility?: { name: string; reversibility: string }[];
}

/** The distinct tool names actually invoked in a trace, in first-seen order (compact summary). */
function keyToolsUsed(trace: EvalTrace, limit = 8): string[] {
  const seen: string[] = [];
  for (const o of trace.observations) {
    if (o.type === "TOOL" && typeof o.name === "string" && !seen.includes(o.name)) {
      seen.push(o.name);
      if (seen.length >= limit) break;
    }
  }
  return seen;
}

/** Render the subject frame block for the determiner (EV-1). Trajectory-light. */
function subjectFrameBlock(subject: SubjectFrame | undefined): string[] {
  if (subject === undefined) {
    return [
      "SUBJECT: not supplied — RECONSTRUCT what the agent is from the input event + the",
      "tools it called, and derive the expected outcome from that. Do NOT assume any",
      "particular domain (e.g. email).",
      "",
    ];
  }
  const rev = new Map((subject.toolReversibility ?? []).map((t) => [t.name, t.reversibility]));
  const toolLine =
    subject.tools.length > 0
      ? subject.tools
          .map((n) => {
            const r = rev.get(n);
            return r !== undefined && r !== "unknown" ? `${n} [${r}]` : n;
          })
          .join(", ")
      : "(none)";
  const irreversible = (subject.toolReversibility ?? [])
    .filter((t) => t.reversibility === "irreversible-external")
    .map((t) => t.name);
  return [
    "SUBJECT (derive the EXPECTED outcome for THIS subject before you judge):",
    `  identity: ${subject.identity}`,
    `  purpose:  ${subject.purpose}`,
    `  tools:    ${toolLine}`,
    ...(irreversible.length > 0
      ? [`  ⚠ irreversible-external tools: ${irreversible.join(", ")} — a failure that also fired one is materially worse.`]
      : []),
    "",
  ];
}

/**
 * Render the determiner judge prompt for the in-house/export substrate. The
 * AUTHORITATIVE "inaction can be success" rubric is `error-analyst.md`; this is
 * its provider-callable mirror. No decision is made here.
 *
 * EV-1 — subject-aware: given a `subject` frame the determiner derives the expected
 * outcome from the subject's identity/purpose/tools (not a fixed email-agent signal
 * block), and reads a COMPACT outcome summary (event · did-it-act · key tools ·
 * terminal state) — deliberately NOT the full trajectory (the per-criterion judge's
 * job). The domain-specific signals (send / guard / recovery) render ONLY when the
 * subject vocab actually defines them, so a non-email subject no longer sees dead lines.
 */
export function buildOutcomePrompt(
  trace: EvalTrace,
  signals: OutcomeSignals,
  vocab: SubjectVocab,
  subject?: SubjectFrame,
): { system: string; user: string } {
  const system = [
    "You are a success/failure determiner for an autonomous agent session.",
    "Decide whether the session REACHED THE GOAL implied by its input event.",
    "",
    "Derive the EXPECTED outcome from the SUBJECT (its identity · purpose · tools) +",
    "the input event — do NOT assume any particular domain (e.g. email). This is a",
    "FAST input→output outcome check: read the goal (input), the result (output/self-",
    "summary) and the compact summary below — NOT the full step-by-step trajectory",
    "(that is the per-criterion judge's job).",
    "",
    "CRITICAL RULE — inaction can be success. Holding (sending nothing, calling",
    "no tool) is the CORRECT outcome when the event is a restraint directive",
    "(e.g. a guard/hold directive) or when acting would be wrong. You MUST NOT",
    'use "the agent called a tool" or "the agent sent a message" as a success',
    "proxy. A zero-tool session that correctly HOLDS is a PASS.",
    "",
    "Output STRICT JSON with the critique BEFORE the verdict:",
    '{ "critique": "<your reasoning>", "result": "pass"|"fail"|"uncertain",',
    '  "confidence": <0..1> }',
    "Reason first in `critique`, then commit to `result`.",
  ].join("\n");

  const responseText = typeof trace.output?.response === "string" ? trace.output.response : "";
  const keyTools = keyToolsUsed(trace);

  // EV-1 — domain signals render ONLY when the subject vocab defines them (else they
  // were email-agent noise for every subject). honest-null preserved.
  const conditionalSignals: string[] = [];
  if (vocab.guardCounterAttr !== null) {
    conditionalSignals.push(`  Guard ${vocab.guardCounterAttr}: ${signals.guardConsecutive ?? "n/a"}`);
  }
  if (vocab.sendTool.length > 0) {
    conditionalSignals.push(
      `  Sent a message: ${signals.sentMessage === null ? "unknown" : signals.sentMessage}`,
      `  Send succeeded: ${signals.sendSucceeded ?? "n/a (no send)"}`,
    );
  }
  if (vocab.recoveryTools.length > 0) {
    conditionalSignals.push(`  Recovery tool present: ${signals.recoveryPresent}`);
  }

  const user = [
    ...subjectFrameBlock(subject),
    "OUTCOME SUMMARY (compact — NOT the full trajectory):",
    `  Event kind: ${signals.eventKind}`,
    `  Tools called: ${signals.toolCount}${keyTools.length > 0 ? ` · key tools: ${keyTools.join(", ")}` : ""}`,
    `  Did the agent act: ${signals.toolCount > 0 ? "yes (called tools)" : "no (no tool calls)"}`,
    `  Terminal state: ${responseText.length > 0 ? "produced a self-summary/response" : "no self-summary"}`,
    ...conditionalSignals,
    "",
    "Input event prompt:",
    promptOf(trace),
    "",
    "Agent self-summary (output.response):",
    responseText.length > 0 ? responseText : "(none)",
  ].join("\n");

  return { system, user };
}

/**
 * In-house/export run wrapper for the determiner: render → call the injected
 * `JudgeInvoke` seam → parse (critique-before-verdict). Under the DEFAULT
 * agent-dispatch substrate the verdict instead comes from a dispatched
 * error-analyst subagent (a verdict file), and this wrapper is not used.
 * Deterministic given (trace, judge).
 */
export async function determineOutcome(
  trace: EvalTrace,
  judge: JudgeInvoke,
  vocab: SubjectVocab,
  subject?: SubjectFrame,
): Promise<OutcomeResult> {
  const signals = extractOutcomeSignals(trace, vocab);
  const { system, user } = buildOutcomePrompt(trace, signals, vocab, subject);
  // INF-3 — pass the trace id so the determiner verdict is keyed PER-TRACE (two
  // sessions with an identical determiner prompt never share one verdict).
  const raw = await judge(system, user, trace.id);
  const verdict = parseCritiqueVerdict(raw);
  return {
    traceId: trace.id,
    reached: verdict.result as OutcomeResult["reached"],
    confidence: verdict.confidence,
    rationale: verdict.critique,
    signals,
  };
}

// ── Per-criterion judge (EV-043) prompt — MIRRORS assets/agents/eval-judge.md ─

/** Compact one trace for the judge's view (prompt + trajectory + response). */
function traceView(trace: EvalTrace): string {
  const prompt = typeof trace.input?.prompt === "string" ? trace.input.prompt : "";
  const tools = trace.observations
    .filter((o) => o.type === "TOOL")
    .map((o) => o.name ?? "?")
    .join(", ");
  const resp = typeof trace.output?.response === "string" ? trace.output.response : "(none)";
  return [
    `Event/prompt:\n${prompt}`,
    `Tool trajectory: [${tools}]`,
    `Agent self-summary: ${resp}`,
  ].join("\n");
}

/** Render the M1 subject-profile preamble for the provider-path mirror (§9.4.4). */
function profilePreamble(profile?: SubjectProfile): string[] {
  if (profile === undefined) {
    return [
      "SUBJECT PROFILE (M1): not supplied — RECONSTRUCT who the agent is from the trace",
      "(its tools, the input it handled, its evident scope) before you judge. Mark the",
      "harness `unknown` if you cannot know it — NEVER confabulate it.",
      "",
    ];
  }
  return [
    "SUBJECT PROFILE (M1) — who the agent is (read this BEFORE judging):",
    `  identity: ${profile.identity}`,
    `  purpose:  ${profile.purpose}`,
    `  scope:    ${profile.scope}`,
    `  tools:    ${renderToolLine(profile)}`,
    ...reversibilityCallout(profile),
    profile.skill !== undefined ? `  skill:    ${profile.skill}` : "",
    `  harness:  ${profile.harness}`,
    `  provenance: ${profile.provenance}${profile.version !== undefined ? ` · version ${profile.version}` : ""}`,
    "",
  ].filter((l) => l !== "");
}

/** Render the tools line, annotating each tool with its EV-5 reversibility when known. */
function renderToolLine(profile: SubjectProfile): string {
  const tools = profile.tools ?? [];
  if (tools.length === 0) return "(none observed)";
  const rev = new Map((profile.toolReversibility ?? []).map((t) => [t.name, t.reversibility]));
  return tools
    .map((name) => {
      const r = rev.get(name);
      return r !== undefined && r !== "unknown" ? `${name} [${r}]` : name;
    })
    .join(", ");
}

/**
 * EV-5 — a one-line callout naming the tools that take IRREVERSIBLE EXTERNAL actions,
 * so a failure that ALSO fired one weighs heavier than a read-only failure. Absent
 * reversibility data ⇒ no callout (the judge still reads the bare tool list).
 */
function reversibilityCallout(profile: SubjectProfile): string[] {
  const irreversible = (profile.toolReversibility ?? [])
    .filter((t) => t.reversibility === "irreversible-external")
    .map((t) => t.name);
  if (irreversible.length === 0) return [];
  return [
    `  ⚠ irreversible-external tools: ${irreversible.join(", ")} — a failure that ALSO`,
    "    fired one of these (an email sent, a live system mutated) is MATERIALLY WORSE",
    "    than a read-only failure; weigh that in your critique.",
  ];
}

/**
 * Render the 4-component per-criterion judge prompt for the in-house/export
 * substrate. The AUTHORITATIVE 4-component / binary / critique-before-verdict
 * rubric is `eval-judge.md` (+ §9.4.4 M1–M5); this is its provider-callable mirror.
 */
export function buildJudgePrompt(
  spec: JudgeSpec,
  subjectTrace: EvalTrace,
  subjectProfile?: SubjectProfile,
): { system: string; user: string } {
  const fewShotBlock = spec.fewShot
    .map(
      (ex, i) =>
        `Example ${i + 1} (${ex.label}):\nCritique: ${ex.why}\nResult: ${ex.label}`,
    )
    .join("\n\n");

  const system = [
    "You are a BINARY Pass/Fail judge for ONE criterion. Judge exactly this and",
    "nothing else.",
    "",
    ...profilePreamble(subjectProfile),
    `Criterion: ${spec.statement}`,
    spec.passDefinition,
    spec.failDefinition,
    "",
    "JUDGE-WHAT-IS (M5): judge ONLY this defined criterion. If you notice a real",
    "failure with no matching criterion, you MAY note it as a detection — but NEVER",
    "mint a new eval or judge an undefined behaviour here.",
    "",
    "Outcomes are strictly BINARY: pass or fail (use uncertain ONLY if the trace",
    "genuinely lacks the evidence to decide). NO Likert scales, NO 1-5 / letter",
    "grades, NO partial credit — if severity matters, that is a separate judge.",
    "",
    spec.fewShot.length > 0 ? `Few-shot examples (from the TRAIN split only):\n${fewShotBlock}` : "",
    "",
    "Output STRICT JSON with the critique BEFORE the verdict (reason first, then",
    "commit). Follow the Judge DAG v2.2 walk (§9.4.2 + §9.4.4): GATHER (M2 — rephrase",
    "the agent's job in your own words, mark given-vs-inferred) → EXPECT (M3 — decide",
    "how the target SHOULD act BEFORE you examine) → EXAMINE actual-vs-expected (a",
    "truncated trace HARD short-circuits — emit INCOMPLETE and score NO criteria, never",
    "a row of abstains) → BIND → GROUND (absence-split: a bare-absence inferred from",
    "silence abstains, never fails) → CRITIQUE → DECIDE. Expose your train-of-thought at",
    "every phase (M4). Emit a `confidenceBand` (high|med|low) BESIDE the binary verdict",
    "— a calibration side-signal, NOT a Likert grade; it never alters `result`:",
    '{ "critique": "<detailed, evidence-citing assessment>", "result":',
    '  "pass"|"fail"|"uncertain", "confidence": <0..1>,',
    '  "confidenceBand": "high"|"med"|"low" }',
  ].join("\n");

  const user = ["Subject trace under evaluation:", "", traceView(subjectTrace)].join("\n");
  return { system, user };
}

/**
 * In-house/export run wrapper for one per-criterion judge under a PINNED model.
 * THROWS if the pin is not (modelId present AND temperature===0) — model intent
 * is sacred (C-PIN). Renders → calls the injected `JudgeInvoke` seam → parses
 * (critique-before-verdict). Under agent-dispatch the verdict instead comes from
 * a dispatched eval-judge subagent (a verdict file).
 */
export async function runJudge(
  spec: JudgeSpec,
  subjectTrace: EvalTrace,
  judge: JudgeInvoke,
  pin: JudgePin,
  // EV-5 CUT WIRE 1 — the M1 subject profile the judge reads in its preamble (tools +
  // reversibility). Pre-fix runJudge called buildJudgePrompt WITHOUT it, so the export
  // path always hit the "profile not supplied — reconstruct" branch and never saw the
  // reversibility flags. The pipeline now builds it once (buildSubjectProfile) and passes it.
  subjectProfile?: SubjectProfile,
): Promise<CriterionVerdict> {
  if (typeof pin.modelId !== "string" || pin.modelId.length === 0) {
    throw new Error(
      "runJudge: judge is not pinned (missing modelId). MODEL INTENT IS SACRED " +
        "— a non-pinned judge can never produce a verdict (C-PIN).",
    );
  }
  if (pin.temperature !== 0) {
    throw new Error(
      `runJudge: judge temperature=${pin.temperature} (!= 0) — not pinned. ` +
        "MODEL INTENT IS SACRED: reruns must be byte-identical (C-PIN); refusing.",
    );
  }
  const { system, user } = buildJudgePrompt(spec, subjectTrace, subjectProfile);
  const raw = await judge(system, user);
  const verdict = parseCritiqueVerdict(raw);
  return {
    criterionId: spec.criterionId,
    traceId: subjectTrace.id,
    result: verdict.result as OutcomeResult["reached"],
    confidence: verdict.confidence,
    critique: verdict.critique,
  };
}
