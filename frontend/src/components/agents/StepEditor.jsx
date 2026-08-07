import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plus, X } from "lucide-react";
import { getRouteConfig } from "../../lib/routeConfig";

export default function StepEditor({ step, onFieldChange, onParamChange, onParamRemove, onParamAdd }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const route = getRouteConfig(step.route);
  const RouteIcon = route.icon;

  const handleAddParam = () => {
    if (!newKey.trim()) return;
    onParamAdd(step.step_number, newKey.trim(), newValue);
    setNewKey("");
    setNewValue("");
  };

  return (
    <div className="rounded-xl border border-slate-200/70 dark:border-white/10 overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-semibold shrink-0 ${route.classes}`}
          >
            {step.step_number}
          </span>
          <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium shrink-0 ${route.classes}`}>
            <RouteIcon size={10} />
            {route.label}
          </span>
          <span className="text-sm truncate">{step.action}</span>
        </div>
        <ChevronDown size={15} className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="p-3 pt-1 border-t border-slate-200/70 dark:border-white/10 space-y-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("stepEditor.action")}</label>
            <input
              value={step.action}
              onChange={(e) => onFieldChange(step.step_number, "action", e.target.value)}
              className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("stepEditor.targetApp")}</label>
            <input
              value={step.app}
              onChange={(e) => onFieldChange(step.step_number, "app", e.target.value)}
              className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("stepEditor.parameters")}</label>
            {Object.entries(step.parameters || {}).map(([key, value]) => (
              <div key={key} className="flex items-center gap-2">
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400 w-1/3 truncate shrink-0">{key}</span>
                <input
                  value={typeof value === "object" ? JSON.stringify(value) : value}
                  onChange={(e) => onParamChange(step.step_number, key, e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-brand-400/50"
                />
                <button
                  onClick={() => onParamRemove(step.step_number, key)}
                  className="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                  aria-label={t("stepEditor.removeParam", { key })}
                >
                  <X size={13} />
                </button>
              </div>
            ))}

            <div className="flex items-center gap-2 mt-1">
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={t("stepEditor.newParamKeyPlaceholder")}
                className="w-1/3 rounded-lg border border-dashed border-slate-300/70 dark:border-white/15 bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-brand-400/50 shrink-0"
              />
              <input
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder={t("stepEditor.valuePlaceholder")}
                className="flex-1 rounded-lg border border-dashed border-slate-300/70 dark:border-white/15 bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:ring-2 focus:ring-brand-400/50"
              />
              <button
                onClick={handleAddParam}
                className="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-brand-500 hover:bg-brand-500/10 transition-colors shrink-0"
                aria-label={t("stepEditor.addParameter")}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
