import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Clipboard,
  Download,
  FileJson,
  FileText,
  LayoutGrid,
  List,
  Loader2,
  Search,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { getVaultNotes } from "../api/vault";
import { downloadFile, normalizeNote, notesToCsv, notesToJson } from "../lib/vaultNotes";

function NoteCard({ note, selected, onToggleSelect, view }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(note.contentText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`glass-panel p-4 flex flex-col gap-2 ${view === "list" ? "sm:flex-row sm:items-start sm:gap-4" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <label className="flex items-center gap-2 min-w-0 cursor-pointer">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(note.id)}
            className="w-4 h-4 accent-brand-500 shrink-0"
          />
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 truncate">
            <FileText size={13} className="text-brand-500 shrink-0" />
            {note.source}
          </span>
        </label>
        <button
          onClick={handleCopy}
          title="Copy content"
          className="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-brand-500 hover:bg-brand-500/10 transition-colors shrink-0"
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Clipboard size={14} />}
        </button>
      </div>

      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-sm">{note.title}</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-3 mt-1 font-mono">{note.contentText}</p>
        <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-400 dark:text-slate-500">
          <span>{note.agentName}</span>
          {note.createdAt && (
            <>
              <span>·</span>
              <span>{new Date(note.createdAt).toLocaleString()}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function VaultNotes() {
  const { userId } = useAuth();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [view, setView] = useState("grid");
  const [selectedIds, setSelectedIds] = useState(new Set());

  useEffect(() => {
    setLoading(true);
    getVaultNotes(userId)
      .then((res) => setNotes((res?.notes || []).map(normalizeNote)))
      .catch((err) => setError(err.message || "Failed to load vault notes."))
      .finally(() => setLoading(false));
  }, [userId]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return notes.filter((note) => {
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
  }, [notes, query, dateFrom, dateTo]);

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
    <div className="flex flex-col gap-5 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Vault Notes</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Extracted DOM summaries and scraped data from your agents' runs.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by keyword or agent name..."
            className="w-full rounded-xl border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 pl-9 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
          />
        </div>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="rounded-xl border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
        />
        <span className="text-xs text-slate-400">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="rounded-xl border border-slate-300/70 dark:border-white/15 bg-white/70 dark:bg-black/20 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-400/50"
        />
        <div className="flex items-center gap-1 glass-panel p-1">
          <button
            onClick={() => setView("grid")}
            aria-pressed={view === "grid"}
            className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
              view === "grid" ? "bg-brand-500 text-white" : "text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            }`}
          >
            <LayoutGrid size={16} />
          </button>
          <button
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
              view === "list" ? "bg-brand-500 text-white" : "text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            }`}
          >
            <List size={16} />
          </button>
        </div>
      </div>

      {filtered.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500 dark:text-slate-400">
          <span>
            {selectedIds.size > 0 ? `${exportCount} selected` : `Export all ${exportCount} visible`}
          </span>
          <button
            onClick={() => handleExport("csv")}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300/70 dark:border-white/15 px-3 py-1.5 font-medium hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
          >
            <Download size={13} />
            CSV
          </button>
          <button
            onClick={() => handleExport("json")}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300/70 dark:border-white/15 px-3 py-1.5 font-medium hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
          >
            <FileJson size={13} />
            JSON
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={16} className="shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="glass-panel p-10 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" />
          Loading notes…
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-panel p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          No notes match your search.
        </div>
      ) : (
        <div className={view === "grid" ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" : "flex flex-col gap-3"}>
          {filtered.map((note) => (
            <NoteCard key={note.id} note={note} view={view} selected={selectedIds.has(note.id)} onToggleSelect={toggleSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
