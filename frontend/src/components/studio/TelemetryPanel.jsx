import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Circle, ExternalLink, FileText, HelpCircle, ImageIcon, Loader2, Radio, Rocket } from "lucide-react";

const RUN_STATUS_CONFIG = {
  idle: { labelKey: "telemetry.idle", icon: Circle, classes: "text-slate-400" },
  saving: { labelKey: "telemetry.saving", icon: Loader2, classes: "text-brand-400", spin: true },
  starting: { labelKey: "telemetry.starting", icon: Loader2, classes: "text-brand-400", spin: true },
  running: { labelKey: "telemetry.running", icon: Loader2, classes: "text-brand-400 animate-pulse", spin: true },
  // Previously fell through to the "idle" entry below (no matching key
  // existed here), so the header pill showed "Idle" styling during a live
  // pause even though the rest of the page correctly showed the amber
  // pending-action card and the step's "Needs Input" ring.
  needs_input: { labelKey: "telemetry.needsInput", icon: HelpCircle, classes: "text-amber-400" },
  listening: { labelKey: "telemetry.listening", icon: Radio, classes: "text-emerald-400 animate-pulse" },
  success: { labelKey: "telemetry.success", icon: CheckCircle2, classes: "text-emerald-400" },
  failed: { labelKey: "telemetry.failed", icon: AlertCircle, classes: "text-red-400" },
};

const LEVEL_DOT = {
  info: "bg-slate-400",
  success: "bg-emerald-400",
  error: "bg-red-400",
  warning: "bg-amber-400",
};

export default function TelemetryPanel({ runStatus, logs }) {
  const { t } = useTranslation();
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const statusConfig = RUN_STATUS_CONFIG[runStatus] || RUN_STATUS_CONFIG.idle;
  const StatusIcon = statusConfig.icon;
  const screenshots = logs.filter((l) => l.screenshotUrl);

  const { githubLinks, deployLinks, savedToVault } = useMemo(() => {
    const ghLinks = new Set();
    const liveLinks = new Set();
    let hasVault = false;
    for (const log of logs) {
      const msg = typeof log.message === "string" ? log.message : "";
      const ghMatches = msg.match(/https:\/\/github\.com\/[^\s"'`,)}\]]+/g);
      if (ghMatches) {
        ghMatches.forEach((u) => ghLinks.add(u));
      }
      const liveMatches = msg.match(/(?:Live URL:\s*)(https:\/\/[^\s"'`,)}\]]+)/gi);
      if (liveMatches) {
        liveMatches.forEach((m) => {
          const clean = m.replace(/^Live URL:\s*/i, "").trim();
          if (clean) liveLinks.add(clean);
        });
      }
      const hostMatches = msg.match(/https:\/\/[^\s"'`,)}\]]+\.(?:vercel\.app|netlify\.app|onrender\.com)(?:\/[^\s"'`,)}\]]*)?/g);
      if (hostMatches) {
        hostMatches.forEach((u) => liveLinks.add(u));
      }
      if (msg.includes("VoxAgent Vault Notes") || msg.includes("SAVE_NOTE")) {
        hasVault = true;
      }
    }
    return { githubLinks: Array.from(ghLinks), deployLinks: Array.from(liveLinks), savedToVault: hasVault };
  }, [logs]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${statusConfig.classes}`}>
          <StatusIcon size={13} className={statusConfig.spin ? "animate-spin" : ""} />
          {t(statusConfig.labelKey)}
        </span>
        {runStatus === "running" && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
            <Radio size={11} className="animate-pulse text-brand-400" />
            {t("telemetry.pollingLive")}
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 min-h-[220px] max-h-[360px] overflow-y-auto rounded-xl bg-slate-900/90 dark:bg-black/40 p-3 font-mono text-xs space-y-1.5"
      >
        {logs.length === 0 ? (
          <p className="text-slate-500 text-center py-8">{t("telemetry.emptyFeed")}</p>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="flex items-start gap-2 text-slate-300">
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${LEVEL_DOT[log.level] || LEVEL_DOT.info}`} />
              <span className="text-slate-500 shrink-0">{log.timestamp}</span>
              <span className={`whitespace-pre-wrap break-words ${log.level === "error" ? "text-red-300" : log.level === "success" ? "text-emerald-300" : ""}`}>
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
            {t("telemetry.proofScreenshots")}
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
                <img src={log.screenshotUrl} alt={t("telemetry.executionProofAlt")} className="w-full h-full object-cover" />
              </a>
            ))}
          </div>
        </div>
      )}

      {(deployLinks.length > 0 || githubLinks.length > 0 || (savedToVault && runStatus === "success")) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {deployLinks.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 transition-colors"
            >
              <Rocket size={13} />
              <span>Open Live App</span>
              <ExternalLink size={11} />
            </a>
          ))}
          {githubLinks.map((url) => {
            const isPr = url.includes("/pull/");
            return (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 transition-colors"
              >
                <ExternalLink size={13} />
                <span>{isPr ? "Open Pull Request on GitHub" : "View Branch on GitHub"}</span>
              </a>
            );
          })}
          {savedToVault && runStatus === "success" && (
            <Link
              to="/notes"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-brand-500/15 hover:bg-brand-500/25 text-brand-700 dark:text-brand-300 border border-brand-500/30 transition-colors"
            >
              <FileText size={13} />
              <span>View in Vault Notes</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
