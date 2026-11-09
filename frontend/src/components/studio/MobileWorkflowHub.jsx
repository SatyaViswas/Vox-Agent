import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Circle,
  HelpCircle,
  Layers,
  Loader2,
  Mic,
  MinusCircle,
  PlayCircle,
  PlusCircle,
  Radio,
  RotateCcw,
  Shield,
  ShieldCheck,
  Sparkles,
  Volume2,
  VolumeX,
  Wand2,
  Workflow,
  XCircle,
} from "lucide-react";
import { getRouteConfig } from "../../lib/routeConfig";
import MobileTelemetrySheet from "./MobileTelemetrySheet";

const STATUS_CONFIG = {
  pending: {
    label: "Pending",
    icon: Circle,
    badge: "bg-slate-500/10 text-slate-500 dark:text-slate-400 border border-slate-300/40 dark:border-white/10",
  },
  executing: {
    label: "Executing",
    icon: Loader2,
    badge: "bg-brand-500/15 text-brand-600 dark:text-brand-300 border border-brand-500/30",
    spin: true,
  },
  mutating: {
    label: "Self-Healing",
    icon: Wand2,
    badge: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300 border border-fuchsia-500/30",
    spin: true,
  },
  success: {
    label: "Complete",
    icon: CheckCircle2,
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    badge: "bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30",
  },
  needs_input: {
    label: "Needs Input",
    icon: HelpCircle,
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30",
  },
  skipped: {
    label: "Skipped",
    icon: MinusCircle,
    badge: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border border-slate-400/30",
  },
};

