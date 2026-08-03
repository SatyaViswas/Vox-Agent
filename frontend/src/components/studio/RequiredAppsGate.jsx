import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Plug } from "lucide-react";
import { Link } from "react-router-dom";
import {
  connectApp,
  connectAppWithCredentials,
  getConnectRequirements,
  getRequiredAppsStatus,
} from "../../api/vault";
import CredentialConnectModal from "../vault/CredentialConnectModal";

/**
 * Blocks agent creation until every app the blueprint actually needs is
 * connected — checked live against Composio (and the legacy Telegram
 * Personal Account table) rather than assumed. Without this, "Save & Run"
 * would create an agent that's silently broken (an on-demand step failing
 * on its first real run, or an event-triggered agent that just never
 * produces anything visible) instead of telling the user up front exactly
 * what to connect.
 */
export default function RequiredAppsGate({ requiredApps, userId, onStatusChange }) {
  const [apps, setApps] = useState(null); // null while loading
  const [error, setError] = useState(null);
  const [connectingSlug, setConnectingSlug] = useState(null);
  const [connectError, setConnectError] = useState(null);
  const [credentialTarget, setCredentialTarget] = useState(null);
  const popupRef = useRef(null);

  const names = requiredApps || [];
  const namesKey = names.join(",");

  const refresh = useCallback(() => {
    if (names.length === 0) {
      setApps([]);
      return Promise.resolve();
    }
    setError(null);
    return getRequiredAppsStatus(userId, names)
      .then((res) => setApps(res?.apps || []))
      .catch((err) => setError(err.message || "Failed to check which apps are connected."));
  }, [userId, namesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setApps(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey, userId]);

  const allConnected = Array.isArray(apps) && apps.every((a) => a.connected);

  useEffect(() => {
    onStatusChange?.(apps === null ? null : allConnected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, allConnected]);

  const handleConnect = async (app) => {
    setConnectError(null);
    setConnectingSlug(app.slug);
    try {
      const requirements = await getConnectRequirements(app.slug);
      if (requirements.mode !== "oauth") {
        setConnectingSlug(null);
        setCredentialTarget({ app: { name: app.app, slug: app.slug }, fields: requirements.fields || [] });
        return;
      }

      const res = await connectApp(userId, app.slug);
      if (res.status === "no_auth_required") {
        setConnectingSlug(null);
        refresh();
        return;
      }

      const popup = window.open(res.redirect_url, "voxagent-oauth", "width=520,height=680");
      if (!popup) {
        setConnectError(`Your browser blocked the popup. Allow popups for this site, then try connecting ${app.app} again.`);
        setConnectingSlug(null);
        return;
      }
      popupRef.current = popup;

      const poll = setInterval(() => {
        if (popup.closed) {
          clearInterval(poll);
          setConnectingSlug(null);
          refresh();
        }
      }, 700);
    } catch (err) {
      setConnectError(err.message || `Failed to start the connection for ${app.app}.`);
      setConnectingSlug(null);
    }
  };

  const handleCredentialSubmit = async (values) => {
    const { app } = credentialTarget;
    await connectAppWithCredentials(userId, app.slug, values);
    setCredentialTarget(null);
    refresh();
  };

  if (names.length === 0) return null;

  return (
    <div className="glass-panel p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Plug size={16} className="text-brand-500" />
        Required apps
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </div>
      )}
      {connectError && (
        <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle size={14} className="shrink-0" />
          {connectError}
        </div>
      )}

      {apps === null ? (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 size={13} className="animate-spin" />
          Checking connections…
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {apps.map((a) => {
            const connecting = connectingSlug === a.slug;
            return (
              <div
                key={a.app}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-300/60 dark:border-white/10 px-3 py-2"
              >
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                    a.connected ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${a.connected ? "bg-emerald-500" : "bg-amber-500"}`} />
                  {a.app}
                </span>

                {a.connected ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 size={12} />
                    {a.builtin ? "Always available" : "Connected"}
                  </span>
                ) : a.connect_via === "telegram_personal" ? (
                  <Link
                    to="/vault"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-500 hover:text-brand-600"
                  >
                    Connect in App Vault <ExternalLink size={11} />
                  </Link>
                ) : (
                  <button
                    onClick={() => handleConnect(a)}
                    disabled={connecting}
                    className="flex items-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-[11px] font-medium px-3 py-1.5 transition-colors"
                  >
                    {connecting ? <Loader2 size={11} className="animate-spin" /> : null}
                    {connecting ? "Connecting…" : "Connect"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CredentialConnectModal
        app={credentialTarget?.app}
        fields={credentialTarget?.fields || []}
        onClose={() => setCredentialTarget(null)}
        onSubmit={handleCredentialSubmit}
      />
    </div>
  );
}
