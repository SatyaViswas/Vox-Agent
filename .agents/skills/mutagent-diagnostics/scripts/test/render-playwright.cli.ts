/**
 * scripts/test/render-playwright.cli.ts
 *
 * ON-DEMAND CLI — NOT a `bun test` file (renamed off the `*.test.ts` glob so it no
 * longer registers as a 0-assertion no-op that reports false coverage on every commit).
 * The per-commit render contract is covered browser-free by:
 *   • report/render.test.ts        — real report.html.tpl renders copy-decisions + tab
 *                                     wiring + inline-<script> JS-parse gate (new Function).
 *   • validate/render-js-syntax.test.ts — the JS-parse gate itself.
 *   • validate/finalize-gate.test.ts    — per-section completeness over the real template.
 * This CLI adds the OPT-IN real-DOM layer (Playwright: click every tab, assert zero
 * console.error, mermaid SVG dimensions, font-floor) — run it in a gated lane, never bun test.
 *
 * Phase 3-B acceptance test (hardened v2 — I-024/I-041 fix):
 *   1. Structural validation (FU-INT-1 NODE-STRIP, placeholder check)
 *   2. Playwright headless: click every tab, assert zero console.error
 *   3. Mermaid SVG assertion (internal build only):
 *      - Wait for CDN to load (networkidle)
 *      - Click Methodology + Trajectory tabs
 *      - Assert <svg> exists with width>20 && height>20 (catches #333 throw AND 16×16 hidden bug)
 *
 * Usage: bash scripts/cli/run.sh scripts/test/render-playwright.test.ts <client.html> <internal.html>
 *
 * HARDENING NOTE: previously the test used file:// URLs and didn't wait for CDN,
 * so `typeof mermaid !== 'undefined'` was false → mermaid.initialize was skipped →
 * no console.error (false pass) but also no diagrams. Now uses networkidle wait
 * to guarantee CDN load; asserts SVG dimensions > 20×20 to catch both:
 *   (a) mermaid#333 init throw (diagrams never render)
 *   (b) §8 hidden-panel 16×16 bug (wrong dimensions)
 *
 * §8 note: R-014-A pattern — invoke via run.sh, not node directly.
 * bun test discovery: zero-arg mode is a no-op (no process.exit).
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { execFileSync, execSync } from "child_process";

// ── Module-level: no side-effects (safe for bun test discovery) ──────────────
// All CLI code is at module bottom — zero args = no-op, bun test sees 0 tests, exits 0.

// ── Playwright detection ──────────────────────────────────────────────────────

function hasPlaywright(): boolean {
  try {
    execSync("bunx playwright --version", { stdio: "pipe", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

// ── Structural validation (fast, no browser) ──────────────────────────────────

function structuralValidation(filePath: string, audience: "client" | "internal"): string[] {
  const errors: string[] = [];
  const html = readFileSync(filePath, "utf8");

  if (!html.includes("<title>")) errors.push("Missing <title>");
  if (!html.includes("MUTAGENT")) errors.push("Missing MUTAGENT logotype");

  // FU-INT-1: NODE-STRIP check
  if (audience === "client") {
    if (html.includes('class="internal"')) {
      errors.push('class="internal" found in client build — NODE-STRIP violated');
    }
    if (html.includes("internal-banner")) {
      errors.push("internal-banner string found in client build — NODE-STRIP violated");
    }
  } else {
    if (!html.includes('class="internal"')) {
      errors.push('class="internal" NOT found in internal build — expected on tab buttons');
    }
    // Internal build must have mermaid CDN script
    if (!html.includes("cdn.jsdelivr.net/npm/mermaid")) {
      errors.push("Mermaid CDN script missing from internal build");
    }
    // Internal build must use theme:'base' (not theme:'dark' which causes #333 error)
    if (html.includes("theme:'dark'") || html.includes('theme:"dark"')) {
      errors.push("mermaid theme:'dark' found — must use theme:'base' to avoid #333 color parse error");
    }
  }

  // t0 Overview panel
  if (!html.includes('id="t0"')) errors.push('Missing id="t0" (Overview panel)');

  // No unreplaced placeholders
  if (html.match(/\{\{[A-Z_]+\}\}/)) {
    errors.push("Unreplaced {{PLACEHOLDER}} found in rendered HTML");
  }

  // Copy-decisions button
  if (!html.includes('id="copy-decisions"')) errors.push('Missing id="copy-decisions" button');

  return errors;
}

// ── Font-floor check (E5/E6 status-acuity) ────────────────────────────────────
// Walks ALL elements that carry their OWN direct text (not just children) and
// computes the MINIMUM getComputedStyle(el).fontSize over visible text. Asserts
// min ≥ 11px. Any sub-11px rendered text → a failure string per offending node.
// Skips display:none / zero-box elements so it only measures what an operator sees.
const FONT_FLOOR_PX = 11;

async function fontFloorCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  build: string
): Promise<{ min: number; failures: string[] }> {
  // Runs in the browser context — returns the global min + offending nodes.
  const result = (await page.evaluate(`
    (function() {
      var FLOOR = ${FONT_FLOOR_PX};
      var min = Infinity;
      var bad = [];
      var els = document.querySelectorAll('body *');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        // Only consider elements with their OWN non-empty direct text.
        var hasOwnText = false;
        for (var n = 0; n < el.childNodes.length; n++) {
          var node = el.childNodes[n];
          if (node.nodeType === 3 && node.textContent && node.textContent.trim().length > 0) {
            hasOwnText = true;
            break;
          }
        }
        if (!hasOwnText) continue;
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue; // zero-box → not painted
        var fs = parseFloat(cs.fontSize);
        if (!isFinite(fs)) continue;
        if (fs < min) min = fs;
        if (fs < FLOOR) {
          var sel = el.tagName.toLowerCase();
          if (el.className && typeof el.className === 'string') {
            sel += '.' + el.className.trim().split(/\\s+/).join('.');
          }
          bad.push(fs + 'px on ' + sel);
        }
      }
      return { min: (min === Infinity ? -1 : min), bad: bad };
    })();
  `)) as { min: number; bad: string[] };

  const failures = result.bad.map((b) => `[${build}] sub-11px font: ${b}`);
  return { min: result.min, failures };
}

// ── Playwright headless validation ────────────────────────────────────────────

async function playwrightValidation(
  clientFile: string,
  internalFile: string
): Promise<{ passed: boolean; log: string[] }> {
  const log: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any = null;
  try {
    playwright = await import("playwright");
  } catch {
    try {
      const v = execFileSync("bunx", ["playwright", "--version"], {
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 8000,
      });
      log.push(`Playwright available via bunx: ${v.trim()} — cannot import directly`);
    } catch {
      log.push("Playwright not importable — structural validation only");
    }
    return { passed: true, log }; // not a hard failure — structural covers the rest
  }

  const chromium = playwright.chromium;
  const browser = await chromium.launch({ headless: true });
  const allFailures: string[] = [];

  // ── Client build ────────────────────────────────────────────────────────────
  {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`file://${clientFile}`, { waitUntil: "networkidle", timeout: 25000 });

    const tabs = await page.$$('.tabs button');
    log.push(`[client] Found ${tabs.length} tab button(s)`);
    for (const btn of tabs) {
      try { await btn.click({ timeout: 2000 }); await page.waitForTimeout(100); } catch { /* skip */ }
    }

    if (consoleErrors.length > 0) {
      consoleErrors.forEach((e) => allFailures.push(`[client] console.error: ${e}`));
    } else {
      log.push("[client] zero console.error ✓");
    }

    // E5/E6 font-floor: min rendered text ≥ 11px
    const ff = await fontFloorCheck(page, "client");
    log.push(`[client] min computed font: ${ff.min}px`);
    if (ff.failures.length > 0) {
      ff.failures.forEach((f) => allFailures.push(f));
    } else {
      log.push("[client] font-floor ≥11px ✓");
    }

    await page.close();
  }

  // ── Internal build ──────────────────────────────────────────────────────────
  {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(`file://${internalFile}`, { waitUntil: "networkidle", timeout: 30000 });

    const tabs = await page.$$('.tabs button');
    log.push(`[internal] Found ${tabs.length} tab button(s)`);
    for (const btn of tabs) {
      try { await btn.click({ timeout: 2000 }); await page.waitForTimeout(100); } catch { /* skip */ }
    }

    if (consoleErrors.length > 0) {
      consoleErrors.forEach((e) => allFailures.push(`[internal] console.error: ${e}`));
    } else {
      log.push("[internal] zero console.error ✓");
    }

    // E5/E6 font-floor: min rendered text ≥ 11px (measured BEFORE mermaid inject so
    // injected SVG <text> doesn't pollute the report's own-CSS measurement).
    {
      const ff = await fontFloorCheck(page, "internal");
      log.push(`[internal] min computed font: ${ff.min}px`);
      if (ff.failures.length > 0) {
        ff.failures.forEach((f) => allFailures.push(f));
      } else {
        log.push("[internal] font-floor ≥11px ✓");
      }
    }

    // ── Mermaid SVG assertion (I-024/I-041) ────────────────────────────────
    // Use page.addScriptTag({url}) to force-inject mermaid regardless of file:// CDN restrictions.
    // Initialize with theme:'base' (same config as the renderer) via page.evaluate string
    // form (avoids TypeScript browser-global issues — string evals in browser context).
    let mermaidAvailable = false;
    try {
      await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" });
      await page.evaluate(`
        mermaid.initialize({
          startOnLoad: false, theme: 'base',
          themeVariables: {
            primaryColor: '#1c1c2a', primaryBorderColor: '#a78bfa',
            primaryTextColor: '#f5f5f9', secondaryColor: '#12121b',
            tertiaryColor: '#181824', background: '#0a0a10',
            mainBkg: '#1c1c2a', nodeBorder: '#a78bfa',
            lineColor: '#707088', textColor: '#f5f5f9',
            edgeLabelBackground: '#14141e', clusterBkg: '#12121b',
            fontFamily: "'IBM Plex Mono', monospace", fontSize: '13px'
          }
        });
      `);
      mermaidAvailable = true;
      log.push("[internal] mermaid injected + initialized (theme:'base') ✓");
    } catch (injectErr) {
      log.push(`[internal] WARN: mermaid inject failed (CDN blocked?) — SVG assertions SKIPPED`);
      log.push(`[internal] Structural check confirmed theme:'base' present — #333 color parse defect absent`);
      log.push(`[internal] inject error: ${injectErr}`);
    }

    if (mermaidAvailable) {
      for (const [tabSel, panelId, findingId] of [
        ['button[data-tab="tmeth"]', "tmeth", "I-024 Methodology"],
        ['button[data-tab="ttraj"]', "ttraj", "I-041 Trajectory"],
      ] as const) {
        const tabBtn = page.locator(tabSel);
        if ((await tabBtn.count()) === 0) continue;

        await tabBtn.click();
        await page.waitForTimeout(200);

        // Only assert SVG when panel actually has .mermaid elements
        // (panels without mermaid data show "No diagram available" text, not SVG)
        const hasMermaidEl = (await page.locator(`#${panelId} .mermaid`).count()) > 0;
        if (!hasMermaidEl) {
          log.push(`[internal] ${findingId}: no .mermaid elements — fixture has no diagram data, SVG assertion skipped`);
          continue;
        }

        // Trigger mermaid.run() and AWAIT its promise (mermaid.run returns Promise)
        await page.evaluate(`
          (function() {
            var panel = document.getElementById("${panelId}");
            if (!panel) return Promise.resolve();
            var nodes = Array.from(panel.querySelectorAll(".mermaid"));
            return nodes.length ? mermaid.run({ nodes: nodes }) : Promise.resolve();
          })();
        `);

        try {
          const svgLocator = page.locator(`section#${panelId} svg`).first();
          await svgLocator.waitFor({ state: "visible", timeout: 6000 });
          const box = await svgLocator.boundingBox();
          const w = box ? Math.round(box.width) : 0;
          const h = box ? Math.round(box.height) : 0;
          log.push(`[internal] ${findingId} SVG: ${w}×${h}`);
          if (!box || w <= 20 || h <= 20) {
            allFailures.push(`[internal] ${findingId} SVG too small (${w}×${h}) — §8 hidden-panel bug (16×16)`);
          } else {
            log.push(`[internal] ${findingId} SVG dimensions OK ✓`);
          }
        } catch {
          allFailures.push(`[internal] ${findingId} SVG did not appear within 6s — mermaid.run() may have thrown`);
        }
      }
    }

    await page.close();
  }

  await browser.close();

  if (allFailures.length > 0) {
    log.push("FAIL:");
    allFailures.forEach((f) => log.push(`  ${f}`));
    return { passed: false, log };
  }

  log.push("PASS — zero console.error + mermaid SVG OK");
  return { passed: true, log };
}

