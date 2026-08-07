import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2, Save } from "lucide-react";
import SlideOver from "../SlideOver";
import StepEditor from "./StepEditor";
import { buildSchedule, DAYS_OF_WEEK, parseSchedule } from "../../lib/cron";
import { getKnowledgeSources } from "../../api/knowledge.js";

function cloneBlueprint(blueprint) {
  return typeof structuredClone === "function" ? structuredClone(blueprint) : JSON.parse(JSON.stringify(blueprint));
}

const SCHEDULE_PRESET_DEFS = [
  { value: "manual", labelKey: "editAgent.presetManual" },
  { value: "hourly", labelKey: "editAgent.presetHourly" },
  { value: "daily", labelKey: "editAgent.presetDaily" },
  { value: "weekly", labelKey: "editAgent.presetWeekly" },
  { value: "custom", labelKey: "editAgent.presetCustom" },
];

export default function EditAgentDrawer({ agent, onClose, onSave }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [blueprint, setBlueprint] = useState(null);
  const [requireApproval, setRequireApproval] = useState(true);
  const [schedule, setSchedule] = useState({ preset: "manual", time: "09:00", day: 1, raw: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [knowledgeSources, setKnowledgeSources] = useState([]);
  const [knowledgeSourcesLoading, setKnowledgeSourcesLoading] = useState(false);

  useEffect(() => {
    if (!agent) return;
    setTitle(agent.title || "");
    setPrompt(agent.original_prompt || "");
    const bp = cloneBlueprint(agent.json_blueprint || { steps: [] });
    setRequireApproval(bp.require_approval !== false); // default true if not set
    setBlueprint(bp);
    const parsed = parseSchedule(agent.trigger_type, agent.cron_schedule);
    setSchedule(parsed);
    setError(null);
  }, [agent]);

  useEffect(() => {
    if (!agent) return;
    setKnowledgeSourcesLoading(true);
    getKnowledgeSources()
      .then((sources) => setKnowledgeSources(sources || []))
      .catch(() => setKnowledgeSources([]))
      .finally(() => setKnowledgeSourcesLoading(false));
  }, [agent]);

  const hasAiGenerateStep = (blueprint?.steps || []).some((s) => s.route === "ai_generate");

  const toggleKnowledgeSource = (sourceName) => {
    setBlueprint((prev) => {
      const current = prev.knowledge_sources || [];
      const next = current.includes(sourceName)
        ? current.filter((s) => s !== sourceName)
        : [...current, sourceName];
      return { ...prev, knowledge_sources: next };
    });
  };

  const updateStepField = (stepNumber, field, value) => {
    setBlueprint((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => (s.step_number === stepNumber ? { ...s, [field]: value } : s)),
    }));
  };

  const updateStepParam = (stepNumber, key, value) => {
    setBlueprint((prev) => ({
      ...prev,
      steps: prev.steps.map((s) =>
        s.step_number === stepNumber ? { ...s, parameters: { ...s.parameters, [key]: value } } : s
      ),
    }));
  };

  const removeStepParam = (stepNumber, key) => {
    setBlueprint((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => {
        if (s.step_number !== stepNumber) return s;
        const nextParams = { ...s.parameters };
        delete nextParams[key];
        return { ...s, parameters: nextParams };
      }),
    }));
  };

  const addStepParam = (stepNumber, key, value) => {
    updateStepParam(stepNumber, key, value);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const { triggerType, cronSchedule } = buildSchedule(schedule.preset, schedule);
      await onSave({
        title,
        original_prompt: prompt,
        json_blueprint: { ...blueprint, require_approval: requireApproval },
        trigger_type: triggerType,
        cron_schedule: cronSchedule,
      });
    } catch (err) {
      setError(err.message || t("editAgent.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SlideOver open={!!agent} onClose={onClose} title={t("editAgent.title")}>
      {agent && blueprint && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("editAgent.agentTitle")}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("editAgent.prompt")}</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50 resize-none"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer hover:text-brand-600 transition-colors">
            <input
              type="checkbox"
              checked={requireApproval}
              onChange={(e) => setRequireApproval(e.target.checked)}
              className="w-4 h-4 rounded text-brand-500 bg-slate-100 border-slate-300 dark:border-slate-600 dark:bg-slate-700 focus:ring-brand-500 focus:ring-2 cursor-pointer"
            />
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{t("editAgent.requireApproval")}</span>
          </label>

          {hasAiGenerateStep && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("editAgent.knowledgeSources")}</label>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("editAgent.knowledgeSourcesDesc")}
              </p>
              {knowledgeSourcesLoading ? (
                <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
                  <Loader2 size={13} className="animate-spin" /> {t("editAgent.loadingSources")}
                </div>
              ) : knowledgeSources.length === 0 ? (
                <div className="text-xs text-slate-500 dark:text-slate-400">{t("editAgent.noSources")}</div>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto rounded-lg border border-slate-300/70 dark:border-white/15 p-2">
                  {knowledgeSources.map((source) => (
                    <label
                      key={source.source_name}
                      className="flex items-center gap-2 cursor-pointer hover:text-brand-600 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={(blueprint.knowledge_sources || []).includes(source.source_name)}
                        onChange={() => toggleKnowledgeSource(source.source_name)}
                        className="w-4 h-4 rounded text-brand-500 bg-slate-100 border-slate-300 dark:border-slate-600 dark:bg-slate-700 focus:ring-brand-500 focus:ring-2 cursor-pointer"
                      />
                      <span className="text-sm text-slate-700 dark:text-slate-200">{source.source_name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("editAgent.schedule")}</label>
            <div className="grid grid-cols-2 gap-2">
              {SCHEDULE_PRESET_DEFS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setSchedule((s) => ({ ...s, preset: p.value }))}
                  className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                    schedule.preset === p.value
                      ? "bg-brand-500 text-white"
                      : "border border-slate-300/70 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
                  }`}
                >
                  {t(p.labelKey)}
                </button>
              ))}
            </div>

            {(schedule.preset === "daily" || schedule.preset === "weekly") && (
              <input
                type="time"
                value={schedule.time}
                onChange={(e) => setSchedule((s) => ({ ...s, time: e.target.value }))}
                className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
              />
            )}

            {schedule.preset === "weekly" && (
              <select
                value={schedule.day}
                onChange={(e) => setSchedule((s) => ({ ...s, day: Number(e.target.value) }))}
                className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
              >
                {DAYS_OF_WEEK.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}

            {schedule.preset === "custom" && (
              <input
                value={schedule.raw}
                onChange={(e) => setSchedule((s) => ({ ...s, raw: e.target.value }))}
                placeholder={t("editAgent.cronPlaceholder")}
                className="rounded-lg border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-brand-400/50"
              />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{t("editAgent.workflowSteps")}</label>
            {blueprint.steps.map((step) => (
              <StepEditor
                key={step.step_number}
                step={step}
                onFieldChange={updateStepField}
                onParamChange={updateStepParam}
                onParamRemove={removeStepParam}
                onParamAdd={addStepParam}
              />
            ))}
          </div>

          {error && (
            <div className="rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={14} className="shrink-0" />
              {error}
            </div>
          )}

          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white text-sm font-medium py-2.5 transition-colors"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {saving ? t("editAgent.saving") : t("editAgent.saveChanges")}
          </button>
        </div>
      )}
    </SlideOver>
  );
}
