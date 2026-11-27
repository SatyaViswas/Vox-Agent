import { useState, useEffect } from "react";
import {
  ShieldCheck,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  Sparkles,
  Loader2,
  RefreshCw,
  X,
  ChevronDown,
  ChevronUp,
  Cpu,
  Zap,
  Target,
  Globe2,
  Layers,
} from "lucide-react";
import { runStressTest, getLatestStressTest } from "../../api/knowledge";

export default function KnowledgeStressTestModal({ isOpen, onClose }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [error, setError] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [scenarioCount, setScenarioCount] = useState(8);

  const PROGRESS_MESSAGES = [
    "Analyzing Business Knowledge & Policy Rules...",
    "Synthesizing Adversarial Customer Scenarios via Adaption Labs...",
    "Executing Agent Customer Support Responses...",
    "Evaluating Hallucination Risk & Scoring Policy Adherence...",
  ];

  useEffect(() => {
    if (isOpen && !report && !loading) {
      getLatestStressTest()
        .then((cached) => {
          if (cached) setReport(cached);
        })
        .catch(() => {});
    }
  }, [isOpen, report, loading]);

  const handleStartSimulation = async (count = scenarioCount) => {
    setLoading(true);
    setError(null);
    setProgressStep(0);

    // Realistic step progression animation
    const stepInterval = setInterval(() => {
      setProgressStep((prev) => (prev < 3 ? prev + 1 : prev));
    }, 2800);

    try {
      const data = await runStressTest({ count });
      setReport(data);
      if (data?.scenarios?.length > 0) {
        setExpandedId(data.scenarios[0].id);
      }
    } catch (err) {
      setError(err.message || "Failed to complete stress test simulation");
    } finally {
      clearInterval(stepInterval);
      setLoading(false);
      setProgressStep(0);
    }
  };

  if (!isOpen) return null;

  const categories = report?.category_breakdown ? Object.keys(report.category_breakdown) : [];
  const filteredScenarios = (report?.scenarios || []).filter((s) => {
    if (selectedCategory === "all") return true;
    return s.category === selectedCategory;
  });

  const getVerdictBadge = (verdict) => {
    if (verdict === "passed") {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
          <CheckCircle2 size={12} /> Passed
        </span>
      );
    }
    if (verdict === "warning") {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
          <AlertTriangle size={12} /> Warning
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30">
        <XCircle size={12} /> Hallucination / Breach
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/60 backdrop-blur-sm animate-fadeIn">
      <div className="glass-panel w-full max-w-4xl max-h-[92vh] rounded-3xl border border-slate-200 dark:border-white/10 bg-white/95 dark:bg-slate-900/95 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200/80 dark:border-white/10 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-brand-600 text-white shadow-md shadow-brand-500/25">
              <ShieldCheck size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                  Autonomous Flight Simulator & Stress-Test
                </h2>
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-brand-500/10 text-brand-600 dark:text-brand-400 border border-brand-500/25">
                  <Sparkles size={11} /> Powered by Adaption Labs
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Synthesizes adversarial customers to audit grounding and eliminate hallucinations before going live.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body Container */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
          {error && (
            <div className="p-3.5 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs sm:text-sm flex items-center gap-2.5">
              <XCircle size={16} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Loading Animation State */}
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-5 text-center">
              <div className="relative">
                <div className="w-16 h-16 rounded-3xl bg-brand-500/10 text-brand-500 flex items-center justify-center animate-pulse">
                  <Cpu size={32} />
                </div>
                <Loader2
                  size={52}
                  className="animate-spin text-brand-500 absolute -top-2 -left-2"
                />
              </div>

              <div>
                <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                  Running Autonomous Flight Simulation
                </h3>
                <p className="text-xs sm:text-sm text-brand-600 dark:text-brand-400 mt-1 font-medium animate-pulse">
                  {PROGRESS_MESSAGES[progressStep]}
                </p>
              </div>

              <div className="w-full max-w-sm bg-slate-200 dark:bg-white/10 h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-brand-500 to-indigo-600 h-full rounded-full transition-all duration-700"
                  style={{ width: `${(progressStep + 1) * 25}%` }}
                />
              </div>

              <p className="text-[11px] text-slate-400 max-w-xs">
                Generating adversarial discount demands, allergen edge-cases, and Hinglish queries via Adaption's high-speed engine...
              </p>
            </div>
          ) : !report ? (
            /* Empty State: Ready to launch first stress test */
            <div className="py-10 flex flex-col items-center justify-center text-center gap-4">
              <div className="w-16 h-16 rounded-3xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center">
                <Target size={32} />
              </div>
              <div className="max-w-md">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  Zero Hallucination Guarantee
                </h3>
                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                  Before your agent talks to real customers on Telegram, Instagram, or Email, Adaption Labs simulates 8 tricky adversarial inquiries (bargaining, out-of-scope requests, Hinglish) to verify policy adherence.
                </p>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={() => handleStartSimulation(8)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-gradient-to-r from-brand-500 to-indigo-600 text-white font-semibold text-xs sm:text-sm shadow-md shadow-brand-500/25 hover:opacity-95 active:scale-95 transition-all"
                >
                  <Sparkles size={16} />
                  <span>Launch 8-Scenario Stress Test</span>
                </button>
              </div>
            </div>
          ) : (
            /* Results View */
            <div className="space-y-5">
              {/* Top Hero Score Card */}
              <div className="glass-panel p-4 sm:p-5 rounded-3xl border border-slate-200/80 dark:border-white/10 bg-gradient-to-br from-slate-50 to-indigo-50/30 dark:from-slate-900 dark:to-brand-950/20 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  {/* Circular Score Badge */}
                  <div
                    className={`flex flex-col items-center justify-center w-20 h-20 rounded-2xl shrink-0 border-2 font-black shadow-md ${
                      report.reliability_score >= 90
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
                        : report.reliability_score >= 75
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/40"
                        : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/40"
                    }`}
                  >
                    <span className="text-2xl leading-none">{report.reliability_score}%</span>
                    <span className="text-[10px] font-semibold tracking-wider uppercase mt-0.5">Reliable</span>
                  </div>

                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold ${
                          report.readiness_status === "DEPLOYMENT_READY"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                            : report.readiness_status === "ACCEPTABLE"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                            : "bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30"
                        }`}
                      >
                        <ShieldCheck size={13} />
                        {report.readiness_status.replace("_", " ")}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        Model: {report.adaption_model}
                      </span>
                    </div>
                    <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1 max-w-xl font-medium">
                      {report.summary}
                    </p>
                  </div>
                </div>

                {/* Re-Run Controls */}
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={scenarioCount}
                    onChange={(e) => setScenarioCount(Number(e.target.value))}
                    className="px-2.5 py-2 rounded-xl text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 outline-none text-slate-700 dark:text-slate-200 font-semibold"
                  >
                    <option value={6}>6 Scenarios</option>
                    <option value={8}>8 Scenarios</option>
                    <option value={12}>12 Scenarios</option>
                  </select>
                  <button
                    onClick={() => handleStartSimulation(scenarioCount)}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-500 hover:bg-brand-600 text-white font-semibold text-xs shadow-sm shadow-brand-500/25 active:scale-95 transition-all"
                  >
                    <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
                    <span>Re-Run</span>
                  </button>
                </div>
              </div>

              {/* Quick Stat Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="p-3 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/70 dark:border-white/5 flex flex-col">
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">Total Tested</span>
                  <span className="text-lg font-bold text-slate-900 dark:text-white mt-0.5">
                    {report.total_scenarios}
                  </span>
                </div>
                <div className="p-3 rounded-2xl bg-emerald-500/5 border border-emerald-500/20 flex flex-col">
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Passed (Safe)</span>
                  <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                    {report.passed_count}
                  </span>
                </div>
                <div className="p-3 rounded-2xl bg-amber-500/5 border border-amber-500/20 flex flex-col">
                  <span className="text-[11px] text-amber-600 dark:text-amber-400">Warnings</span>
                  <span className="text-lg font-bold text-amber-600 dark:text-amber-400 mt-0.5">
                    {report.warning_count}
                  </span>
                </div>
                <div className="p-3 rounded-2xl bg-red-500/5 border border-red-500/20 flex flex-col">
                  <span className="text-[11px] text-red-600 dark:text-red-400">Hallucinations</span>
                  <span className="text-lg font-bold text-red-600 dark:text-red-400 mt-0.5">
                    {report.failed_count}
                  </span>
                </div>
              </div>

              {/* Category Filter Chips */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
                <button
                  onClick={() => setSelectedCategory("all")}
                  className={`px-3 py-1.5 rounded-xl font-medium shrink-0 transition-all ${
                    selectedCategory === "all"
                      ? "bg-brand-500 text-white shadow-xs"
                      : "bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10"
                  }`}
                >
                  All ({report.total_scenarios})
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1.5 rounded-xl font-medium shrink-0 transition-all ${
                      selectedCategory === cat
                        ? "bg-brand-500 text-white shadow-xs"
                        : "bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10"
                    }`}
                  >
                    {cat} ({report.category_breakdown[cat]?.total})
                  </button>
                ))}
              </div>

              {/* Scenarios Accordion List */}
              <div className="space-y-2.5">
                {filteredScenarios.map((sc) => {
                  const isExpanded = expandedId === sc.id;
                  return (
                    <div
                      key={sc.id}
                      className={`rounded-2xl border transition-all duration-200 overflow-hidden ${
                        sc.verdict === "failed"
                          ? "border-red-500/30 bg-red-500/5"
                          : sc.verdict === "warning"
                          ? "border-amber-500/30 bg-amber-500/5"
                          : "border-slate-200 dark:border-white/10 bg-white/70 dark:bg-slate-900/60"
                      }`}
                    >
                      {/* Accordion Row Header */}
                      <div
                        onClick={() => setExpandedId(isExpanded ? null : sc.id)}
                        className="p-3.5 sm:p-4 flex items-center justify-between gap-3 cursor-pointer select-none hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex items-center justify-center w-7 h-7 rounded-xl bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 text-xs font-bold shrink-0">
                            #{sc.id}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] font-semibold text-brand-600 dark:text-brand-400 uppercase tracking-wider">
                                {sc.category}
                              </span>
                              <span className="text-slate-300 dark:text-slate-700">•</span>
                              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                {sc.scenario_title}
                              </span>
                            </div>
                            <p className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-white truncate mt-0.5">
                              "{sc.customer_query}"
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2.5 shrink-0">
                          {getVerdictBadge(sc.verdict)}
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </div>
                      </div>

                      {/* Expanded Details Content */}
                      {isExpanded && (
                        <div className="px-4 pb-4 pt-1 border-t border-slate-200/60 dark:border-white/5 space-y-3 text-xs sm:text-sm">
                          {/* Full Customer Question */}
                          <div className="p-3 rounded-xl bg-slate-100/70 dark:bg-white/5 border border-slate-200/50 dark:border-white/5">
                            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block mb-1">
                              Simulated Customer Question
                            </span>
                            <p className="text-slate-800 dark:text-slate-200 font-medium">
                              "{sc.customer_query}"
                            </p>
                          </div>

                          {/* Agent's Grounded Reply */}
                          <div className="p-3 rounded-xl bg-brand-500/5 border border-brand-500/20">
                            <span className="text-[11px] font-bold text-brand-600 dark:text-brand-400 uppercase tracking-wider block mb-1">
                              Agent's Verified Response
                            </span>
                            <p className="text-slate-900 dark:text-slate-100 leading-relaxed">
                              {sc.agent_answer}
                            </p>
                          </div>

                          {/* Audit & Policy Explanation */}
                          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200/60 dark:border-white/5 text-xs">
                            <div>
                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                                Audit Verdict & Policy Compliance
                              </span>
                              <p className="text-slate-700 dark:text-slate-300 font-medium mt-0.5">
                                {sc.explanation}
                              </p>
                            </div>
                            <div className="shrink-0 flex items-center gap-1.5 text-[11px] text-slate-400">
                              <span>Source:</span>
                              <span className="font-semibold text-slate-600 dark:text-slate-300">
                                {sc.sources?.[0] || "Policies & Knowledge"}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200/80 dark:border-white/10 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/40 text-xs">
          <span className="text-slate-400 flex items-center gap-1">
            <Zap size={13} className="text-amber-500" />
            Tested against active RAG pillars
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-slate-200 dark:bg-white/10 hover:bg-slate-300 dark:hover:bg-white/20 text-slate-700 dark:text-slate-200 font-semibold transition-colors"
          >
            Close Simulator
          </button>
        </div>
      </div>
    </div>
  );
}
