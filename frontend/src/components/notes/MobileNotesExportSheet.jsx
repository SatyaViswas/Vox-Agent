import { useState } from "react";
import { Check, Clipboard, Download, FileJson, FileSpreadsheet, X } from "lucide-react";
import { downloadFile, notesToCsv, notesToJson } from "../../lib/vaultNotes";

export default function MobileNotesExportSheet({
  open,
  onClose,
  notes,
  selectedCount,
  totalCount,
}) {
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const count = notes.length;
  const stamp = new Date().toISOString().slice(0, 10);

  const handleExportCsv = () => {
    downloadFile(`vault-notes-${stamp}.csv`, notesToCsv(notes), "text/csv");
    onClose();
  };

  const handleExportJson = () => {
    downloadFile(`vault-notes-${stamp}.json`, notesToJson(notes), "application/json");
    onClose();
  };

  const handleCopyAll = async () => {
    try {
      const allText = notes
        .map(
          (n) =>
            `Title: ${n.title}\nSource: ${n.source}\nAgent: ${n.agentName}\nDate: ${n.createdAt || "—"}\n\n${n.contentText}`
        )
        .join("\n\n---\n\n");
      await navigator.clipboard.writeText(allText);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        onClose();
      }, 1200);
    } catch {
      // fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end p-0 md:hidden animate-fade-in">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Sheet Content */}
      <div className="relative w-full rounded-t-[2rem] bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-white/10 p-5 text-slate-900 dark:text-white shadow-2xl z-10 flex flex-col max-h-[85vh] overflow-y-auto pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] animate-slide-up">
        {/* Handle */}
        <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-white/20 mx-auto mb-3 shrink-0" />

        <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-white/10 shrink-0">
          <div>
            <h3 className="font-bold text-base">Export Notes</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Exporting {count} {count === 1 ? "note" : "notes"}
              {selectedCount > 0 ? ` (${selectedCount} selected)` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-2.5 my-4">
          {/* CSV */}
          <button
            type="button"
            onClick={handleExportCsv}
            className="flex items-center gap-3 p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/80 dark:border-white/5 hover:border-emerald-500/30 active:scale-98 transition-all text-left"
          >
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
              <FileSpreadsheet size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-xs text-slate-900 dark:text-white">Spreadsheet (CSV)</h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Open in Excel, Google Sheets, or Numbers</p>
            </div>
            <Download size={16} className="text-slate-400" />
          </button>

          {/* JSON */}
          <button
            type="button"
            onClick={handleExportJson}
            className="flex items-center gap-3 p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/80 dark:border-white/5 hover:border-brand-500/30 active:scale-98 transition-all text-left"
          >
            <div className="w-10 h-10 rounded-xl bg-brand-500/15 text-brand-600 dark:text-brand-400 flex items-center justify-center shrink-0">
              <FileJson size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-xs text-slate-900 dark:text-white">Raw JSON Document</h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Structured data with full payload metadata</p>
            </div>
            <Download size={16} className="text-slate-400" />
          </button>

          {/* Copy all to clipboard */}
          <button
            type="button"
            onClick={handleCopyAll}
            className="flex items-center gap-3 p-3.5 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/80 dark:border-white/5 hover:border-fuchsia-500/30 active:scale-98 transition-all text-left"
          >
            <div className="w-10 h-10 rounded-xl bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 flex items-center justify-center shrink-0">
              {copied ? <Check size={20} className="text-emerald-500" /> : <Clipboard size={20} />}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-xs text-slate-900 dark:text-white">
                {copied ? "Copied all notes to clipboard!" : "Copy All to Clipboard"}
              </h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Formatted text ready to paste into chat or docs</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

