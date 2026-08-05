/**
 * verify-render — a PURE, BROWSER-FREE structural verifier for a rendered v3 report.
 *
 * WHY THIS EXISTS. Until now, nothing in `bun test` could catch a broken report. The
 * render checks lived in the SIM harness (`scripts/release/sim-all.ts`), and the CI
 * guard test drives that harness with `playwright:false` — so every deep check (tab
 * sections, the drill, the E6 font floor, the layout gates) executes only when a human
 * runs the sim by hand. A report could ship structurally broken and the test suite
 * would stay green. This module is the part of that verification which needs no
 * browser, so it can run as an ordinary unit test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT COVERS  (assert-able from the emitted bytes alone)
 *   · no unfilled `@@SLOT@@` markers survived the render
 *   · every tab exists, and every tab PANEL carries content
 *   · every required `data-component` island is present, and none is blank
 *   · the server-rendered collections are non-empty — metric tiles, trace-inventory
 *     rows, criterion-detail cards, finding cards, self-eval cards
 *   · the embedded `window.ASTER` payload parses and its arrays are non-empty
 *     (criteria · traces · per-criterion scores · the findings handoff markdown)
 *   · audience discipline — no "INTERNAL" text on a client-audience render, and no
 *     dev feedback bar unless devFeedback was explicitly requested
 *   · the E6 FONT FLOOR, statically: every reachable `font-size` — in the embedded
 *     stylesheet AND in inline styles emitted by the page's own JS — is >= the floor
 *   · NAMED ABSENCE — a section with nothing to report must SAY so in words; a blank
 *     island is a defect, not an empty state
 *
 * WHAT IT DOES **NOT** COVER  (this is not a substitute for the Playwright pass)
 *   · COMPUTED styles. It reads declarations, not what the browser resolves. A rule
 *     overridden by specificity, a CSS variable, or a media query is invisible here.
 *   · LAYOUT and geometry. Nothing is measured: no box sizes, no text extent, no
 *     overrun, wrapping, overlap or clipping. The rotated-header containment checks
 *     live in the sim's headless pass and can only live there.
 *   · ANY behaviour. No tab is clicked, no row is drilled, no walk is opened. Client
 *     JS never executes, so the checks below verify the DATA the page will render
 *     FROM (`window.ASTER`) and the HOSTS it renders INTO — never that the render
 *     actually happened. `#ledger tbody` is legitimately empty in the emitted bytes.
 *   · CONSOLE errors, network, or anything runtime.
 *
 * So: this catches a report that was BUILT wrong. Playwright still owns everything
 * about a report that BEHAVES wrong. Neither replaces the other.
 *
 * PURE — no clock, no randomness, no network, no filesystem. Input is HTML text.
 */

/** One problem found in a rendered report. `note` never fails a verification. */
export interface RenderIssue {
  severity: "error" | "note";
  /** the check that produced it (stable id, safe to assert on) */
  check: string;
  detail: string;
}

export interface VerifyRenderResult {
  ok: boolean;
  issues: RenderIssue[];
  /** counts the checks read off the document — useful in failure messages. */
  stats: Record<string, number>;
  /**
   * Checks this spec DECLARED ITSELF OUT OF, by name. A reader must be able to see
   * what did not run without inferring it from a missing stats key — otherwise a
   * surface that skips the panel checks reads as one that passed them.
   */
  checksSkipped: string[];
}

/** A required island: an element that must exist AND must not be blank. */
interface IslandReq {
  /** CSS selector (HTMLRewriter subset) */
  selector: string;
  label: string;
  /** minimum matching elements (default 1) */
  minCount?: number;
  /**
   * `true` when this element is a HOST that client JS fills at runtime — it must
   * EXIST but is legitimately empty in the emitted bytes. Its content is covered by
   * the corresponding `dataArrays` entry instead.
   */
  jsFilled?: boolean;
  /**
   * `true` when this island belongs to an INTERNAL-only surface. Required on an
   * internal render; NOT required on an external one, where the audience strip has
   * correctly removed it (its absence there is asserted via `internalMarkers`).
   */
  internalOnly?: boolean;
}

