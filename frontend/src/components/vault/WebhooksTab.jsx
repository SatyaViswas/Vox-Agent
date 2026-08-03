import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { disconnectApp, getVaultApps, saveSession } from "../../api/vault";
import WebhookFormModal from "./WebhookFormModal";

export default function WebhooksTab() {
  const { userId } = useAuth();
  const [webhooks, setWebhooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [formState, setFormState] = useState(null); // { mode: "create" | "edit", name?: string }

  const fetchWebhooks = () => {
    setLoading(true);
    getVaultApps(userId)
      .then((res) => {
        const rows = (res?.apps || []).filter((a) => a.auth_type === "api_key" && a.status !== "revoked");
        setWebhooks(rows);
        setError(null);
      })
      .catch((err) => setError(err.message || "Failed to load webhooks."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchWebhooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleSubmit = async ({ name, url, headers }) => {
    await saveSession({ userId, appName: name, authType: "api_key", credentials: { url, headers } });
    setFormState(null);
    fetchWebhooks();
  };

  const handleRemove = async (webhook) => {
    setWebhooks((prev) => prev.filter((w) => w.id !== webhook.id));
    try {
      await disconnectApp(userId, webhook.app_name);
    } catch (err) {
      setError(err.message || `Failed to remove ${webhook.app_name}.`);
      fetchWebhooks();
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Register custom REST endpoints and keys VoxAgent's HTTP engine can call directly.
        </p>
        <button
          onClick={() => setFormState({ mode: "create" })}
          className="flex items-center gap-1.5 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-4 py-2.5 transition-colors shrink-0"
        >
          <Plus size={16} />
          New Webhook
        </button>
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
          Loading webhooks…
        </div>
      ) : webhooks.length === 0 ? (
        <div className="glass-panel p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          No custom webhooks yet. Add one to let agents call it directly.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {webhooks.map((webhook) => (
            <div key={webhook.id} className="glass-panel p-4 flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-teal-500/10 text-teal-600 dark:text-teal-400 shrink-0">
                <Zap size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{webhook.app_name}</p>
                <p className="text-xs text-slate-400">
                  Updated {webhook.updated_at ? new Date(webhook.updated_at).toLocaleDateString() : "recently"}
                </p>
              </div>
              <button
                onClick={() => setFormState({ mode: "edit", name: webhook.app_name })}
                title="Edit webhook"
                className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-brand-500 hover:bg-brand-500/10 transition-colors shrink-0"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => handleRemove(webhook)}
                title="Remove webhook"
                className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
              >
                <Trash2 size={14} />
              </button>
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
