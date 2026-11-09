import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Globe,
  Loader2,
  Pencil,
  Plus,
  QrCode,
  Send,
  Trash2,
  Zap,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { disconnectApp, getVaultApps } from "../../api/vault";
import WhatsAppQrModal from "./WhatsAppQrModal";
import TelegramLoginModal from "./TelegramLoginModal";
import PortalSessionFormModal from "./PortalSessionFormModal";

const TELEGRAM_PERSONAL_APP_NAME = "Telegram Personal Account";
const TELEGRAM_BOT_APP_NAME = "Telegram Bot";

const isWhatsApp = (appName) => (appName || "").toLowerCase() === "whatsapp web";
const isTelegramPersonal = (appName) =>
  (appName || "").toLowerCase() === TELEGRAM_PERSONAL_APP_NAME.toLowerCase();
const isTelegramBot = (appName) =>
  (appName || "").toLowerCase() === TELEGRAM_BOT_APP_NAME.toLowerCase();

export default function WebSessionsTab() {
  const { userId } = useAuth();
  const { t } = useTranslation();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [telegramMode, setTelegramMode] = useState(null); // "personal" | "bot" | null
  const [formState, setFormState] = useState(null); // { mode: "create" | "edit", name?: string }

  const fetchSessions = useCallback(() => {
    setLoading(true);
    getVaultApps(userId)
      .then((res) => {
        const rows = (res?.apps || []).filter(
          (a) => a.auth_type === "session_cookie" && a.status !== "revoked"
        );
        setSessions(rows);
        setError(null);
      })
      .catch((err) => setError(err.message || t("vault.webSessionsTab.loadFailed")))
      .finally(() => setLoading(false));
  }, [userId, t]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleDisconnect = async (session) => {
    setSessions((prev) => prev.filter((s) => s.id !== session.id));
    try {
      await disconnectApp(userId, session.app_name);
    } catch (err) {
      setError(err.message || t("vault.webSessionsTab.disconnectFailed", { name: session.app_name }));
      fetchSessions();
    }
  };

  const handleEdit = (session) => {
    if (isWhatsApp(session.app_name)) {
      setQrOpen(true);
    } else if (isTelegramPersonal(session.app_name)) {
      setTelegramMode("personal");
    } else if (isTelegramBot(session.app_name)) {
      setTelegramMode("bot");
    } else {
      setFormState({ mode: "edit", name: session.app_name });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
        {t("vault.webSessionsTab.description")}
      </p>

      {/* Mobile-Native Session Quick Action Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3">
        {/* WhatsApp Web */}
        <button
          onClick={() => setQrOpen(true)}
          className="glass-panel p-3.5 rounded-2xl flex flex-col items-start gap-2 border border-slate-200/70 dark:border-white/10 hover:border-emerald-500/40 active:scale-95 transition-all text-left touch-manipulation group"
        >
          <div className="w-9 h-9 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <QrCode size={18} />
          </div>
          <div>
            <p className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 group-hover:text-emerald-500 transition-colors">
              WhatsApp Web
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">Link via QR code</p>
          </div>
        </button>

        {/* Telegram Bot */}
        <button
          onClick={() => setTelegramMode("bot")}
          className="glass-panel p-3.5 rounded-2xl flex flex-col items-start gap-2 border border-slate-200/70 dark:border-white/10 hover:border-sky-500/40 active:scale-95 transition-all text-left touch-manipulation group"
        >
          <div className="w-9 h-9 rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
            <Send size={17} />
          </div>
          <div>
            <p className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 group-hover:text-sky-500 transition-colors">
              Telegram Bot
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">Token authentication</p>
          </div>
        </button>

        {/* Telegram Personal Account */}
        <button
          onClick={() => setTelegramMode("personal")}
          className="glass-panel p-3.5 rounded-2xl flex flex-col items-start gap-2 border border-slate-200/70 dark:border-white/10 hover:border-indigo-500/40 active:scale-95 transition-all text-left touch-manipulation group"
        >
          <div className="w-9 h-9 rounded-xl bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <Send size={17} />
          </div>
          <div>
            <p className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 group-hover:text-indigo-500 transition-colors">
              Telegram Account
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">Phone & OTP login</p>
          </div>
        </button>

        {/* New Portal Session */}
        <button
          onClick={() => setFormState({ mode: "create" })}
          className="glass-panel p-3.5 rounded-2xl flex flex-col items-start gap-2 border border-slate-200/70 dark:border-white/10 hover:border-brand-500/40 active:scale-95 transition-all text-left touch-manipulation group"
        >
          <div className="w-9 h-9 rounded-xl bg-brand-500/15 text-brand-600 dark:text-brand-400 flex items-center justify-center shrink-0">
            <Plus size={18} />
          </div>
          <div>
            <p className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 group-hover:text-brand-500 transition-colors">
              New Portal
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">Custom website session</p>
          </div>
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-xs sm:text-sm text-red-600 dark:text-red-400 animate-fadeIn">
          <AlertCircle size={16} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="glass-panel rounded-2xl p-10 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={18} className="animate-spin text-brand-500" />
          <span>{t("vault.webSessionsTab.loading")}</span>
        </div>
      ) : sessions.length === 0 ? (
        <div className="glass-panel rounded-3xl p-8 sm:p-12 text-center flex flex-col items-center justify-center gap-3 border border-slate-200/70 dark:border-white/10 shadow-sm">
          <div className="w-14 h-14 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center mb-1">
            <Globe size={26} />
          </div>
          <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-white">
            {t("vault.webSessionsTab.empty")}
          </h3>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md">
            Connect your WhatsApp Web, Telegram bot or account, or create a portal session to let AI agents automate actions in web apps.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="glass-panel p-4 rounded-2xl flex items-center justify-between gap-3 border border-slate-200/70 dark:border-white/10 shadow-xs hover:border-brand-500/30 transition-all"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400 shrink-0">
                  {isTelegramPersonal(session.app_name) || isTelegramBot(session.app_name) ? (
                    <Send size={18} />
                  ) : (
                    <Globe size={18} />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-xs sm:text-sm truncate text-slate-800 dark:text-slate-100">
                    {session.app_name}
                  </p>
                  <p
                    className={`text-[11px] font-semibold flex items-center gap-1 mt-0.5 ${
                      session.status === "active"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-slate-400"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        session.status === "active" ? "bg-emerald-500 animate-pulse" : "bg-slate-400"
                      }`}
                    />
                    <span>
                      {session.status === "active"
                        ? t("vault.webSessionsTab.activeSession")
                        : session.status}
                    </span>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => handleEdit(session)}
                  title={
                    isWhatsApp(session.app_name)
                      ? t("vault.webSessionsTab.relinkWhatsApp")
                      : isTelegramPersonal(session.app_name)
                      ? t("vault.webSessionsTab.relinkTelegramAccount")
                      : isTelegramBot(session.app_name)
                      ? t("vault.webSessionsTab.relinkTelegramBot")
                      : t("vault.webSessionsTab.editLoginDetails")
                  }
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation"
                >
                  <Pencil size={15} />
                </button>
                <button
                  onClick={() => handleDisconnect(session)}
                  title={t("vault.webSessionsTab.removeSession")}
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-slate-500 hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-all touch-manipulation"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <WhatsAppQrModal open={qrOpen} onClose={() => setQrOpen(false)} onLinked={fetchSessions} />
      <TelegramLoginModal
        mode={telegramMode}
        open={!!telegramMode}
        onClose={() => setTelegramMode(null)}
        onLinked={fetchSessions}
      />
      <PortalSessionFormModal
        open={!!formState}
        mode={formState?.mode}
        initialName={formState?.name}
        lockName={formState?.mode === "edit"}
        userId={userId}
        onClose={() => setFormState(null)}
        onConnected={fetchSessions}
      />
    </div>
  );
}