/** A non-empty array required inside the embedded data payload. */
interface DataArrayReq {
  /** dotted path into the payload, e.g. "criteria" */
  path: string;
  label: string;
  minLength?: number;
}

export interface ReportSpec {
  /** human name, used in messages */
  surface: string;
  /** the global the payload is assigned to, e.g. "window.ASTER" */
  dataGlobal: string;
  /** the tab-bar elements themselves — labels are read from HERE, not from the
   *  whole document (every label is repeated in its panel header). */
  tabSelector: string;
  /**
   * Every tab label that must appear, in order. EMPTY is allowed only alongside
   * `tabless: true` — see that field.
   */
  tabLabels: string[];
  /**
   * DECLARE that this surface genuinely has no tab bar. Required when `tabLabels` is
   * empty, because to the engine an empty array is indistinguishable from a typo, a
   * bad copy-paste, or a half-finished spec — and it would silently skip the tab
   * check while still reporting `ok`. This is the NAMED-ABSENCE rule applied to the
   * SPEC itself: absence has to be stated, not inferred.
   */
  tabless?: true;
  /** tab labels belonging to INTERNAL-only surfaces — not required on an external render. */
  internalOnlyTabs: string[];
  /** `data-page` panels belonging to INTERNAL-only surfaces — ditto. */
  internalOnlyPanels: string[];
  /** substrings that mark INTERNAL-only material; none may survive an `external`
   *  render. Matched case-insensitively. */
  internalMarkers: string[];
  /** every `data-page` panel that must exist and carry content. EMPTY only with
   *  `panelless: true`. */
  panels: string[];
  /**
   * DECLARE that this surface has no `data-page` panels. Required when `panels` is
   * empty. Skipping the panel checks ALSO skips the per-panel NAMED-ABSENCE check, so
   * an undeclared empty array buys a "sections all fine" impression for a surface
   * whose sections were never looked at.
   */
  panelless?: true;
  islands: IslandReq[];
  dataArrays: DataArrayReq[];
  /** payload string fields that must be non-empty */
  dataStrings: { path: string; label: string }[];
  /**
   * NAMED-ABSENCE surfaces that are CONDITIONALLY populated. Each entry demands that
   * AT LEAST ONE of its `anyOf` strings appears: either the populated form, or the
   * explicit "nothing to report" wording. Neither ⇒ the section rendered BLANK, which
   * this contract treats as a defect rather than an empty state.
   *
   * This is how a surface like the PENDING near-duplicate block is checked: it has no
   * `data-component` marker and legitimately renders one of two shapes, so requiring
   * the populated form alone would fail every clean run.
   */
  requireAnyOf?: { label: string; anyOf: string[] }[];
}

export interface VerifyOpts {
  /**
   * Drives the V11 audience check in BOTH directions: `external` asserts the internal
   * markers are absent, `internal` asserts they are still present. Omit to skip the
   * audience check entirely.
   */
  audience?: "internal" | "external";
  /** the run id — asserted ABSENT from an external render (run-internal detail). */
  runId?: string;
  /** the pinned judge-model string — asserted ABSENT from an external render. */
  judgeModel?: string;
  /** the dev feedback bar is expected ONLY when this is true. */
  devFeedback?: boolean;
  /** E6 readability floor in px. */
  fontFloorPx?: number;
}

