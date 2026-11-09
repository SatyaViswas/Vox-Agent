import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Link2, Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { disconnectApp, getVaultApps, saveSession } from "../../api/vault";
import WebhookFormModal from "./WebhookFormModal";

export default function WebhooksTab() {
  const { userId } = useAuth();
  const { t } = useTranslation();
  const [webhooks, setWebhooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [formState, setFormState] = useState(null); // { mode: "create" | "edit", name?: string }

  const fetchWebhooks = () => {
    setLoading(true);
    getVaultApps(userId)
      .then((res) => {
        const rows = (res?.apps || []).filter(
          (a) => a.auth_type === "api_key" && a.status !== "revoked"
        );
        setWebhooks(rows);
        setError(null);
      })
      .catch((err) => setError(err.message || t("vault.webhooksTab.loadFailed")))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchWebhooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleSubmit = async ({ name, url, headers }) => {
    await saveSession({
      userId,
      appName: name,
      authType: "api_key",
      credentials: { url, headers },
    });
    setFormState(null);
    fetchWebhooks();
  };

  const handleRemove = async (webhook) => {
    setWebhooks((prev) => prev.filter((w) => w.id !== webhook.id));
    try {
      await disconnectApp(userId, webhook.app_name);
    } catch (err) {
      setError(err.message || t("vault.webhooksTab.removeFailed", { name: webhook.app_name }));
      fetchWebhooks();
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
          {t("vault.webhooksTab.description")}
        </p>
        <button
          onClick={() => setFormState({ mode: "create" })}
          className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 active:scale-95 text-white text-xs sm:text-sm font-semibold px-4 py-2.5 transition-all shadow-sm shadow-brand-500/25 shrink-0 touch-manipulation min-h-[40px]"
        >
          <Plus size={16} />
          <span>{t("vault.webhooksTab.newWebhook")}</span>
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
          <span>{t("vault.webhooksTab.loading")}</span>
        </div>
      ) : webhooks.length === 0 ? (
        <div className="glass-panel rounded-3xl p-8 sm:p-12 text-center flex flex-col items-center justify-center gap-3 border border-slate-200/70 dark:border-white/10 shadow-sm">
          <div className="w-14 h-14 rounded-2xl bg-teal-500/10 text-teal-600 dark:text-teal-400 flex items-center justify-center mb-1">
            <Link2 size={26} />
          </div>
          <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-white">
            {t("vault.webhooksTab.empty")}
          </h3>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md">
            Register custom HTTP webhooks with authorization headers to trigger workflow automations.
          </p>
          <button
            onClick={() => setFormState({ mode: "create" })}
            className="mt-2 flex items-center gap-1.5 rounded-xl bg-brand-500 text-white text-xs font-semibold px-4 py-2.5 hover:bg-brand-600 active:scale-95 transition-all"
          >
            <Plus size={15} />
            <span>Create First Webhook</span>
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {webhooks.map((webhook) => (
            <div
              key={webhook.id}
              className="glass-panel p-4 rounded-2xl flex items-center justify-between gap-3 border border-slate-200/70 dark:border-white/10 shadow-xs hover:border-teal-500/30 transition-all"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-teal-500/10 text-teal-600 dark:text-teal-400 shrink-0">
                  <Zap size={18} />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-xs sm:text-sm truncate text-slate-800 dark:text-slate-100">
                    {webhook.app_name}
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                    {t("vault.webhooksTab.updated", {
                      date: webhook.updated_at
                        ? new Date(webhook.updated_at).toLocaleDateString()
                        : t("vault.webhooksTab.recently"),
                    })}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => setFormState({ mode: "edit", name: webhook.app_name })}
                  title={t("vault.webhooksTab.editWebhook")}
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation"
                >
                  <Pencil size={15} />
                </button>
                <button
                  onClick={() => handleRemove(webhook)}
                  title={t("vault.webhooksTab.removeWebhook")}
                  className="flex items-center justify-center w-10 h-10 rounded-xl text-slate-500 hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-all touch-manipulation"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <WebhookFormModal
        open={!!formState}
        mode={formState?.mode}
        initialName={formState?.name}
        onClose={() => setFormState(null)}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
