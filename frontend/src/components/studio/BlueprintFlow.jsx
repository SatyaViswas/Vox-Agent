import { useTranslation } from "react-i18next";
import { Workflow } from "lucide-react";
import StepNode from "./StepNode";

export default function BlueprintFlow({ blueprint, stepStatuses }) {
  const { t } = useTranslation();
  if (!blueprint) {
    return (
      <div className="flex-1 flex items-center justify-center rounded-xl border border-dashed border-slate-300/70 dark:border-white/10 text-center px-6">
        <p className="text-sm text-slate-400 dark:text-slate-500">
          {t("blueprintFlow.placeholder")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto pr-1">
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div>
          <h3 className="font-semibold text-sm">{blueprint.title}</h3>
          {blueprint.required_apps?.length > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {t("blueprintFlow.uses", { apps: blueprint.required_apps.join(", ") })}
            </p>
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full glass px-3 py-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
          <Workflow size={12} />
          {blueprint.trigger?.type === "schedule" ? t("blueprintFlow.scheduled") : t("blueprintFlow.manualTrigger")}
        </span>
      </div>

      <div>
        {blueprint.steps.map((step, i) => (
          <StepNode
            key={step.step_number}
            step={step}
            status={stepStatuses?.[step.step_number] || "pending"}
            isLast={i === blueprint.steps.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