/* ── the EVAL report (v3 frozen contract) ──────────────────────────────────── */
export const EVAL_REPORT_SPEC: ReportSpec = {
  surface: "eval-report-v3",
  dataGlobal: "window.ASTER",
  tabSelector: "#report > .tabs s",
  tabLabels: ["① Overview", "② Trajectory ‖ Judge", "③ Eval Scorecard", "④ Findings", "⑤ Self-Eval"],
  panels: ["overview", "trajectory-judge", "scorecard", "findings", "self-eval"],
  // ⑤ is the INTERNAL surface: required on an internal render, correctly gone on an
  // external one. Without this the structural checks would demand the very tab the
  // audience strip is supposed to remove.
  internalOnlyTabs: ["⑤ Self-Eval"],
  internalOnlyPanels: ["self-eval"],
  /**
   * V11 audience contract. Every one of these must be ABSENT from an `external`
   * render and PRESENT in an `internal` one — the verifier checks both directions,
   * because a one-directional check passes vacuously if the renderer strips
   * everything (or renders nothing at all).
   *
   * Note the HTML COMMENT marker. `<!-- ⑤ SELF-EVAL -->` ships to the client exactly
   * like any other byte, so removing the visible tab while leaving the marker is
   * still a leak; matching is case-insensitive and comment-blind for that reason.
   */
  internalMarkers: [
    "⑤ Self-Eval", // the tab-bar entry + panel header
    "<!-- ⑤ SELF-EVAL -->", // the section comment marker — ships like any byte
    "internal — stripped on publish", // the panel's own internal label
    "mgt-selfeval-card", // the MR-1..5 self-grading cards
    ".mutagent/evaluator/reports", // the gitignored artifact path (footer + payload)
  ],
  islands: [
    // server-rendered — content is in the bytes
    { selector: '[data-component="mgt-report-hero"]', label: "① report hero" },
    { selector: ".scm", label: "① / ③ metric tiles", minCount: 5 },
    { selector: '[data-component="mgt-trace-inventory"] tbody tr', label: "① ingested-trace inventory rows" },
    { selector: ".subc", label: "③ criterion-detail cards" },
    { selector: '[data-component="mgt-finding-card"]', label: "④ finding cards" },
    { selector: '[data-component="mgt-selfeval-card"]', label: "⑤ self-eval cards", minCount: 5, internalOnly: true },
    // JS-filled hosts — must EXIST; their content is asserted via dataArrays
    { selector: '[data-component="mgt-subject-profile"]', label: "① subject-profile host", jsFilled: true },
    { selector: '[data-component="mgt-suite-summary"]', label: "① eval-suite host", jsFilled: true },
    { selector: '[data-component="mgt-trace-ledger"]', label: "② trace-ledger host", jsFilled: true },
    { selector: '[data-component="mgt-layer-matrix"]', label: "③ layer-matrix host", jsFilled: true },
    { selector: '[data-component="mgt-criteria-matrix"]', label: "③ criteria-matrix host", jsFilled: true },
  ],
  dataArrays: [
    { path: "criteria", label: "criteria (drives the suite table + both matrices)" },
    { path: "traces", label: "traces (drives the ② ledger + matrix columns)" },
  ],
  dataStrings: [
    { path: "handoffMd", label: "④ findings handoff markdown" },
    { path: "profile.name", label: "① subject name" },
  ],
};

/* ── the DISCOVERY report (v3 frozen contract) ─────────────────────────────────
 * Added with no engine change, which was the design bet in 10df56fe8: a new surface
 * is a `ReportSpec` plus the thin wrapper below. ⑥ Methodology is this surface's
 * INTERNAL boundary — the counterpart of the eval report's ⑤ Self-Eval. */
