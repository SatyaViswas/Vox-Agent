# Monitoring — `*dogfood` (inward) + `*monitor` (outward) User Manual

> Helix ships **two** monitors that share the low-level Slack transport but keep **separate voices**:
>
> | | **Dogfood Monitor** (`*dogfood`) | **External Monitor** (`*monitor`) |
> |---|---|---|
> | Direction | INWARD — self-observation of a live session | OUTWARD — watches system conditions |
> | Watches | `config.dogfood.source_dir` (a live coding session) | `config.triggers` (evaluate/diagnose rules) |
> | On tick / match | re-render report + post a Slack **thread** reply | route a `HandoverBundle` + post a Slack **notification** |
> | Slack shape | a live THREAD (root + progress replies) | discrete one-shot NOTIFICATIONS |
> | Ships | live (watch-by-default) | **DISABLED** (no auto-fire until enabled) |
>
> §1–4 below cover `*dogfood`; **§5 covers `*monitor`**. Both post only when Slack is configured;
> unconfigured ⇒ no Slack, never an error.

---

## 1. What `*dogfood` is

`*dogfood` is Helix's **inward self-observation** monitor. It live-tails a Helix coding session and,
on every drift **and** at least every 3 minutes, reconstructs the ADL trajectory, extracts feedback +
signals, and re-renders a live status report.

- **Always live.** `*dogfood` is a monitor, not a one-shot: it watches by default (3-minute heartbeat
  **+** on-drift re-render). There is no "just render once" operator mode (an internal `--once` exists
  for tests only).
- **Start:** `*dogfood <sessionId>` — or `*dogfood` with no id to watch the latest session in the
  configured `source_dir`.
- **Stop:** `*dogfood-stop` (it also stops on session inactivity).
- **Where the report lands:** `.mutagent/dogfood/<runId>/status.html` — a self-contained HTML page that
  **auto-reloads** in the browser (Helix auto-opens it once). Sections: timeline · command usage ·
  subagents · feedback · Call-Stack DAG.

> **Build project ≠ dogfood target.** `*dogfood` does NOT watch the project you're developing Helix in;
> it watches the dogfood TARGET project's Claude-Code session dir, set in `config.dogfood.source_dir`.

---

## 2. Config reference — `config.dogfood`

In `.mutagent/config.yaml`:

```yaml
dogfood:
  # The dogfood TARGET project's Claude-Code session dir (NOT the build project).
  # Absolute by design (Claude encodes the project cwd by replacing "/" with "-").
  source_dir: "~/.claude/projects/-Users-you-Desktop-your-DOGFOOD-project"

  # Forced re-render cadence in seconds. Default 180 (3 min). The watch loop ALSO
  # re-renders on drift (a new *command / ADL stage / [feedback] / subagent).
  cadence_seconds: 180

  # Resolve + ingest dispatched subagent session JSONLs too. Default true.
  include_subagents: true

  # OPTIONAL live Slack thread (see §3). Omit or set enabled:false ⇒ HTML report
  # only, never an error.
  slack:
    enabled: true
    channel: "C0123ABC"              # a Slack channel id the bot is in
    token_ref: "SLACK_BOT_TOKEN"     # the ENV-VAR NAME holding the xoxb-… token (never the secret itself)
```

| Key | Meaning | Default |
|---|---|---|
| `source_dir` | dogfood target's `~/.claude/projects/<enc(path)>/` dir | *(required)* |
| `cadence_seconds` | forced re-render cadence (seconds) | `180` |
| `include_subagents` | ingest dispatched subagent transcripts | `true` |
| `slack.enabled` | post a live Slack thread | `false` |
| `slack.channel` | Slack channel id | — |
| `slack.token_ref` | **name** of the env var holding the bot token | — |

---

## 3. Slack setup — the operator flow {#slack-setup}

The dogfood live thread posts a **root message on start** and **threaded replies** as the session moves
(stage change · agent dispatch · feedback · signal · progress heartbeat · stop). Threading requires the
Slack **Web API** (`chat.postMessage` + `thread_ts`) — a **bot token**, NOT an incoming webhook.

**Step by step:**

1. **Create a Slack App.** Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
   Name it (e.g. "Helix Dogfood") and pick your workspace.
2. **Add the bot scope.** In the app: **OAuth & Permissions** → **Scopes** → **Bot Token Scopes** → add
   **`chat:write`**. If you'll post to a channel the bot hasn't been invited to, also add
   **`chat:write.public`**.
3. **Install to workspace.** **OAuth & Permissions** → **Install to Workspace** → Allow. Copy the
   **Bot User OAuth Token** — it starts with `xoxb-…`.
4. **Export the token as an env var.** The **name** (not the value) goes in `token_ref`:
   ```bash
   export SLACK_BOT_TOKEN=xoxb-your-token-here
   ```
5. **Invite the bot + get the channel id.** In the target channel run `/invite @YourApp`. Get the
   channel **ID** (`C0…`) from the channel's *View channel details* (bottom of the popover) or the URL.
