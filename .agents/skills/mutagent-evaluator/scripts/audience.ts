/**
 * audience — the V11 report AUDIENCE CONTRACT, shared by every v3 report renderer.
 *
 * WHY THIS EXISTS. `render-eval-report-v3` declared `audience: "internal" | "external"`
 * and NEVER READ IT, so an external render was byte-identical to an internal one; the
 * discovery renderer had no audience concept at all. Both therefore shipped their
 * INTERNAL methodology surface to clients. This module holds the ONE implementation so
 * the rule cannot drift between surfaces — and so the review surface, when it lands,
 * inherits it instead of rediscovering it.
 *
 * ── WHAT AN `external` RENDER STRIPS ────────────────────────────────────────────
 *   1. the INTERNAL methodology surface — the eval report's ⑤ Self-Eval (MR-1..5
 *      self-grading) and the discovery report's ⑥ Methodology (process-as-executed,
 *      provenance, proof-of-work, honest gaps) — INCLUDING:
 *        · its TAB-BAR entry (never leave a tab that opens onto nothing), and
 *        · its HTML COMMENT marker. A comment ships to the client exactly like any
 *          other byte, so removing the visible tab and leaving `<!-- ⑤ SELF-EVAL -->`
 *          behind is still a leak. This is not hypothetical: it is the case the
 *          verifier's comment-blind matching caught.
 *   2. run-internal OPERATIONAL detail — the pinned judge-model string, internal run
 *      ids, and the gitignored artifact path printed in the footer.
 *
 * ── WHAT IT KEEPS ───────────────────────────────────────────────────────────────
 *   verdicts · quoted evidence · findings · criteria · the gate. The client gets the
 *   judgment and the proof, not how the judge graded itself. The determinism CLAIM
 *   survives (rendered as "pinned · temp 0") because reproducibility is
 *   client-relevant; the model identifier is not.
 *
 * ── ORDERING (a real trap) ──────────────────────────────────────────────────────
 *   Strip AFTER slot-fill. The internal panel contains a data slot, so cutting it
 *   first trips the renderer's fail-loud "TEMPLATE SLOT MISSING" guard. Fill every
 *   slot, then remove the surface.
 *
 * Enforced browser-free by `verify-render.ts`, in BOTH directions — an external
 * render must contain none of the internal markers, an internal render must still
 * contain them. A one-directional check passes vacuously the moment a strip
 * over-reaches or the renderer emits nothing.
 *
 * PURE — no clock, no randomness, no network, no filesystem.
 */

export type Audience = "internal" | "external";

/** True when this render is for a CLIENT audience and must carry no internal surface. */
export function isExternal(input: { audience?: Audience }): boolean {
  return input.audience === "external";
}

/**
 * Cut `startAnchor` … `endAnchor` out of `html`. FAIL-LOUD when either anchor is
 * missing — a silent no-op here would ship the very surface being removed, which is
 * the worst possible failure mode for a leak strip.
 *
 * `consumeEnd: false` stops immediately BEFORE the end anchor — needed when the anchor
 * is markup that must survive (e.g. the container's closing tag after the last panel).
 *
 * NOTE on choosing an end anchor: do not reach for the panel's own closing tags. The
 * cards inside these panels contain the same `</div></div>` sequence, so a first-match
 * end anchor cuts one card and leaves the rest. Anchor on something UNIQUE that follows
 * the panel (the footer marker) and stop before it.
 */
export function cutBlock(html: string, startAnchor: string, endAnchor: string, what: string, consumeEnd = true): string {
  const start = html.indexOf(startAnchor);
  const end = start >= 0 ? html.indexOf(endAnchor, start) : -1;
  if (start < 0 || end < 0) throw new Error(`AUDIENCE STRIP anchor missing: ${what}`);
  return html.slice(0, start) + html.slice(consumeEnd ? end + endAnchor.length : end);
}

/** The unique marker that follows the LAST panel in both v3 templates. */
export const FOOT_ANCHOR = '  </div>\n\n  <div class="foot">';

/**
 * Strip an internal methodology surface: its comment-marked panel plus its tab-bar
 * entry. `tabIndex` is the `onclick="tab(N)"` index of the entry to remove — the
 * internal surface is the LAST tab on both surfaces, so the remaining indices stay
 * contiguous and the template's index-based `tab()` switcher keeps working.
 */
export function stripInternalSurface(
  html: string,
  opts: { commentMarker: string; tabIndex: number; label: string },
): string {
  const withoutPanel = cutBlock(html, opts.commentMarker, FOOT_ANCHOR, `${opts.label} panel`, false);
  return cutBlock(withoutPanel, `<s onclick="tab(${opts.tabIndex})">`, "</s>", `${opts.label} tab-bar entry`);
}
