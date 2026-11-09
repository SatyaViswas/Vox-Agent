import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronDown, Loader2, LogIn, Save, X } from "lucide-react";
import { cancelBrowserLogin, captureBrowserLogin, saveSession, startBrowserLogin } from "../../api/vault";
import MobileBrowserLiveView from "./MobileBrowserLiveView";

const checkIsMobile = () => {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
  return Boolean(isMobileUA || (hasTouch && window.innerWidth <= 820));
};

// Connecting a browser_agent app used to mean typing a username/password
// into VoxAgent's own UI and hoping the target site's bot detection didn't
// notice an automated login. It usually does. This instead opens a real,
// visible browser window the user logs into themselves — completely
// ordinary human browsing from the site's point of view — and silently
// captures the resulting session cookies once they say they're done (see
// backend/app/services/browser_login_engine.py). The old manual
// username/password path stays available behind "Advanced" for sites where
// popping up a window isn't practical.
export default function PortalSessionFormModal({ open, mode, initialName, lockName = false, userId, onClose, onConnected }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const [phase, setPhase] = useState("idle"); // idle | starting | waiting | mobile_streaming | capturing
  const [sessionId, setSessionId] = useState(null);
  const [isMobileSession, setIsMobileSession] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initialName || "");
    setUrl("");
    setUsername("");
    setPassword("");
    setAdvancedOpen(false);
    setError(null);
    setPhase("idle");
    setSessionId(null);
    setIsMobileSession(false);
  }, [open, initialName]);

  // If the modal is closed (or unmounted) while a login window is still
  // open and waiting, cancel the backend session instead of leaving an
  // orphaned browser window and in-memory session behind.
  useEffect(() => {
    return () => {
      if (sessionId) cancelBrowserLogin(sessionId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  if (!open) return null;

  const isEdit = mode === "edit";

  const handleStartLogin = async () => {
    setError(null);
    setPhase("starting");
    try {
      const mobile = checkIsMobile();
      const vpWidth = mobile && typeof window !== "undefined" ? Math.round(window.innerWidth) : 390;
      const vpHeight = mobile && typeof window !== "undefined" ? Math.round(window.innerHeight - 82) : 844;
      const res = await startBrowserLogin({
        userId,
        appName: name,
        loginUrl: url || undefined,
        isMobile: mobile,
        viewportWidth: mobile ? vpWidth : undefined,
        viewportHeight: mobile ? vpHeight : undefined,
      });
      setSessionId(res.session_id);
      if (res.is_mobile) {
        setIsMobileSession(true);
        setPhase("mobile_streaming");
      } else {
        setIsMobileSession(false);
        setPhase("waiting");
      }
    } catch (err) {
      setError(err.message || t("vault.portalModal.browserLoginStartFailed"));
      setPhase("idle");
    }
  };

  const handleDone = async () => {
    setError(null);
    const prevPhase = phase;
    setPhase("capturing");
    try {
      await captureBrowserLogin(sessionId);
      setSessionId(null);
      setPhase("idle");
      setIsMobileSession(false);
      onConnected?.();
      onClose();
    } catch (err) {
      setError(err.message || t("vault.portalModal.browserLoginCaptureFailed"));
      setPhase(prevPhase);
    }
  };

  const handleCancelLogin = async () => {
    const sid = sessionId;
    setSessionId(null);
    setPhase("idle");
    setIsMobileSession(false);
    if (sid) await cancelBrowserLogin(sid).catch(() => {});
  };

  const handleAdvancedSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await saveSession({ userId, appName: name, authType: "session_cookie", credentials: { url, username, password } });
      onConnected?.();
      onClose();
    } catch (err) {
      setError(err.message || t("vault.portalModal.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (phase === "mobile_streaming" || (phase === "capturing" && isMobileSession)) {
    return createPortal(
      <MobileBrowserLiveView
        sessionId={sessionId}
        appName={name}
        onDone={handleDone}
        onCancel={handleCancelLogin}
        capturing={phase === "capturing"}
        error={error}
      />,
      document.body
    );
  }

  const waiting = phase === "waiting" || (phase === "capturing" && !isMobileSession);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={waiting ? undefined : onClose} />
      <div className="relative bg-white dark:bg-[#13131a] border border-slate-200 dark:border-white/10 rounded-2xl shadow-xl w-full max-w-md p-6 flex flex-col gap-4 text-slate-900 dark:text-slate-100">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            {isEdit ? t("vault.portalModal.updateTitle") : t("vault.portalModal.createTitle")}
          </h2>
          {!waiting && (
            <button
              type="button"
              onClick={onClose}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
              aria-label={t("common.close")}
            >
              <X size={18} />
            </button>
          )}
        </div>

        {waiting ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <Loader2 size={28} className="animate-spin text-brand-500" />
              <p className="text-sm font-medium">{t("vault.portalModal.browserLoginWaitingTitle")}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("vault.portalModal.browserLoginWaitingBody", { app: name })}
              </p>
            </div>
            {error && (
              <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                <AlertCircle size={14} className="shrink-0" />
                {error}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDone}
                disabled={phase === "capturing"}
                className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-sm font-medium py-2.5 transition-colors"
              >
                {phase === "capturing" ? <Loader2 size={15} className="animate-spin" /> : null}
                {phase === "capturing" ? t("vault.portalModal.browserLoginCapturing") : t("vault.portalModal.browserLoginDone")}
              </button>
              <button
                type="button"
                onClick={handleCancelLogin}
                disabled={phase === "capturing"}
                className="rounded-lg border border-slate-300/70 dark:border-white/15 disabled:opacity-40 text-slate-600 dark:text-slate-300 text-sm font-medium px-4 py-2.5 transition-colors"
              >
                {t("vault.portalModal.browserLoginCancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400 -mt-1">{t("vault.portalModal.browserLoginIntro")}</p>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("vault.portalModal.nameLabel")}</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isEdit || lockName}
                required
                placeholder={t("vault.portalModal.namePlaceholder")}
                className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50 disabled:opacity-60"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("vault.portalModal.urlLabel")}</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                type="url"
                placeholder={t("vault.portalModal.urlPlaceholder")}
                className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
                <AlertCircle size={14} className="shrink-0" />
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleStartLogin}
              disabled={!name.trim() || phase === "starting"}
              className="flex items-center justify-center gap-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-sm font-medium py-2.5 transition-colors"
            >
              {phase === "starting" ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
              {phase === "starting" ? t("vault.portalModal.browserLoginStarting") : t("vault.portalModal.browserLoginButton")}
            </button>

            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 self-start"
            >
              <ChevronDown size={13} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              {t("vault.portalModal.advancedToggle")}
            </button>

            {advancedOpen && (
              <form onSubmit={handleAdvancedSubmit} className="flex flex-col gap-3 rounded-lg border border-slate-200/70 dark:border-white/10 p-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("vault.portalModal.usernameLabel")}</label>
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder={t("vault.portalModal.usernamePlaceholder")}
                      className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("vault.portalModal.passwordLabel")}</label>
                    <input
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      type="password"
                      placeholder={t("vault.portalModal.passwordPlaceholder")}
                      className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center justify-center gap-2 rounded-lg border border-slate-300/70 dark:border-white/15 hover:bg-slate-900/5 dark:hover:bg-white/5 disabled:opacity-60 text-slate-700 dark:text-slate-200 text-sm font-medium py-2 transition-colors"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {saving ? t("vault.portalModal.saving") : t("vault.portalModal.save")}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
