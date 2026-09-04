/**
 * scripts/materialize-dataset.ts — F8: PROJECT the agentspec's real dataset items
 * into runnable evaluator DatasetCases (Type A — PURE).
 * ---------------------------------------------------------------------------
 * AgentSpec 0.3.0 (D18/D19) moved the dataset from a DEFINITION (0.2's
 * `dataset_categories[] × edge_cases[]`, which the evaluator had to synthesize
 * base+edge queries from) to `spec.evaluation.datasets[].items[]` — REAL,
 * already-materialized rows, each carrying `category` / `scenarioRef` / a `case`
 * assignment over the dataset's `caseDimensions`, plus kind-specific `input` /
 * `expected` payloads.
 *
 * So materialization is now a faithful PROJECTION, not a synthesis:
 *   - one DatasetCase per spec item (the seed layer, source: "seed").
 *   - the case TUPLE = the item's `category` + its `case` assignment (the axes the
 *     dataset varies over — see `dimensionsFromAgentspec`).
 *   - the case QUERY = the item's opaque `input` payload rendered deterministically
 *     (raw string when `input` is a string; a stable key-sorted serialization
 *     otherwise), so a re-projection is byte-identical.
 *
 * The dataset-builder agent then EXPANDS these seeds synthetically; build-dataset.ts's
 * deterministic id/dedup/merge dedups any overlap. Subject-agnostic (EV-002): axes
 * and values come from the agentspec, never hard-coded. DETERMINISTIC — items and
 * axes consumed in given order; no clock / random / network → re-projecting is
 * byte-identical (C-PIN).
 */
import {
  type Dataset,
  type DatasetCase,
  type DatasetTuple,
  type Dimension,
} from "./contracts/dataset.ts";
import type {
  SpecEvaluation,
  SpecEvalDatasetItem,
} from "./contracts/agentspec-evals.ts";
import { buildCase, appendToDataset } from "./build-dataset.ts";
import { CaseSource } from "./contracts/dataset.ts";

/** The tuple key under which an item's dataset-local category is recorded. */
const CATEGORY_DIM = "category";

/**
 * Deterministic, key-sorted serialization — a stable rendering of an opaque item
 * payload so two projections of the same payload are byte-identical regardless of
 * key insertion order. PURE.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * The dimensions the projected dataset varies over: `category` (values = the
 * dataset-local category ids, first-seen order) + one dimension per distinct
 * `caseDimensions` axis (values merged across datasets, first-seen order). Both are
 * derived from the agentspec, never hard-coded. Subject-agnostic. PURE.
 */
export function dimensionsFromAgentspec(evaluation: SpecEvaluation): Dimension[] {
  const dims: Dimension[] = [];

  // category dimension — the union of dataset-local category ids (first-seen, deduped).
  const categoryIds: string[] = [];
  const seenCategory = new Set<string>();
  for (const dataset of evaluation.datasets) {
    for (const category of dataset.categories ?? []) {
      if (seenCategory.has(category.id)) continue;
      seenCategory.add(category.id);
      categoryIds.push(category.id);
    }
  }
  if (categoryIds.length > 0) {
    dims.push({ name: CATEGORY_DIM, description: "the dataset-local category slice", values: categoryIds });
  }

  // caseDimensions — each named axis, values merged across datasets (first-seen, deduped).
  const axisOrder: string[] = [];
  const axes = new Map<string, { description?: string; values: string[]; seen: Set<string> }>();
  for (const dataset of evaluation.datasets) {
    for (const [name, axis] of Object.entries(dataset.caseDimensions ?? {})) {
      let entry = axes.get(name);
      if (entry === undefined) {
        entry = { values: [], seen: new Set<string>() };
        if (axis.description !== undefined) entry.description = axis.description;
        axes.set(name, entry);
        axisOrder.push(name);
      }
      for (const value of axis.values) {
        if (entry.seen.has(value)) continue;
        entry.seen.add(value);
        entry.values.push(value);
      }
    }
  }
  for (const name of axisOrder) {
    const entry = axes.get(name);
    if (entry === undefined) continue;
    const dim: Dimension = { name, values: entry.values };
    if (entry.description !== undefined) dim.description = entry.description;
    dims.push(dim);
  }

  return dims;
}

/**
 * The variation tuple an item realizes — its dataset-local `category` (when present)
 * plus its `case` axis assignments. Falls back to the item id when an item declares
 * neither (a DatasetTuple must have ≥1 assignment). PURE.
 */
function tupleFromItem(item: SpecEvalDatasetItem): DatasetTuple {
  const tuple: DatasetTuple = {};
  if (item.category !== undefined && item.category.length > 0) tuple[CATEGORY_DIM] = item.category;
  for (const [axis, value] of Object.entries(item.case ?? {})) tuple[axis] = value;
  if (Object.keys(tuple).length === 0) tuple.item = item.id;
  return tuple;
}

/**
 * The natural-language query an item realizes — its opaque `input` payload rendered
 * deterministically. A string input is used verbatim; any other payload is
 * stable-serialized; a missing payload falls back to a deterministic descriptor so
 * the query is always non-empty (DatasetCase requires it). PURE.
 */
function queryFromItem(item: SpecEvalDatasetItem): string {
  const input = item.input;
  if (typeof input === "string" && input.length > 0) return input;
  if (input !== undefined) {
    const rendered = stableStringify(input);
    if (rendered.length > 0) return rendered;
  }
  const context = item.category ?? item.scenarioRef ?? item.id;
  return `[${context}] ${item.id}`;
}

/**
 * PROJECT the agentspec's real dataset items (0.3.0 `spec.evaluation.datasets[].items[]`)
 * into runnable DatasetCases (F8), one seed case per item. DETERMINISTIC, deduped by
 * content id (a re-projection collides → drop). Returns [] when no dataset carries
 * items. PURE.
 */
export function materializeFromAgentspec(evaluation: SpecEvaluation): DatasetCase[] {
  const out: DatasetCase[] = [];
  const seen = new Set<string>();
  for (const dataset of evaluation.datasets) {
    for (const item of dataset.items ?? []) {
      const c = buildCase(tupleFromItem(item), queryFromItem(item), CaseSource.Seed);
      if (seen.has(c.id)) continue; // content-id dedup (re-project collides → drop)
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/**
 * Assemble (or extend) a Dataset seeded with the projected real items. When
 * `existing` is supplied, the projected cases are merged MONOTONICALLY (no
 * duplicates, version bumps). Subject-agnostic. DETERMINISTIC. PURE.
 */
export function materializeToDataset(
  subject: string,
  evaluation: SpecEvaluation,
  existing?: Dataset,
): Dataset {
  const dimensions = dimensionsFromAgentspec(evaluation);
  const cases = materializeFromAgentspec(evaluation);
  const base: Dataset = existing ?? { subject, dimensions, cases: [], version: 0 };
  return appendToDataset(base, cases);
}
