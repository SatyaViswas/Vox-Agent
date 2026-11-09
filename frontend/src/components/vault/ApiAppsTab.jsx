import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Mic,
  RefreshCw,
  Search,
  Unplug,
  X,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import useSpeechRecognition from "../../hooks/useSpeechRecognition";
import {
  connectApp,
  connectAppWithCredentials,
  disconnectComposioAccount,
  getComposioApps,
  getComposioConnections,
  getConnectRequirements,
} from "../../api/vault";
import AppIcon from "./AppIcon";
import CredentialConnectModal from "./CredentialConnectModal";
import MobileVaultAppCard from "./MobileVaultAppCard";

const SEARCH_DEBOUNCE_MS = 350;

const VAULT_CATEGORIES = [
  { id: "all", label: "All Apps" },
  { id: "connected", label: "Connected" },
  { id: "google", label: "Google Workspace" },
  { id: "messaging", label: "Messaging & Chat" },
  { id: "productivity", label: "Productivity & CRM" },
  { id: "developer", label: "Developer & Cloud" },
];

export default function ApiAppsTab() {
  const { userId } = useAuth();
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [totalItems, setTotalItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalogError, setCatalogError] = useState(null);

  const [connections, setConnections] = useState({});
  const [noAuthSlugs, setNoAuthSlugs] = useState(new Set());
  const [connectingSlug, setConnectingSlug] = useState(null);
  const [error, setError] = useState(null);
  const [credentialTarget, setCredentialTarget] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const popupRef = useRef(null);
  const debounceRef = useRef(null);

  // Gnani Prisma Voice Search with smart command routing
  const {
    isRecording: isVoiceSearching,
    isProcessing: isVoiceProcessing,
    interimTranscript,
    toggle: toggleVoiceSearch,
  } = useSpeechRecognition({
    onFinalTranscript: (text) => {
      const clean = (text || "").trim();
      if (!clean) return;

      const lower = clean.toLowerCase();
      if (lower.includes("show connected") || lower === "connected") {
        setSelectedCategory("connected");
        return;
      }
      if (lower.includes("google") || lower.includes("gmail") || lower.includes("workspace")) {
        setSelectedCategory("google");
        return;
      }
      if (lower.includes("messaging") || lower.includes("chat") || lower.includes("telegram")) {
        setSelectedCategory("messaging");
        return;
      }
      if (lower.includes("productivity") || lower.includes("notion")) {
        setSelectedCategory("productivity");
        return;
      }
      if (lower.includes("developer") || lower.includes("github")) {
        setSelectedCategory("developer");
        return;
      }
      if (lower.includes("all apps") || lower === "all") {
        setSelectedCategory("all");
        return;
      }

      handleSearchChange(clean);
    },
  });

  const refreshConnections = useCallback(() => {
    return getComposioConnections(userId)
      .then((res) => {
        setConnections(Object.fromEntries((res?.connections || []).map((c) => [c.slug, c])));
      })
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    refreshConnections();
  }, [refreshConnections]);

  const fetchCatalog = useCallback((searchTerm) => {
    setLoading(true);
    setCatalogError(null);
    getComposioApps({ search: searchTerm || undefined, limit: 32 })
      .then((res) => {
        setApps(res?.apps || []);
        setNextCursor(res?.next_cursor || null);
        setTotalItems(res?.total_items ?? null);
      })
      .catch((err) => setCatalogError(err.message || t("vault.apiAppsTab.loadCatalogFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    fetchCatalog("");
  }, [fetchCatalog]);

  const handleSearchChange = (value) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchCatalog(value), SEARCH_DEBOUNCE_MS);
  };

  const handleClearSearch = () => {
    setQuery("");
    fetchCatalog("");
  };

  const handleLoadMore = () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    getComposioApps({ search: query || undefined, cursor: nextCursor, limit: 32 })
      .then((res) => {
        setApps((prev) => [...prev, ...(res?.apps || [])]);
        setNextCursor(res?.next_cursor || null);
      })
      .catch((err) => setCatalogError(err.message || t("vault.apiAppsTab.loadMoreFailed")))
      .finally(() => setLoadingMore(false));
  };

  const isConnected = (app) => Boolean(connections[app.slug]);
  const isNoAuthAlways = (app) => app.auth_mode === "none" || noAuthSlugs.has(app.slug);

  const connectedCount = Object.keys(connections).length;

  const handleConnect = async (app) => {
    setError(null);
    setConnectingSlug(app.slug);
    try {
      const requirements = await getConnectRequirements(app.slug);
      if (requirements.mode === "none") {
        setConnectingSlug(null);
        setNoAuthSlugs((prev) => new Set(prev).add(app.slug));
        return;
      }
      if (requirements.mode !== "oauth") {
        setConnectingSlug(null);
        setCredentialTarget({ app, fields: requirements.fields || [], authScheme: requirements.auth_scheme });
        return;
      }

      const res = await connectApp(userId, app.slug);
      if (res.status === "no_auth_required") {
        setConnectingSlug(null);
        setNoAuthSlugs((prev) => new Set(prev).add(app.slug));
        return;
      }

      const popup = window.open(res.redirect_url, "voxagent-oauth", "width=520,height=680");

      if (!popup) {
        setError(t("vault.apiAppsTab.popupBlocked", { name: app.name }));
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
      setError(err.message || t("vault.apiAppsTab.connectStartFailed", { name: app.name }));
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
      setError(err.message || t("vault.apiAppsTab.disconnectFailed", { name: app.name }));
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
      setError(err.message || t("vault.apiAppsTab.disconnectFailed", { name: app.name }));
      setConnectingSlug(null);
    }
  };

  const filteredApps = useMemo(() => {
    return apps.filter((app) => {
      if (selectedCategory === "all") return true;
      if (selectedCategory === "connected") return isConnected(app) || isNoAuthAlways(app);
      const slug = (app.slug || "").toLowerCase();
      const name = (app.name || "").toLowerCase();
      const cat = (app.category || "").toLowerCase();

      if (selectedCategory === "google") {
        return (
          slug.includes("google") ||
          slug.includes("gmail") ||
          name.includes("google") ||
          name.includes("gmail") ||
          slug.includes("sheet") ||
          slug.includes("doc") ||
          slug.includes("drive") ||
          slug.includes("calendar")
        );
      }
      if (selectedCategory === "messaging") {
        return (
          cat.includes("communication") ||
          ["slack", "discord", "telegram", "whatsapp", "teams"].some(
            (s) => slug.includes(s) || name.includes(s)
          )
        );
      }
      if (selectedCategory === "productivity") {
        return (
          cat.includes("productivity") ||
          ["notion", "airtable", "linear", "trello", "asana", "hubspot", "jira"].some(
            (s) => slug.includes(s) || name.includes(s)
          )
        );
      }
      if (selectedCategory === "developer") {
        return (
          cat.includes("developer") ||
          ["github", "gitlab", "supabase", "docker", "postman"].some(
            (s) => slug.includes(s) || name.includes(s)
          )
        );
      }
      return true;
    });
  }, [apps, selectedCategory, connections, noAuthSlugs]);

  // List of connected apps for the quick pinned strip
  const connectedAppsList = useMemo(() => {
    return apps.filter((app) => isConnected(app));
  }, [apps, connections]);

  return (
    <div className="flex flex-col gap-3.5">
      {/* Full-width Search Input with Gnani Prisma Voice Recognition */}
      <div className="relative flex items-center w-full">
        <Search size={18} className="absolute left-3.5 text-slate-400 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder={
            isVoiceSearching
              ? interimTranscript || "Listening... Say 'Google Sheets' or 'Connected'"
              : t("vault.apiAppsTab.searchPlaceholder")
          }
          className={`w-full rounded-2xl border bg-white/70 dark:bg-black/20 pl-10 pr-24 py-3 text-xs sm:text-sm outline-none transition-all shadow-xs ${
            isVoiceSearching
              ? "border-emerald-500 ring-2 ring-emerald-500/30 text-emerald-600 dark:text-emerald-400"
              : "border-slate-300/70 dark:border-white/15 focus:ring-2 focus:ring-brand-400/50"
          }`}
        />
        <div className="absolute right-2 flex items-center gap-1">
          {query && (
            <button
              onClick={handleClearSearch}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 active:scale-95 transition-all"
              aria-label="Clear search"
            >
              <X size={15} />
            </button>
          )}
          <button
            type="button"
            onClick={() => toggleVoiceSearch()}
            className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all active:scale-95 touch-manipulation ${
              isVoiceSearching
                ? "bg-emerald-500 text-white animate-pulse shadow-sm shadow-emerald-500/40"
                : isVoiceProcessing
                ? "bg-brand-500/20 text-brand-500"
                : "text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            }`}
            title="Voice search apps with Gnani Prisma"
            aria-label="Voice search apps"
          >
            {isVoiceProcessing ? (
              <Loader2 size={16} className="animate-spin text-brand-500" />
            ) : (
              <Mic size={17} className={isVoiceSearching ? "animate-bounce" : ""} />
            )}
          </button>
        </div>
      </div>

      {/* Pinned "My Connected Apps" Quick Ribbon (if any apps are connected) */}
      {connectedAppsList.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300 px-1">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
              <span>Active Integrations ({connectedAppsList.length})</span>
            </span>
            <button
              onClick={() => setSelectedCategory("connected")}
              className="text-brand-500 hover:underline flex items-center gap-0.5"
            >
              <span>View all</span>
              <ChevronRight size={13} />
            </button>
          </div>
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
            {connectedAppsList.map((app) => (
              <button
                key={app.slug}
                onClick={() => {
                  setQuery(app.name);
                  fetchCatalog(app.name);
                }}
                className="flex items-center gap-2 rounded-xl glass-panel px-3 py-1.5 border border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 active:scale-95 transition-all shrink-0 touch-manipulation"
              >
                <AppIcon app={app} className="w-5 h-5 rounded-lg" />
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">{app.name}</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Swipeable Category Filter Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1">
        {VAULT_CATEGORIES.map((cat) => {
          const isSelected = selectedCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategory(cat.id)}
              className={`shrink-0 flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all active:scale-95 touch-manipulation min-h-[36px] ${
                isSelected
                  ? "bg-brand-500 text-white shadow-sm shadow-brand-500/25"
                  : "bg-white/70 dark:bg-white/5 border border-slate-200/70 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:bg-brand-500/10"
              }`}
            >
              {cat.id === "connected" && (
                <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? "bg-white" : "bg-emerald-500"} inline-block animate-pulse`} />
              )}
              <span>{cat.label}</span>
              {cat.id === "connected" && connectedCount > 0 && (
                <span className={`text-[10px] font-mono px-1 rounded-full ${isSelected ? "bg-white/20 text-white" : "text-emerald-500"}`}>
                  {connectedCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {(error || catalogError) && (
        <div className="rounded-2xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-xs sm:text-sm text-red-600 dark:text-red-400 animate-fadeIn">
          <AlertCircle size={16} className="shrink-0" />
          <span>{error || catalogError}</span>
        </div>
      )}

      {/* Main SaaS App Card Grid */}
      {loading ? (
        <div className="glass-panel rounded-2xl p-12 flex flex-col items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={22} className="animate-spin text-brand-500" />
          <span>{t("vault.apiAppsTab.loadingCatalog")}</span>
        </div>
      ) : filteredApps.length === 0 ? (
        <div className="glass-panel rounded-3xl p-8 sm:p-12 text-center flex flex-col items-center justify-center gap-3 border border-slate-200/70 dark:border-white/10 shadow-sm">
          <div className="w-14 h-14 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center mb-1">
            <Search size={26} />
          </div>
          <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-white">
            {query ? `No apps matching "${query}"` : t("vault.apiAppsTab.noMatch")}
          </h3>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md">
            {query
              ? "Try checking your spelling or speak another tool name with the 🎙️ mic."
              : "No tools match this category filter. Try selecting 'All Apps'."}
          </p>
          {(query || selectedCategory !== "all") && (
            <button
              onClick={() => {
                setQuery("");
                setSelectedCategory("all");
                fetchCatalog("");
              }}
              className="mt-2 px-4 py-2.5 rounded-xl border border-slate-300 dark:border-white/15 text-xs font-semibold hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all"
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Mobile-Native App Card Feed (< sm) */}
          <div className="sm:hidden flex flex-col gap-2.5">
            {filteredApps.map((app) => (
              <MobileVaultAppCard
                key={app.slug}
                app={app}
                connected={isConnected(app)}
                noAuthNeeded={isNoAuthAlways(app)}
                connecting={connectingSlug === app.slug}
                onConnect={handleConnect}
                onChangeAccount={handleChangeAccount}
                onDisconnect={handleDisconnect}
              />
            ))}
          </div>

          {/* Desktop Responsive Grid Feed (>= sm) */}
          <div className="hidden sm:grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5 sm:gap-4">
            {filteredApps.map((app) => {
              const connected = isConnected(app);
              const noAuthNeeded = isNoAuthAlways(app);
              const connecting = connectingSlug === app.slug;
              return (
                <div
                  key={app.slug}
                  className="glass-panel rounded-2xl p-4 flex flex-col justify-between gap-3.5 border border-slate-200/70 dark:border-white/10 shadow-xs hover:border-brand-500/40 transition-all hover:shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <AppIcon app={app} className="w-10 h-10 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-semibold text-xs sm:text-sm truncate text-slate-800 dark:text-slate-100">
                          {app.name}
                        </p>
                        <p className="text-[11px] text-slate-400 capitalize truncate">
                          {app.category || "Tool"}
                        </p>
                      </div>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 text-[10px] font-semibold shrink-0 px-2 py-0.5 rounded-full ${
                        connected || noAuthNeeded
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                          : "bg-slate-200/50 dark:bg-white/5 text-slate-500 dark:text-slate-400"
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          connected || noAuthNeeded ? "bg-emerald-500" : "bg-slate-400"
                        }`}
                      />
                      <span>
                        {connected
                          ? t("vault.apiAppsTab.connected")
                          : noAuthNeeded
                          ? t("vault.apiAppsTab.alwaysAvailable")
                          : t("vault.apiAppsTab.notConnected")}
                      </span>
                    </span>
                  </div>

                  <div className="pt-1">
                    {noAuthNeeded ? (
                      <p className="text-xs text-slate-500 dark:text-slate-400 text-center py-2 bg-slate-100/60 dark:bg-white/5 rounded-xl font-medium">
                        {t("vault.apiAppsTab.noConnectionNeeded")}
                      </p>
                    ) : connected ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          disabled
                          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold min-h-[42px] border border-emerald-500/20"
                        >
                          <CheckCircle2 size={14} />
                          <span>{t("vault.apiAppsTab.connected")}</span>
                        </button>
                        <button
                          onClick={() => handleChangeAccount(app)}
                          disabled={connecting}
                          title={t("vault.apiAppsTab.changeAccountTitle", { name: app.name })}
                          className="w-11 h-11 flex items-center justify-center rounded-xl border border-slate-300/70 dark:border-white/15 text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 disabled:opacity-60 transition-colors shrink-0 active:scale-95 touch-manipulation"
                          aria-label="Change account"
                        >
                          {connecting ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                        </button>
                        <button
                          onClick={() => handleDisconnect(app)}
                          disabled={connecting}
                          title={t("vault.apiAppsTab.disconnectAccountTitle", { name: app.name })}
                          className="w-11 h-11 flex items-center justify-center rounded-xl border border-red-300/70 dark:border-red-500/20 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-60 transition-colors shrink-0 active:scale-95 touch-manipulation"
                          aria-label="Disconnect account"
                        >
                          {connecting ? <Loader2 size={15} className="animate-spin" /> : <Unplug size={15} />}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleConnect(app)}
                        disabled={connecting}
                        className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 disabled:opacity-60 text-white text-xs sm:text-sm font-semibold min-h-[42px] shadow-sm shadow-brand-500/25 active:scale-[0.98] transition-all touch-manipulation"
                      >
                        {connecting ? (
                          <>
                            <Loader2 size={15} className="animate-spin" />
                            <span>{t("vault.apiAppsTab.connecting")}</span>
                          </>
                        ) : (
                          <span>{t("vault.apiAppsTab.connectOneClick")}</span>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {nextCursor && (
            <div className="flex justify-center pt-2">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="flex items-center justify-center gap-2 rounded-2xl border border-slate-300/70 dark:border-white/15 text-xs sm:text-sm font-semibold px-8 py-3 text-slate-700 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 disabled:opacity-60 transition-all active:scale-95 shadow-xs touch-manipulation min-h-[44px]"
              >
                {loadingMore && <Loader2 size={16} className="animate-spin text-brand-500" />}
                <span>{loadingMore ? t("common.loading") : t("vault.apiAppsTab.loadMore")}</span>
              </button>
            </div>
          )}
        </>
      )}

      <CredentialConnectModal
        app={credentialTarget?.app}
        fields={credentialTarget?.fields || []}
        authScheme={credentialTarget?.authScheme}
        onClose={() => setCredentialTarget(null)}
        onSubmit={handleCredentialSubmit}
      />
    </div>
  );
}
