// ---------------------------------------------------------------------------
// render-dogfood-report — Trajectory + FeedbackItem[] + meta → a self-contained
// live status HTML string. Five sections:
//   1) Lifecycle stage TIMELINE (Gantt-style colored bars, per-stage color vars)
//   2) *command / skill usage (ordered, with counts)
//   3) Agent internal steps (per subagent, collapsible)
//   4) User feedback + notes TABLE (verbatim + actionable + rationale + evidence)
//   5) Trajectory Call-Stack DAG (embedded mermaid ESM CDN, dark theme)
//
// STYLE: the operator-approved `docs/architecture.html` visual language — Space
// Grotesk + IBM Plex Mono, restrained dark, per-stage color vars, sharp corners,
// toned status. Tokens are INLINED (the report ships standalone under
// .mutagent/dogfood/{runId}/, with no external CSS to link).
//
// PURITY: pure — input → string. No clock (meta.generatedAt is injected), no I/O.
// The ONLY <script> emitted is a STATIC mermaid module import — so it is always
// syntactically valid (no dynamic data is interpolated into any <script>).
// ---------------------------------------------------------------------------

import { STAGE_META } from "./types.ts";
import type { DogfoodReportInput, FeedbackItem, SubagentActivity } from "./types.ts";

// ── HTML escaping ─────────────────────────────────────────────────────────────

