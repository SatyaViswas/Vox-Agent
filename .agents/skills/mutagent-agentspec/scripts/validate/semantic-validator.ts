/**
 * scripts/validate/semantic-validator.ts
 * The SEMANTIC layer of the AgentSpec 0.3.0 gate — everything the closed TypeBox structure cannot
 * express. Type A — Pure Script (a pure `semanticValidate(obj) => { ok, errors[] }`, no I/O).
 *
 * Runs AFTER the structural checker (scripts/contract/agentspec.schema.ts) passes; it assumes a
 * roughly-shaped object but narrows defensively (never throws). It enforces the Wave-1 exit checks:
 *
 *   1. KIND LEAKAGE      — exactly the one body matching `kind` is present; no other kind's body.
 *   2. WORKFLOW GRAPHS   — entry resolves · edge targets resolve · terminal/edge consistency ·
 *                          reachability · BOUNDED loops (any cycle-closing edge declares
 *                          loop.maxIterations or loop.exitWhen — unbounded loops fail, N02).
 *   3. EXECUTOR BINDING  — every node executor has a form and its actionRef/contextRefs/memberRef resolve.
 *   4. MULTI-AGENT       — orchestrator resolves · unique member ids · relations resolve ·
 *                          member dispatch graph is ACYCLIC (N02) · member ref-fields resolve.
 *   5. TARGETS           — implementation.* only on artifact.format: code (N04).
 *   6. DECISION SIDECAR  — decisionsRef is a colocated relative sibling (./name.md), no escape (N03).
 *   7. EVALUATION REFS   — dataset mapsTo/items resolve to jobs/scenarios/criteria/categories/dimensions.
 *
 * Every failure is a field-pathed string so a `[validate-spec]` run reads like the structural errors.
 */

import type { ValidationResult } from "../contract/agentspec.schema.ts";
import { Kind } from "../contract/agentspec.schema.ts";

