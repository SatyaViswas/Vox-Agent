import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Search, Unplug } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import {
  connectApp,
  connectAppWithCredentials,
  disconnectComposioAccount,
  getComposioApps,
  getComposioConnections,
  getConnectRequirements,
  mockConnectApp,
} from "../../api/vault";
import AppIcon from "./AppIcon";
import CredentialConnectModal from "./CredentialConnectModal";

const SEARCH_DEBOUNCE_MS = 400;

export default function ApiAppsTab() {
  const { userId } = useAuth();
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [totalItems, setTotalItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalogError, setCatalogError] = useState(null);

  // Keyed by toolkit slug — the source of truth for "is this connected" is
  // read live from Composio's own connected_accounts API (see
  // list_composio_connected_accounts on the backend), not a local flag, so
  // it stays correct across refreshes no matter what.
  const [connections, setConnections] = useState({});
  // Toolkits Composio reports as needing OAuth/credentials but whose tools
  // actually run with no connected account at all (e.g. Gemini) — learned
  // reactively the first time a connect attempt comes back "no_auth_required".
  const [noAuthSlugs, setNoAuthSlugs] = useState(new Set());
  const [connectingSlug, setConnectingSlug] = useState(null);
  const [error, setError] = useState(null);
  const [credentialTarget, setCredentialTarget] = useState(null); // { app, fields }
  const popupRef = useRef(null);
  const debounceRef = useRef(null);

  const refreshConnections = useCallback(() => {
    return getComposioConnections(userId)
      .then((res) => {
        setConnections(Object.fromEntries((res?.connections || []).map((c) => [c.slug, c])));
      })
      .catch(() => {
        // Non-fatal — connection badges just won't reflect server state yet
      });
  }, [userId]);

  useEffect(() => {
    refreshConnections();
  }, [refreshConnections]);

  const fetchCatalog = useCallback((searchTerm) => {
    setLoading(true);
    setCatalogError(null);
    getComposioApps({ search: searchTerm || undefined, limit: 30 })
      .then((res) => {
        setApps(res?.apps || []);
        setNextCursor(res?.next_cursor || null);
        setTotalItems(res?.total_items ?? null);
      })
      .catch((err) => setCatalogError(err.message || "Failed to load the app catalog."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchCatalog("");
  }, [fetchCatalog]);

  const handleSearchChange = (value) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchCatalog(value), SEARCH_DEBOUNCE_MS);
  };

  const handleLoadMore = () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    getComposioApps({ search: query || undefined, cursor: nextCursor, limit: 30 })
      .then((res) => {
        setApps((prev) => [...prev, ...(res?.apps || [])]);
        setNextCursor(res?.next_cursor || null);
      })
      .catch((err) => setCatalogError(err.message || "Failed to load more apps."))
      .finally(() => setLoadingMore(false));
  };

  const isConnected = (app) => Boolean(connections[app.slug]);

  const handleConnect = async (app) => {
    setError(null);
    setConnectingSlug(app.slug);
    try {
      const requirements = await getConnectRequirements(app.slug);
      if (requirements.mode === "no_auth") {
        // Bypasses authentication & redirects for unauthenticated apps — instantly active
        await mockConnectApp(userId, app.slug);
        setConnectingSlug(null);
        setNoAuthSlugs((prev) => new Set(prev).add(app.slug));
        return;
      }
      if (requirements.mode !== "oauth") {
        // No Composio-managed OAuth for this toolkit (e.g. Telegram, which
        // is bot-token-only) — there's nothing to redirect a popup to.
        setConnectingSlug(null);
        setCredentialTarget({ app, fields: requirements.fields || [] });
        return;
      }

      const res = await connectApp(userId, app.slug);
      if (res.status === "no_auth_required") {
        setConnectingSlug(null);
        setNoAuthSlugs((prev) => new Set(prev).add(app.slug));
        return;
      }

      // Deliberately no "noopener" here — we need the returned window handle to poll .closed.
      const popup = window.open(res.redirect_url, "voxagent-oauth", "width=520,height=680");

      if (!popup) {
        setError(`Your browser blocked the popup. Allow popups for this site, then try connecting ${app.name} again.`);
        setConnectingSlug(null);
        return;
      }
      popupRef.current = popup;

      const poll = setInterval(() => {
        if (popup.closed) {
          clearInterval(poll);
          setConnectingSlug(null);
          refreshConnections();
        }
      }, 700);
    } catch (err) {
      setError(err.message || `Failed to start the connection for ${app.name}.`);
      setConnectingSlug(null);
    }
  };

  const handleCredentialSubmit = async (values) => {
    const { app } = credentialTarget;
    const res = await connectAppWithCredentials(userId, app.slug, values);
    setCredentialTarget(null);
    if (res.status === "no_auth_required") {
      setNoAuthSlugs((prev) => new Set(prev).add(app.slug));
      return;
    }
    refreshConnections();
  };

  const handleDisconnect = async (app) => {
    setError(null);
    const existing = connections[app.slug];
    if (!existing) return;
    setConnectingSlug(app.slug);
    try {
      await disconnectComposioAccount(existing.connected_account_id);
      setConnections((prev) => {
        const next = { ...prev };
        delete next[app.slug];
        return next;
      });
    } catch (err) {
      setError(err.message || `Failed to disconnect the current ${app.name} account.`);
    } finally {
      setConnectingSlug(null);
    }
  };

  const handleChangeAccount = async (app) => {
    setError(null);
    const existing = connections[app.slug];
    if (!existing) {
      handleConnect(app);
      return;
    }
    setConnectingSlug(app.slug);
    try {
      await disconnectComposioAccount(existing.connected_account_id);
      setConnections((prev) => {
        const next = { ...prev };
        delete next[app.slug];
        return next;
      });
      await handleConnect(app);
    } catch (err) {
      setError(err.message || `Failed to disconnect the current ${app.name} account.`);
      setConnectingSlug(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search 1,000+ apps via Composio..."
            className="w-full rounded-xl border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 pl-9 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
          />
        </div>
        {totalItems != null && (
          <span className="text-xs text-slate-400">{totalItems.toLocaleString()} apps available</span>
        )}
      </div>

      {(error || catalogError) && (
        <div className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={16} className="shrink-0" />
          {error || catalogError}
        </div>
      )}

      {loading ? (
        <div className="glass-panel p-10 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          Loading app catalog…
        </div>
      ) : apps.length === 0 ? (
        <div className="glass-panel p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          No apps match your search.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {apps.map((app) => {
              const connected = isConnected(app);
              const noAuthNeeded = noAuthSlugs.has(app.slug);
              const connecting = connectingSlug === app.slug;
              return (
                <div key={app.slug} className="glass-panel p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <AppIcon app={app} />
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                        connected || noAuthNeeded ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400"
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          connected || noAuthNeeded ? "bg-emerald-500" : "bg-slate-400"
                        }`}
                      />
                      {connected ? "Connected" : noAuthNeeded ? "Always Available" : "Not Connected"}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-sm">{app.name}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 capitalize">{app.category}</p>
                  </div>
                  {noAuthNeeded ? (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center py-2">
                      No connection needed — its tools work right away.
                    </p>
                  ) : connected ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        disabled
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium py-2"
                      >
                        <CheckCircle2 size={12} />
                        Connected
                      </button>
                      <button
                        onClick={() => handleChangeAccount(app)}
                        disabled={connecting}
                        title={`Change the ${app.name} account`}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-300/70 dark:border-white/15 text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 disabled:opacity-60 text-xs font-medium py-2 px-2.5 transition-colors shrink-0"
                      >
                        {connecting ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      </button>
                      <button
                        onClick={() => handleDisconnect(app)}
                        disabled={connecting}
                        title={`Disconnect the ${app.name} account`}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-red-300/70 dark:border-red-500/15 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-60 text-xs font-medium py-2 px-2.5 transition-colors shrink-0"
                      >
                        {connecting ? <Loader2 size={12} className="animate-spin" /> : <Unplug size={12} />}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleConnect(app)}
                      disabled={connecting}
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-xs font-medium py-2 transition-colors"
                    >
                      {connecting ? (
                        <>
                          <Loader2 size={12} className="animate-spin" />
                          Connecting…
                        </>
                      ) : (
                        "Connect (1-Click)"
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {nextCursor && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="self-center flex items-center gap-2 rounded-xl border border-slate-300/70 dark:border-white/15 text-sm font-medium px-5 py-2.5 text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 disabled:opacity-60 transition-colors"
            >
              {loadingMore && <Loader2 size={14} className="animate-spin" />}
              {loadingMore ? "Loading…" : "Load More Apps"}
            </button>
          )}
        </>
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
