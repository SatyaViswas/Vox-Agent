/**
 * scripts/contracts/agentspec-evals.ts — the MINIMAL `spec.evaluation` slice the
 * EVAL stage consumes (standalone — NEVER imports the agentspec skill's schema).
 * ---------------------------------------------------------------------------
 * AgentSpec 0.3.0 (D18/D19) replaces the flat 0.2 `definition.evals` shape
 * (`dataset_categories[] × edge_cases[]`) with `spec.evaluation`, a universal
 * closure of THREE arrays (each may be empty, F05):
 *
 *   - criteria[]  — `{ id, description, type, goal }` — binary-actionable pass/fail
 *     criteria (type ∈ llm-judge | code-check). (0.2 `success_criteria[]`, with
 *     `criterion` → `description`.)
 *   - scenarios[] — `{ id, description, expectedBehavior, edgeCase? }` — representative
 *     situations + the correct behavior. Scenario↔dataset linkage now lives on the
 *     dataset ITEM (`scenarioRef`), not on the scenario.
 *   - datasets[]  — `{ id, description, mapsTo?, categories[], caseDimensions?,
 *     items[]|itemsRef? }` — REAL, already-materialized dataset rows (D18):
 *       · mapsTo        — direct job/scenario/criterion references this dataset exercises.
 *       · categories[]  — DATASET-LOCAL taxonomy (`{ id, description, generationGuidance? }`),
 *         no longer a top-level global list (D18).
 *       · caseDimensions — a MAP `name → { description?, values[] }`; the independent
 *         variation axes each item's `case` assigns over.
 *       · items[]       — each `{ id, category?, scenarioRef?, case?, input?, expected? }`
 *         carrying a KIND-SPECIFIC `input`/`expected` payload (opaque data — we read the
 *         shape structurally, never interpret the kind).
 *
 * We DECLARE only the fields we read, with `additionalProperties: true` on the
 * objects so a richer 0.3.x agentspec still parses (forward-compatible). The cross-skill
 * import ban (coding-rules "Sealed-Sibling" + standalone discipline) is why this is
 * a local re-declaration, not an import. PURE — no clock / random / network.
 */
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** A binary-actionable SUCCESS CRITERION (0.3 `criteria[]`). */
export const SpecEvalCriterionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    type: Type.Union([Type.Literal("llm-judge"), Type.Literal("code-check")]),
    goal: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);
export type SpecEvalCriterion = Static<typeof SpecEvalCriterionSchema>;

/** A representative SCENARIO (the situation + correct behavior). */
export const SpecEvalScenarioSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    expectedBehavior: Type.String({ minLength: 1 }),
    edgeCase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
export type SpecEvalScenario = Static<typeof SpecEvalScenarioSchema>;

/** A DATASET-LOCAL category slice (D18) — the taxonomy is owned by its dataset. */
export const SpecEvalDatasetCategorySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    generationGuidance: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export type SpecEvalDatasetCategory = Static<typeof SpecEvalDatasetCategorySchema>;

/** One independent variation AXIS in a dataset's `caseDimensions` map (the map VALUE). */
export const SpecEvalCaseDimensionSchema = Type.Object(
  {
    description: Type.Optional(Type.String()),
    values: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: true },
);
export type SpecEvalCaseDimension = Static<typeof SpecEvalCaseDimensionSchema>;

/**
 * A single, already-materialized dataset ITEM. `case` assigns a value per
 * `caseDimensions` axis; `input`/`expected` are opaque kind-specific payloads we
 * carry structurally but never interpret.
 */
export const SpecEvalDatasetItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    category: Type.Optional(Type.String()),
    scenarioRef: Type.Optional(Type.String()),
    case: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
    input: Type.Optional(Type.Unknown()),
    expected: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
export type SpecEvalDatasetItem = Static<typeof SpecEvalDatasetItemSchema>;

/** Direct job/scenario/criterion references a dataset exercises (all optional). */
export const SpecEvalDatasetMapsToSchema = Type.Object(
  {
    jobs: Type.Optional(Type.Array(Type.String())),
    scenarios: Type.Optional(Type.Array(Type.String())),
    criteria: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);
export type SpecEvalDatasetMapsTo = Static<typeof SpecEvalDatasetMapsToSchema>;

/** A dataset: local categories + variation axes + the real materialized `items[]`. */
export const SpecEvalDatasetSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    mapsTo: Type.Optional(SpecEvalDatasetMapsToSchema),
    categories: Type.Optional(Type.Array(SpecEvalDatasetCategorySchema)),
    caseDimensions: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SpecEvalCaseDimensionSchema)),
    items: Type.Optional(Type.Array(SpecEvalDatasetItemSchema)),
    itemsRef: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export type SpecEvalDataset = Static<typeof SpecEvalDatasetSchema>;

/** The `spec.evaluation` closure. Each array is required but may be empty (F05). */
export const SpecEvaluationSchema = Type.Object(
  {
    criteria: Type.Array(SpecEvalCriterionSchema),
    scenarios: Type.Array(SpecEvalScenarioSchema),
    datasets: Type.Array(SpecEvalDatasetSchema),
  },
  { additionalProperties: true },
);
export type SpecEvaluation = Static<typeof SpecEvaluationSchema>;

/**
 * Parse + narrow the `spec.evaluation` slice (guarded). THROWS on schema violation —
 * a malformed contract must never silently reach materialization. PURE.
 */
export function parseSpecEvaluation(value: unknown): SpecEvaluation {
  if (!Value.Check(SpecEvaluationSchema, value)) {
    const first = [...Value.Errors(SpecEvaluationSchema, value)][0];
    throw new Error(
      `parseSpecEvaluation: schema violation at '${first?.path ?? "(root)"}': ` +
        `${first?.message ?? "invalid spec.evaluation slice"}`,
    );
  }
  return value;
}
