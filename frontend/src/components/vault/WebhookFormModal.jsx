import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2, Save, X } from "lucide-react";

export default function WebhookFormModal({ open, mode, initialName, onClose, onSubmit }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName || "");
    setUrl("");
    setHeaders("");
    setError(null);
  }, [open, initialName]);

  if (!open) return null;

  const isEdit = mode === "edit";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    let parsedHeaders = {};
    if (headers.trim()) {
      try {
        parsedHeaders = JSON.parse(headers);
      } catch {
        setError(t("vault.webhookModal.invalidHeaders"));
        return;
      }
    }

    setSaving(true);
    try {
      await onSubmit({ name, url, headers: parsedHeaders });
    } catch (err) {
      setError(err.message || t("vault.webhookModal.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <form onSubmit={handleSubmit} className="relative glass-panel w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{isEdit ? t("vault.webhookModal.updateTitle") : t("vault.webhookModal.createTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>

        {isEdit && (
          <p className="text-xs text-slate-500 dark:text-slate-400 -mt-1">
            {t("vault.webhookModal.editNotice")}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("vault.webhookModal.nameLabel")}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            required
            placeholder={t("vault.webhookModal.namePlaceholder")}
            className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50 disabled:opacity-60"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("vault.webhookModal.urlLabel")}</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            placeholder={t("vault.webhookModal.urlPlaceholder")}
            className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("vault.webhookModal.headersLabel")}</label>
          <textarea
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            rows={3}
            placeholder={t("vault.webhookModal.headersPlaceholder")}
            className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-brand-400/50 resize-none"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle size={14} className="shrink-0" />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="flex items-center justify-center gap-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-sm font-medium py-2.5 transition-colors"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {saving ? t("vault.webhookModal.saving") : t("vault.webhookModal.save")}
        </button>
      </form>
    </div>
  );
}
