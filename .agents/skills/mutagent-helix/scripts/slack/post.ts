// ---------------------------------------------------------------------------
// slack/post — the SHARED Slack transport (SLACK-CORE). The ONE impure seam.
//
// Threading needs the Slack WEB API (`chat.postMessage` + `thread_ts`), NOT a
// plain incoming webhook (webhooks cannot open/append a thread). We call it with
// native `fetch` — NO `@slack/*` runtime dependency (packaging: no new deps).
//
// CONFIG-GATED NO-OP: with no bot token OR no channel, every call RETURNS null
// WITHOUT touching the network — Slack is a strictly-optional sink. Unconfigured
// ⇒ HTML report only, never an error. A network/HTTP failure ALSO returns null
// (never throws): a broken Slack must never break a dogfood render.
//
// Testability: `fetch` is injectable via `deps.fetch` so a test can assert the
// no-op path performs ZERO network calls.
// ---------------------------------------------------------------------------

/** A built thread message — `root` opens the thread, `reply` appends to it. */
export interface SlackMsg {
  kind: "root" | "reply";
  text: string;
}

/** The init shape we hand to `fetch` (structural — avoids depending on DOM libs). */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The response shape we read back (only `json()` is used). */
export interface FetchResponse {
  json(): Promise<unknown>;
}

/** The minimal `fetch` shape this module needs (injectable for tests). */
export type FetchLike = (input: string, init?: FetchInit) => Promise<FetchResponse>;

/** Injectable dependencies — defaults to the global `fetch`. */
export interface PostDeps {
  fetch?: FetchLike;
}

/** The result of a successful post — the message `ts` (the thread anchor). */
export interface PostResult {
  ts: string;
}

const CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

/** True only when BOTH a non-empty token and channel are present. */
function configured(token: string | undefined, channel: string | undefined): boolean {
  return typeof token === "string" && token.length > 0 && typeof channel === "string" && channel.length > 0;
}

/** POST to chat.postMessage; returns the `ts` on ok, else null. Never throws. */
async function chatPostMessage(
  body: Record<string, unknown>,
  token: string,
  deps: PostDeps,
): Promise<PostResult | null> {
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (doFetch === undefined) return null;
  try {
    const res = await doFetch(CHAT_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; ts?: string };
    if (json.ok === true && typeof json.ts === "string") return { ts: json.ts };
    return null;
  } catch {
    return null;
  }
}

/** Arguments for opening a thread (posting the root message). */
export interface PostMessageArgs {
  channel: string;
  text: string;
  token?: string;
}

/**
 * Post a top-level message → returns its `ts` (use it as `thread_ts` for
 * replies). Config-gated no-op: no token/channel ⇒ null, no network.
 */
export async function postMessage(args: PostMessageArgs, deps: PostDeps = {}): Promise<PostResult | null> {
  if (!configured(args.token, args.channel)) return null;
  return chatPostMessage({ channel: args.channel, text: args.text }, args.token as string, deps);
}

/** Arguments for appending a threaded reply. */
export interface PostReplyArgs {
  channel: string;
  thread_ts: string;
  text: string;
  token?: string;
}

/**
 * Append a reply under `thread_ts`. Config-gated no-op: no token/channel (or no
 * thread anchor) ⇒ null, no network.
 */
export async function postReply(args: PostReplyArgs, deps: PostDeps = {}): Promise<PostResult | null> {
  if (!configured(args.token, args.channel) || args.thread_ts.length === 0) return null;
  return chatPostMessage(
    { channel: args.channel, thread_ts: args.thread_ts, text: args.text },
    args.token as string,
    deps,
  );
}
