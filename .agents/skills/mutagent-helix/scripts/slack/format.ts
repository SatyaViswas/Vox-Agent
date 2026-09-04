// ---------------------------------------------------------------------------
// slack/format — PURE Slack mrkdwn primitives (SLACK-CORE).
//
// The SHARED low-level formatting layer used by BOTH monitor emitters
// (dogfood/slack-thread.ts · monitor/slack-notify.ts). No I/O, no clock, no
// random — every function is `string → string` (or a small tuple in), so a
// rendered message is byte-identical for identical input (deterministic tests).
//
// Slack "mrkdwn" is NOT CommonMark: bold is `*x*` (single asterisk), italic is
// `_x_`, inline code is backticks. These primitives encode exactly that dialect.
// ---------------------------------------------------------------------------

/** Bold — Slack mrkdwn uses a SINGLE asterisk (`*x*`, not `**x**`). */
export function bold(text: string): string {
  return `*${text}*`;
}

/** Italic — Slack mrkdwn underscores (`_x_`). */
export function italic(text: string): string {
  return `_${text}_`;
}

/** Inline code span (backticks). */
export function code(text: string): string {
  return `\`${text}\``;
}

/** A single bullet line (`• item`). Compose several with `\n`. */
export function bullet(text: string): string {
  return `• ${text}`;
}

/**
 * A titled section: a bold heading followed by its body lines (each already a
 * rendered string, e.g. `bullet(...)`). Empty bodies render the heading alone.
 */
export function section(title: string, lines: string[] = []): string {
  const head = bold(title);
  return lines.length === 0 ? head : `${head}\n${lines.join("\n")}`;
}

/**
 * A deterministic UTC `HH:MM` clock label for an epoch-ms stamp. Pure (no locale,
 * no self-read clock) — the caller INJECTS the epoch, so renders stay stable
 * across machines/timezones.
 */
export function ts(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

/**
 * A compact human duration for a millisecond span (`0s` · `45s` · `12m` · `3h`).
 * Pure + deterministic. Used by progress/heartbeat lines.
 */
export function fmtDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}
