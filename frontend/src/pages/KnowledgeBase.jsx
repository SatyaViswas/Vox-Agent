import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Tag,
  ShieldCheck,
  MessageSquare,
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
  Check,
  Copy,
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
import MobileKnowledgeHeader from "../components/knowledge/MobileKnowledgeHeader";
import MobileSourceCard from "../components/knowledge/MobileSourceCard";
import MobileIngestSheet from "../components/knowledge/MobileIngestSheet";
import BusinessPillarsGrid from "../components/knowledge/BusinessPillarsGrid";
import KnowledgeTestPlayground from "../components/knowledge/KnowledgeTestPlayground";

/* ─────────────── helpers ─────────────── */
const URL_RE = /^https?:\/\/.+/i;

function isUrl(str) {
  return URL_RE.test(str.trim());
}

const AUDIO_EXTS_RE = /\.(wav|mp3|m4a|ogg|flac|aac)$/i;

function isAudioSource(source) {
  if (!source) return false;
  if (typeof source === "string") return AUDIO_EXTS_RE.test(source) || source.toLowerCase().includes("(audio)");
  return (
    source.source_type === "audio" ||
    AUDIO_EXTS_RE.test(source.source_name || "") ||
    (source.source_name || "").toLowerCase().includes("(audio)")
  );
}

