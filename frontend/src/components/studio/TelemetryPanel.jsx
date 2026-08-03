import { useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, Circle, ImageIcon, Loader2, Radio } from "lucide-react";

const RUN_STATUS_CONFIG = {
  idle: { label: "Idle", icon: Circle, classes: "text-slate-400" },
  saving: { label: "Saving Agent…", icon: Loader2, classes: "text-brand-400", spin: true },
  starting: { label: "Starting…", icon: Loader2, classes: "text-brand-400", spin: true },
  running: { label: "Executing", icon: Loader2, classes: "text-brand-400 animate-pulse", spin: true },
  listening: { label: "Listening for events", icon: Radio, classes: "text-emerald-400 animate-pulse" },
  success: { label: "Complete", icon: CheckCircle2, classes: "text-emerald-400" },
  failed: { label: "Failed", icon: AlertCircle, classes: "text-red-400" },
};

const LEVEL_DOT = {
  info: "bg-slate-400",
  success: "bg-emerald-400",
  error: "bg-red-400",
  warning: "bg-amber-400",
};

export default function TelemetryPanel({ runStatus, logs }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const statusConfig = RUN_STATUS_CONFIG[runStatus] || RUN_STATUS_CONFIG.idle;
  const StatusIcon = statusConfig.icon;
  const screenshots = logs.filter((l) => l.screenshotUrl);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${statusConfig.classes}`}>
          <StatusIcon size={13} className={statusConfig.spin ? "animate-spin" : ""} />
          {statusConfig.label}
        </span>
        {runStatus === "running" && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
            <Radio size={11} className="animate-pulse text-brand-400" />
            polling live
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 min-h-[220px] max-h-[360px] overflow-y-auto rounded-xl bg-slate-900/90 dark:bg-black/40 p-3 font-mono text-xs space-y-1.5"
      >
        {logs.length === 0 ? (
          <p className="text-slate-500 text-center py-8">Live browser feed and execution logs will stream here.</p>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="flex items-start gap-2 text-slate-300">
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${LEVEL_DOT[log.level] || LEVEL_DOT.info}`} />
              <span className="text-slate-500 shrink-0">{log.timestamp}</span>
              <span className={log.level === "error" ? "text-red-300" : log.level === "success" ? "text-emerald-300" : ""}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>

      {screenshots.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1">
            <ImageIcon size={12} />
            Proof Screenshots
          </p>
          <div className="flex gap-2 overflow-x-auto scrollbar-none">
            {screenshots.map((log, i) => (
              <a
                key={i}
                href={log.screenshotUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 w-20 h-16 rounded-lg overflow-hidden border border-slate-200/70 dark:border-white/10"
              >
                <img src={log.screenshotUrl} alt="Execution proof" className="w-full h-full object-cover" />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
