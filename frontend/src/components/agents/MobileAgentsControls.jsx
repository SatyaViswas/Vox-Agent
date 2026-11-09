import { Clock, Loader2, Mic, Plus, Radio, Search, Webhook, X, Zap } from "lucide-react";

export default function MobileAgentsControls({
  activeTab,
  setActiveTab,
  tabCounts,
  statusFilter,
  setStatusFilter,
  statusCounts,
  search,
  setSearch,
  isVoiceSearching,
  isVoiceProcessing,
  interimTranscript,
  toggleVoiceSearch,
  onNewAgent,
  totalAgentsCount,
}) {
  const tabs = [
    { id: "on-demand", label: "On Demand", icon: Zap, count: tabCounts["on-demand"] || 0 },
    { id: "scheduled", label: "Scheduled", icon: Clock, count: tabCounts["scheduled"] || 0 },
    { id: "event", label: "Live Events", icon: Webhook, count: tabCounts["event"] || 0 },
  ];

  const statuses = [
    { id: "all", label: "All", count: statusCounts.all || 0 },
    { id: "active", label: "Active", count: statusCounts.active || 0 },
    { id: "paused", label: "Paused", count: statusCounts.paused || 0 },
  ];

  return (
    <div className="flex flex-col gap-3 w-full animate-fade-in">
      {/* 1. App Bar Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
            My Agents
          </h2>
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-300 border border-brand-500/20">
            {totalAgentsCount}
          </span>
        </div>

        <button
          type="button"
          onClick={onNewAgent}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-brand-500 to-fuchsia-500 text-white font-semibold text-xs shadow-md shadow-brand-500/20 active:scale-95 transition-all"
        >
          <Plus size={15} />
          <span>New Agent</span>
        </button>
      </div>

      {/* 2. Voice Search Capsule */}
      <div className="relative flex items-center w-full">
        <Search size={16} className="absolute left-3.5 text-slate-400 pointer-events-none" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            isVoiceSearching
              ? interimTranscript || "Listening for agent or app..."
              : "Search agents or speak command..."
          }
          className={`w-full rounded-2xl border bg-white/80 dark:bg-black/30 pl-10 pr-22 py-2.5 text-xs sm:text-sm outline-none transition-all shadow-xs ${
            isVoiceSearching
              ? "border-emerald-500 ring-2 ring-emerald-500/30 text-emerald-600 dark:text-emerald-400"
              : "border-slate-200/80 dark:border-white/10 focus:ring-2 focus:ring-brand-500/30 text-slate-800 dark:text-slate-100"
          }`}
        />

        <div className="absolute right-2 flex items-center gap-1">
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
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

      {/* 3. Horizontally Scrollable Segmented Tab Carousel */}
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-0.5 -mx-1 px-1">
        {tabs.map((tab) => {
          const isSelected = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all active:scale-95 ${
                isSelected
                  ? "bg-brand-500 text-white shadow-sm shadow-brand-500/25"
                  : "bg-white/70 dark:bg-white/5 text-slate-600 dark:text-slate-300 border border-slate-200/60 dark:border-white/10 hover:border-brand-500/30"
              }`}
            >
              <Icon size={13} className={isSelected ? "text-white" : "text-brand-500"} />
              <span>{tab.label}</span>
              <span
                className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                  isSelected ? "bg-white/20 text-white" : "bg-black/5 dark:bg-white/10 text-slate-500"
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 4. Secondary Status Filter Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-1 -mx-1 px-1">
        <span className="text-[11px] font-medium text-slate-400 pl-1 shrink-0">Filter:</span>
        {statuses.map((s) => {
          const isSelected = statusFilter === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStatusFilter(s.id)}
              className={`shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all active:scale-95 ${
                isSelected
                  ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-xs"
                  : "bg-black/5 dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:text-slate-700"
              }`}
            >
              <span>{s.label}</span>
              <span className="opacity-70 font-mono text-[10px]">({s.count})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

