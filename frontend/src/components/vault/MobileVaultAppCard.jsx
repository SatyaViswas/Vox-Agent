import { CheckCircle2, Loader2, RefreshCw, Unplug, Zap } from "lucide-react";
import AppIcon from "./AppIcon";

export default function MobileVaultAppCard({
  app,
  connected,
  noAuthNeeded,
  connecting,
  onConnect,
  onChangeAccount,
  onDisconnect,
}) {
  return (
    <div className="glass-panel rounded-2xl p-3.5 border border-slate-200/80 dark:border-white/10 shadow-sm flex flex-col justify-between gap-3 transition-all active:scale-[0.99] touch-manipulation">
      {/* 1. Card Top: App Icon, Name, and Status Badge */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <AppIcon app={app} className="w-10 h-10 shrink-0 shadow-xs" />
          <div className="min-w-0 flex-1">
            <h4 className="font-bold text-sm text-slate-900 dark:text-white truncate leading-tight">
              {app.name}
            </h4>
            <p className="text-[11px] text-slate-400 capitalize truncate mt-0.5 font-medium">
              {app.category || "Integration"}
            </p>
          </div>
        </div>

        {/* Status indicator pill */}
        <span
          className={`inline-flex items-center gap-1.5 text-[10px] font-semibold shrink-0 px-2.5 py-1 rounded-full ${
            connected || noAuthNeeded
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25"
              : "bg-slate-200/60 dark:bg-white/5 text-slate-500 dark:text-slate-400"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              connected || noAuthNeeded ? "bg-emerald-500 animate-pulse" : "bg-slate-400"
            }`}
          />
          <span>{connected ? "Connected" : noAuthNeeded ? "Built-in" : "Not Linked"}</span>
        </span>
      </div>

      {/* 2. Card Bottom: Action Buttons */}
      <div className="pt-1">
        {noAuthNeeded ? (
          <div className="text-[11px] text-slate-500 dark:text-slate-400 text-center py-2 bg-slate-100/60 dark:bg-white/5 rounded-xl font-medium">
            Ready to use · No credentials required
          </div>
        ) : connected ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold py-2.5 border border-emerald-500/20">
              <CheckCircle2 size={14} />
              <span>Active</span>
            </div>

            <button
              type="button"
              onClick={() => onChangeAccount(app)}
              disabled={connecting}
              title={`Change account for ${app.name}`}
              className="w-11 h-10 flex items-center justify-center rounded-xl bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:text-brand-500 disabled:opacity-50 active:scale-95 transition-all shrink-0"
              aria-label="Change account"
            >
              {connecting ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </button>

            <button
              type="button"
              onClick={() => onDisconnect(app)}
              disabled={connecting}
              title={`Disconnect ${app.name}`}
              className="w-11 h-10 flex items-center justify-center rounded-xl bg-red-50 dark:bg-red-950/20 text-red-500 hover:text-red-600 disabled:opacity-50 active:scale-95 transition-all shrink-0"
              aria-label="Disconnect account"
            >
              {connecting ? <Loader2 size={15} className="animate-spin" /> : <Unplug size={15} />}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onConnect(app)}
            disabled={connecting}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 disabled:opacity-50 text-white font-bold text-xs shadow-md shadow-brand-500/20 active:scale-[0.98] transition-all"
          >
            {connecting ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                <span>Connecting...</span>
              </>
            ) : (
              <>
                <Zap size={14} />
                <span>1-Tap Connect</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

