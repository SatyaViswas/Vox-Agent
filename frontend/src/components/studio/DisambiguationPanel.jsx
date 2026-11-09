import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Loader2, Mic, Sparkles, Volume2 } from "lucide-react";

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
  onSpeak,
  isListeningForDisambig,
  onStartVoiceClarification,
  onStopVoiceClarification,
  disambigResolving,
  activeParamListening,
}) {
  const { t } = useTranslation();
  const missingParameters = blueprint?.missing_parameters || [];
  const needsApproval = Boolean(blueprint?.needs_human_approval);
  const needsClarification = Boolean(blueprint?.needs_clarification) || missingParameters.length > 0;

  if (!needsClarification && !needsApproval) return null;

  const allFilled = missingParameters.every((p) => (values[paramKey(p)] || "").trim().length > 0);
  const canUpdate = allFilled && (!needsApproval || approved);

  return (
    <div
      className={`rounded-2xl p-4 md:p-5 transition-all ${
        resolved
          ? "border border-emerald-400/40 bg-emerald-500/10 shadow-[0_0_30px_rgba(16,185,129,0.08)]"
          : "border border-amber-400/40 bg-amber-400/10 shadow-[0_0_30px_rgba(245,158,11,0.08)]"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div
          className={`flex items-center gap-2 font-medium text-sm ${
            resolved ? "text-emerald-700 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
          }`}
        >
          {resolved ? (
            <>
              <CheckCircle2 size={16} className="shrink-0 text-emerald-500" />
              <span>{t("disambiguation.updatedReady") || "Workflow details configured & ready"}</span>
              <span className="text-xs font-normal text-emerald-700/80 dark:text-emerald-300/80 ml-2 hidden sm:inline">
                (Review or edit any value below)
              </span>
            </>
          ) : (
            <>
              <AlertTriangle size={16} className="shrink-0" />
              <span>{t("disambiguation.needsDetails")}</span>
            </>
          )}
        </div>
        {onStartVoiceClarification && (
          <button
            type="button"
            onClick={isListeningForDisambig ? onStopVoiceClarification : () => onStartVoiceClarification(null)}
            disabled={disambigResolving}
            className={`flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg font-semibold transition-all ${
              isListeningForDisambig
                ? "bg-red-500 text-white animate-pulse shadow-md"
                : disambigResolving
                ? "bg-amber-500 text-white"
                : resolved
                ? "text-emerald-900 dark:text-emerald-200 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30"
                : "text-amber-900 dark:text-amber-200 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30"
            }`}
            title="Answer hands-free with Gnani Prisma v3.0 voice"
          >
            {disambigResolving ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Mic size={13} className={isListeningForDisambig ? "animate-bounce" : ""} />
            )}
            <span>
              {isListeningForDisambig
                ? "Listening for Answer..."
                : disambigResolving
                ? "Resolving..."
                : resolved
                ? "🎙️ Re-speak Details"
                : "🎙️ Speak Answer"}
            </span>
          </button>
        )}
      </div>

      {isListeningForDisambig && (
        <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-xl bg-amber-500/20 border border-amber-500/40 text-xs text-amber-900 dark:text-amber-200 animate-fadeIn">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
          </span>
          <span className="font-medium">
            {activeParamListening
              ? `Listening for parameter: ${activeParamListening}...`
              : "Hands-Free Mode Active: Speak your answer clearly (e.g. \"Personal Account\" or \"Outreach Leads\")..."}
          </span>
        </div>
      )}

      {blueprint.clarification_question && (
        <div
          className={`flex items-center justify-between gap-2 mb-3 p-2.5 rounded-xl border text-xs ${
            resolved
              ? "bg-emerald-500/10 border-emerald-400/20 text-emerald-900 dark:text-emerald-200"
              : "bg-white/40 dark:bg-black/10 border-amber-400/20 text-amber-900 dark:text-amber-200"
          }`}
        >
          <p className="font-medium">
            {resolved ? (
              <span className="opacity-75 font-normal">Requirement: </span>
            ) : null}
            {blueprint.clarification_question}
          </p>
          {onSpeak && (
            <button
              type="button"
              onClick={() => onSpeak(blueprint.clarification_question)}
              className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-medium shrink-0 transition-colors ${
                resolved
                  ? "text-emerald-700 dark:text-emerald-300 hover:text-emerald-800 bg-emerald-500/10 hover:bg-emerald-500/20"
                  : "text-amber-700 dark:text-amber-300 hover:text-amber-800 bg-amber-500/10 hover:bg-amber-500/20"
              }`}
              title="Listen with Gnani Timbre"
            >
              <Volume2 size={12} />
              <span>Listen</span>
            </button>
          )}
        </div>
      )}

      {missingParameters.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
          {missingParameters.map((param) => {
            const key = paramKey(param);
            const isThisFieldListening = isListeningForDisambig && activeParamListening === key;

            const pKeyLower = (param.parameter_key || "").toLowerCase();
            const labelLower = (param.label || "").toLowerCase();
            const isEmail =
              pKeyLower.includes("email") ||
              pKeyLower.includes("recipient") ||
              labelLower.includes("email") ||
              labelLower.includes("recipient");

            const isFreeform =
              isEmail ||
              pKeyLower.includes("to") ||
              pKeyLower.includes("body") ||
              pKeyLower.includes("message") ||
              pKeyLower.includes("subject") ||
              pKeyLower.includes("phone") ||
              pKeyLower.includes("user") ||
              labelLower.includes("message") ||
              labelLower.includes("subject") ||
              labelLower.includes("phone");

            const isSelect =
              !isFreeform &&
              param.suggested_type === "select" &&
              param.options &&
              param.options.length > 0;

            return (
              <div key={key} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor={key} className="text-xs font-medium text-slate-700 dark:text-slate-200">
                    {param.label}{" "}
                    <span className="text-slate-400 dark:text-slate-500 font-normal">
                      {t("disambiguation.stepSuffix", { number: param.step_number })}
                    </span>
                  </label>
                  {onStartVoiceClarification && (
                    <button
                      type="button"
                      onClick={() => onStartVoiceClarification(key)}
                      disabled={disambigResolving}
                      title={`Speak value for ${param.label}`}
                      className={`p-1 rounded-md text-xs transition-colors ${
                        isThisFieldListening
                          ? "bg-red-500 text-white animate-pulse"
                          : "text-slate-400 hover:text-brand-500 hover:bg-black/5 dark:hover:bg-white/5"
                      }`}
                    >
                      <Mic size={12} />
                    </button>
                  )}
                </div>
                {isSelect ? (
                  <select
                    id={key}
                    value={values[key] || ""}
                    onChange={(e) => onChange(key, e.target.value)}
                    className={`rounded-lg border px-3 py-2 text-sm outline-none appearance-none transition-all ${
                      resolved
                        ? "border-emerald-400/50 bg-white/80 dark:bg-black/30 focus:ring-2 focus:ring-emerald-400/50 text-slate-800 dark:text-slate-100"
                        : "border-amber-400/40 bg-white/70 dark:bg-black/20 focus:ring-2 focus:ring-amber-400/50"
                    }`}
                  >
                    <option value="" disabled>{t("disambiguation.selectOption")}</option>
                    {param.options.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={key}
                    type={isEmail ? "email" : param.suggested_type === "number" ? "number" : "text"}
                    placeholder={
                      isEmail
                        ? "Enter recipient email (e.g. name@example.com)"
                        : param.description || `Enter ${param.label || "value"}`
                    }
                    value={values[key] || ""}
                    onChange={(e) => onChange(key, e.target.value)}
                    className={`rounded-lg border px-3 py-2 text-sm outline-none transition-all ${
                      isThisFieldListening
                        ? "border-amber-500 ring-2 ring-amber-400/50 bg-amber-50/50 dark:bg-amber-950/30"
                        : resolved
                        ? "border-emerald-400/50 bg-white/80 dark:bg-black/30 focus:ring-2 focus:ring-emerald-400/50 text-slate-800 dark:text-slate-100 font-medium"
                        : "border-amber-400/40 bg-white/70 dark:bg-black/20 focus:ring-2 focus:ring-amber-400/50"
                    }`}
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

      <div className="mt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-3 border-t border-black/5 dark:border-white/5">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {resolved
            ? "✓ All parameters applied to the blueprint. Edit any field above if needed."
            : "Please fill in the missing details or use the microphone to speak."}
        </span>
        <button
          onClick={onUpdate}
          disabled={!canUpdate}
          className={`flex items-center gap-1.5 rounded-lg text-white text-sm font-medium px-4 py-2 transition-colors shrink-0 ${
            resolved
              ? "bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40"
              : "bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
          }`}
        >
          {resolved ? <CheckCircle2 size={14} /> : <Sparkles size={14} />}
          <span>{resolved ? "Save Updates" : t("disambiguation.updateBlueprint")}</span>
        </button>
      </div>
    </div>
  );
}
