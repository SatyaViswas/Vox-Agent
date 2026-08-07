import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Globe, Loader2, Pencil, Plus, QrCode, Send, Trash2 } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { disconnectApp, getVaultApps, saveSession } from "../../api/vault";
import WhatsAppQrModal from "./WhatsAppQrModal";
import TelegramLoginModal from "./TelegramLoginModal";
import PortalSessionFormModal from "./PortalSessionFormModal";

const TELEGRAM_PERSONAL_APP_NAME = "Telegram Personal Account";
const TELEGRAM_BOT_APP_NAME = "Telegram Bot";

const isWhatsApp = (appName) => (appName || "").toLowerCase() === "whatsapp web";
const isTelegramPersonal = (appName) => (appName || "").toLowerCase() === TELEGRAM_PERSONAL_APP_NAME.toLowerCase();
const isTelegramBot = (appName) => (appName || "").toLowerCase() === TELEGRAM_BOT_APP_NAME.toLowerCase();

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
        const rows = (res?.apps || []).filter((a) => a.auth_type === "session_cookie" && a.status !== "revoked");
        setSessions(rows);
        setError(null);
      })
      .catch((err) => setError(err.message || t("vault.webSessionsTab.loadFailed")))
      .finally(() => setLoading(false));
  }, [userId]);

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

  const handleSubmitPortal = async ({ name, url, username, password }) => {
    await saveSession({
      userId,
      appName: name,
      authType: "session_cookie",
      credentials: { url, username, password },
    });
    setFormState(null);
    fetchSessions();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("vault.webSessionsTab.description")}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setFormState({ mode: "create" })}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300/70 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 text-sm font-medium px-4 py-2.5 transition-colors shrink-0"
          >
            <Plus size={16} />
            {t("vault.webSessionsTab.newPortalSession")}
          </button>
          <button
            onClick={() => setTelegramMode("bot")}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300/70 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 text-sm font-medium px-4 py-2.5 transition-colors shrink-0"
            title={t("vault.webSessionsTab.linkBotTitle")}
          >
            <Send size={16} />
            {t("vault.webSessionsTab.linkTelegramBot")}
          </button>
          <button
            onClick={() => setTelegramMode("personal")}
            className="flex items-center gap-1.5 rounded-xl border border-slate-300/70 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 text-sm font-medium px-4 py-2.5 transition-colors shrink-0"
            title={t("vault.webSessionsTab.linkPersonalTitle")}
          >
            <Send size={16} />
            {t("vault.webSessionsTab.linkTelegramAccount")}
          </button>
          <button
            onClick={() => setQrOpen(true)}
            className="flex items-center gap-1.5 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2.5 transition-colors shrink-0"
          >
            <QrCode size={16} />
            {t("vault.webSessionsTab.linkWhatsApp")}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={16} className="shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="glass-panel p-10 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          {t("vault.webSessionsTab.loading")}
        </div>
      ) : sessions.length === 0 ? (
        <div className="glass-panel p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          {t("vault.webSessionsTab.empty")}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map((session) => (
            <div key={session.id} className="glass-panel p-4 flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-brand-500/10 text-brand-500 shrink-0">
                {(isTelegramPersonal(session.app_name) || isTelegramBot(session.app_name)) ? <Send size={18} /> : <Globe size={18} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{session.app_name}</p>
                <p
                  className={`text-xs ${
                    session.status === "active" ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400"
                  }`}
                >
                  {session.status === "active" ? t("vault.webSessionsTab.activeSession") : session.status}
                </p>
              </div>
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
                className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-brand-500 hover:bg-brand-500/10 transition-colors shrink-0"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => handleDisconnect(session)}
                title={t("vault.webSessionsTab.removeSession")}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <WhatsAppQrModal open={qrOpen} onClose={() => setQrOpen(false)} onLinked={fetchSessions} />
      <TelegramLoginModal mode={telegramMode} open={!!telegramMode} onClose={() => setTelegramMode(null)} onLinked={fetchSessions} />
      <PortalSessionFormModal
        open={!!formState}
        mode={formState?.mode}
        initialName={formState?.name}
        onClose={() => setFormState(null)}
        onSubmit={handleSubmitPortal}
      />
    </div>
  );
}