/** Escape a value for safe embedding in HTML text/attributes. */
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Round a percentage to 2dp for byte-stable output. */
function pct(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Section 1 · lifecycle timeline (Gantt) ────────────────────────────────────

function timelineBounds(input: DogfoodReportInput): { startMs: number; span: number } | null {
  const { trajectory } = input;
  const starts = trajectory.timeline
    .map((s) => (s.startTime ? Date.parse(s.startTime) : NaN))
    .filter((n) => Number.isFinite(n));
  if (starts.length === 0) return null;
  const startMs = trajectory.startTime && Number.isFinite(Date.parse(trajectory.startTime))
    ? Date.parse(trajectory.startTime)
    : Math.min(...starts);
  const span = trajectory.now - startMs;
  if (!(span > 0)) return null;
  return { startMs, span };
}

function renderTimeline(input: DogfoodReportInput): string {
  const { timeline } = input.trajectory;
  if (timeline.length === 0) {
    return `<p class="empty">No <code>*command</code> invocations detected yet — the timeline populates as the session runs.</p>`;
  }
  const bounds = timelineBounds(input);
  const rows = timeline
    .map((seg, i) => {
      const meta = STAGE_META[seg.stage];
      let leftPct = 0;
      let widthPct = 100 / timeline.length;
      if (bounds && seg.startTime) {
        const start = Date.parse(seg.startTime);
        const end = seg.endTime ? Date.parse(seg.endTime) : input.trajectory.now;
        leftPct = pct(((start - bounds.startMs) / bounds.span) * 100);
        widthPct = pct(Math.max(1.5, ((end - start) / bounds.span) * 100));
        if (leftPct + widthPct > 100) widthPct = pct(100 - leftPct);
      } else {
        leftPct = pct(i * widthPct);
        widthPct = pct(widthPct);
      }
      const dur = seg.durationMs !== undefined ? `${Math.round(seg.durationMs / 1000)}s` : "live";
      return `<div class="gantt-row">
        <div class="gantt-lab" style="color:var(${meta.colorVar})">${esc(meta.label)}</div>
        <div class="gantt-track">
          <div class="gantt-bar" style="left:${leftPct}%;width:${widthPct}%;background:var(${meta.colorVar})" title="${esc(seg.command)} · ${esc(dur)}">
            <span class="gantt-cmd">${esc(seg.command)}</span>
          </div>
        </div>
        <div class="gantt-dur ds-mono">${esc(dur)}</div>
      </div>`;
    })
    .join("\n");
  return `<div class="gantt">${rows}</div>`;
}

// ── Section 2 · command / skill usage ─────────────────────────────────────────

function renderUsage(input: DogfoodReportInput): string {
  const { commandUsage } = input.trajectory;
  if (commandUsage.length === 0) {
    return `<p class="empty">No commands recorded yet.</p>`;
  }
  const chips = commandUsage
    .map((u) => {
      const meta = STAGE_META[u.stage];
      return `<div class="usechip" style="border-left-color:var(${meta.colorVar})">
        <span class="uc-cmd">${esc(u.command)}</span>
        <span class="uc-skill ds-mono">${esc(meta.skill)}</span>
        <span class="uc-count">×${u.count}</span>
      </div>`;
    })
    .join("\n");
  return `<div class="usewrap">${chips}</div>`;
}

// ── Section 3 · agent internal steps (collapsible) ────────────────────────────

function renderSubagent(sub: SubagentActivity): string {
  const tools = Object.entries(sub.toolCounts)
    .map(([name, n]) => `<span class="ds-chip">${esc(name)} ×${n}</span>`)
    .join(" ");
  const steps = sub.steps.length
    ? sub.steps
        .map((s, i) => {
          const ts = s.timestamp ? `<span class="step-ts ds-mono">${esc(s.timestamp)}</span>` : "";
          return `<li><span class="step-idx ds-mono">${i + 1}</span><span class="step-tool">${esc(s.toolName)}</span>${ts}</li>`;
        })
        .join("\n")
    : `<li class="empty">No tool-steps recorded.</li>`;
  return `<details class="subagent">
    <summary>
      <span class="sa-name">${esc(sub.agentName)}</span>
      <span class="sa-meta ds-mono">${sub.steps.length} steps</span>
      <span class="sa-tools">${tools}</span>
    </summary>
    <ol class="steps">${steps}</ol>
  </details>`;
}

function renderSubagents(input: DogfoodReportInput): string {
  const { subagents } = input.trajectory;
  if (subagents.length === 0) {
    return `<p class="empty">No subagents dispatched by this session.</p>`;
  }
  return subagents.map(renderSubagent).join("\n");
}

// ── Section 4 · feedback table ────────────────────────────────────────────────

function renderFeedbackRow(f: FeedbackItem): string {
  const ev = f.evidencePointer;
  return `<tr class="sev-${esc(f.severity)}">
    <td><span class="sev-pill sev-${esc(f.severity)}">${esc(f.severity)}</span></td>
    <td class="ds-mono">${esc(f.source)}<br/><span class="fk">${esc(f.kind)}</span></td>
    <td class="verbatim">${esc(f.observation)}</td>
    <td>${esc(f.actionable)}</td>
    <td class="rationale">${esc(f.rationale)}</td>
    <td class="ds-mono evidence">turn ${esc(ev.turnIndex)}<br/><span class="ev-span">${esc(ev.spanId)}</span></td>
  </tr>`;
}

function renderFeedback(input: DogfoodReportInput): string {
  const { feedback } = input;
  if (feedback.length === 0) {
    return `<p class="empty">No explicit <code>[feedback]</code> blocks or implicit reactions captured yet.</p>`;
  }
  const rows = feedback.map(renderFeedbackRow).join("\n");
  return `<table class="fbtable">
    <thead><tr>
      <th>severity</th><th>source</th><th>observation (verbatim)</th>
      <th>actionable</th><th>rationale</th><th>evidence</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Section 5 · Call-Stack DAG (mermaid) ──────────────────────────────────────

function renderDag(input: DogfoodReportInput): string {
  const { dag } = input.trajectory;
  // Escape the mermaid source: the browser decodes textContent, so mermaid still
  // receives the raw graph — but the HTML never mis-parses a stray angle bracket.
  return `<pre class="mermaid">${esc(dag.mermaid)}</pre>`;
}

// ── The stylesheet (inlined @mutagent/templates tokens) ───────────────────────

const STYLE = `
:root{
  --bg:#06060a;--surf:#14141f;--surf-2:#1b1b29;--surf-3:#262636;
  --border:rgba(255,255,255,.10);--border-strong:rgba(255,255,255,.18);
  --fg:#dde2ee;--fg-strong:#f3f5fb;--muted:#9b97ab;--dim:#65617a;
  --primary:#7E47D7;--primary-soft:#b794f4;--cyan:#45b8cc;
  --pass:#43c39a;--fail:#e06666;--warn:#e8a64d;
  --spec:#b794f4;--build:#5aa6d6;--eval:#7E47D7;--diag:#43c39a;--optimize:#e8a64d;
  --radius:0px;--font:'Space Grotesk',system-ui,-apple-system,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,monospace;
}
*{box-sizing:border-box;border-radius:var(--radius)}
body{margin:0;background:
  radial-gradient(1100px 620px at 78% -8%,rgba(126,71,215,.10),transparent 62%),
  radial-gradient(900px 540px at 8% 4%,rgba(69,184,204,.07),transparent 60%),var(--bg);
  color:var(--fg);font-family:var(--font);font-size:15px;line-height:1.55}
.ds-mono{font-family:var(--mono)}
code{font-family:var(--mono);color:var(--primary-soft);font-size:.9em}
.wrap{max-width:1160px;margin:0 auto;padding:0 22px 80px}
.header{position:sticky;top:0;z-index:10;background:rgba(6,6,10,.92);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--border-strong);padding:14px 22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.wm{font-weight:700;font-size:20px;letter-spacing:.5px}
.wm b{background:linear-gradient(90deg,var(--primary-soft),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}
.header .hmeta{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--muted)}
.metarow{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 4px}
.metarow i{font-family:var(--mono);font-size:10.5px;font-style:normal;padding:3px 9px;border:1px solid var(--border);color:var(--muted)}
.metarow i b{color:var(--fg-strong)}
section{margin:34px 0 0}
.lbl{font-family:var(--mono);font-size:11.5px;letter-spacing:.16em;color:var(--cyan);text-transform:uppercase}
h1{font-size:30px;margin:12px 0 6px;font-weight:700;color:var(--fg-strong)}
h1 b{background:linear-gradient(90deg,var(--primary-soft),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}
h2{font-size:20px;margin:6px 0 12px;font-weight:600;color:var(--fg-strong)}
.panel{border:1px solid var(--border);background:var(--surf);padding:14px 16px}
.empty{color:var(--dim);font-family:var(--mono);font-size:12.5px}
/* gantt */
.gantt{display:flex;flex-direction:column;gap:7px}
.gantt-row{display:grid;grid-template-columns:96px 1fr 56px;align-items:center;gap:10px}
.gantt-lab{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-align:right}
.gantt-track{position:relative;height:22px;background:var(--surf-2);border:1px solid var(--border)}
.gantt-bar{position:absolute;top:0;bottom:0;opacity:.82;display:flex;align-items:center;min-width:2px;overflow:hidden}
.gantt-cmd{font-family:var(--mono);font-size:10px;color:#06060a;font-weight:600;padding:0 6px;white-space:nowrap}
.gantt-dur{font-size:10px;color:var(--muted);text-align:right}
/* usage */
.usewrap{display:flex;flex-wrap:wrap;gap:8px}
.usechip{display:flex;align-items:center;gap:9px;border:1px solid var(--border);border-left:3px solid var(--cyan);
  background:var(--surf-2);padding:6px 11px}
.uc-cmd{font-family:var(--mono);font-size:12px;color:var(--fg-strong);font-weight:600}
.uc-skill{font-size:10px;color:var(--muted)}
.uc-count{font-family:var(--mono);font-size:11px;color:var(--cyan)}
/* subagents */
.subagent{border:1px solid var(--border);background:var(--surf-2);margin-bottom:8px}
.subagent summary{cursor:pointer;padding:9px 13px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sa-name{font-weight:600;color:var(--fg-strong)}
.sa-meta{font-size:10.5px;color:var(--cyan)}
.sa-tools{display:flex;gap:5px;flex-wrap:wrap;margin-left:auto}
.ds-chip{font-family:var(--mono);font-size:9.5px;color:var(--muted);border:1px solid var(--border);padding:1px 6px}
.steps{margin:0;padding:10px 13px 13px 34px;display:flex;flex-direction:column;gap:4px}
.steps li{list-style:none;display:flex;align-items:center;gap:10px;font-size:12.5px}
.step-idx{color:var(--dim);font-size:10px;min-width:18px}
.step-tool{font-family:var(--mono);color:var(--primary-soft);font-size:12px}
.step-ts{color:var(--dim);font-size:10px;margin-left:auto}
/* feedback table */
.fbtable{width:100%;border-collapse:collapse;font-size:12.5px}
.fbtable th{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--primary-soft);text-align:left;padding:7px 9px;border-bottom:1px solid var(--border-strong);background:var(--surf-2)}
.fbtable td{padding:8px 9px;border-bottom:1px solid var(--border);vertical-align:top}
.fbtable .verbatim{color:var(--fg-strong);white-space:pre-wrap;max-width:260px}
.fbtable .rationale{color:var(--muted);max-width:220px}
.fbtable .evidence{color:var(--dim);font-size:10.5px;white-space:nowrap}
.fbtable .ev-span{color:var(--cyan)}
.fbtable .fk{color:var(--dim);font-size:10px}
.sev-pill{font-family:var(--mono);font-size:9.5px;font-weight:700;padding:2px 8px;text-transform:uppercase;border:1px solid}
.sev-pill.sev-high{color:var(--fail);border-color:var(--fail)}
.sev-pill.sev-med{color:var(--warn);border-color:var(--warn)}
.sev-pill.sev-low{color:var(--muted);border-color:var(--border-strong)}
tr.sev-high td{background:rgba(224,102,102,.05)}
/* dag */
.mermaid{background:var(--surf-2);border:1px solid var(--border);padding:16px;overflow:auto;font-family:var(--mono);font-size:12px}
.foot{margin-top:34px;color:var(--dim);font-size:11px;border-top:1px solid var(--border);padding-top:12px;font-family:var(--mono)}
`;

// ── The mermaid loader (STATIC — never interpolates dynamic data) ─────────────

const MERMAID_SCRIPT = `import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose', themeVariables: { fontFamily: 'IBM Plex Mono, monospace', fontSize: '13px' } });`;

// ── The document ──────────────────────────────────────────────────────────────

/**
 * Render the full live-status report as a single self-contained HTML string.
 * Deterministic: identical inputs → byte-identical output (meta.generatedAt is the
 * only time value, and it is injected).
 */
export function renderDogfoodReport(input: DogfoodReportInput): string {
  const { meta, trajectory, feedback } = input;
  const title = meta.title ?? "Helix Dogfood — Live Status";
  const cmdCount = trajectory.commands.length;
  const subCount = meta.subagentCount ?? trajectory.subagents.length;

  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"/>${
    meta.refreshSeconds ? `\n<meta http-equiv="refresh" content="${meta.refreshSeconds}"/>` : ""
  }
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head><body>

<div class="header">
  <div class="wm">MUTAGENT<b>/dogfood</b></div>
  <span class="ds-mono" style="font-size:11px;color:var(--muted)">live session status</span>
  <span class="hmeta">run ${esc(meta.runId)} · generated ${esc(meta.generatedAt)}</span>
</div>

<div class="wrap">
  <div class="lbl">🧬 the agentic development lifecycle · dogfood vacuum</div>
  <h1>${esc(title)}</h1>
  <div class="metarow">
    <i>session <b>${esc(meta.sessionId)}</b></i>
    <i>commands <b>${cmdCount}</b></i>
    <i>subagents <b>${subCount}</b></i>
    <i>feedback <b>${feedback.length}</b></i>
    ${meta.sourceDir ? `<i>source <b>${esc(meta.sourceDir)}</b></i>` : ""}
  </div>

  <section>
    <div class="lbl">section 1 · lifecycle</div>
    <h2>Stage timeline</h2>
    <div class="panel">${renderTimeline(input)}</div>
  </section>

  <section>
    <div class="lbl">section 2 · usage</div>
    <h2>*command / skill usage</h2>
    <div class="panel">${renderUsage(input)}</div>
  </section>

  <section>
    <div class="lbl">section 3 · agents</div>
    <h2>Agent internal steps</h2>
    <div class="panel">${renderSubagents(input)}</div>
  </section>

  <section>
    <div class="lbl">section 4 · feedback</div>
    <h2>User feedback + notes</h2>
    <div class="panel">${renderFeedback(input)}</div>
  </section>

  <section>
    <div class="lbl">section 5 · trajectory</div>
    <h2>Call-Stack DAG</h2>
    <div class="panel">${renderDag(input)}</div>
  </section>

  <div class="foot">MutagenT · Helix dogfood live-status · ${esc(meta.generatedAt)} · restrained-dark · @mutagent/templates palette</div>
</div>

<script type="module">${MERMAID_SCRIPT}</script>
</body></html>`;
}
