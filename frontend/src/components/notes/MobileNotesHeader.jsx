import { Calendar, Download, Loader2, Mic, Search, X } from "lucide-react";

export default function MobileNotesHeader({
  totalNotes,
  filteredCount,
  searchQuery,
  setSearchQuery,
  isVoiceSearching,
  isVoiceProcessing,
  interimTranscript,
  toggleVoiceSearch,
  sourcesList = [],
  activeSource,
  setActiveSource,
  showDateFilter,
  setShowDateFilter,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  onOpenExport,
}) {
  return (
    <div className="flex flex-col gap-3 w-full animate-fade-in">
      {/* 1. App Bar Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
            Vault Notes
          </h2>
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300 border border-brand-500/20">
            {totalNotes}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowDateFilter(!showDateFilter)}
            className={`p-2 rounded-xl border text-xs font-semibold transition-all active:scale-95 ${
              showDateFilter || dateFrom || dateTo
                ? "bg-brand-500/10 border-brand-500/40 text-brand-600 dark:text-brand-400"
                : "border-slate-200/80 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5"
            }`}
            aria-label="Toggle date filter"
            title="Filter by date range"
          >
            <Calendar size={16} />
          </button>

          {totalNotes > 0 && (
            <button
              type="button"
              onClick={onOpenExport}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 dark:bg-white/10 text-white font-semibold text-xs border border-slate-900/10 dark:border-white/10 active:scale-95 transition-all shadow-xs"
            >
              <Download size={14} />
              <span>Export</span>
            </button>
          )}
        </div>
      </div>

      {/* 2. Voice Search Input Bar */}
      <div className="relative flex items-center w-full">
        <Search size={16} className="absolute left-3.5 text-slate-400 pointer-events-none" />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={
            isVoiceSearching
              ? interimTranscript || "Listening for note title or topic..."
              : "Search notes, agent runs, or data..."
          }
          className={`w-full rounded-2xl border bg-white/80 dark:bg-black/30 pl-10 pr-20 py-2.5 text-xs outline-none transition-all shadow-xs ${
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
            aria-label="Voice search notes"
            title="Voice search with Gnani Prisma"
          >
            {isVoiceProcessing ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Mic size={15} className={isVoiceSearching ? "animate-bounce" : ""} />
            )}
          </button>
        </div>
      </div>

      {/* 3. Collapsible Date Range Sheet */}
      {showDateFilter && (
        <div className="glass-panel p-3 rounded-2xl flex flex-col gap-2.5 border border-brand-500/20 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              Date Filter
            </span>
            {(dateFrom || dateTo) && (
              <button
                type="button"
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                }}
                className="text-xs text-brand-500 font-semibold hover:underline"
              >
                Reset
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/30 px-2.5 py-1.5 text-xs outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/30 px-2.5 py-1.5 text-xs outline-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* 4. Segmented Source Filter Carousel */}
      {sourcesList.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 -mx-1 px-1">
          <button
            type="button"
            onClick={() => setActiveSource("all")}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all active:scale-95 ${
              activeSource === "all"
                ? "bg-brand-500 text-white shadow-sm shadow-brand-500/25"
                : "bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200/60"
            }`}
          >
            All Notes ({totalNotes})
          </button>
          {sourcesList.map((src) => (
            <button
              key={src.name}
              type="button"
              onClick={() => setActiveSource(src.name)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all active:scale-95 ${
                activeSource === src.name
                  ? "bg-brand-500 text-white shadow-sm shadow-brand-500/25"
                  : "bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200/60"
              }`}
            >
              {src.name} ({src.count})
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