6. **Set the config:**
   ```yaml
   dogfood:
     slack: { enabled: true, channel: "C0123ABC", token_ref: "SLACK_BOT_TOKEN" }
   ```
7. **Run it.** `*dogfood <sessionId>` → a live thread appears in the channel (root + replies). Verify the
   root posts and replies thread underneath as the session moves.

> **Unconfigured = no Slack.** With no token/channel, or `enabled:false`, `*dogfood` produces the HTML
> report only and posts nothing — it is **never** an error. A misconfigured or unreachable Slack likewise
> never breaks a render (the post silently no-ops).

### Troubleshooting

| Slack error | Cause | Fix |
|---|---|---|
| `not_in_channel` | the bot isn't a member of `channel` | `/invite @YourApp` in that channel (or add `chat:write.public`) |
| `invalid_auth` | token missing/expired, or `token_ref` points at an unset/typo'd env var | re-check the exported env var name + value (`echo $SLACK_BOT_TOKEN`) |
| `missing_scope` | the app lacks `chat:write` | add the **Bot Token Scope** `chat:write`, then **reinstall** the app |
| *(nothing posts, no error)* | `slack.enabled:false` or `token_ref` env var unset | set `enabled:true` and export the token; disabled/unset ⇒ intentional no-op |

---

## 4. Quick reference

```bash
# start watching the latest session in source_dir
*dogfood

# start watching a specific session
*dogfood d4e98196-926d-4602-965f-d5aed291a54c

# stop
*dogfood-stop

# the live report (auto-reloads in the browser)
.mutagent/dogfood/<runId>/status.html
```

---

## 5. The External Monitor — `*monitor` (outward)

`*monitor` is Helix's **outward** monitor. Where `*dogfood` looks INWARD at a live session,
`*monitor` watches **conditions** in `config.triggers` (the dormant evaluate/diagnose trigger rules).
When a trigger fires, it **routes** a `HandoverBundle` to the target ADL stage — the same dispatch
model as `*discover` — and posts a discrete Slack **notification**. It never runs the stage itself
and never edits a target; it hands off and notifies.

- **Notification vs dogfood thread (the distinction).** `*dogfood` posts a live THREAD (a root
  message + progress replies under it) so coworkers follow one session in real time. `*monitor` posts
  a discrete NOTIFICATION — one standalone message per fired trigger. Shared Slack transport
  (`scripts/slack/*`), **separate emitters**: `dogfood/slack-thread.ts` vs `monitor/slack-notify.ts`.
- **Start / stop:** `*monitor` arms the watch; `*monitor-stop` disarms it. Both are internal
  (maintainer/system) commands — invocable by name, hidden from the roster.

### Ships DISABLED — how to enable

The condition source is `config.triggers`, which **ships DISABLED** (`enabled:false`, empty rules).
A disabled block fires **nothing**, so a fresh install never auto-fires. To enable a trigger, opt in
per stage:

```yaml
# .mutagent/config.yaml
triggers:
  diagnose:
    enabled: true                 # ← opt-in (ships false)
    rules:
      - on: "trace-count>=100"    # fire when ≥ 100 new traces arrive
        run: "*diagnose"          # the stage/command to route to
  evaluate:
    enabled: true
    rules:
      - on: "schedule"            # fire on a scheduled wake
        run: "*evaluate"
```

**Event kinds** a rule's `on` can name: `trace-count` (optionally `trace-count>=N` / `trace-count>N`),
`schedule`, `ci`, `manual`. A rule fires only for its own event kind (and, for `trace-count` with a
threshold, only when the count satisfies the comparator).

### The external notification sink — `config.monitor.slack`

`*monitor` uses its **own** Slack sink, separate from `dogfood.slack`:

```yaml
# .mutagent/config.yaml
monitor:
  slack:                          # OPTIONAL — omit / disable ⇒ no notifications, never an error
    enabled: true
    channel: "C0123ABC"           # a Slack channel id the bot is a member of
    token_ref: "SLACK_BOT_TOKEN"  # the ENV-VAR NAME holding the xoxb-… bot token (never the secret)
```

The Slack app setup is identical to §3 (`chat:write` bot token; `token_ref` is the env-var **name**).
Unconfigured / disabled `monitor.slack` ⇒ the monitor still **routes** the handover, it just posts no
Slack (the post no-ops; a broken Slack never blocks a route).

| Key | Meaning | Default |
|---|---|---|
| `triggers.<stage>.enabled` | arm this stage's rules | `false` (ships DISABLED) |
| `triggers.<stage>.rules[].on` | the event condition (`trace-count[>=N]` · `schedule` · `ci` · `manual`) | — |
| `triggers.<stage>.rules[].run` | the stage/command to route to on a match | — |
| `monitor.slack.enabled` | post a notification per fired trigger | `false` |
| `monitor.slack.channel` | Slack channel id | — |
| `monitor.slack.token_ref` | **name** of the env var holding the bot token | — |

```bash
# arm the external watch on config.triggers
*monitor

# disarm it
*monitor-stop
```