function MobileStepCard({ step, status = "pending", skipReason, isLast }) {
  const [expanded, setExpanded] = useState(false);
  const route = getRouteConfig(step.route);
  const RouteIcon = route.icon;
  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;

  const params = step.parameters || {};
  const paramEntries = Object.entries(params);

  return (
    <div className="relative flex gap-3">
      {/* Step number avatar and vertical connecting track */}
      <div className="flex flex-col items-center shrink-0">
        <div
          className={`flex items-center justify-center w-8 h-8 rounded-full font-bold text-xs transition-all shadow-sm ${
            status === "success"
              ? "bg-emerald-500 text-white"
              : status === "skipped"
              ? "bg-slate-400/20 text-slate-600 dark:text-slate-300 border border-slate-400/40"
              : status === "executing"
              ? "bg-brand-500 text-white animate-pulse ring-4 ring-brand-400/30"
              : status === "mutating"
              ? "bg-fuchsia-500 text-white ring-4 ring-fuchsia-400/30"
              : status === "failed"
              ? "bg-red-500 text-white"
              : status === "needs_input"
              ? "bg-amber-500 text-white ring-4 ring-amber-400/30"
              : "bg-slate-200 dark:bg-white/10 text-slate-700 dark:text-slate-300"
          }`}
        >
          {status === "success" ? <CheckCircle2 size={15} /> : status === "skipped" ? <MinusCircle size={15} /> : step.step_number}
        </div>
        {!isLast && (
          <div className="w-0.5 flex-1 my-1.5 bg-gradient-to-b from-slate-300/80 dark:from-white/20 to-transparent" />
        )}
      </div>

      {/* Main Step Card */}
      <div
        className={`flex-1 mb-3.5 p-3.5 rounded-2xl border transition-all shadow-sm ${
          status === "executing"
            ? "bg-brand-50/40 dark:bg-brand-950/20 border-brand-500/40 shadow-[0_4px_20px_rgba(109,84,255,0.1)]"
            : status === "mutating"
            ? "bg-fuchsia-50/40 dark:bg-fuchsia-950/20 border-fuchsia-500/40"
            : status === "needs_input"
            ? "bg-amber-50/40 dark:bg-amber-950/20 border-amber-500/40"
            : "glass-panel border-slate-200/80 dark:border-white/10"
        }`}
      >
        {/* Card Header: Route & Status Badges */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${route.classes}`}
          >
            <RouteIcon size={11} />
            {route.label}
          </span>

          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${statusConfig.badge}`}
          >
            <StatusIcon size={11} className={statusConfig.spin ? "animate-spin" : ""} />
            {statusConfig.label}
          </span>
        </div>

        {(step.condition || step.skip_if_empty) && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {step.condition && (
              <span className="inline-flex items-center text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-purple-500/10 text-purple-600 dark:text-purple-300 border border-purple-500/20">
                ⚡ If: {step.condition}
              </span>
            )}
            {step.skip_if_empty && (
              <span className="inline-flex items-center text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-blue-500/10 text-blue-600 dark:text-blue-300 border border-blue-500/20">
                Skip if empty
              </span>
            )}
          </div>
        )}

        {/* Action Title and App */}
        <h4 className="font-semibold text-xs text-slate-900 dark:text-white leading-snug">
          {step.action}
        </h4>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 capitalize mt-0.5 font-medium">
          {step.app ? step.app.replace("_", " ") : "System"}
        </p>

        {status === "skipped" && (
          <div className="mt-2 mb-1 flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-500/10 border border-slate-500/20 text-slate-600 dark:text-slate-300">
            <MinusCircle size={12} className="text-slate-400 shrink-0" />
            <span className="font-medium truncate">
              {skipReason ? `Skipped: ${skipReason}` : "Skipped (condition not met)"}
            </span>
          </div>
        )}

        {/* Parameter summary pill tags */}
        {paramEntries.length > 0 && (
          <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-white/5">
            <div className="flex flex-wrap gap-1.5 items-center">
              {paramEntries.slice(0, 2).map(([k, v]) => (
                <span
                  key={k}
                  className="inline-flex items-center text-[10px] bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-md font-mono text-slate-600 dark:text-slate-300 max-w-[180px] truncate"
                >
                  <span className="text-slate-400 mr-1">{k}:</span>
                  <span className="truncate">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                </span>
              ))}
              {paramEntries.length > 2 && !expanded && (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="text-[10px] text-brand-500 font-medium hover:underline"
                >
                  +{paramEntries.length - 2} more
                </button>
              )}
            </div>

            {/* Expanded full parameters view */}
            {expanded && (
              <div className="mt-2 text-[10px] font-mono bg-slate-100 dark:bg-black/40 text-slate-800 dark:text-slate-200 p-2.5 rounded-xl overflow-x-auto space-y-1 border border-slate-200/80 dark:border-white/5">
                {paramEntries.map(([k, v]) => (
                  <div key={k} className="flex gap-1.5">
                    <span className="text-brand-600 dark:text-brand-300 shrink-0">{k}:</span>
                    <span className="text-slate-700 dark:text-slate-300 break-all">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="text-[10px] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white mt-1 underline block"
                >
                  Collapse details
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MobileWorkflowHub({
  blueprint,
  stepStatuses = {},
  stepSkipReasons = {},
  runStatus = "idle",
  runError,
  agentId,
  logs = [],
  clearStudio,
  handleSaveAndRun,
  runButtonLabel,
  isRunning,
  blockedByDisambiguation,
  blockedByRequiredApps,
  requireApproval,
  setRequireApproval,
  ttsEnabled,
  setTtsEnabled,
  ttsVoice,
  disambiguationSlot,
  requiredAppsSlot,
  pendingActionSlot,
  prompt,
  setPrompt,
  isRecording,
  speechProcessing,
  interimTranscript,
  toggleRecording,
  speechSupported,
  handleGenerate,
  planning,
  onOpenUpdateModal,
}) {
  const { t } = useTranslation();
  const [telemetrySheetOpen, setTelemetrySheetOpen] = useState(false);

  const steps = blueprint?.steps || [];
  const triggerType =
    blueprint?.trigger?.type === "schedule"
      ? t("mobileWorkflow.scheduled")
      : t("mobileWorkflow.onDemand");

  return (
    <div className="flex flex-col w-full pb-40 animate-fade-in">
      {/* 1. Mobile Workflow Header Card */}
      <div className="glass-panel rounded-2xl p-4 mb-3 border border-slate-200/80 dark:border-white/10 shadow-sm">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300 text-[10px] font-semibold border border-brand-500/20">
                <Sparkles size={11} /> {t("mobileWorkflow.stepsCount", { count: steps.length })}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-200/60 dark:bg-white/10 text-slate-600 dark:text-slate-300 text-[10px] font-medium">
                <Workflow size={11} /> {triggerType}
              </span>
              {agentId && (
                <span className="text-[10px] font-mono text-slate-400">
                  #{agentId.slice(0, 6)}
                </span>
              )}
              {runStatus === "success" && (
                Object.values(stepStatuses || {}).includes("skipped") ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-700 dark:text-slate-300 text-[10px] font-semibold border border-slate-400/30">
                    <MinusCircle size={10} className="text-slate-400" /> Finished (steps skipped)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-semibold border border-emerald-500/30">
                    <CheckCircle2 size={10} /> Completed
                  </span>
                )
              )}
            </div>

            <h2 className="text-base font-bold text-slate-900 dark:text-white leading-snug truncate">
              {blueprint.title}
            </h2>
            {blueprint.description && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                {blueprint.description}
              </p>
            )}
          </div>

          {/* Quick Header Actions: Update, Voice Toggle & Reset */}
          <div className="flex items-center gap-1.5 shrink-0">
            {onOpenUpdateModal && (
              <button
                type="button"
                onClick={onOpenUpdateModal}
                disabled={isRunning || planning}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-300 border border-brand-500/20 text-xs font-semibold active:scale-95 transition-all"
                title="Update workflow with new steps"
              >
                <Sparkles size={13} className="text-brand-500" />
                <span>Update</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setTtsEnabled(!ttsEnabled)}
              className={`p-2 rounded-xl transition-colors ${
                ttsEnabled
                  ? "bg-brand-500/10 text-brand-500 border border-brand-500/30"
                  : "bg-black/5 dark:bg-white/5 text-slate-400"
              }`}
              title={ttsEnabled ? "Voice Feedback Active" : "Voice Feedback Muted"}
            >
              {ttsEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>

            <button
              type="button"
              onClick={clearStudio}
              className="p-2 rounded-xl text-slate-400 hover:text-red-500 bg-black/5 dark:bg-white/5 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
              title="Reset and create new agent"
            >
              <RotateCcw size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* 2. Priority Attention Slots (Rendered seamlessly on mobile) */}
      {pendingActionSlot && <div className="mb-3">{pendingActionSlot}</div>}
      {disambiguationSlot && <div className="mb-3">{disambiguationSlot}</div>}
      {requiredAppsSlot && <div className="mb-3">{requiredAppsSlot}</div>}

      {/* 3. Workflow Steps Timeline */}
      <div className="glass-panel rounded-2xl p-4 mb-4 border border-slate-200/80 dark:border-white/10 shadow-sm">
        <div className="flex items-center justify-between mb-3.5 pb-2 border-b border-slate-100 dark:border-white/5">
          <div className="flex items-center gap-2">
            <Layers size={15} className="text-brand-500" />
            <h3 className="font-semibold text-xs text-slate-800 dark:text-slate-200">
              {t("mobileWorkflow.executionPlan")}
            </h3>
          </div>
          <span className="text-[11px] text-slate-400 font-medium">
            {t("mobileWorkflow.sequentialFlow")}
          </span>
        </div>

        <div className="pt-1">
          {steps.map((step, idx) => (
            <MobileStepCard
              key={step.step_number || idx}
              step={step}
              status={stepStatuses?.[step.step_number] || "pending"}
              skipReason={stepSkipReasons?.[step.step_number]}
              isLast={idx === steps.length - 1}
            />
          ))}
        </div>

        {/* Add Steps or Update Workflow Button */}
        {onOpenUpdateModal && (
          <button
            type="button"
            onClick={onOpenUpdateModal}
            disabled={isRunning || planning}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-dashed border-brand-500/40 bg-brand-500/5 hover:bg-brand-500/10 text-brand-600 dark:text-brand-400 text-xs font-semibold transition-all active:scale-[0.99] mt-3 shadow-xs cursor-pointer"
          >
            <PlusCircle size={15} />
            <span>+ Add Steps / Update Workflow</span>
          </button>
        )}
      </div>

      {/* 4. Streamlined Floating Action Dock (Floats above mobile bottom nav with zero overlap) */}
      <div className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+3.75rem)] inset-x-3 z-30 flex flex-col gap-2 p-2.5 rounded-2xl bg-white/95 dark:bg-[#12121f]/95 backdrop-blur-xl border border-slate-200/80 dark:border-white/15 shadow-[0_10px_35px_rgba(0,0,0,0.2)] animate-slide-up">
        {/* Top Mini Control Strip */}
        <div className="flex items-center justify-between px-1 text-xs">
          {/* Require Approval Toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer text-slate-600 dark:text-slate-300 text-[11px]">
            <input
              type="checkbox"
              checked={requireApproval}
              onChange={(e) => setRequireApproval(e.target.checked)}
              className="w-3.5 h-3.5 rounded text-brand-500 bg-slate-100 border-slate-300 dark:border-slate-600 dark:bg-slate-700 focus:ring-brand-500 cursor-pointer"
            />
            <span className="flex items-center gap-1 font-medium">
              <ShieldCheck size={12} className="text-brand-500" /> {t("mobileWorkflow.requireApproval")}
            </span>
          </label>

          {/* Telemetry Logs Sheet Trigger */}
          <button
            type="button"
            onClick={() => setTelemetrySheetOpen(true)}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:text-brand-500 transition-colors"
          >
            <Radio
              size={12}
              className={runStatus === "running" ? "text-brand-500 animate-pulse" : "text-slate-400"}
            />
            <span>{t("mobileWorkflow.logs", { count: logs.length })}</span>
          </button>
        </div>

        {/* Action Buttons Row */}
        <div className="flex items-center gap-2">
          {onOpenUpdateModal && (
            <button
              type="button"
              onClick={onOpenUpdateModal}
              disabled={isRunning || planning}
              className="flex items-center justify-center gap-1.5 px-3.5 py-3 rounded-xl bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-200 text-xs font-semibold border border-slate-200 dark:border-white/10 transition-all active:scale-95 shrink-0"
              title="Open popup to update workflow with text or voice"
            >
              <Sparkles size={14} className="text-brand-500" />
              <span>Update</span>
            </button>
          )}

          {/* Primary CTA Run Button */}
          <button
            type="button"
            onClick={handleSaveAndRun}
            disabled={blockedByDisambiguation || blockedByRequiredApps || isRunning}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-xs text-white shadow-lg transition-all active:scale-[0.98] ${
              isRunning
                ? "bg-brand-600 shadow-brand-500/25 animate-pulse cursor-wait"
                : blockedByDisambiguation
                ? "bg-amber-600 opacity-90 shadow-amber-500/20"
                : blockedByRequiredApps
                ? "bg-rose-600 opacity-90 shadow-rose-500/20"
                : "bg-gradient-to-r from-brand-500 via-brand-600 to-fuchsia-600 shadow-brand-500/30 hover:shadow-brand-500/50"
            }`}
          >
            {isRunning ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <PlayCircle size={16} />
            )}
            <span>{runButtonLabel}</span>
          </button>
        </div>

        {runError && (
          <p className="text-[10px] text-red-500 text-center font-medium truncate px-1">
            {runError}
          </p>
        )}
      </div>

      {/* 5. Mobile Telemetry Sheet Modal */}
      <MobileTelemetrySheet
        open={telemetrySheetOpen}
        onClose={() => setTelemetrySheetOpen(false)}
        runStatus={runStatus}
        logs={logs}
      />
    </div>
  );
}

