import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Plug } from "lucide-react";
import { Link } from "react-router-dom";
import {
  connectApp,
  connectAppWithCredentials,
  getConnectRequirements,
  getRequiredAppsStatus,
  saveSession,
} from "../../api/vault";

const DEPLOY_TOKEN_HINTS = {
  vercel: "https://vercel.com/account/tokens",
  render: "https://dashboard.render.com/u/settings#api-keys",
  netlify: "https://app.netlify.com/user/applications#personal-access-tokens",
};
import CredentialConnectModal from "../vault/CredentialConnectModal";
import PortalSessionFormModal from "../vault/PortalSessionFormModal";
import TelegramLoginModal from "../vault/TelegramLoginModal";

/**
 * Blocks agent creation until every app the blueprint actually needs is
 * connected — checked live against Composio (and the legacy Telegram
 * Personal Account table) rather than assumed. Without this, "Save & Run"
 * would create an agent that's silently broken (an on-demand step failing
 * on its first real run, or an event-triggered agent that just never
 * produces anything visible) instead of telling the user up front exactly
 * what to connect.
 *
 * `requiredApps` is a list of `{ app, route }` pairs derived straight from
 * the blueprint's own steps (see AgentStudio.jsx's deriveRequiredApps) —
 * NOT the planner LLM's freeform `required_apps` field — so an app only
 * shows up here when a real step actually uses it, and its `route` decides
 * which connect flow applies: a `composio_api` app goes through Composio's
 * OAuth/credential flow same as before; a `browser_agent` app instead needs
 * a saved App Vault session (cookies or a login form), never a Composio
 * connection — probing Composio for one of those is exactly what used to
 * either crash (an app Composio doesn't have at all, e.g. "zomato") or
 * mislead (offering an OAuth "Connect" for an app the workflow never calls
 * the API of, e.g. a browser_agent-only "Google Slides" step).
 */
export default function RequiredAppsGate({ requiredApps, userId, onStatusChange }) {
  const { t } = useTranslation();
  const [apps, setApps] = useState(null); // null while loading
  const [error, setError] = useState(null);
  const [connectingSlug, setConnectingSlug] = useState(null);
  const [connectError, setConnectError] = useState(null);
  const [credentialTarget, setCredentialTarget] = useState(null);
  const [portalTarget, setPortalTarget] = useState(null);
  const [telegramTarget, setTelegramTarget] = useState(null);
  const popupRef = useRef(null);

  const entries = requiredApps || [];
  const names = entries.map((a) => (typeof a === "string" ? a : a.app));
  const routes = entries.map((a) => (typeof a === "string" ? undefined : a.route));
  const namesKey = entries.map((a) => (typeof a === "string" ? a : `${a.app}:${a.route || ""}`)).join(",");

  const refresh = useCallback(() => {
    if (names.length === 0) {
      setApps([]);
      return Promise.resolve();
    }
    setError(null);
    return getRequiredAppsStatus(userId, names, routes)
      .then((res) => setApps(res?.apps || []))
      .catch((err) => setError(err.message || t("requiredApps.checkFailed")));
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
        setConnectError(t("requiredApps.popupBlocked", { app: app.app }));
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
      setConnectError(err.message || t("requiredApps.connectStartFailed", { app: app.app }));
      setConnectingSlug(null);
    }
  };

  const handleCredentialSubmit = async (values) => {
    const { app, connectVia } = credentialTarget;
    if (connectVia === "deploy_vault") {
      await saveSession({
        userId,
        appName: app.name,
        authType: "api_key",
        credentials: values,
      });
    } else {
      await connectAppWithCredentials(userId, app.slug, values);
    }
    setCredentialTarget(null);
    refresh();
  };

  if (names.length === 0) return null;

  return (
    <div className="glass-panel p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Plug size={16} className="text-brand-500" />
        {t("requiredApps.title")}
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
          {t("requiredApps.checkingConnections")}
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
                    {a.builtin || a.no_auth_required ? t("requiredApps.alwaysAvailable") : t("requiredApps.connected")}
                  </span>
                ) : a.connect_via === "telegram_personal" ? (
                  <Link
                    to="/vault"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-500 hover:text-brand-600"
                  >
                    {t("requiredApps.connectInVault")} <ExternalLink size={11} />
                  </Link>
                ) : a.connect_via === "telegram_bot" ? (
                  <button
                    onClick={() => setTelegramTarget({ mode: "bot" })}
                    className="flex items-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-[11px] font-medium px-3 py-1.5 transition-colors"
                  >
                    {t("requiredApps.connect")}
                  </button>
                ) : a.connect_via === "deploy_vault" ? (
                  <button
                    onClick={() =>
                      setCredentialTarget({
                        app: { name: a.app, slug: a.app.toLowerCase() },
                        connectVia: "deploy_vault",
                        fields: [
                          {
                            name: "api_key",
                            display_name: `${a.app} API Token`,
                            is_secret: true,
                            description: `Generate a personal API token at ${
                              DEPLOY_TOKEN_HINTS[a.app.toLowerCase()] || "your provider settings"
                            }. Stored encrypted in App Vault.`,
                          },
                        ],
                      })
                    }
                    className="flex items-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-[11px] font-medium px-3 py-1.5 transition-colors"
                  >
                    {t("requiredApps.connect")}
                  </button>
                ) : a.connect_via === "browser_vault" ? (
                  <button
                    onClick={() => setPortalTarget({ app: a.app })}
                    className="flex items-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-[11px] font-medium px-3 py-1.5 transition-colors"
                  >
                    {t("requiredApps.connect")}
                  </button>
                ) : (
                  <button
                    onClick={() => handleConnect(a)}
                    disabled={connecting}
                    className="flex items-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-[11px] font-medium px-3 py-1.5 transition-colors"
                  >
                    {connecting ? <Loader2 size={11} className="animate-spin" /> : null}
                    {connecting ? t("requiredApps.connecting") : t("requiredApps.connect")}
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

      <PortalSessionFormModal
        open={!!portalTarget}
        mode="create"
        initialName={portalTarget?.app}
        lockName
        userId={userId}
        onClose={() => setPortalTarget(null)}
        onConnected={refresh}
      />

      <TelegramLoginModal
        open={!!telegramTarget}
        mode={telegramTarget?.mode}
        onClose={() => setTelegramTarget(null)}
        onLinked={() => {
          setTelegramTarget(null);
          refresh();
        }}
      />
    </div>
  );
}
