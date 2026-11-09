import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Calendar,
  Check,
  Clipboard,
  Download,
  FileJson,
  FileText,
  Filter,
  LayoutGrid,
  List,
  Loader2,
  Mic,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { getVaultNotes } from "../api/vault";
import useSpeechRecognition from "../hooks/useSpeechRecognition";
import { downloadFile, normalizeNote, notesToCsv, notesToJson } from "../lib/vaultNotes";
import MobileNotesHeader from "../components/notes/MobileNotesHeader";
import MobileNoteCard from "../components/notes/MobileNoteCard";
import MobileNotesExportSheet from "../components/notes/MobileNotesExportSheet";

function ViewNoteModal({ note, onClose }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  if (!note) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(note.contentText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xs transition-opacity" onClick={onClose} />
      
      <div className="relative glass-panel w-full sm:max-w-2xl max-h-[90dvh] sm:max-h-[85vh] rounded-t-3xl sm:rounded-2xl flex flex-col overflow-hidden shadow-2xl border-t border-slate-200/80 dark:border-white/15 sm:border animate-in fade-in zoom-in-95 duration-200">
        {/* Mobile drag handle */}
        <div className="sm:hidden pt-3 pb-1 flex justify-center cursor-pointer" onClick={onClose}>
          <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-white/20" />
        </div>

        <div className="flex items-center justify-between px-4 sm:px-5 h-14 sm:h-16 border-b border-slate-300/70 dark:border-white/10 shrink-0">
          <div className="min-w-0 pr-2">
            <h2 className="text-sm sm:text-base font-semibold truncate">{note.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5 truncate">
              <FileText size={13} className="text-brand-500 shrink-0" />
              <span className="truncate">{note.source}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 text-xs sm:text-sm font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed select-text bg-white/50 dark:bg-black/20">
          {note.contentText}
        </div>

        <div className="p-4 border-t border-slate-300/70 dark:border-white/10 flex items-center justify-between text-xs text-slate-400 bg-slate-50/50 dark:bg-slate-900/50 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:pb-4">
          <div className="flex items-center gap-2 truncate pr-2">
            <span className="truncate">{t("notes.agent")}: <span className="text-slate-600 dark:text-slate-300 font-medium">{note.agentName}</span></span>
            {note.createdAt && (
              <>
                <span>·</span>
                <span className="truncate">{new Date(note.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              </>
            )}
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400 font-semibold hover:bg-brand-500/20 active:scale-95 transition-all touch-manipulation shrink-0 min-h-[36px]"
          >
            {copied ? <Check size={14} className="text-emerald-500" /> : <Clipboard size={14} />}
            <span>{copied ? "Copied" : t("common.copy")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function NoteCard({ note, selected, onToggleSelect, onView, view }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(note.contentText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      onClick={() => onView(note)}
      className={`glass-panel p-4 rounded-2xl flex flex-col gap-2.5 group hover:border-brand-400/40 transition-all duration-200 cursor-pointer border border-slate-200/70 dark:border-white/10 shadow-xs hover:shadow-sm active:scale-[0.99] touch-manipulation ${
        view === "list" ? "sm:flex-row sm:items-start sm:gap-4" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <label
          className="flex items-center gap-2 min-w-0 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(note.id)}
            className="w-4 h-4 rounded text-brand-500 bg-slate-100 border-slate-300 dark:border-slate-600 focus:ring-brand-500 shrink-0 cursor-pointer"
          />
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 truncate">
            <FileText size={13} className="text-brand-500 shrink-0" />
            <span className="truncate">{note.source}</span>
          </span>
        </label>

        <button
          onClick={handleCopy}
          title={t("notes.copyContent")}
          className="flex items-center justify-center w-8 h-8 rounded-xl text-slate-400 hover:text-brand-500 hover:bg-brand-500/10 active:scale-95 transition-all shrink-0 touch-manipulation"
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Clipboard size={14} />}
        </button>
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-xs sm:text-sm tracking-tight text-slate-800 dark:text-slate-200 group-hover:text-brand-500 transition-colors truncate">
          {note.title}
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-3 mt-1 font-mono leading-relaxed bg-slate-50/50 dark:bg-black/20 p-2 rounded-xl">
          {note.contentText}
        </p>
        <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-400 dark:text-slate-500 flex-wrap">
          <span className="font-medium text-slate-600 dark:text-slate-400">{note.agentName}</span>
          {note.createdAt && (
            <>
              <span>·</span>
              <span>{new Date(note.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VaultNotes() {
  const { userId } = useAuth();
  const { t } = useTranslation();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [view, setView] = useState("grid");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [viewingNote, setViewingNote] = useState(null);
  const [activeSource, setActiveSource] = useState("all");
  const [isExportSheetOpen, setIsExportSheetOpen] = useState(false);

  // Gnani Prisma Voice Search
  const {
    isRecording: isVoiceSearching,
    isProcessing: isVoiceProcessing,
    interimTranscript,
    toggle: toggleVoiceSearch,
  } = useSpeechRecognition({
    onFinalTranscript: (text) => {
      const clean = (text || "").trim();
      if (!clean) return;
      setQuery(clean);
    },
  });

  useEffect(() => {
    setLoading(true);
    getVaultNotes(userId)
      .then((res) => setNotes((res?.notes || []).map(normalizeNote)))
      .catch((err) => setError(err.message || t("notes.loadFailed")))
      .finally(() => setLoading(false));
  }, [userId, t]);

  const sourcesList = useMemo(() => {
    const map = new Map();
    for (const n of notes) {
      const s = n.source || n.agentName || "General";
      map.set(s, (map.get(s) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [notes]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return notes.filter((note) => {
      const matchesSource =
        activeSource === "all" ||
        (note.source && note.source.toLowerCase() === activeSource.toLowerCase()) ||
        (note.agentName && note.agentName.toLowerCase() === activeSource.toLowerCase());

      if (!matchesSource) return false;

      const matchesQuery =
        !q ||
        note.title.toLowerCase().includes(q) ||
        note.agentName.toLowerCase().includes(q) ||
        note.source.toLowerCase().includes(q) ||
        note.contentText.toLowerCase().includes(q);

      const noteDate = note.createdAt ? new Date(note.createdAt) : null;
      const afterFrom = !dateFrom || (noteDate && noteDate >= new Date(dateFrom));
      const beforeTo = !dateTo || (noteDate && noteDate <= new Date(`${dateTo}T23:59:59`));

      return matchesQuery && afterFrom && beforeTo;
    });
  }, [notes, query, dateFrom, dateTo, activeSource]);

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const exportTargets = () => {
    const selected = filtered.filter((n) => selectedIds.has(n.id));
    return selected.length > 0 ? selected : filtered;
  };

  const handleExport = (format) => {
    const targets = exportTargets();
    if (targets.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      downloadFile(`vault-notes-${stamp}.csv`, notesToCsv(targets), "text/csv");
    } else {
      downloadFile(`vault-notes-${stamp}.json`, notesToJson(targets), "application/json");
    }
  };

  const exportCount = exportTargets().length;

  return (
    <div className="flex flex-col gap-4 max-w-6xl mx-auto pb-12 sm:pb-6">
      {/* ── Mobile-Native View (< sm) ── */}
      <div className="sm:hidden flex flex-col gap-3.5 pb-20">
        <MobileNotesHeader
          totalNotes={notes.length}
          filteredCount={filtered.length}
          searchQuery={query}
          setSearchQuery={setQuery}
          isVoiceSearching={isVoiceSearching}
          isVoiceProcessing={isVoiceProcessing}
          interimTranscript={interimTranscript}
          toggleVoiceSearch={toggleVoiceSearch}
          sourcesList={sourcesList}
          activeSource={activeSource}
          setActiveSource={setActiveSource}
          showDateFilter={showFilters}
          setShowDateFilter={setShowFilters}
          dateFrom={dateFrom}
          setDateFrom={setDateFrom}
          dateTo={dateTo}
          setDateTo={setDateTo}
          onOpenExport={() => setIsExportSheetOpen(true)}
        />

        {error && (
          <div className="rounded-2xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle size={15} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="glass-panel rounded-2xl p-8 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
            <Loader2 size={24} className="animate-spin text-brand-500" />
            <span>Loading vault notes...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="glass-panel rounded-3xl p-6 text-center border border-dashed border-slate-300 dark:border-white/10 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center">
              <Sparkles size={24} />
            </div>
            <div>
              <p className="font-bold text-sm text-slate-900 dark:text-white">
                {query ? `No notes matching "${query}"` : "No notes captured yet"}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs">
                {query
                  ? "Try speaking another term or clearing the filter chips."
                  : "Agents automatically capture structured outputs and save them to your Vault Notes."}
              </p>
            </div>
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-1 px-4 py-1.5 rounded-xl border border-slate-300 dark:border-white/15 text-xs font-semibold hover:bg-black/5 dark:hover:bg-white/5 active:scale-95 transition-all"
              >
                Clear Search
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((note) => (
              <MobileNoteCard
                key={note.id}
                note={note}
                onView={setViewingNote}
                isSelectionMode={selectedIds.size > 0}
                isSelected={selectedIds.has(note.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Desktop View (>= sm) ── */}
      <div className="hidden sm:flex flex-col gap-4">
        {/* Page Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{t("notes.title")}</h1>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
                {notes.length}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
              {t("notes.subtitle")}
            </p>
          </div>

          {/* Export Shortcuts */}
          {filtered.length > 0 && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleExport("csv")}
                className="flex items-center gap-1.5 rounded-xl border border-slate-300/70 dark:border-white/15 px-3 py-2 text-xs font-semibold hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation min-h-[38px]"
              >
                <Download size={13} />
                <span>CSV</span>
              </button>
              <button
                onClick={() => handleExport("json")}
                className="flex items-center gap-1.5 rounded-xl border border-slate-300/70 dark:border-white/15 px-3 py-2 text-xs font-semibold hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation min-h-[38px]"
              >
                <FileJson size={13} />
                <span>JSON</span>
              </button>
            </div>
          )}
        </div>

        {/* Full-width Search Bar with Voice Mic */}
        <div className="flex flex-col gap-2.5">
          <div className="relative flex items-center w-full">
            <Search size={18} className="absolute left-3.5 text-slate-400 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                isVoiceSearching
                  ? interimTranscript || "Listening for note title or query..."
                  : t("notes.searchPlaceholder")
              }
              className={`w-full rounded-2xl border bg-white/70 dark:bg-black/20 pl-10 pr-24 py-3 text-xs sm:text-sm outline-none transition-all shadow-xs ${
                isVoiceSearching
                  ? "border-emerald-500 ring-2 ring-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                  : "border-slate-300/70 dark:border-white/15 focus:ring-2 focus:ring-brand-400/50"
              }`}
            />
            <div className="absolute right-2 flex items-center gap-1">
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 active:scale-95 transition-all"
                  aria-label="Clear search"
                >
                  <X size={15} />
                </button>
              )}
              <button
                onClick={() => toggleVoiceSearch()}
                className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all active:scale-95 touch-manipulation ${
                  isVoiceSearching
                    ? "bg-emerald-500 text-white animate-pulse shadow-sm shadow-emerald-500/40"
                    : isVoiceProcessing
                    ? "bg-brand-500/20 text-brand-500"
                    : "text-slate-500 hover:text-brand-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
                }`}
                title="Voice search notes with Gnani Prisma"
                aria-label="Voice search notes with Gnani Prisma"
              >
                {isVoiceProcessing ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Mic size={17} className={isVoiceSearching ? "animate-bounce" : ""} />
                )}
              </button>
            </div>
          </div>

          {/* Date Filter & View Mode Controls */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setShowFilters((prev) => !prev)}
                className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold border transition-all touch-manipulation min-h-[36px] ${
                  showFilters || dateFrom || dateTo
                    ? "bg-brand-500/10 border-brand-500/30 text-brand-600 dark:text-brand-400"
                    : "border-slate-300/70 dark:border-white/15 text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
                }`}
              >
                <Calendar size={13} />
                <span>Date Filter</span>
                {(dateFrom || dateTo) && <span className="w-2 h-2 rounded-full bg-brand-500" />}
              </button>

              {selectedIds.size > 0 && (
                <span className="text-xs font-medium text-brand-600 dark:text-brand-400 bg-brand-500/10 px-2.5 py-1.5 rounded-xl">
                  {exportCount} {t("notes.selected")}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1 glass-panel p-1 rounded-xl">
              <button
                onClick={() => setView("grid")}
                aria-pressed={view === "grid"}
                className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors touch-manipulation ${
                  view === "grid"
                    ? "bg-brand-500 text-white shadow-xs"
                    : "text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
                }`}
              >
                <LayoutGrid size={15} />
              </button>
              <button
                onClick={() => setView("list")}
                aria-pressed={view === "list"}
                className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors touch-manipulation ${
                  view === "list"
                    ? "bg-brand-500 text-white shadow-xs"
                    : "text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
                }`}
              >
                <List size={15} />
              </button>
            </div>
          </div>

          {/* Collapsible Date Picker Bar */}
          {showFilters && (
            <div className="glass-panel p-3 rounded-2xl flex items-center gap-2 flex-wrap border border-slate-200/70 dark:border-white/10 animate-fadeIn">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-xl border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-brand-400/50"
              />
              <span className="text-xs text-slate-400">{t("common.to")}</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-xl border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-brand-400/50"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 underline ml-1"
                >
                  Reset
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-2xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-xs sm:text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={16} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Main Notes Grid / List */}
        {loading ? (
          <div className="glass-panel rounded-2xl p-10 flex items-center justify-center gap-2 text-sm text-slate-400">
            <Loader2 size={18} className="animate-spin text-brand-500" />
            <span>{t("notes.loading")}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="glass-panel rounded-3xl p-8 sm:p-12 text-center flex flex-col items-center justify-center gap-3 border border-slate-200/70 dark:border-white/10 shadow-sm">
            <div className="w-14 h-14 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center mb-1">
              {query ? <Search size={26} /> : <FileText size={26} />}
            </div>
            <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-white">
              {query ? `No notes found matching "${query}"` : t("notes.noMatch")}
            </h3>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md">
              {query
                ? "Try clearing your search query or speak another phrase with the 🎙️ mic."
                : "Vault Notes are automatically captured by agents during workflow executions and saved here securely."}
            </p>
            {query && (
              <button
                onClick={() => setQuery("")}
                className="mt-2 px-4 py-2 rounded-xl border border-slate-300 dark:border-white/15 text-xs font-semibold hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all"
              >
                Clear Search
              </button>
            )}
          </div>
        ) : (
          <div
            className={
              view === "grid"
                ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 sm:gap-4"
                : "flex flex-col gap-3"
            }
          >
            {filtered.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                view={view}
                selected={selectedIds.has(note.id)}
                onToggleSelect={toggleSelect}
                onView={setViewingNote}
              />
            ))}
          </div>
        )}
      </div>

      {/* Slide-Up Mobile Export Sheet */}
      <MobileNotesExportSheet
        open={isExportSheetOpen}
        onClose={() => setIsExportSheetOpen(false)}
        notes={exportTargets()}
        selectedCount={selectedIds.size}
        totalCount={notes.length}
      />

      {/* Note Inspection Sheet */}
      {viewingNote && <ViewNoteModal note={viewingNote} onClose={() => setViewingNote(null)} />}
    </div>
  );
}