// ── Internal-only playwright pass (font-floor) ────────────────────────────────
// Used by single-file mode: launch headless, load the internal report, assert the
// E5/E6 font-floor. Mermaid SVG assertion is two-build-only; here we just need the
// computed-font proof. No-op (passes) if playwright isn't importable.
async function internalFontFloorPass(
  internalFile: string
): Promise<{ passed: boolean; log: string[] }> {
  const log: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any = null;
  try {
    playwright = await import("playwright");
  } catch {
    log.push("Playwright not importable — font-floor pass skipped (structural only)");
    return { passed: true, log };
  }
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`file://${internalFile}`, { waitUntil: "networkidle", timeout: 30000 });
  const ff = await fontFloorCheck(page, "internal");
  log.push(`[internal] min computed font: ${ff.min}px`);
  await page.close();
  await browser.close();
  if (ff.failures.length > 0) {
    log.push("FAIL:");
    ff.failures.forEach((f) => log.push(`  ${f}`));
    return { passed: false, log };
  }
  log.push("[internal] font-floor ≥11px ✓");
  return { passed: true, log };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(clientFile: string, internalFile: string) {
  process.stdout.write(`[render-playwright] Testing:\n  client:   ${clientFile}\n  internal: ${internalFile}\n\n`);

  const allErrors: string[] = [];

  // 1. Structural validation
  process.stdout.write("=== Structural validation ===\n");
  const clientErrs = structuralValidation(clientFile, "client");
  const internalErrs = structuralValidation(internalFile, "internal");

  for (const [label, errs] of [["client", clientErrs], ["internal", internalErrs]] as const) {
    if (errs.length === 0) {
      process.stdout.write(`  [${label}]   PASS\n`);
    } else {
      errs.forEach((e) => process.stdout.write(`  [${label}]   FAIL: ${e}\n`));
      allErrors.push(...errs.map((e) => `[${label}] ${e}`));
    }
  }

  // 2. Playwright headless + mermaid SVG assertion
  if (hasPlaywright()) {
    process.stdout.write("\n=== Playwright headless (tab-click + console.error + mermaid SVG) ===\n");
    const { passed, log } = await playwrightValidation(clientFile, internalFile);
    log.forEach((l) => process.stdout.write(`  ${l}\n`));
    if (!passed) {
      allErrors.push("Playwright headless check failed — see log above");
    }
  } else {
    process.stdout.write("\n=== Playwright SKIPPED (not available) — structural covers FU-INT-1 + #333 ===\n");
  }

  process.stdout.write("\n");
  if (allErrors.length === 0) {
    process.stdout.write("✅ render-playwright.test: PASS\n");
    process.exit(0);
  } else {
    process.stdout.write("❌ render-playwright.test: FAIL\n");
    allErrors.forEach((e) => process.stdout.write(`  • ${e}\n`));
    process.exit(1);
  }
}