export const DISCOVERY_REPORT_SPEC: ReportSpec = {
  surface: "discovery-report-v3",
  dataGlobal: "window.ASTER",
  tabSelector: "#report > .tabs s",
  tabLabels: [
    "① Overview",
    "② Corpus & Sampling", // NOTE: `&amp;` in the source; HTMLRewriter decodes entities
    "③ Discovery Walk",
    "④ Criteria Catalog",
    "⑤ Dataset",
    "⑥ Methodology [INT]",
  ],
  panels: ["overview", "corpus-sampling", "discovery-walk", "criteria-catalog", "dataset", "methodology"],
  internalOnlyTabs: ["⑥ Methodology [INT]"],
  internalOnlyPanels: ["methodology"],
  internalMarkers: [
    "⑥ Methodology", // the tab-bar entry + panel header
    "[INT]", // the tab's explicit internal label
    "<!-- ⑥ METHODOLOGY -->", // the section comment marker — ships like any byte
    "internal — stripped on publish", // the panel's own internal label
    ".mutagent/evaluator/reports", // the gitignored artifact path (footer + payload)
  ],
  islands: [
    { selector: '[data-component="mgt-report-hero"]', label: "① report hero" },
    // JS-filled hosts — must EXIST; content asserted via dataArrays
    { selector: '[data-component="mgt-funnel"]', label: "① coverage funnel host", jsFilled: true },
    { selector: '[data-component="mgt-sample-heatgrid"]', label: "① sample heatgrid host", jsFilled: true },
    { selector: '[data-component="mgt-criterion-catalog"]', label: "④ criterion-catalog host", jsFilled: true },
    { selector: '[data-component="mgt-layer-coverage"]', label: "④ layer-coverage host", jsFilled: true },
    { selector: '[data-component="mgt-trace-peek"]', label: "③ trace-peek host", jsFilled: true },
  ],
  dataArrays: [
    { path: "criteria", label: "mined criteria (drives the ④ catalog)" },
    { path: "traces", label: "traces (drives the ① heatgrid + ③ peek)" },
    { path: "funnelStages", label: "① funnel stages" },
  ],
  dataStrings: [{ path: "adoptionMd", label: "④ adoption handoff markdown" }],
  requireAnyOf: [
    {
      // The near-duplicate PENDING surface (impl-dedup's cross-run decision ledger).
      // It renders EITHER the open-questions table or an explicit "None." — both are
      // valid; silence is not. Wording taken from `pendingSection()`, not invented.
      label: "③ PENDING near-duplicate questions (populated or explicitly none)",
      anyOf: [
        "⚖ PENDING — open near-duplicate questions",
        "No pair of criteria was similar enough to raise a question",
      ],
    },
  ],
};

/* ── the REVIEW surface — deliberately NOT specced here ──────────────────────
 * CLOSED (was TODO(review-surface)). The review surface hosts its own
 * `REVIEW_REPORT_SPEC` inside its test file and drives `verifyRenderedReport`
 * unchanged — the engine needed no modification for a third surface, which is the
 * whole point of it being spec-driven. A spec does not have to live in this module
 * to be a first-class citizen; co-locating it with the tests that use it keeps the
 * surface's owner and its contract in one place.
 *
 * NOTE for any future surface: that surface has NO tab bar, so it sets
 * `tabless: true` / `panelless: true` and its result carries the corresponding
 * `checksSkipped` entries. It compensates with island + payload assertions. If you
 * are adding a tabless surface, do the same — and read the two declaration fields'
 * docs before assuming an empty array is harmless.
 *
 * `audience` for any new renderer comes from `scripts/audience.ts`
 * (`isExternal` + `stripInternalSurface`) — do not rediscover the rule. */

/* ── tiny helpers (pure) ───────────────────────────────────────────────────── */
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc === null || acc === undefined ? undefined : (acc as Record<string, unknown>)[k]), obj);
}

/**
 * Extract the balanced JSON object starting at `from`. String-aware, so a `{` or `}`
 * inside subject text (a quoted agent reply, a criterion statement) does not end it.
 *
 * A naive "slice to the next `;\n`" DOES NOT WORK across surfaces: the eval template
 * puts the payload on its own line, the discovery template ends it with `;</script>` on
 * the same line, so the naive scan ran past the payload and captured garbage. Balanced
 * braces is the surface-independent answer.
 */
function extractJsonObject(html: string, from: number): string | null {
  const open = html.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Decode the handful of HTML entities that appear in TAB LABELS. HTMLRewriter hands
 * back raw source text, so a label written `② Corpus &amp; Sampling` in the template
 * arrives with the entity intact — comparing it against the human-readable label in a
 * spec would spuriously report the tab missing.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Extract the `<style>` blocks (the embedded stylesheet). */
function styleBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]!);
  return out;
}