function sourceTypeIcon(source) {
  if (isAudioSource(source)) return Mic;
  const name = typeof source === "object" ? source?.source_name : "";
  const type = typeof source === "object" ? source?.source_type : source;
  if (name === "Business Profile & Hours") return Building2;
  if (name === "Services, Products & Pricing") return Tag;
  if (name === "Policies & Refund Rules") return ShieldCheck;
  if (name === "Customer FAQs & Templates") return MessageSquare;
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
    <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-3 sm:gap-4 min-w-0 border border-slate-200/70 dark:border-white/10 shadow-xs">
      <div
        className={`flex items-center justify-center w-8 h-8 sm:w-10 sm:h-10 rounded-xl shrink-0 ${accent}`}
      >
        <Icon size={16} className="text-white sm:w-5 sm:h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate">{label}</p>
        <p className="text-base sm:text-xl font-bold tracking-tight truncate">{value}</p>
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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    getKnowledgeSourceContent(sourceName)
      .then((res) => {
        setContent(res.content || "");
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

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const lineCount = content ? content.split("\n").length : 0;
  const wordCount = content ? content.trim().split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xs transition-opacity" onClick={onClose} />
      
      <div className="relative glass-panel w-full sm:max-w-4xl h-[92dvh] sm:h-[88vh] rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden shadow-2xl border-t border-slate-200/80 dark:border-white/15 sm:border bg-white dark:bg-slate-900 animate-in fade-in zoom-in-95 duration-200">
        {/* Mobile drag handle */}
        <div className="sm:hidden pt-3 pb-1 flex justify-center cursor-pointer shrink-0" onClick={onClose}>
          <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-white/20" />
        </div>

        {/* Modal Top Bar */}
        <div className="flex items-center justify-between px-4 sm:px-6 h-16 border-b border-slate-200/80 dark:border-white/10 shrink-0 bg-slate-50/60 dark:bg-black/20">
          <div className="min-w-0 pr-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-brand-500/10 text-brand-500 flex items-center justify-center shrink-0">
                <FileText size={16} />
              </div>
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                {sourceName}
              </h2>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 pl-10">
              <span>{wordCount} words</span>
              <span>•</span>
              <span>{lineCount} lines</span>
              <span>•</span>
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                {isEditing ? "Editing mode" : "Full Document View"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {!isEditing && (
              <button
                onClick={handleCopy}
                disabled={!content || loading}
                title="Copy all text"
                className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all min-h-[36px]"
              >
                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
              </button>
            )}

            {!isEditing ? (
              <button
                onClick={() => setIsEditing(true)}
                disabled={loading}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-slate-200 hover:bg-brand-500 hover:text-white active:scale-95 transition-all touch-manipulation min-h-[36px]"
              >
                <Pencil size={14} /> <span>{t("common.edit")}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setIsEditing(false)}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-all min-h-[36px]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs sm:text-sm font-semibold bg-brand-500 text-white hover:bg-brand-600 active:scale-95 transition-all disabled:opacity-50 touch-manipulation min-h-[36px] shadow-sm shadow-brand-500/25"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  <span>{t("common.save")}</span>
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="flex items-center justify-center w-9 h-9 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation ml-1"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {error && (
          <div className="p-3 bg-red-500/10 border-b border-red-500/20 text-red-500 text-xs sm:text-sm flex items-center gap-2 shrink-0">
            <AlertCircle size={15} /> <span>{error}</span>
          </div>
        )}

        {/* Modal Scrollable Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-7 bg-slate-50/40 dark:bg-black/30 pb-[calc(env(safe-area-inset-bottom,0px)+2rem)] flex flex-col">
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center min-h-[300px] text-slate-400 gap-3">
              <Loader2 size={28} className="animate-spin text-brand-500" />
              <span className="text-xs">Loading complete document content...</span>
            </div>
          ) : isEditing ? (
            <div className="flex-1 flex flex-col h-full min-h-[380px]">
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full flex-1 min-h-[380px] p-4 sm:p-5 rounded-2xl bg-white dark:bg-slate-950/70 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-slate-100 font-mono text-xs sm:text-sm leading-relaxed outline-none focus:ring-2 focus:ring-brand-500/40 shadow-inner resize-none"
                placeholder={t("knowledge.sourceContentPlaceholder")}
              />
            </div>
          ) : (
            <div className="w-full min-h-full p-4 sm:p-6 rounded-2xl bg-white/80 dark:bg-slate-950/50 border border-slate-200/80 dark:border-white/10 shadow-xs">
              <pre className="font-mono text-xs sm:text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words leading-relaxed select-text font-normal">
                {content || (
                  <span className="text-slate-400 italic">This document is empty. Tap "Edit" to add content.</span>
                )}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceRow({ source, onDelete, deleting, onRename, onView }) {
  const { t } = useTranslation();
  const Icon = sourceTypeIcon(source);
  const isPillar = [
    "Business Profile & Hours",
    "Services, Products & Pricing",
    "Policies & Refund Rules",
    "Customer FAQs & Templates",
  ].includes(source.source_name);

  const typeLabel = isAudioSource(source)
    ? "Voice Audio"
    : isPillar || source.source_type?.startsWith("pillar_")
    ? "Business Pillar"
    : source.source_type === "url"
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
    <div className="glass-panel px-3.5 sm:px-4 py-3 rounded-2xl flex items-center gap-3 group hover:border-brand-400/30 transition-all duration-200 border border-slate-200/70 dark:border-white/10 shadow-xs">
      <div className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400 shrink-0">
        <Icon size={18} />
      </div>

      <div
        className="flex-1 min-w-0 cursor-pointer"
        onClick={() => {
          if (!isRenaming) onView(source.source_name);
        }}
      >
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
              className="text-xs sm:text-sm font-medium bg-white/70 dark:bg-black/20 border border-brand-500 rounded-lg px-2.5 py-1 outline-none w-full max-w-xs"
            />
          </div>
        ) : (
          <p className="text-xs sm:text-sm font-semibold truncate group-hover:text-brand-500 transition-colors">
            {source.source_name}
          </p>
        )}
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-brand-500/10 text-brand-500">
            {typeLabel}
          </span>
          {source.created_at && (
            <span className="text-[11px] text-slate-400 dark:text-slate-500 truncate">
              {t("knowledge.added", { date: formatDate(source.created_at) })}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons: Visible by default on touch screens, group-hover on desktop */}
      <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-all shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsRenaming(true);
          }}
          aria-label={t("knowledge.renameSource")}
          className="flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl text-slate-400 hover:text-brand-500 hover:bg-brand-500/10 active:scale-95 transition-all touch-manipulation"
        >
          <Edit3 size={15} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(source.source_name);
          }}
          disabled={deleting === source.source_name}
          aria-label={`Delete ${source.source_name}`}
          className="flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-500/10 active:scale-95 transition-all disabled:cursor-not-allowed touch-manipulation"
        >
          {deleting === source.source_name ? (
            <Loader2 size={15} className="animate-spin text-red-500" />
          ) : (
            <Trash2 size={15} />
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
  const [mode, setMode] = useState("text"); // "text" | "url" | "file" | "audio"
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
    isProcessing: speechProcessing,
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
    const audioExts = ["wav", "mp3", "m4a", "ogg", "flac", "aac"];
    const ext = f.name.split(".").pop().toLowerCase();
    if (audioExts.includes(ext) || f.type.startsWith("audio/")) {
      setFile(f);
      setMode("audio");
      return;
    }
    const allowed = ["application/pdf", "text/csv", "text/plain"];
    if (!allowed.includes(f.type) && !["pdf", "csv", "txt"].includes(ext)) {
      return showToast("error", "Unsupported format. Supported: PDF, CSV, TXT, WAV, MP3, M4A, OGG, FLAC");
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

  const tabBtn = (id, label, Icon) => {
    const isSelected = mode === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => setMode(id)}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-150 touch-manipulation min-h-[36px] ${
          isSelected
            ? "bg-brand-500 text-white shadow-sm shadow-brand-500/25"
            : "text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-white/10"
        }`}
      >
        <Icon size={14} />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`glass-panel p-4 sm:p-5 rounded-3xl flex flex-col gap-4 border border-slate-200/70 dark:border-white/10 shadow-sm transition-all duration-200 ${
        dragging ? "border-brand-400 ring-2 ring-brand-400/30 scale-[1.01]" : ""
      }`}
    >
      {/* Header and Mode Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-indigo-600 shadow-xs">
            <Plus size={16} className="text-white" />
          </div>
          <span className="font-semibold text-sm sm:text-base tracking-tight">{t("knowledge.addKnowledge")}</span>
        </div>

        {/* Scrollable mode tabs on mobile */}
        <div className="flex items-center gap-1 p-1 rounded-2xl bg-slate-100 dark:bg-white/5 overflow-x-auto no-scrollbar">
          {tabBtn("text", t("knowledge.modeText"), FileText)}
          {tabBtn("url", t("knowledge.modeUrl"), Globe)}
          {tabBtn("file", t("knowledge.modeFile"), UploadCloud)}
          {tabBtn("audio", "Audio / Voice", Mic)}
        </div>
      </div>

      {/* Input area */}
      {mode === "text" && (
        <div className="flex flex-col gap-2 relative z-20">
          <textarea
            id="kb-text-input"
            value={
              isRecording || speechProcessing
                ? (interimTranscript ? `${textInput ? textInput + " " : ""}${interimTranscript}` : textInput)
                : textInput
            }
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={t("knowledge.textPlaceholderVoice")}
            rows={4}
            disabled={isRecording || speechProcessing}
            className="w-full resize-none rounded-2xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/20 px-4 py-3 text-xs sm:text-sm outline-none focus:ring-2 focus:ring-brand-400/50 placeholder-slate-400 dark:placeholder-slate-600 transition disabled:opacity-70 leading-relaxed"
          />
          <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
            <VoiceLanguagePicker value={voiceLanguage.speechCode} onChange={setVoiceLanguage} />
            <button
              type="button"
              onClick={toggleRecording}
              disabled={!speechSupported || speechProcessing}
              aria-pressed={isRecording}
              aria-label={t("voice.toggleRecording")}
              title={speechSupported ? "Speak text with Gnani Prisma v3.0" : t("voice.notSupported")}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all shrink-0 touch-manipulation min-h-[38px] disabled:opacity-30 disabled:cursor-not-allowed ${
                isRecording
                  ? "bg-red-500 text-white animate-pulse shadow-md shadow-red-500/30"
                  : speechProcessing
                  ? "bg-amber-500 text-white"
                  : "bg-slate-900/5 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:text-brand-500"
              }`}
            >
              {speechProcessing ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Mic size={16} className={isRecording ? "animate-bounce" : ""} />
              )}
              <span>{isRecording ? "Listening..." : "Dictate"}</span>
            </button>
          </div>
          {speechError && (
            <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-3.5 py-2.5 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertCircle size={14} className="shrink-0" />
              <span>{speechError}</span>
            </div>
          )}
        </div>
      )}

      {mode === "url" && (
        <div className="relative">
          <Globe
            size={18}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            id="kb-url-input"
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder={t("knowledge.urlPlaceholder")}
            className="w-full rounded-2xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/20 pl-10 pr-4 py-3 text-xs sm:text-sm outline-none focus:ring-2 focus:ring-brand-400/50 placeholder-slate-400 dark:placeholder-slate-600 transition"
          />
        </div>
      )}

      {mode === "file" && (
        <div
          onClick={() => fileRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-4 py-8 sm:py-10 cursor-pointer transition-all duration-150 touch-manipulation ${
            file
              ? "border-brand-400 bg-brand-500/5"
              : "border-slate-200 dark:border-white/10 hover:border-brand-400/60 hover:bg-brand-500/5"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.csv,.txt,.wav,.mp3,.m4a,.ogg,.flac,.aac"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileDrop(f);
            }}
          />
          {file ? (
            <>
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-brand-500/10 text-brand-500">
                <FileText size={24} />
              </div>
              <div className="text-center">
                <p className="font-semibold text-xs sm:text-sm truncate max-w-xs">{file.name}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {(file.size / 1024).toFixed(0)} KB
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
                className="absolute top-3 right-3 flex items-center justify-center w-8 h-8 rounded-full bg-slate-200 dark:bg-white/10 text-slate-500 hover:bg-red-500/20 hover:text-red-500 transition-colors"
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-slate-100 dark:bg-white/5 text-slate-400">
                <UploadCloud size={24} />
              </div>
              <div className="text-center">
                <p className="font-semibold text-xs sm:text-sm">{t("knowledge.dropOrClick")}</p>
                <p className="text-xs text-slate-400 mt-1">{t("knowledge.supportedFormats")}</p>
              </div>
            </>
          )}
        </div>
      )}

      {mode === "audio" && (
        <div
          onClick={() => fileRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-4 py-8 sm:py-10 cursor-pointer transition-all duration-150 touch-manipulation ${
            file
              ? "border-brand-400 bg-brand-500/5"
              : "border-slate-200 dark:border-white/10 hover:border-brand-400/60 hover:bg-brand-500/5"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".wav,.mp3,.m4a,.ogg,.flac,.aac"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileDrop(f);
            }}
          />
          {file ? (
            <>
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-brand-500/10 text-brand-500">
                <Mic size={24} />
              </div>
              <div className="text-center">
                <p className="font-semibold text-xs sm:text-sm truncate max-w-xs">{file.name}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {(file.size / 1024).toFixed(0)} KB • Audio Recording
                </p>
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400 text-[11px] font-medium mt-2">
                  <Sparkles size={12} className="text-brand-500" />
                  <span>Gnani Prisma v3.0 Auto-LID & Code-Mix</span>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
                className="absolute top-3 right-3 flex items-center justify-center w-8 h-8 rounded-full bg-slate-200 dark:bg-white/10 text-slate-500 hover:bg-red-500/20 hover:text-red-500 transition-colors"
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-brand-500/10 text-brand-500">
                <Mic size={24} />
              </div>
              <div className="text-center">
                <p className="font-semibold text-xs sm:text-sm">Upload Voice Notes or Audio</p>
                <p className="text-xs text-slate-400 mt-1">WAV, MP3, M4A, OGG up to 10 MB</p>
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 text-[11px] font-medium mt-2">
                  <Sparkles size={12} className="text-brand-500" />
                  <span>Auto-transcribed with Gnani Prisma into RAG vectors</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Drag overlay hint */}
      {dragging && (
        <div className="absolute inset-0 rounded-3xl bg-brand-500/10 flex items-center justify-center pointer-events-none">
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
          className="w-full rounded-2xl border border-slate-200 dark:border-white/10 bg-white/70 dark:bg-black/20 px-4 py-3 text-xs sm:text-sm outline-none focus:ring-2 focus:ring-brand-400/50 placeholder-slate-400 dark:placeholder-slate-600 transition"
        />
      </div>

      {/* Submit Button */}
      <button
        id="kb-submit-btn"
        onClick={handleSubmit}
        disabled={loading}
        className="flex items-center justify-center gap-2 w-full rounded-2xl py-3 text-xs sm:text-sm font-semibold bg-gradient-to-r from-brand-500 to-indigo-600 text-white shadow-sm shadow-brand-500/25 hover:opacity-95 active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-not-allowed touch-manipulation min-h-[44px]"
      >
        {loading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Sparkles size={16} />
        )}
        <span>{loading ? t("knowledge.processing") : t("knowledge.submit")}</span>
      </button>

      {/* Toast */}
      {toast && (
        <div
          className={`flex items-start gap-2.5 rounded-2xl px-4 py-3 text-xs sm:text-sm border animate-fadeIn ${
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
  const [ingestSheetOpen, setIngestSheetOpen] = useState(false);
  const [ingestMode, setIngestMode] = useState("voice");
  const [searchQuery, setSearchQuery] = useState("");

  const {
    isSupported: voiceSearchSupported,
    isRecording: isVoiceSearching,
    isProcessing: isVoiceProcessing,
    interimTranscript: voiceSearchInterim,
    toggle: toggleVoiceSearch,
  } = useSpeechRecognition({
    onFinalTranscript: (text) => {
      setSearchQuery(text.trim());
    },
  });

  const handleOpenIngest = (mode = "voice") => {
    setIngestMode(mode);
    setIngestSheetOpen(true);
  };

  const fetchSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    getKnowledgeSources()
      .then(setSources)
      .catch((err) => setError(err.message || t("knowledge.loadFailed")))
      .finally(() => setLoading(false));
  }, [t]);

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

  const filteredSources = sources.filter((s) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      (s.source_name || "").toLowerCase().includes(q) ||
      (s.source_type || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex flex-col gap-5 max-w-4xl mx-auto pb-12 sm:pb-6">
      {/* ── Mobile-Native View (< sm) ── */}
      <div className="sm:hidden flex flex-col gap-4 pb-20">
        <MobileKnowledgeHeader
          totalSources={totalSources}
          onOpenIngest={handleOpenIngest}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          isVoiceSearching={isVoiceSearching}
          isVoiceProcessing={isVoiceProcessing}
          interimTranscript={voiceSearchInterim}
          toggleVoiceSearch={toggleVoiceSearch}
        />

        {/* Mobile Structured Pillars */}
        <BusinessPillarsGrid sources={sources} onPillarUpdated={fetchSources} />

        {/* Mobile Test Playground */}
        <KnowledgeTestPlayground />

        {error && (
          <div className="rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle size={15} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="glass-panel rounded-2xl p-8 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
            <Loader2 size={24} className="animate-spin text-brand-500" />
            <span>Loading knowledge base...</span>
          </div>
        ) : totalSources === 0 ? (
          <div className="glass-panel rounded-3xl p-6 text-center border border-dashed border-slate-300 dark:border-white/10 flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center">
              <Sparkles size={24} />
            </div>
            <div>
              <p className="font-bold text-sm text-slate-900 dark:text-white">No knowledge sources yet</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs">
                Dictate voice notes, upload documents, or link websites so agents can answer questions accurately.
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleOpenIngest("voice")}
              className="mt-1 px-4 py-2 rounded-xl bg-brand-500 text-white font-semibold text-xs shadow-md shadow-brand-500/25 active:scale-95 transition-all"
            >
              Dictate First Note
            </button>
          </div>
        ) : filteredSources.length === 0 ? (
          <div className="glass-panel rounded-2xl p-6 text-center text-xs text-slate-500 dark:text-slate-400">
            <p>No documents found matching "{searchQuery}"</p>
            <button
              onClick={() => setSearchQuery("")}
              className="mt-2 text-brand-500 font-semibold underline text-xs"
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filteredSources.map((source) => (
              <MobileSourceCard
                key={source.id || source.source_name}
                source={source}
                onDelete={handleDelete}
                deleting={deleting}
                onRename={handleRename}
                onView={setViewingSource}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Desktop View (>= sm) ── */}
      <div className="hidden sm:flex flex-col gap-5">
        {/* Page Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{t("knowledge.title")}</h1>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
                {totalSources}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed max-w-lg">
              {t("knowledge.subtitle")}
            </p>
          </div>
        </div>

        {/* Stats Strip */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <StatCard
            icon={Brain}
            label={t("knowledge.activeSources")}
            value={loading ? "—" : totalSources}
            accent="bg-gradient-to-br from-brand-500 to-indigo-600"
          />
          <StatCard
            icon={Zap}
            label={t("knowledge.cacheStatus")}
            value={totalSources > 0 ? t("knowledge.live") : t("knowledge.empty")}
            accent="bg-gradient-to-br from-indigo-500 to-purple-600"
          />
          <StatCard
            icon={Sparkles}
            label={t("knowledge.aiMode")}
            value={totalSources > 0 ? t("knowledge.contextAware") : t("knowledge.generic")}
            accent="bg-gradient-to-br from-amber-500 to-orange-500"
          />
        </div>

        {/* Feature 1: Structured Business Knowledge Pillars */}
        <section className="relative">
          <BusinessPillarsGrid sources={sources} onPillarUpdated={fetchSources} />
        </section>

        {/* Feature 3: Live "Test Your Business" Knowledge Playground */}
        <section className="relative">
          <KnowledgeTestPlayground />
        </section>

        {/* Explainer banner when empty */}
        {!loading && totalSources === 0 && (
          <div className="glass-panel p-4 sm:p-5 rounded-2xl flex items-start gap-3.5 border border-brand-400/20 shadow-xs">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500 to-indigo-600 text-white shrink-0 mt-0.5">
              <Sparkles size={18} />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-xs sm:text-sm">{t("knowledge.flyingBlindTitle")}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                {t("knowledge.flyingBlindDesc")}
              </p>
            </div>
          </div>
        )}

        {/* Omni-box (Add Custom Files, URLs or Text) */}
        <section className="relative">
          <OmniBox onSuccess={fetchSources} />
        </section>

        {/* Source List */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs sm:text-sm font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
              <ChevronRight size={15} className="text-brand-500" />
              <span>{t("knowledge.activeSources")}</span>
              {!loading && totalSources > 0 && (
                <span className="text-[11px] font-normal bg-brand-500/10 text-brand-500 px-2 py-0.2 rounded-full">
                  {totalSources}
                </span>
              )}
            </h2>
          </div>

          {error && (
            <div className="rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 flex items-center gap-2 text-xs sm:text-sm text-red-600 dark:text-red-400">
              <AlertCircle size={16} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="glass-panel rounded-2xl p-10 flex items-center justify-center gap-2 text-sm text-slate-400">
              <Loader2 size={18} className="animate-spin text-brand-500" />
              <span>{t("common.loading")}</span>
            </div>
          ) : totalSources === 0 ? (
            <div className="glass-panel rounded-2xl p-10 text-center text-xs sm:text-sm text-slate-500 dark:text-slate-400 border border-slate-200/70 dark:border-white/10">
              {t("knowledge.noSources")}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
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
      </div>

      {/* Slide-Up Mobile Ingest Sheet */}
      <MobileIngestSheet
        open={ingestSheetOpen}
        initialMode={ingestMode}
        onClose={() => setIngestSheetOpen(false)}
        onSuccess={fetchSources}
      />

      {/* Source Detail Modal (supports mobile slide-up sheet) */}
      {viewingSource && (
        <ViewSourceModal sourceName={viewingSource} onClose={() => setViewingSource(null)} />
      )}
    </div>
  );
}