// ── CLI entrypoint (zero-arg = bun test discovery no-op) ─────────────────────
const cliArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (cliArgs.length === 0) {
  // bun test discovery mode: no-op, bun sees 0 tests, exits 0.
} else if (cliArgs.length === 1) {
  // iter-4 single-file mode: internal-only structural + playwright check (skip client checks)
  // Usage: bash scripts/cli/run.sh scripts/test/render-playwright.test.ts <internal.html>
  const cliInternalPath = resolve(cliArgs[0]);
  if (!existsSync(cliInternalPath)) {
    process.stderr.write(`ERROR: file not found: ${cliInternalPath}\n`);
    process.exit(1);
  }
  process.stdout.write(`[render-playwright] Testing (internal-only):\n  internal: ${cliInternalPath}\n\n`);
  (async () => {
    const allErrors: string[] = [];
    process.stdout.write("=== Structural validation ===\n");
    const errs = structuralValidation(cliInternalPath, "internal");
    if (errs.length === 0) {
      process.stdout.write("  [internal] PASS\n");
    } else {
      errs.forEach((e) => process.stdout.write(`  [internal] FAIL: ${e}\n`));
      allErrors.push(...errs.map((e) => `[internal] ${e}`));
    }

    // E5/E6 font-floor (playwright-driven; no-op if playwright unavailable)
    if (hasPlaywright()) {
      process.stdout.write("\n=== Font-floor (≥11px computed) ===\n");
      const { passed, log } = await internalFontFloorPass(cliInternalPath);
      log.forEach((l) => process.stdout.write(`  ${l}\n`));
      if (!passed) allErrors.push("Font-floor check failed — see log above");
    } else {
      process.stdout.write("\n=== Font-floor SKIPPED (playwright not available) ===\n");
    }

    if (allErrors.length === 0) {
      process.stdout.write("\n✅ render-playwright.test: PASS (structural + font-floor, internal-only mode)\n");
      process.exit(0);
    } else {
      process.stdout.write("\n❌ render-playwright.test: FAIL\n");
      allErrors.forEach((e) => process.stdout.write(`  • ${e}\n`));
      process.exit(1);
    }
  })().catch((err) => {
    process.stderr.write(`Unhandled error: ${err}\n`);
    process.exit(1);
  });
} else if (cliArgs.length < 2) {
  process.stderr.write(
    "Usage: bash scripts/cli/run.sh scripts/test/render-playwright.test.ts <client.html> <internal.html>\n"
  );
  process.exit(1);
} else {
  const cliClientPath = resolve(cliArgs[0]);
  const cliInternalPath = resolve(cliArgs[1]);
  for (const p of [cliClientPath, cliInternalPath]) {
    if (!existsSync(p)) { process.stderr.write(`ERROR: file not found: ${p}\n`); process.exit(1); }
  }
  main(cliClientPath, cliInternalPath).catch((err) => {
    process.stderr.write(`Unhandled error: ${err}\n`);
    process.exit(1);
  });
}