/**
 * Split a stylesheet into `{selector, body}` rules. Deliberately simple: the frozen
 * template is machine-generated flat CSS with no nesting and no at-rule blocks that
 * carry font sizes. A rule this misses is a NOTE, never a silent pass — see the
 * unreachable-rule handling in `checkFontFloor`.
 */
function cssRules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) out.push({ selector: m[1]!.trim(), body: m[2]! });
  return out;
}

/**
 * Is a CSS rule REACHABLE in this document? A selector's class/id tokens are looked
 * up as literal `class="…"` / `id="…"` occurrences anywhere in the file — including
 * inside the page's own JS, which is how the report emits most of its markup.
 *
 * The frozen contract legitimately retains rules for chrome that production no longer
 * renders (the mock badge, the VQ pick widgets, a tag removed in a later round). Those
 * must not fail a font-floor check — but they must not be silently ignored either, so
 * an unreachable sub-floor rule is reported as a NOTE.
 */
function selectorReachable(selector: string, html: string): boolean {
  const tokens = selector.match(/[.#][A-Za-z0-9_-]+/g);
  if (tokens === null || tokens.length === 0) return true; // bare tag selector — assume reachable
  return tokens.every((t) => {
    const name = t.slice(1);
    return t.startsWith(".")
      ? new RegExp(`class="[^"]*\\b${name}\\b`).test(html) || new RegExp(`classList\\.(add|toggle)\\('${name}'`).test(html)
      : new RegExp(`id="${name}"`).test(html);
  });
}

/* ── the checks ────────────────────────────────────────────────────────────── */

/** E6, statically. Reads DECLARATIONS — never computed styles (see the header). */
function checkFontFloor(html: string, floor: number, issues: RenderIssue[], stats: Record<string, number>): void {
  let declarations = 0;
  let waived = 0;

  // (a) the embedded stylesheet, rule by rule, so an offender can be NAMED.
  for (const css of styleBlocks(html)) {
    for (const { selector, body } of cssRules(css)) {
      const m = /font-size:\s*([\d.]+)px/.exec(body);
      if (m === null) continue;
      declarations++;
      const px = Number.parseFloat(m[1]!);
      if (px >= floor) continue;
      if (selectorReachable(selector, html)) {
        issues.push({
          severity: "error",
          check: "font-floor",
          detail: `stylesheet rule \`${selector}\` sets font-size:${px}px, below the ${floor}px floor`,
        });
      } else {
        waived++;
        issues.push({
          severity: "note",
          check: "font-floor-unreachable",
          detail: `\`${selector}\` is ${px}px but renders nowhere in this document — retained mock chrome, not a live offender`,
        });
      }
    }
  }

  // (b) INLINE font sizes — including the ones the page's own JS emits into markup.
  //     These are invisible to any stylesheet census, and are exactly where a
  //     sub-floor size hides.
  const inline = /style="[^"]*font-size:\s*([\d.]+)px/g;
  let im: RegExpExecArray | null;
  while ((im = inline.exec(html)) !== null) {
    declarations++;
    const px = Number.parseFloat(im[1]!);
    if (px < floor) {
      const at = Math.max(0, im.index - 60);
      issues.push({
        severity: "error",
        check: "font-floor-inline",
        detail: `inline style sets font-size:${px}px, below the ${floor}px floor — near: …${html.slice(at, im.index + 40).replace(/\s+/g, " ")}…`,
      });
    }
  }

  stats["fontDeclarations"] = declarations;
  stats["fontRulesWaivedUnreachable"] = waived;
}

/** The embedded data payload the page renders FROM. */
function checkDataPayload(html: string, spec: ReportSpec, issues: RenderIssue[], stats: Record<string, number>): void {
  const anchor = `${spec.dataGlobal}=`;
  const start = html.indexOf(anchor);
  if (start < 0) {
    issues.push({ severity: "error", check: "data-payload", detail: `no \`${spec.dataGlobal}=\` payload found` });
    return;
  }
  const raw = extractJsonObject(html, start + anchor.length);
  if (raw === null) {
    issues.push({ severity: "error", check: "data-payload", detail: `\`${spec.dataGlobal}\` payload is not a balanced JSON object` });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw.replace(/\\u003c/g, "<"));
  } catch (e) {
    issues.push({ severity: "error", check: "data-payload", detail: `\`${spec.dataGlobal}\` is not valid JSON: ${String(e).slice(0, 120)}` });
    return;
  }
  for (const a of spec.dataArrays) {
    const v = getPath(payload, a.path);
    const n = Array.isArray(v) ? v.length : -1;
    stats[`data.${a.path}`] = n;
    if (n < (a.minLength ?? 1)) {
      issues.push({
        severity: "error",
        check: "data-array-empty",
        detail: `${a.label} — \`${a.path}\` ${n < 0 ? "is not an array" : `has ${n} entries`}; the page would render an empty section`,
      });
    }
  }
  for (const s of spec.dataStrings) {
    const v = getPath(payload, s.path);
    if (typeof v !== "string" || v.trim().length === 0) {
      issues.push({ severity: "error", check: "data-string-empty", detail: `${s.label} — \`${s.path}\` is empty` });
    }
  }
}

