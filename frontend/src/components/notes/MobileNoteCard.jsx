import { useState } from "react";
import { Check, Clipboard, Clock, FileText, Sparkles, User } from "lucide-react";

export default function MobileNoteCard({
  note,
  onView,
  isSelectionMode,
  isSelected,
  onToggleSelect,
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(note.contentText);
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([30]);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
    }
  };

  const formatDate = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  return (
    <div
      onClick={() => {
        if (isSelectionMode) {
          onToggleSelect(note.id);
        } else {
          onView(note);
        }
      }}
      className={`glass-panel rounded-2xl p-3.5 border transition-all active:scale-[0.99] touch-manipulation cursor-pointer flex flex-col gap-2 shadow-xs group ${
        isSelected
          ? "border-brand-500 bg-brand-500/5 ring-1 ring-brand-500"
          : "border-slate-200/80 dark:border-white/10 hover:border-brand-400/30"
      }`}
    >
      {/* 1. Header with Source Badge & Copy/Select */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {isSelectionMode ? (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onToggleSelect(note.id)}
              onClick={(e) => e.stopPropagation()}
              className="w-4 h-4 rounded text-brand-500 border-slate-300 dark:border-white/20 focus:ring-brand-500 cursor-pointer"
            />
          ) : (
            <div className="w-6 h-6 rounded-lg bg-brand-500/10 text-brand-500 flex items-center justify-center shrink-0">
              <Sparkles size={13} />
            </div>
          )}

          <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 truncate flex items-center gap-1">
            <span className="truncate">{note.source}</span>
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {note.createdAt && (
            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium flex items-center gap-1">
              <Clock size={11} />
              <span>{formatDate(note.createdAt)}</span>
            </span>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all active:scale-90 ${
              copied
                ? "bg-emerald-500/20 text-emerald-500"
                : "text-slate-400 hover:text-brand-500 hover:bg-black/5 dark:hover:bg-white/5"
            }`}
            aria-label="Copy note content"
            title="Copy content"
          >
            {copied ? <Check size={14} className="text-emerald-500" /> : <Clipboard size={14} />}
          </button>
        </div>
      </div>

      {/* 2. Note Title */}
      <div>
        <h3 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white leading-snug truncate group-hover:text-brand-500 transition-colors">
          {note.title}
        </h3>
      </div>

      {/* 3. Text Preview Snippet */}
      <div className="rounded-xl bg-slate-50/70 dark:bg-black/25 p-2.5 border border-slate-100 dark:border-white/5">
        <p className="text-xs text-slate-600 dark:text-slate-300 font-mono line-clamp-2 leading-relaxed">
          {note.contentText}
        </p>
      </div>

      {/* 4. Footer with Agent Pill */}
      <div className="flex items-center justify-between text-[11px] text-slate-400 pt-0.5">
        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-500 dark:text-slate-400 truncate max-w-[200px]">
          <User size={11} className="shrink-0" />
          <span className="truncate">{note.agentName}</span>
        </span>
        <span className="text-[10px] text-brand-500 font-semibold group-hover:underline">
          Tap to view →
        </span>
      </div>
    </div>
  );
}