// ── defensive accessors (never throw on malformed input) ──────────────────────────
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asRec = (v: unknown): Rec => (isRec(v) ? v : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const ids = (arr: unknown[]): Set<string> => {
  const s = new Set<string>();
  for (const el of arr) {
    const id = asStr(asRec(el).id);
    if (id !== undefined) s.add(id);
  }
  return s;
};

// The four kind → body-key pairings. Exactly one body must be present, matching `kind`.
const BODY_KEYS = ["agent", "skill", "multiAgent", "workflow"] as const;
const KIND_TO_BODY: Record<string, (typeof BODY_KEYS)[number]> = {
  [Kind.Agent]: "agent",
  [Kind.Skill]: "skill",
  [Kind.MultiAgent]: "multiAgent",
  [Kind.Workflow]: "workflow",
};

/**
 * Validate the SEMANTIC rules of an AgentSpec 0.3.0 card. Pure; never throws. Intended to run after
 * `validateAgentSpec` (structural) reports ok — but it narrows defensively so a partially-shaped
 * object yields errors rather than an exception.
 */
export function semanticValidate(obj: unknown): ValidationResult {
  const errors: string[] = [];
  const push = (path: string, msg: string) => errors.push(`${path}: ${msg}`);

  const root = asRec(obj);
  const kind = asStr(root.kind);
  const spec = asRec(root.spec);

  // ── 1. KIND LEAKAGE ─────────────────────────────────────────────────────────────
  if (kind !== undefined && kind in KIND_TO_BODY) {
    const expected = KIND_TO_BODY[kind];
    if (spec[expected] === undefined) {
      push(`/spec/${expected}`, `kind is ${kind} but the matching body is missing`);
    }
    for (const key of BODY_KEYS) {
      if (key !== expected && spec[key] !== undefined) {
        push(
          `/spec/${key}`,
          `kind leakage — kind is ${kind}; a '${key}' body is not permitted`,
        );
      }
    }
  }

  // Shared reference pools drawn from the universal spec.
  const contextIds = ids(asArr(spec.context));
  const actionIds = ids(asArr(spec.actions));
  const jobIds = ids(asArr(asRec(spec.intent).jobs));
  const evaluation = asRec(spec.evaluation);
  const scenarioIds = ids(asArr(evaluation.scenarios));
  const criterionIds = ids(asArr(evaluation.criteria));

  // ── 4. MULTI-AGENT (collect member ids first; needed for executor memberRef) ─────
  const memberIds = new Set<string>();
  let hasSpecRefMember = false;
  if (spec.multiAgent !== undefined) {
    const ma = asRec(spec.multiAgent);
    for (const m of asArr(ma.members)) {
      const mr = asRec(m);
      if (typeof mr.specRef === "string") {
        hasSpecRefMember = true;
        continue;
      }
      const id = asStr(asRec(mr.metadata).id);
      if (id !== undefined) {
        if (memberIds.has(id)) push("/spec/multiAgent/members", `duplicate member id '${id}'`);
        memberIds.add(id);
      }
    }
    // Unknown-reference errors only fire when EVERY member is inline (specRef targets are external).
    const canResolveMembers = !hasSpecRefMember;
    const checkMember = (path: string, id: string) => {
      if (canResolveMembers && !memberIds.has(id)) push(path, `unknown member '${id}'`);
    };

    const orchestrator = asStr(ma.orchestrator);
    if (orchestrator !== undefined) checkMember("/spec/multiAgent/orchestrator", orchestrator);

    // Member ref-fields (intentRef/contextRefs/actionRefs) resolve against the parent spec.
    for (const m of asArr(ma.members)) {
      const mr = asRec(m);
      if (typeof mr.specRef === "string") continue;
      const mid = asStr(asRec(mr.metadata).id) ?? "?";
      const mspec = asRec(mr.spec);
      const intentRef = asStr(mspec.intentRef);
      if (intentRef !== undefined && !intentRef.startsWith("#spec/")) {
        push(`/spec/multiAgent/members[${mid}]/intentRef`, `must be an in-card pointer starting '#spec/' (got '${intentRef}')`);
      }
      for (const c of asArr(mspec.contextRefs)) {
        const cid = asStr(c);
        if (cid !== undefined && !contextIds.has(cid))
          push(`/spec/multiAgent/members[${mid}]/contextRefs`, `unknown context '${cid}'`);
      }
      for (const a of asArr(mspec.actionRefs)) {
        const aid = asStr(a);
        if (aid !== undefined && !actionIds.has(aid))
          push(`/spec/multiAgent/members[${mid}]/actionRefs`, `unknown action '${aid}'`);
      }
    }

    // Relations resolve, and the dispatch (subagents) graph is ACYCLIC (N02).
    const relations = asRec(ma.relations);
    const subagents = asRec(relations.subagents);
    const observes = asRec(relations.observes);
    const adjacency = new Map<string, string[]>();
    for (const [from, tos] of Object.entries(subagents)) {
      checkMember("/spec/multiAgent/relations/subagents", from);
      const list: string[] = [];
      for (const to of asArr(tos)) {
        const t = asStr(to);
        if (t !== undefined) {
          checkMember("/spec/multiAgent/relations/subagents", t);
          list.push(t);
        }
      }
      adjacency.set(from, list);
    }
    for (const [from, tos] of Object.entries(observes)) {
      checkMember("/spec/multiAgent/relations/observes", from);
      for (const to of asArr(tos)) {
        const t = asStr(to);
        if (t !== undefined) checkMember("/spec/multiAgent/relations/observes", t);
      }
    }
    const cycle = findCycle(adjacency);
    if (cycle) {
      push(
        "/spec/multiAgent/relations/subagents",
        `member dispatch cycle is forbidden (N02): ${cycle.join(" → ")}`,
      );
    }
  }

  // ── 2 + 3. WORKFLOW GRAPHS + EXECUTOR BINDING (every graph in the card) ──────────
  for (const g of collectWorkflows(spec)) {
    validateGraph(g.body, g.path, { contextIds, actionIds, memberIds, hasSpecRefMember }, push);
  }

  // ── 5. TARGETS: implementation only on code artifacts (N04) ──────────────────────
  asArr(spec.targets).forEach((t, i) => {
    const tr = asRec(t);
    const format = asStr(asRec(tr.artifact).format);
    if (tr.implementation !== undefined && format !== "code") {
      push(
        `/spec/targets[${i}]/implementation`,
        `only 'code' artifacts may carry implementation.* (format is '${format ?? "?"}', N04)`,
      );
    }
  });

  // ── 6. DECISION SIDECAR: colocated relative sibling, no escape (N03) ─────────────
  const decisionsRef = asStr(spec.decisionsRef);
  if (decisionsRef !== undefined) {
    const bad =
      !decisionsRef.startsWith("./") ||
      decisionsRef.includes("..") ||
      decisionsRef.slice(2).includes("/") ||
      !decisionsRef.endsWith(".md");
    if (bad) {
      push(
        "/spec/decisionsRef",
        `must be a colocated relative sibling like './agentspec.decisions.md' — no absolute path, directory escape, or subdirectory (N03) (got '${decisionsRef}')`,
      );
    }
  }

  // ── 7. EVALUATION REFERENCES ─────────────────────────────────────────────────────
  asArr(evaluation.datasets).forEach((d, i) => {
    const dr = asRec(d);
    const base = `/spec/evaluation/datasets[${i}]`;
    const mapsTo = asRec(dr.mapsTo);
    for (const j of asArr(mapsTo.jobs)) {
      const id = asStr(j);
      if (id !== undefined && !jobIds.has(id)) push(`${base}/mapsTo/jobs`, `unknown job '${id}'`);
    }
    for (const s of asArr(mapsTo.scenarios)) {
      const id = asStr(s);
      if (id !== undefined && !scenarioIds.has(id))
        push(`${base}/mapsTo/scenarios`, `unknown scenario '${id}'`);
    }
    for (const c of asArr(mapsTo.criteria)) {
      const id = asStr(c);
      if (id !== undefined && !criterionIds.has(id))
        push(`${base}/mapsTo/criteria`, `unknown criterion '${id}'`);
    }
    const categoryIds = ids(asArr(dr.categories));
    const dimensionKeys = new Set(Object.keys(asRec(dr.caseDimensions)));
    asArr(dr.items).forEach((it, k) => {
      const itr = asRec(it);
      const ibase = `${base}/items[${k}]`;
      const scenarioRef = asStr(itr.scenarioRef);
      if (scenarioRef !== undefined && !scenarioIds.has(scenarioRef))
        push(`${ibase}/scenarioRef`, `unknown scenario '${scenarioRef}'`);
      const category = asStr(itr.category);
      if (category !== undefined && !categoryIds.has(category))
        push(`${ibase}/category`, `unknown dataset-local category '${category}'`);
      if (dimensionKeys.size > 0) {
        for (const dim of Object.keys(asRec(itr.case))) {
          if (!dimensionKeys.has(dim))
            push(`${ibase}/case`, `unknown case dimension '${dim}' (not in caseDimensions)`);
        }
      }
    });
  });

  return { ok: errors.length === 0, errors };
}

// ── Workflow-graph helpers ────────────────────────────────────────────────────────

interface GraphRef {
  body: Rec;
  path: string;
}
/** Collect every canonical Workflow graph in the card: top-level, Agent-embedded, MultiAgent-embedded. */
function collectWorkflows(spec: Rec): GraphRef[] {
  const out: GraphRef[] = [];
  if (isRec(spec.workflow)) out.push({ body: spec.workflow, path: "/spec/workflow" });
  const agentWf = asRec(asRec(spec.agent).workflow).inline;
  if (isRec(agentWf)) out.push({ body: agentWf, path: "/spec/agent/workflow/inline" });
  const maWf = asRec(asRec(spec.multiAgent).workflow).inline;
  if (isRec(maWf)) out.push({ body: maWf, path: "/spec/multiAgent/workflow/inline" });
  return out;
}

interface RefPools {
  contextIds: Set<string>;
  actionIds: Set<string>;
  memberIds: Set<string>;
  hasSpecRefMember: boolean;
}

function validateGraph(
  body: Rec,
  path: string,
  pools: RefPools,
  push: (path: string, msg: string) => void,
): void {
  const nodes = asArr(body.nodes);
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    const id = asStr(asRec(n).id);
    if (id !== undefined) {
      if (nodeIds.has(id)) push(`${path}/nodes`, `duplicate node id '${id}'`);
      nodeIds.add(id);
    }
  }

  // entry resolves
  const entry = asStr(body.entry);
  if (entry !== undefined && !nodeIds.has(entry))
    push(`${path}/entry`, `entry node '${entry}' does not exist`);

  // adjacency + per-node structural rules
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) {
    const nr = asRec(n);
    const id = asStr(nr.id);
    if (id === undefined) continue;
    const edges = asArr(nr.edges);
    const terminal = nr.terminal === true;
    if (terminal && edges.length > 0)
      push(`${path}/nodes[${id}]`, `terminal node must have no outgoing edges`);
    if (!terminal && edges.length === 0)
      push(`${path}/nodes[${id}]`, `non-terminal node must have at least one outgoing edge (or be marked terminal)`);

    // executor binding resolves — strict { kind, ref } (F03/R4). action/member refs resolve.
    if (nr.executor !== undefined) {
      const ex = asRec(nr.executor);
      const exKind = asStr(ex.kind);
      const ref = asStr(ex.ref);
      if (exKind === "action" && ref !== undefined && !pools.actionIds.has(ref))
        push(`${path}/nodes[${id}]/executor`, `unknown action '${ref}'`);
      if (exKind === "member" && ref !== undefined && !pools.hasSpecRefMember && !pools.memberIds.has(ref))
        push(`${path}/nodes[${id}]/executor`, `unknown member '${ref}'`);
    }
    // required INPUT (context reads) — a SEPARATE node field, not an executor form (F03/R4).
    for (const c of asArr(nr.contextRefs)) {
      const cid = asStr(c);
      if (cid !== undefined && !pools.contextIds.has(cid))
        push(`${path}/nodes[${id}]/contextRefs`, `unknown context '${cid}'`);
    }

    const list: string[] = [];
    for (const e of edges) {
      const to = asStr(asRec(e).to);
      if (to === undefined) continue;
      if (!nodeIds.has(to)) push(`${path}/nodes[${id}]/edges`, `edge target '${to}' does not exist`);
      else list.push(to);
    }
    adjacency.set(id, list);
  }

  // reachability from entry
  if (entry !== undefined && nodeIds.has(entry)) {
    const reachable = bfs(entry, adjacency);
    for (const id of nodeIds) {
      if (!reachable.has(id)) push(`${path}/nodes[${id}]`, `node is unreachable from entry '${entry}'`);
    }
  }

  // BOUNDED loops: a RETURNING edge is a DFS back edge (u → v where v is an ancestor still on the
  // traversal stack). Only that returning edge — not the forward edges of the cycle — must declare a
  // loop bound (N02). Reachability-based detection would wrongly flag the forward edge too.
  const edgeLoopBounded = new Map<string, boolean>(); // "u->v" → has a loop bound
  const edgeMap = new Map<string, string[]>();
  for (const n of nodes) {
    const nr = asRec(n);
    const u = asStr(nr.id);
    if (u === undefined) continue;
    const outs: string[] = [];
    for (const e of asArr(nr.edges)) {
      const er = asRec(e);
      const v = asStr(er.to);
      if (v === undefined || !nodeIds.has(v)) continue;
      outs.push(v);
      const loop = asRec(er.loop);
      edgeLoopBounded.set(`${u}->${v}`, loop.maxIterations !== undefined || asStr(loop.exitWhen) !== undefined);
    }
    edgeMap.set(u, outs);
  }
  for (const backEdge of findBackEdges(nodeIds, edgeMap)) {
    if (!edgeLoopBounded.get(`${backEdge.from}->${backEdge.to}`)) {
      push(
        `${path}/nodes[${backEdge.from}]/edges`,
        `returning edge '${backEdge.from} → ${backEdge.to}' closes a loop and must declare loop.maxIterations or loop.exitWhen (N02: no unbounded loops)`,
      );
    }
  }
}

