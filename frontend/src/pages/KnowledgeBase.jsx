import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  Mic,
  Plus,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
  Zap,
  Edit3,
  Pencil,
  Save,
  Check
} from "lucide-react";
import {
  ingestKnowledge,
  getKnowledgeSources,
  deleteKnowledgeSource,
  getKnowledgeSourceContent,
  renameKnowledgeSource,
  updateKnowledgeSource,
} from "../api/knowledge";
import { useAuth } from "../context/AuthContext";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useVoiceLanguage } from "../hooks/useVoiceLanguage";
import { translateText } from "../api/translate";
import { needsTranslation } from "../lib/textLanguage";
import VoiceLanguagePicker from "../components/shared/VoiceLanguagePicker";

/* ─────────────── helpers ─────────────── */
const URL_RE = /^https?:\/\/.+/i;

function isUrl(str) {
  return URL_RE.test(str.trim());
}

function sourceTypeIcon(type) {
  if (type === "url") return Globe;
  if (type === "file") return FileSpreadsheet;
  return FileText;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/* ─────────────── sub-components ─────────────── */

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div className="glass-panel p-4 flex items-center gap-4 min-w-0">
      <div
        className={`flex items-center justify-center w-10 h-10 rounded-xl shrink-0 ${accent}`}
      >
        <Icon size={20} className="text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{label}</p>
        <p className="text-xl font-bold tracking-tight">{value}</p>
      </div>
    </div>
  );
}

