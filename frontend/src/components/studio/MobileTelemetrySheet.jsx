import { useEffect, useRef } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  HelpCircle,
  ImageIcon,
  Loader2,
  Radio,
  X,
} from "lucide-react";

const RUN_STATUS_CONFIG = {
  idle: { label: "Idle", icon: Circle, classes: "text-slate-400" },
  saving: { label: "Saving Agent...", icon: Loader2, classes: "text-brand-400", spin: true },
  starting: { label: "Starting Run...", icon: Loader2, classes: "text-brand-400", spin: true },
  running: { label: "Running Live...", icon: Loader2, classes: "text-brand-400 animate-pulse", spin: true },
  needs_input: { label: "Waiting on Input", icon: HelpCircle, classes: "text-amber-400" },
  listening: { label: "Listening for Events", icon: Radio, classes: "text-emerald-400 animate-pulse" },
  success: { label: "Completed Successfully", icon: CheckCircle2, classes: "text-emerald-400" },
  failed: { label: "Execution Failed", icon: AlertCircle, classes: "text-red-400" },
};

const LEVEL_DOT = {
  info: "bg-slate-400",
  success: "bg-emerald-400",
  error: "bg-red-400",
  warning: "bg-amber-400",
};

export default function MobileTelemetrySheet({ open, onClose, runStatus, logs = [] }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  if (!open) return null;

  const statusConfig = RUN_STATUS_CONFIG[runStatus] || RUN_STATUS_CONFIG.idle;
  const StatusIcon = statusConfig.icon;
  const screenshots = logs.filter((l) => l.screenshotUrl);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end p-0 transition-all md:hidden animate-fade-in">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet Container */}
      <div className="relative w-full rounded-t-[2rem] bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-white/10 p-5 text-slate-900 dark:text-white shadow-2xl z-10 flex flex-col max-h-[85vh] pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] animate-slide-up">
        {/* Drag handle */}
        <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-white/20 mx-auto mb-3 shrink-0" />

        {/* Sheet Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Radio size={16} className={runStatus === "running" ? "text-brand-500 animate-pulse" : "text-slate-400"} />
            <h3 className="font-semibold text-sm">Live Agent Telemetry</h3>
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 ${statusConfig.classes}`}>
              <StatusIcon size={11} className={statusConfig.spin ? "animate-spin" : ""} />
              {statusConfig.label}
            </span>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label="Close logs"
          >
            <X size={18} />
          </button>
        </div>

        {/* Console Log Feed */}
        <div
          ref={scrollRef}
          className="flex-1 my-3 overflow-y-auto rounded-xl bg-slate-950 dark:bg-black/70 border border-slate-800 dark:border-white/5 p-3.5 font-mono text-[11px] leading-relaxed space-y-2 min-h-[220px]"
        >
          {logs.length === 0 ? (
            <div className="text-center py-10 text-slate-500">
              <Radio size={24} className="mx-auto mb-2 opacity-40" />
              <p>No telemetry events logged yet.</p>
              <p className="text-[10px] text-slate-500 mt-1">Logs will stream here automatically during execution.</p>
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="flex items-start gap-2 text-slate-300">
                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${LEVEL_DOT[log.level] || LEVEL_DOT.info}`} />
                <span className="text-slate-500 shrink-0 text-[10px]">{log.timestamp}</span>
                <span
                  className={
                    log.level === "error"
                      ? "text-red-300 font-semibold"
                      : log.level === "success"
                      ? "text-emerald-300 font-medium"
                      : ""
                  }
                >
                  {log.message}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Screenshots if any */}
        {screenshots.length > 0 && (
          <div className="pt-2 border-t border-slate-200 dark:border-white/10 shrink-0">
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
              <ImageIcon size={13} className="text-brand-500" />
              <span>Browser Screenshots ({screenshots.length})</span>
            </p>
            <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
              {screenshots.map((log, i) => (
                <a
                  key={i}
                  href={log.screenshotUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 w-24 h-18 rounded-lg overflow-hidden border border-slate-200 dark:border-white/15 bg-black"
                >
                  <img src={log.screenshotUrl} alt="Execution Proof" className="w-full h-full object-cover" />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