/** BFS reachable set from a start node. */
function bfs(start: string, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Find every DFS BACK EDGE — an edge u → v where v is an ancestor of u still on the recursion stack
 * (i.e. the edge that closes a cycle). Iterates all nodes as roots so cycles are found regardless of
 * reachability from entry. Returns each back edge as { from, to }.
 */
function findBackEdges(
  nodeIds: Set<string>,
  adjacency: Map<string, string[]>,
): Array<{ from: string; to: string }> {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);
  const back: Array<{ from: string; to: string }> = [];

  const dfs = (node: string): void => {
    color.set(node, GRAY);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) back.push({ from: node, to: next });
      else if (c === WHITE) dfs(next);
    }
    color.set(node, BLACK);
  };

  for (const id of nodeIds) {
    if (color.get(id) === WHITE) dfs(id);
  }
  return back;
}

/** Detect a cycle in a directed graph (DFS with a recursion stack). Returns the cycle path or null. */
function findCycle(adjacency: Map<string, string[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const nodes = new Set<string>();
  for (const [from, tos] of adjacency) {
    nodes.add(from);
    for (const to of tos) nodes.add(to);
  }
  for (const n of nodes) color.set(n, WHITE);
  const stack: string[] = [];

  const dfs = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(next);
        return [...stack.slice(idx), next];
      }
      if (c === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    color.set(node, BLACK);
    stack.pop();
    return null;
  };

  for (const n of nodes) {
    if (color.get(n) === WHITE) {
      const found = dfs(n);
      if (found) return found;
    }
  }
  return null;
}