function ViewSourceModal({ sourceName, onClose }) {
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    getKnowledgeSourceContent(sourceName)
      .then((res) => {
        setContent(res.content);
        setError(null);
      })
      .catch((err) => setError(err.message || "Failed to load content."))
      .finally(() => setLoading(false));
  }, [sourceName]);

  const handleSave = async () => {
    try {
      setSaving(true);
      await updateKnowledgeSource(sourceName, content);
      setIsEditing(false);
    } catch (err) {
      setError(err.message || t("knowledge.saveContentFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="glass-panel w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between p-4 border-b border-slate-300/70 dark:border-white/10 bg-slate-50/50 dark:bg-slate-900/50">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{sourceName}</h2>
          </div>
          <div className="flex items-center gap-2">
            {!isEditing ? (
              <button
                onClick={() => setIsEditing(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
              >
                <Pencil size={14} /> {t("common.edit")}
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-brand-500 text-white hover:bg-brand-600 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {t("common.save")}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 ml-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>
        
        {error && (
          <div className="p-3 bg-red-500/10 border-b border-red-500/20 text-red-500 text-sm flex items-center gap-2">
            <AlertCircle size={16} /> {error}
          </div>
        )}
        
        <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-white/50 dark:bg-black/20">
          {loading ? (
            <div className="flex items-center justify-center h-full text-slate-400">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : isEditing ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-full min-h-[300px] bg-transparent outline-none resize-none font-mono text-sm"
              placeholder={t("knowledge.sourceContentPlaceholder")}
            />
          ) : (
            <div className="text-sm font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed select-text">
              {content}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceRow({ source, onDelete, deleting, onRename, onView }) {
  const { t } = useTranslation();
  const Icon = sourceTypeIcon(source.source_type);
  const typeLabel =
    source.source_type === "url"
      ? t("knowledge.typeWebsite")
      : source.source_type === "file"
      ? t("knowledge.typeFile")
      : t("knowledge.typeText");

  const [isRenaming, setIsRenaming] = useState(false);
  const [editName, setEditName] = useState(source.source_name);

  const handleRenameSubmit = () => {
    if (editName.trim() && editName.trim() !== source.source_name) {
      onRename(source.source_name, editName.trim());
    }
    setIsRenaming(false);
  };

  return (
    <div className="glass-panel px-4 py-3 flex items-center gap-3 group hover:border-brand-400/30 transition-all duration-200">
      <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-brand-500/10 shrink-0">
        <Icon size={17} className="text-brand-500" />
      </div>

      <div className="flex-1 min-w-0 cursor-pointer" onClick={(e) => {
        if (!isRenaming) onView(source.source_name);
      }}>
        {isRenaming ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleRenameSubmit()}
              onBlur={handleRenameSubmit}
              onClick={(e) => e.stopPropagation()}
              className="text-sm font-medium bg-white/70 dark:bg-black/20 border border-brand-500 rounded px-2 py-0.5 outline-none w-full max-w-xs"
            />
          </div>
        ) : (
          <p className="text-sm font-medium truncate group-hover:text-brand-500 transition-colors">{source.source_name}</p>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest px-1.5 py-0.5 rounded-md bg-brand-500/10 text-brand-500">
            {typeLabel}
          </span>
          {source.created_at && (
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              {t("knowledge.added", { date: formatDate(source.created_at) })}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-all shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsRenaming(true);
          }}
          aria-label={t("knowledge.renameSource")}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-brand-500 hover:bg-brand-500/10 transition-all"
        >
          <Edit3 size={14} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(source.source_name);
          }}
          disabled={deleting === source.source_name}
          aria-label={`Delete ${source.source_name}`}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-all disabled:cursor-not-allowed"
        >
          {deleting === source.source_name ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Trash2 size={14} />
          )}
        </button>
      </div>
    </div>
  );
}

/* drag-and-drop omni-box */
function OmniBox({ onSuccess }) {
  const { t } = useTranslation();
  const { voiceLanguage, setVoiceLanguage } = useVoiceLanguage();
  const [mode, setMode] = useState("text"); // "text" | "url" | "file"
  const [textInput, setTextInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null); // { type: "success"|"error", msg }
  const fileRef = useRef(null);
  const dragCounter = useRef(0);

  const {
    isSupported: speechSupported,
    isRecording,
    interimTranscript,
    error: speechError,
    toggle: toggleRecording,
  } = useSpeechRecognition({
    lang: voiceLanguage.speechCode,
    onFinalTranscript: (finalText) => {
      setTextInput((prev) => (prev ? prev + " " + finalText : finalText).trim());
    },
  });

  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

  const showToast = (type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const handleSubmit = async () => {
    try {
      setLoading(true);
      if (mode === "text") {
        if (!textInput.trim()) return showToast("error", t("knowledge.enterText"));
        // Same translate-before-send pattern as Studio's voice mode — the
        // textarea keeps showing the user's own words; ingestKnowledge only
        // ever receives English, so knowledge_ingestion.py needs no changes.
        // Detection is based on the text itself, not just the language
        // picker, so a mismatched or forgotten selection still translates.
        const trimmedText = textInput.trim();
        const englishText = needsTranslation(trimmedText, voiceLanguage.uiCode)
          ? await translateText(trimmedText, "auto")
          : trimmedText;
        await ingestKnowledge({ text: englishText, name: nameInput.trim() });
        setTextInput("");
      } else if (mode === "url") {
        if (!isUrl(urlInput)) return showToast("error", t("knowledge.enterValidUrl"));
        await ingestKnowledge({ url: urlInput.trim(), name: nameInput.trim() });
        setUrlInput("");
      } else {
        if (!file) return showToast("error", t("knowledge.selectFile"));
        await ingestKnowledge({ file, name: nameInput.trim() });
        setFile(null);
      }
      setNameInput("");
      showToast("success", t("knowledge.addSuccess"));
      onSuccess();
    } catch (err) {
      showToast("error", err.message || t("knowledge.addFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleFileDrop = (f) => {
    if (f.size > MAX_BYTES) {
      return showToast("error", t("knowledge.fileTooLarge"));
    }
    const allowed = ["application/pdf", "text/csv", "text/plain"];
    const ext = f.name.split(".").pop().toLowerCase();
    if (!allowed.includes(f.type) && !["pdf", "csv", "txt"].includes(ext)) {
      return showToast("error", t("knowledge.unsupportedFormat"));
    }
    setFile(f);
    setMode("file");
  };

  const onDragEnter = (e) => {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFileDrop(f);
  };

  const tabBtn = (id, label, Icon) => (
    <button
      key={id}
      onClick={() => setMode(id)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
        mode === id
          ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20"
          : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5"
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  );

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`glass-panel p-5 flex flex-col gap-4 transition-all duration-200 ${
        dragging ? "border-brand-400 ring-2 ring-brand-400/30 scale-[1.01]" : ""
      }`}
    >
      {/* header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-fuchsia-500">
            <Plus size={16} className="text-white" />
          </div>
          <span className="font-semibold text-sm">{t("knowledge.addKnowledge")}</span>
        </div>
        {/* mode tabs */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-white/5">
          {tabBtn("text", t("knowledge.modeText"), FileText)}
          {tabBtn("url", t("knowledge.modeUrl"), Globe)}
          {tabBtn("file", t("knowledge.modeFile"), UploadCloud)}
        </div>
      </div>

      {/* input area */}
      {mode === "text" && (
        <div className="flex flex-col gap-2">
          <textarea
            id="kb-text-input"
            value={isRecording && interimTranscript ? `${textInput} ${interimTranscript}`.trim() : textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={t("knowledge.textPlaceholderVoice")}
            rows={5}
            disabled={isRecording}
            className="w-full resize-none rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-black/20 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-brand-400/50 placeholder-slate-400 dark:placeholder-slate-600 transition disabled:opacity-70"
          />
          <div className="flex items-center justify-end gap-2">
            <VoiceLanguagePicker value={voiceLanguage.speechCode} onChange={setVoiceLanguage} />
            <button
              type="button"
              onClick={toggleRecording}
              disabled={!speechSupported}
              aria-pressed={isRecording}
              aria-label={t("voice.toggleRecording")}
              title={speechSupported ? t("voice.speakPrompt") : t("voice.notSupported")}
              className={`flex items-center justify-center w-9 h-9 rounded-xl transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed ${
                isRecording
                  ? "bg-red-500 text-white animate-pulse"
                  : "bg-slate-900/5 dark:bg-white/5 text-slate-500 hover:text-brand-500"
              }`}
            >
              <Mic size={16} />
            </button>
          </div>
          {speechError && (
            <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertCircle size={13} className="shrink-0" />
              {speechError}
            </div>
          )}
        </div>
      )}

      {mode === "url" && (
        <div className="relative">
          <Globe
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            id="kb-url-input"
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder={t("knowledge.urlPlaceholder")}
            className="w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-black/20 pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 focus:ring-brand-400/50 placeholder-slate-400 dark:placeholder-slate-600 transition"
          />
        </div>
      )}

      {mode === "file" && (
        <div
          onClick={() => fileRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 cursor-pointer transition-all duration-150 ${
            file
              ? "border-brand-400 bg-brand-500/5"
              : "border-slate-200 dark:border-white/10 hover:border-brand-400/60 hover:bg-brand-500/5"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.csv,.txt"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileDrop(f);
            }}
          />
          {file ? (
            <>
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-brand-500/10">
                <FileText size={24} className="text-brand-500" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-sm">{file.name}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {(file.size / 1024).toFixed(0)} KB
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
                className="absolute top-3 right-3 flex items-center justify-center w-6 h-6 rounded-full bg-slate-200 dark:bg-white/10 text-slate-500 hover:bg-red-500/20 hover:text-red-500 transition-colors"
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-slate-100 dark:bg-white/5">
                <UploadCloud size={24} className="text-slate-400" />
              </div>
              <div className="text-center">
                <p className="font-medium text-sm">{t("knowledge.dropOrClick")}</p>
                <p className="text-xs text-slate-400 mt-1">{t("knowledge.supportedFormats")}</p>
              </div>
            </>
          )}
        </div>
      )}

      {/* drag overlay hint */}
      {dragging && (
        <div className="absolute inset-0 rounded-2xl bg-brand-500/10 flex items-center justify-center pointer-events-none">
          <p className="font-semibold text-brand-500 text-sm">{t("knowledge.dropHere")}</p>
        </div>
      )}

      {/* Name Input */}
      <div className="relative">
        <input
          type="text"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          placeholder={t("knowledge.namePlaceholder")}
          className="w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-black/20 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-400/50 placeholder-slate-400 dark:placeholder-slate-600 transition"
        />
      </div>

      {/* submit */}
      <button
        id="kb-submit-btn"
        onClick={handleSubmit}
        disabled={loading}
        className="flex items-center justify-center gap-2 w-full rounded-xl py-2.5 text-sm font-semibold bg-gradient-to-r from-brand-500 to-fuchsia-500 text-white shadow-md shadow-brand-500/20 hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {loading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Sparkles size={16} />
        )}
        {loading ? t("knowledge.processing") : t("knowledge.submit")}
      </button>

      {/* toast */}
      {toast && (
        <div
          className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm border animate-fade-in ${
            toast.type === "success"
              ? "bg-emerald-500/10 border-emerald-400/30 text-emerald-600 dark:text-emerald-400"
              : "bg-red-500/10 border-red-400/30 text-red-600 dark:text-red-400"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
          ) : (
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
          )}
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

/* ─────────────── main page ─────────────── */
export default function KnowledgeBase() {
  const { t } = useTranslation();
  const { userId } = useAuth();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [viewingSource, setViewingSource] = useState(null);

  const fetchSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    getKnowledgeSources()
      .then(setSources)
      .catch((err) => setError(err.message || t("knowledge.loadFailed")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources, userId]);

  const handleDelete = async (name) => {
    setDeleting(name);
    try {
      await deleteKnowledgeSource(name);
      setSources((prev) => prev.filter((s) => s.source_name !== name));
      setError(null);
    } catch (err) {
      setError(err.message || t("knowledge.deleteFailed"));
    } finally {
      setDeleting(null);
    }
  };

  const handleRename = async (oldName, newName) => {
    try {
      await renameKnowledgeSource(oldName, newName);
      fetchSources();
    } catch (err) {
      setError(err.message || t("knowledge.renameFailed"));
    }
  };

  const totalSources = sources.length;

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto pb-24 md:pb-6">
      {/* page header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-fuchsia-500 text-white shrink-0">
              <Brain size={19} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{t("knowledge.title")}</h1>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed max-w-lg">
            {t("knowledge.subtitle")}
          </p>
        </div>
      </div>

      {/* stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard
          icon={Brain}
          label={t("knowledge.activeSources")}
          value={loading ? "—" : totalSources}
          accent="bg-gradient-to-br from-brand-500 to-brand-600"
        />
        <StatCard
          icon={Zap}
          label={t("knowledge.cacheStatus")}
          value={totalSources > 0 ? t("knowledge.live") : t("knowledge.empty")}
          accent="bg-gradient-to-br from-fuchsia-500 to-purple-600"
        />
        <StatCard
          icon={Sparkles}
          label={t("knowledge.aiMode")}
          value={totalSources > 0 ? t("knowledge.contextAware") : t("knowledge.generic")}
          accent="bg-gradient-to-br from-amber-400 to-orange-500"
        />
      </div>

      {/* explainer banner when empty */}
      {!loading && totalSources === 0 && (
        <div className="glass-panel p-5 flex items-start gap-4 border-brand-400/20">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-fuchsia-500 shrink-0">
            <Sparkles size={18} className="text-white" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm">{t("knowledge.flyingBlindTitle")}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              {t("knowledge.flyingBlindDesc")}
            </p>
          </div>
        </div>
      )}

      {/* omni-box */}
      <section className="relative">
        <OmniBox onSuccess={fetchSources} />
      </section>

      {/* source list */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-2">
            <ChevronRight size={15} className="text-brand-500" />
            {t("knowledge.activeSources")}
            {!loading && totalSources > 0 && (
              <span className="ml-1 text-xs font-normal bg-brand-500/10 text-brand-500 px-2 py-0.5 rounded-full">
                {totalSources}
              </span>
            )}
          </h2>
        </div>

        {error && (
          <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={15} className="shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="glass-panel p-10 flex items-center justify-center gap-2 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : totalSources === 0 ? (
          <div className="glass-panel p-10 text-center text-sm text-slate-500 dark:text-slate-400">
            {t("knowledge.noSources")}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                onDelete={handleDelete}
                deleting={deleting}
                onRename={handleRename}
                onView={setViewingSource}
              />
            ))}
          </div>
        )}
      </section>

      {viewingSource && <ViewSourceModal sourceName={viewingSource} onClose={() => setViewingSource(null)} />}
    </div>
  );
}