/* ── the verifier ──────────────────────────────────────────────────────────── */
/**
 * Verify a rendered report's STRUCTURE + DATA. See the module header for the
 * (deliberately explicit) list of what this does and does not cover.
 */
export async function verifyRenderedReport(html: string, spec: ReportSpec, opts: VerifyOpts = {}): Promise<VerifyRenderResult> {
  const issues: RenderIssue[] = [];
  const stats: Record<string, number> = {};
  const checksSkipped: string[] = [];
  const floor = opts.fontFloorPx ?? 11;

  // ── SPEC HONESTY GATE ────────────────────────────────────────────────────────
  // An empty requirement array is indistinguishable from a mistake, and skipping a
  // check silently is worse than not having it: it manufactures confidence. So an
  // empty array must be DECLARED, and whatever is skipped is NAMED in the result.
  if (spec.tabLabels.length === 0) {
    if (spec.tabless !== true) {
      issues.push({
        severity: "error",
        check: "spec-undeclared-tabless",
        detail: `${spec.surface}: spec declares no tabs — set \`tabless: true\` if that is intentional, otherwise \`tabLabels\` is empty by mistake and the tab check would be silently skipped`,
      });
    } else {
      checksSkipped.push("tab-presence (surface declared tabless)");
    }
  }
  if (spec.panels.length === 0) {
    if (spec.panelless !== true) {
      issues.push({
        severity: "error",
        check: "spec-undeclared-panelless",
        detail: `${spec.surface}: spec declares no panels — set \`panelless: true\` if that is intentional, otherwise \`panels\` is empty by mistake and BOTH the panel-content and per-panel named-absence checks would be silently skipped`,
      });
    } else {
      checksSkipped.push("panel-content (surface declared panelless)");
      checksSkipped.push("named-absence per panel (surface declared panelless)");
    }
  }
  // On an EXTERNAL render the internal-only surfaces are meant to be gone, so they
  // are not required here — their ABSENCE is asserted by the `internalMarkers` pass.
  const external = opts.audience === "external";
  const reqTabs = external ? spec.tabLabels.filter((t) => !spec.internalOnlyTabs.includes(t)) : spec.tabLabels;
  const reqPanels = external ? spec.panels.filter((p) => !spec.internalOnlyPanels.includes(p)) : spec.panels;
  const reqIslands = external ? spec.islands.filter((i) => i.internalOnly !== true) : spec.islands;

  // 1. unfilled slots — the renderer guards this too, but a report can reach a test
  //    from disk without having gone through that guard.
  const slot = /@@[A-Z_]+@@/.exec(html);
  if (slot !== null) issues.push({ severity: "error", check: "unfilled-slot", detail: `slot marker survived the render: ${slot[0]}` });

  // 2. tabs present — as TAB ELEMENTS, not as text anywhere in the document. Every
  //    tab label also appears in its panel header, so a substring search over the
  //    whole file would happily "find" a tab that had been deleted from the tab bar.
  const tabLabelsFound: string[] = [];
  await new HTMLRewriter()
    .on(spec.tabSelector, {
      text(t) {
        const s = decodeEntities(t.text).trim();
        if (s.length > 0) tabLabelsFound.push(s);
      },
    })
    .transform(new Response(html))
    .text();
  for (const label of reqTabs) {
    if (!tabLabelsFound.includes(label)) {
      issues.push({
        severity: "error",
        check: "tab-missing",
        detail: `tab "${label}" is not in the tab bar (\`${spec.tabSelector}\`); found [${tabLabelsFound.join(" | ")}]`,
      });
    }
  }
  stats["tabs"] = tabLabelsFound.length;

  // 3. panels present AND carrying content (a tab that opens onto nothing is a defect).
  const panelText = new Map<string, number>();
  const panelSeen = new Set<string>();
  let rewriter = new HTMLRewriter();
  for (const page of reqPanels) {
    rewriter = rewriter.on(`.sec[data-page="${page}"]`, {
      element() {
        panelSeen.add(page);
      },
      text(t) {
        panelText.set(page, (panelText.get(page) ?? 0) + t.text.trim().length);
      },
    });
  }
  // 4. islands.
  const islandCount = new Map<string, number>();
  const islandText = new Map<string, number>();
  const islandChildren = new Map<string, number>();
  for (const isl of reqIslands) {
    rewriter = rewriter.on(isl.selector, {
      element() {
        islandCount.set(isl.selector, (islandCount.get(isl.selector) ?? 0) + 1);
      },
      text(t) {
        islandText.set(isl.selector, (islandText.get(isl.selector) ?? 0) + t.text.trim().length);
      },
    });
    rewriter = rewriter.on(`${isl.selector} *`, {
      element() {
        islandChildren.set(isl.selector, (islandChildren.get(isl.selector) ?? 0) + 1);
      },
    });
  }
  // 5. the dev feedback bar.
  let fbpanel = 0;
  rewriter = rewriter.on("#fbpanel", { element() { fbpanel++; } });

  await rewriter.transform(new Response(html)).text();

  for (const page of reqPanels) {
    if (!panelSeen.has(page)) {
      issues.push({ severity: "error", check: "panel-missing", detail: `panel \`[data-page="${page}"]\` is absent` });
      continue;
    }
    const len = panelText.get(page) ?? 0;
    stats[`panel.${page}.textLen`] = len;
    // NAMED ABSENCE: a panel with nothing to report must still SAY something. Blank
    // is never a valid empty state in this contract.
    if (len < 40) {
      issues.push({
        severity: "error",
        check: "named-absence",
        detail: `panel \`${page}\` renders only ${len} chars of text — a section with nothing to report must NAME the absence in words, never be blank`,
      });
    }
  }

  for (const isl of reqIslands) {
    const n = islandCount.get(isl.selector) ?? 0;
    stats[`island.${isl.selector}`] = n;
    if (n < (isl.minCount ?? 1)) {
      issues.push({
        severity: "error",
        check: "island-missing",
        detail: `${isl.label} — expected >= ${isl.minCount ?? 1} \`${isl.selector}\`, found ${n}`,
      });
      continue;
    }
    if (isl.jsFilled === true) continue; // content lives in the data payload
    const filled = (islandText.get(isl.selector) ?? 0) > 0 || (islandChildren.get(isl.selector) ?? 0) > 0;
    if (!filled) {
      issues.push({
        severity: "error",
        check: "island-blank",
        detail: `${isl.label} — \`${isl.selector}\` is present but BLANK (no text, no children)`,
      });
    }
  }

  // 6. audience discipline.
  stats["fbpanel"] = fbpanel;
  if (opts.devFeedback !== true && fbpanel > 0) {
    issues.push({
      severity: "error",
      check: "feedback-bar-leak",
      detail: "the dev feedback bar (#fbpanel) is present on a report not rendered with devFeedback",
    });
  }
  if (opts.devFeedback === true && fbpanel === 0) {
    issues.push({ severity: "error", check: "feedback-bar-missing", detail: "devFeedback was requested but #fbpanel is absent" });
  }
  // V11 — BOTH DIRECTIONS. An `external` render must contain NONE of the internal
  // markers; an `internal` render must still contain them. Checking only the external
  // direction would pass vacuously the moment the renderer strips too much (or
  // renders nothing), which is exactly how a "leak fixed" claim goes wrong.
  const lower = html.toLowerCase();
  let internalMarkersPresent = 0;
  for (const marker of spec.internalMarkers) {
    const present = lower.includes(marker.toLowerCase());
    if (present) internalMarkersPresent++;
    if (opts.audience === "external" && present) {
      issues.push({
        severity: "error",
        check: "internal-leak",
        detail: `a client-audience render still contains INTERNAL-only material: "${marker}"`,
      });
    }
    if (opts.audience === "internal" && !present) {
      issues.push({
        severity: "error",
        check: "internal-surface-missing",
        detail: `an INTERNAL render is missing "${marker}" — the audience strip is over-reaching, or the internal surface regressed`,
      });
    }
  }
  stats["internalMarkersPresent"] = internalMarkersPresent;

  // run-internal operational detail that must never reach a client render. The run id
  // is caller-supplied, so it is passed in rather than pattern-matched.
  if (opts.audience === "external") {
    if (opts.runId !== undefined && opts.runId.length > 0 && html.includes(opts.runId)) {
      issues.push({ severity: "error", check: "run-id-leak", detail: `the internal run id "${opts.runId}" appears in a client-audience render` });
    }
    if (opts.judgeModel !== undefined && opts.judgeModel.length > 0 && html.includes(opts.judgeModel)) {
      issues.push({
        severity: "error",
        check: "judge-pin-leak",
        detail: `the pinned judge-model string "${opts.judgeModel}" appears in a client-audience render`,
      });
    }
  }

  // 7. conditionally-populated NAMED-ABSENCE surfaces: populated OR explicitly empty,
  //    never blank.
  for (const req of spec.requireAnyOf ?? []) {
    const hit = req.anyOf.find((n) => html.includes(n));
    if (hit === undefined) {
      issues.push({
        severity: "error",
        check: "named-absence-surface",
        detail: `${req.label} — the section says NEITHER its populated form nor its explicit empty form; a blank section is a defect, not an empty state (expected one of: ${req.anyOf.map((n) => `"${n}"`).join(" | ")})`,
      });
    }
  }

  // 8. data payload + 9. font floor.
  checkDataPayload(html, spec, issues, stats);
  checkFontFloor(html, floor, issues, stats);

  return { ok: issues.every((i) => i.severity !== "error"), issues, stats, checksSkipped };
}

/** Convenience wrapper for the v3 eval report. */
export async function verifyEvalReportHtml(html: string, opts: VerifyOpts = {}): Promise<VerifyRenderResult> {
  return verifyRenderedReport(html, EVAL_REPORT_SPEC, opts);
}

/** Convenience wrapper for the v3 discovery report. */
export async function verifyDiscoveryReportHtml(html: string, opts: VerifyOpts = {}): Promise<VerifyRenderResult> {
  return verifyRenderedReport(html, DISCOVERY_REPORT_SPEC, opts);
}

/** Render a verification result as a single actionable message (empty when ok). */
export function formatRenderIssues(result: VerifyRenderResult): string {
  return result.issues
    .filter((i) => i.severity === "error")
    .map((i) => `[${i.check}] ${i.detail}`)
    .join("\n");
}
