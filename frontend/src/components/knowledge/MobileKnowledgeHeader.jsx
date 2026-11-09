import { FileText, Globe, Loader2, Mic, Plus, Search, Sparkles, UploadCloud, X } from "lucide-react";

export default function MobileKnowledgeHeader({
  totalSources,
  onOpenIngest,
  searchQuery,
  setSearchQuery,
  isVoiceSearching,
  isVoiceProcessing,
  interimTranscript,
  toggleVoiceSearch,
}) {
  return (
    <div className="flex flex-col gap-3 w-full animate-fade-in">
      {/* 1. App Bar Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
            Knowledge Hub
          </h2>
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300 border border-brand-500/20">
            {totalSources} {totalSources === 1 ? "Doc" : "Docs"}
          </span>
        </div>

        <button
          type="button"
          onClick={() => onOpenIngest("voice")}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 text-white font-semibold text-xs shadow-md shadow-brand-500/20 active:scale-95 transition-all"
        >
          <Plus size={15} />
          <span>Add Knowledge</span>
        </button>
      </div>

      {/* 2. Voice Search Input */}
      <div className="relative flex items-center w-full">
        <Search size={16} className="absolute left-3.5 text-slate-400 pointer-events-none" />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={
            isVoiceSearching
              ? interimTranscript || "Listening for document name..."
              : "Search documents or voice dictations..."
          }
          className={`w-full rounded-2xl border bg-white/80 dark:bg-black/30 pl-10 pr-22 py-2.5 text-xs outline-none transition-all shadow-xs ${
            isVoiceSearching
              ? "border-emerald-500 ring-2 ring-emerald-500/30 text-emerald-600 dark:text-emerald-400"
              : "border-slate-200/80 dark:border-white/10 focus:ring-2 focus:ring-brand-500/30 text-slate-800 dark:text-slate-100"
          }`}
        />

        <div className="absolute right-2 flex items-center gap-1">
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 active:scale-90"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}

          <button
            type="button"
            onClick={toggleVoiceSearch}
            className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all active:scale-90 ${
              isVoiceSearching
                ? "bg-emerald-500 text-white animate-pulse shadow-sm shadow-emerald-500/30"
                : isVoiceProcessing
                ? "bg-brand-500/20 text-brand-500"
                : "text-slate-400 hover:text-brand-500 hover:bg-black/5 dark:hover:bg-white/5"
            }`}
            aria-label="Voice search"
            title="Voice search documents with Gnani Prisma"
          >
            {isVoiceProcessing ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Mic size={15} className={isVoiceSearching ? "animate-bounce" : ""} />
            )}
          </button>
        </div>
      </div>

      {/* 3. Ingestion Quick-Action Dock (Shortcuts) */}
      <div className="grid grid-cols-4 gap-2 py-0.5">
        <button
          type="button"
          onClick={() => onOpenIngest("voice")}
          className="glass-panel p-2.5 rounded-2xl flex flex-col items-center justify-center gap-1 border border-slate-200/70 dark:border-white/10 hover:border-brand-500/30 active:scale-95 transition-all text-center"
        >
          <div className="w-8 h-8 rounded-xl bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 flex items-center justify-center">
            <Mic size={16} />
          </div>
          <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-200">Voice</span>
        </button>

        <button
          type="button"
          onClick={() => onOpenIngest("text")}
          className="glass-panel p-2.5 rounded-2xl flex flex-col items-center justify-center gap-1 border border-slate-200/70 dark:border-white/10 hover:border-brand-500/30 active:scale-95 transition-all text-center"
        >
          <div className="w-8 h-8 rounded-xl bg-brand-500/15 text-brand-600 dark:text-brand-400 flex items-center justify-center">
            <FileText size={16} />
          </div>
          <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-200">Text</span>
        </button>

        <button
          type="button"
          onClick={() => onOpenIngest("url")}
          className="glass-panel p-2.5 rounded-2xl flex flex-col items-center justify-center gap-1 border border-slate-200/70 dark:border-white/10 hover:border-brand-500/30 active:scale-95 transition-all text-center"
        >
          <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 flex items-center justify-center">
            <Globe size={16} />
          </div>
          <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-200">Website</span>
        </button>

        <button
          type="button"
          onClick={() => onOpenIngest("file")}
          className="glass-panel p-2.5 rounded-2xl flex flex-col items-center justify-center gap-1 border border-slate-200/70 dark:border-white/10 hover:border-brand-500/30 active:scale-95 transition-all text-center"
        >
          <div className="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
            <UploadCloud size={16} />
          </div>
          <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-200">Upload</span>
        </button>
      </div>
    </div>
  );
}
