import { useState } from "react";
import { ChevronDown, Circle, Loader2, CheckCircle2, XCircle, HelpCircle } from "lucide-react";
import { getRouteConfig } from "../../lib/routeConfig";

const STATUS_CONFIG = {
  pending: {
    label: "Pending",
    icon: Circle,
    ring: "ring-slate-300/60 dark:ring-white/10",
    badge: "bg-slate-400/10 text-slate-500 dark:text-slate-400",
  },
  executing: {
    label: "Executing",
    icon: Loader2,
    ring: "ring-brand-400/70 shadow-[0_0_0_4px_rgba(109,84,255,0.15)]",
    badge: "bg-brand-500/15 text-brand-600 dark:text-brand-300",
    spin: true,
  },
  success: {
    label: "Complete",
    icon: CheckCircle2,
    ring: "ring-emerald-400/70 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    ring: "ring-red-400/70 shadow-[0_0_0_4px_rgba(239,68,68,0.12)]",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  needs_input: {
    label: "Needs Input",
    icon: HelpCircle,
    ring: "ring-amber-400/70 shadow-[0_0_0_4px_rgba(245,158,11,0.12)]",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
};

export default function StepNode({ step, status = "pending", isLast }) {
  const [expanded, setExpanded] = useState(false);
  const route = getRouteConfig(step.route);
  const RouteIcon = route.icon;
  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const hasParams = step.parameters && Object.keys(step.parameters).length > 0;

  return (
    <div className="relative flex gap-4">
      <div className="flex flex-col items-center shrink-0">
        <div
          className={`flex items-center justify-center w-10 h-10 rounded-full font-semibold text-sm glass ring-2 transition-shadow ${statusConfig.ring}`}
        >
          {step.step_number}
        </div>
        {!isLast && (
          <div className="w-px flex-1 mt-1 mb-1 bg-gradient-to-b from-slate-300/70 dark:from-white/15 to-transparent" />
        )}
      </div>

      <div className={`glass-panel flex-1 mb-4 p-4 transition-colors ${status === "executing" ? "animate-pulse" : ""}`}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${route.classes}`}
              >
                <RouteIcon size={11} />
                {route.label}
              </span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusConfig.badge}`}>
                <StatusIcon size={11} className={statusConfig.spin ? "animate-spin" : ""} />
                {statusConfig.label}
              </span>
            </div>
            <h4 className="font-medium text-sm truncate">{step.action}</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{step.app}</p>
          </div>

          {hasParams && (
            <button
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-brand-500 transition-colors shrink-0"
            >
              Details
              <ChevronDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
            </button>
          )}
        </div>

        {expanded && hasParams && (
          <div className="mt-3 pt-3 border-t border-slate-200/70 dark:border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Object.entries(step.parameters).map(([key, value]) => (
              <div key={key} className="text-xs">
                <span className="text-slate-400 dark:text-slate-500">{key}</span>
                <p className="font-mono text-slate-700 dark:text-slate-300 break-all">
                  {typeof value === "object" ? JSON.stringify(value) : String(value)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
