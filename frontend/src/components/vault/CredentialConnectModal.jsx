import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, KeyRound, Loader2, X } from "lucide-react";

export default function CredentialConnectModal({ app, fields, authScheme, onClose, onSubmit }) {
  const { t } = useTranslation();
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setValues({});
    setError(null);
  }, [app]);

  if (!app) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err.message || t("vault.credentialModal.connectFailed", { name: app.name }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <form onSubmit={handleSubmit} className="relative glass-panel w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{t("vault.credentialModal.connectTitle", { name: app.name })}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 -mt-1">
          {t("vault.credentialModal.noOauthNotice", { name: app.name })}
        </p>

        {authScheme === "OAUTH2" && (
          <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>
              {t("vault.credentialModal.oauth2Notice", { name: app.name })}
            </span>
          </div>
        )}

        {fields.map((field) => (
          <div key={field.name} className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{field.display_name}</label>
            <input
              value={values[field.name] || ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
              type={field.is_secret ? "password" : "text"}
              required
              placeholder={field.description}
              className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
            />
            {field.description && (
              <p className="text-[11px] text-slate-400 dark:text-slate-500">{field.description}</p>
            )}
          </div>
        ))}

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
          {saving ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
          {saving ? t("vault.credentialModal.connecting") : t("vault.credentialModal.connectTitle", { name: app.name })}
        </button>
      </form>
    </div>
  );
}
