import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";

export function paramKey(param) {
  return `${param.step_number}::${param.parameter_key}`;
}

export default function DisambiguationPanel({
  blueprint,
  values,
  onChange,
  onUpdate,
  approved,
  onApprovedChange,
  resolved,
}) {
  const { t } = useTranslation();
  const missingParameters = blueprint?.missing_parameters || [];
  const needsApproval = Boolean(blueprint?.needs_human_approval);
  const needsClarification = Boolean(blueprint?.needs_clarification) || missingParameters.length > 0;

  if (!needsClarification && !needsApproval) return null;

  if (resolved) {
    return (
      <div className="rounded-2xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-3 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 size={16} />
        {t("disambiguation.updatedReady")}
      </div>
    );
  }

  const allFilled = missingParameters.every((p) => (values[paramKey(p)] || "").trim().length > 0);
  const canUpdate = allFilled && (!needsApproval || approved);

  return (
    <div className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 md:p-5 shadow-[0_0_30px_rgba(245,158,11,0.08)]">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-medium text-sm mb-1">
        <AlertTriangle size={16} className="shrink-0" />
        {t("disambiguation.needsDetails")}
      </div>
      {blueprint.clarification_question && (
        <p className="text-xs text-amber-700/80 dark:text-amber-300/80 mb-3">{blueprint.clarification_question}</p>
      )}

      {missingParameters.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          {missingParameters.map((param) => {
            const key = paramKey(param);
            return (
              <div key={key} className="flex flex-col gap-1.5">
                <label htmlFor={key} className="text-xs font-medium text-slate-600 dark:text-slate-300">
                  {param.label}{" "}
                  <span className="text-slate-400 dark:text-slate-500 font-normal">
                    {t("disambiguation.stepSuffix", { number: param.step_number })}
                  </span>
                </label>
                {param.suggested_type === "select" && param.options ? (
                  <select
                    id={key}
                    value={values[key] || ""}
                    onChange={(e) => onChange(key, e.target.value)}
                    className="rounded-lg border border-amber-400/40 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/50 appearance-none"
                  >
                    <option value="" disabled>{t("disambiguation.selectOption")}</option>
                    {param.options.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={key}
                    type={param.suggested_type === "number" ? "number" : "text"}
                    placeholder={param.description}
                    value={values[key] || ""}
                    onChange={(e) => onChange(key, e.target.value)}
                    className="rounded-lg border border-amber-400/40 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400/50"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {needsApproval && (
        <label className="mt-4 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300 cursor-pointer">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => onApprovedChange(e.target.checked)}
            className="w-4 h-4 accent-amber-500"
          />
          {t("disambiguation.approvalConfirm")}
        </label>
      )}

      <button
        onClick={onUpdate}
        disabled={!canUpdate}
        className="mt-4 flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition-colors"
      >
        <Sparkles size={14} />
        {t("disambiguation.updateBlueprint")}
      </button>
    </div>
  );
}
