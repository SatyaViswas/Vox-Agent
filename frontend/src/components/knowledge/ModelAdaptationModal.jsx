import { useState, useEffect, useRef } from "react";
import {
  Sparkles,
  Cpu,
  Zap,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Play,
  RotateCw,
  X,
  ChevronDown,
  Layers,
  Sliders,
  ExternalLink,
  Shield,
  Activity,
  XCircle,
} from "lucide-react";
import {
  getAdaptationStats,
  getTrainableModels,
  recommendHyperparameters,
  launchTraining,
  getTrainingRuns,
  getTrainingRunStatus,
  cancelTrainingRun,
} from "../../api/adaptation";

export default function ModelAdaptationModal({ isOpen, onClose }) {
  const [stats, setStats] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("Qwen/Qwen3.5-2B");
  const [maxIterations, setMaxIterations] = useState(1);
  const [targetWinRate, setTargetWinRate] = useState(0.7);
  const [autoAugment, setAutoAugment] = useState(true);

  const [recommendedHp, setRecommendedHp] = useState(null);
  const [loadingHp, setLoadingHp] = useState(false);

  const [runs, setRuns] = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const pollIntervalRef = useRef(null);

  // Initial load when modal opens
  useEffect(() => {
    if (!isOpen) return;

    setError(null);
    setSuccessMessage(null);

    // 1. Fetch stats
    getAdaptationStats()
      .then((data) => setStats(data))
      .catch((err) => console.warn("Failed to load adaptation stats:", err));

    // 2. Fetch models
    getTrainableModels()
      .then((data) => {
        if (data?.length > 0) {
          setModels(data);
          const hasQwen = data.some((m) => m.id === "Qwen/Qwen3.5-2B");
          if (hasQwen) setSelectedModel("Qwen/Qwen3.5-2B");
          else setSelectedModel(data[0].id);
        }
      })
      .catch((err) => console.warn("Failed to load models:", err));

    // 3. Fetch runs
    fetchRuns();
  }, [isOpen]);

  // Polling active runs
  useEffect(() => {
    if (!isOpen) {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      return;
    }

    const hasActiveRun = runs.some((r) => r.status === "running" || r.status === "pending");
    if (hasActiveRun) {
      if (!pollIntervalRef.current) {
        pollIntervalRef.current = setInterval(() => {
          fetchRuns(true);
        }, 5000);
      }
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [isOpen, runs]);

  const fetchRuns = async (silent = false) => {
    if (!silent) setLoadingRuns(true);
    try {
      const data = await getTrainingRuns();
      setRuns(data || []);
    } catch (err) {
      if (!silent) setError(err.message || "Failed to load runs");
    } finally {
      if (!silent) setLoadingRuns(false);
    }
  };

  const handleRecommendHyperparams = async () => {
    setLoadingHp(true);
    setError(null);
    try {
      const rec = await recommendHyperparameters({
        datasetId: runs[0]?.dataset_id || "default",
        model: selectedModel,
        augmentationDomainRows: autoAugment ? 960 : 0,
      });
      setRecommendedHp(rec?.hyperparams || null);
    } catch (err) {
      setError(err.message || "Failed to fetch hyperparameter recommendation");
    } finally {
      setLoadingHp(false);
    }
  };

  const handleLaunchTraining = async () => {
    setLaunching(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await launchTraining({
        model: selectedModel,
        maxIterations,
        targetWinRate,
        autoAugment,
      });
      setSuccessMessage(res.message || "Training run launched successfully!");
      if (res.run) {
        setRuns((prev) => [res.run, ...prev.filter((r) => r.id !== res.run.id)]);
      }
    } catch (err) {
      setError(err.message || "Failed to launch training run");
    } finally {
      setLaunching(false);
    }
  };

  const handleCancelRun = async (runId) => {
    try {
      const res = await cancelTrainingRun(runId);
      if (res) {
        setRuns((prev) =>
          prev.map((r) => (r.id === runId ? { ...r, status: "cancelled" } : r))
        );
      }
    } catch (err) {
      setError(err.message || "Failed to cancel run");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/70">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-violet-600/10 dark:bg-violet-400/10 text-violet-600 dark:text-violet-400 border border-violet-500/20">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
                  Adaption AutoScientist Fine-Tuning
                </h2>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Auto-Optimization Loop
                </span>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Self-supervised model refinement from production trajectories with automated hyperparameter derivation.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Top KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/80 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Harvested Samples</span>
                <Layers className="w-4 h-4 text-violet-500" />
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  {stats?.total_trajectories || 39}
                </span>
                <span className="text-xs text-zinc-400 font-medium">records</span>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/80 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Apps Covered</span>
                <Zap className="w-4 h-4 text-amber-500" />
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  {stats?.unique_apps_count || 27}
                </span>
                <span className="text-xs text-zinc-400 font-medium">integrations</span>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/80 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Readiness</span>
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                  AutoScientist Ready
                </span>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/80 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">Active Loops</span>
                <Activity className="w-4 h-4 text-blue-500" />
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
                  {runs.filter((r) => r.status === "running").length}
                </span>
                <span className="text-xs text-zinc-400 font-medium">running</span>
              </div>
            </div>
          </div>

          {/* Feedback messages */}
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/50 flex items-center gap-3 text-rose-700 dark:text-rose-300 text-sm">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMessage && (
            <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 flex items-center gap-3 text-emerald-700 dark:text-emerald-300 text-sm">
              <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Training Configuration Panel */}
          <div className="p-5 rounded-2xl bg-zinc-50/70 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-violet-500" />
                <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  Training Configuration
                </h3>
              </div>
              <button
                type="button"
                onClick={handleRecommendHyperparams}
                disabled={loadingHp}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors"
              >
                {loadingHp ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                Inspect AutoScientist Recommendation
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Model Select */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Target Foundation Model
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  {models.length > 0 ? (
                    models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display_name} ({m.api_model_size || m.model_size})
                        {m.train_with_reasoning ? " • Reasoning" : ""}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="Qwen/Qwen3.5-2B">Qwen3.5 2B (Reasoning, LoRA+Full)</option>
                      <option value="Qwen/Qwen3.5-4B">Qwen3.5 4B (Reasoning, 262k)</option>
                      <option value="google/gemma-3-4b-pt">Gemma 3 4B PT</option>
                      <option value="openai/gpt-oss-20b">gpt-oss (20B)</option>
                    </>
                  )}
                </select>
              </div>

              {/* Max Iterations */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Max Iterations
                </label>
                <select
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  <option value={1}>1 Iteration (Fastest convergence)</option>
                  <option value={2}>2 Iterations (Deep exploration)</option>
                  <option value={3}>3 Iterations (Production full run)</option>
                </select>
              </div>

              {/* Target Win Rate */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Target Win Rate (Early Stop)
                </label>
                <select
                  value={targetWinRate}
                  onChange={(e) => setTargetWinRate(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-xl bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  <option value={0.7}>70% Win Rate (Standard)</option>
                  <option value={0.8}>80% Win Rate (High Precision)</option>
                  <option value={0.9}>90% Win Rate (Ultra Rigorous)</option>
                </select>
              </div>
            </div>

            {/* Recommended Hyperparameters Disclosure */}
            {recommendedHp && (
              <div className="p-3.5 rounded-xl bg-violet-50/50 dark:bg-violet-950/20 border border-violet-200/70 dark:border-violet-800/50 animate-in fade-in duration-200">
                <div className="text-xs font-bold text-violet-700 dark:text-violet-300 mb-2 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  AutoScientist Derived Hyperparameters:
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-zinc-600 dark:text-zinc-400 font-mono">
                  <div>
                    Type: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{recommendedHp.training_type}</span>
                  </div>
                  <div>
                    LR: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{recommendedHp.learning_rate}</span>
                  </div>
                  <div>
                    LoRA Rank: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{recommendedHp.lora_r}</span>
                  </div>
                  <div>
                    LoRA Alpha: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{recommendedHp.lora_alpha}</span>
                  </div>
                  <div>
                    Scheduler: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{recommendedHp.lr_scheduler_type}</span>
                  </div>
                  <div>
                    Warmup: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{recommendedHp.warmup_ratio * 100}%</span>
                  </div>
                  <div>
                    Max Grad Norm: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{recommendedHp.max_grad_norm}</span>
                  </div>
                  <div>
                    Modules: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{recommendedHp.lora_trainable_modules}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Action Bar */}
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="autoAugment"
                  checked={autoAugment}
                  onChange={(e) => setAutoAugment(e.target.checked)}
                  className="rounded text-violet-600 focus:ring-violet-500"
                />
                <label htmlFor="autoAugment" className="text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer">
                  Auto-fill synthetic domain rows to reach 1,000 threshold
                </label>
              </div>

              <button
                type="button"
                onClick={handleLaunchTraining}
                disabled={launching}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 transition-all shadow-md shadow-violet-500/20"
              >
                {launching ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Launching AutoScientist...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-white" />
                    Launch Live AutoScientist Loop
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Active & Past Training Runs */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <Activity className="w-4 h-4 text-violet-500" />
                AutoScientist Training Experiments ({runs.length})
              </h3>
              <button
                type="button"
                onClick={() => fetchRuns(false)}
                disabled={loadingRuns}
                className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 flex items-center gap-1"
              >
                <RotateCw className={`w-3.5 h-3.5 ${loadingRuns ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            {runs.length === 0 ? (
              <div className="p-8 text-center rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-800 text-zinc-500 text-xs">
                No active or previous AutoScientist training runs found. Click "Launch Live AutoScientist Loop" to initiate one.
              </div>
            ) : (
              <div className="space-y-2.5">
                {runs.map((r) => {
                  const isRunning = r.status === "running" || r.status === "pending";
                  const isSucceeded = r.status === "succeeded";
                  const isCancelled = r.status === "cancelled";

                  return (
                    <div
                      key={r.id}
                      className="p-4 rounded-xl bg-white dark:bg-zinc-800/70 border border-zinc-200 dark:border-zinc-700/80 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-100">
                            {r.model}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${isRunning
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                              : isSucceeded
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                                : isCancelled
                                  ? "bg-zinc-500/10 text-zinc-500 border border-zinc-500/20"
                                  : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20"
                              }`}
                          >
                            {isRunning && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                            {isSucceeded && <CheckCircle2 className="w-2.5 h-2.5" />}
                            {r.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400 font-mono">
                          <span>Run ID: {r.id.slice(0, 8)}...</span>
                          <span>•</span>
                          <span>
                            Iter: {r.iterations_completed || 0}/{r.max_iterations || 1}
                          </span>
                          <span>•</span>
                          <span>Target: {Math.round((r.target_win_rate || 0.7) * 100)}% Win Rate</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {isRunning && (
                          <button
                            type="button"
                            onClick={() => handleCancelRun(r.id)}
                            className="px-2.5 py-1 text-xs font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-lg transition-colors border border-rose-500/20"
                          >
                            Cancel Run
                          </button>
                        )}
                        {isSucceeded && (
                          <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                            Ready for Shadow Evaluation
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
