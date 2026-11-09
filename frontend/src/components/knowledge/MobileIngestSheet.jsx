import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  Mic,
  Plus,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import { ingestKnowledge } from "../../api/knowledge";
import { translateText } from "../../api/translate";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";
import { useVoiceLanguage } from "../../hooks/useVoiceLanguage";
import { needsTranslation } from "../../lib/textLanguage";
import VoiceLanguagePicker from "../shared/VoiceLanguagePicker";

const URL_RE = /^https?:\/\/.+/i;
function isUrl(str) {
  return URL_RE.test((str || "").trim());
}

export default function MobileIngestSheet({ open, onClose, onSuccess, initialMode = "voice" }) {
  const { voiceLanguage, setVoiceLanguage } = useVoiceLanguage();
  const [mode, setMode] = useState(initialMode); // "voice" | "text" | "url" | "file"
  const [textInput, setTextInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (open && initialMode) {
      setMode(initialMode);
    }
  }, [open, initialMode]);

  const {
    isSupported: speechSupported,
    isRecording,
    isProcessing: speechProcessing,
    interimTranscript,
    error: speechError,
    toggle: toggleRecording,
    stop: stopRecording,
  } = useSpeechRecognition({
    lang: voiceLanguage.speechCode,
    onFinalTranscript: (finalText) => {
      setTextInput((prev) => (prev ? prev + " " + finalText : finalText).trim());
    },
  });

  if (!open) return null;

  const handleSubmit = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      if (mode === "voice" || mode === "text") {
        const cleanText = textInput.trim();
        if (!cleanText) {
          setErrorMsg("Please dictate or type text to add to the knowledge base.");
          setLoading(false);
          return;
        }
        const englishText = needsTranslation(cleanText, voiceLanguage.uiCode)
          ? await translateText(cleanText, "auto")
          : cleanText;
        await ingestKnowledge({ text: englishText, name: nameInput.trim() });
      } else if (mode === "url") {
        if (!isUrl(urlInput)) {
          setErrorMsg("Please enter a valid website URL starting with https://");
          setLoading(false);
          return;
        }
        await ingestKnowledge({ url: urlInput.trim(), name: nameInput.trim() });
      } else if (mode === "file") {
        if (!file) {
          setErrorMsg("Please choose a file to upload.");
          setLoading(false);
          return;
        }
        await ingestKnowledge({ file, name: nameInput.trim() });
      }

      setSuccessMsg("Document ingested and vectorized successfully!");
      setTextInput("");
      setUrlInput("");
      setNameInput("");
      setFile(null);
      onSuccess?.();
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err) {
      setErrorMsg(err.message || "Failed to ingest knowledge source.");
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end p-0 transition-all md:hidden animate-fade-in">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => {
          stopRecording();
          onClose();
        }}
      />

      {/* Sheet Container */}
      <div className="relative w-full rounded-t-[2rem] bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-white/10 p-5 text-slate-900 dark:text-white shadow-2xl z-10 flex flex-col max-h-[90vh] overflow-y-auto pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] animate-slide-up">
        {/* Pull handle */}
        <div className="w-12 h-1.5 rounded-full bg-slate-300 dark:bg-white/20 mx-auto mb-3 shrink-0" />

        {/* Sheet Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-brand-500" />
            <h3 className="font-bold text-base">Add Knowledge Source</h3>
          </div>
          <button
            onClick={() => {
              stopRecording();
              onClose();
            }}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Mode Selector Tabs */}
        <div className="flex items-center gap-1.5 p-1 rounded-2xl bg-slate-100 dark:bg-white/5 my-3 shrink-0 overflow-x-auto scrollbar-none">
          <button
            type="button"
            onClick={() => setMode("voice")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              mode === "voice"
                ? "bg-brand-500 text-white shadow-sm"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            <Mic size={14} />
            <span>Voice Dictation</span>
          </button>

          <button
            type="button"
            onClick={() => setMode("text")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              mode === "text"
                ? "bg-brand-500 text-white shadow-sm"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            <FileText size={14} />
            <span>Type Text</span>
          </button>

          <button
            type="button"
            onClick={() => setMode("url")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              mode === "url"
                ? "bg-brand-500 text-white shadow-sm"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            <Globe size={14} />
            <span>Web URL</span>
          </button>

          <button
            type="button"
            onClick={() => setMode("file")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              mode === "file"
                ? "bg-brand-500 text-white shadow-sm"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
            }`}
          >
            <UploadCloud size={14} />
            <span>Upload File</span>
          </button>
        </div>

        {/* Dynamic Mode Form */}
        <div className="my-2 space-y-3">
          {/* Voice Dictation Mode */}
          {mode === "voice" && (
            <div className="flex flex-col items-center justify-center py-4 bg-slate-50 dark:bg-white/5 rounded-2xl border border-slate-200/80 dark:border-white/5 p-4 text-center">
              {/* Radiating voice button */}
              <div className="relative flex items-center justify-center my-2">
                {isRecording && (
                  <div className="absolute w-28 h-28 rounded-full border border-brand-500/40 animate-wave-ring" />
                )}
                <button
                  type="button"
                  onClick={toggleRecording}
                  disabled={!speechSupported || speechProcessing}
                  className={`w-20 h-20 rounded-full flex items-center justify-center text-white shadow-lg transition-all active:scale-90 ${
                    isRecording
                      ? "bg-red-500 animate-pulse ring-4 ring-red-400/40"
                      : "bg-gradient-to-tr from-brand-600 to-fuchsia-600"
                  }`}
                >
                  {speechProcessing ? (
                    <Loader2 size={30} className="animate-spin" />
                  ) : (
                    <Mic size={32} className={isRecording ? "animate-bounce" : ""} />
                  )}
                </button>
              </div>

              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mt-2">
                {isRecording ? "Listening... Speak naturally" : "Tap orb to dictate knowledge note"}
              </p>

              <div className="w-full mt-3">
                <textarea
                  rows={3}
                  value={
                    isRecording && interimTranscript
                      ? `${textInput ? textInput + " " : ""}${interimTranscript}`
                      : textInput
                  }
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Dictated notes will stream here..."
                  className="w-full rounded-xl bg-white dark:bg-black/40 border border-slate-200 dark:border-white/10 p-3 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none resize-none shadow-xs"
                />
              </div>

              <div className="flex items-center justify-between w-full pt-1">
                <VoiceLanguagePicker value={voiceLanguage.speechCode} onChange={setVoiceLanguage} />
                <span className="text-[10px] text-brand-600 dark:text-brand-400 font-medium">Prisma v3.0 Auto-LID</span>
              </div>
            </div>
          )}

          {/* Type Text Mode */}
          {mode === "text" && (
            <div className="space-y-2">
              <textarea
                rows={5}
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Paste company policy, customer FAQ, product specs, or SOP..."
                className="w-full rounded-2xl bg-white dark:bg-black/40 border border-slate-200 dark:border-white/10 p-3.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none resize-none leading-relaxed shadow-xs"
              />
              <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                <span>{textInput.length} characters</span>
                <VoiceLanguagePicker value={voiceLanguage.speechCode} onChange={setVoiceLanguage} />
              </div>
            </div>
          )}

          {/* Web URL Mode */}
          {mode === "url" && (
            <div className="space-y-2">
              <div className="relative flex items-center">
                <Globe size={16} className="absolute left-3.5 text-slate-400" />
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://example.com/api-docs"
                  className="w-full rounded-2xl bg-white dark:bg-black/40 border border-slate-200 dark:border-white/10 pl-10 pr-4 py-3 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none focus:border-brand-500 shadow-xs"
                />
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 px-1">
                VoxAgent will crawl and vectorize text from this webpage for agent retrieval.
              </p>
            </div>
          )}

          {/* Upload File Mode */}
          {mode === "file" && (
            <div
              onClick={() => fileRef.current?.click()}
              className="flex flex-col items-center justify-center p-6 rounded-2xl border-2 border-dashed border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-white/5 cursor-pointer active:scale-[0.99] transition-all text-center"
            >
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.csv,.txt,.wav,.mp3,.m4a"
                className="sr-only"
                onChange={handleFileChange}
              />
              {file ? (
                <>
                  <FileText size={28} className="text-brand-500 mb-1.5" />
                  <p className="font-semibold text-xs text-slate-900 dark:text-white truncate max-w-xs">{file.name}</p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">{(file.size / 1024).toFixed(0)} KB</p>
                </>
              ) : (
                <>
                  <UploadCloud size={30} className="text-slate-400 mb-2" />
                  <p className="font-semibold text-xs text-slate-800 dark:text-slate-200">Tap to select PDF, CSV, TXT, or Audio</p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Up to 10 MB per file</p>
                </>
              )}
            </div>
          )}

          {/* Optional Name Tag */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
              Source Name (Optional)
            </label>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="e.g. Q4 Sales Playbook"
              className="w-full rounded-xl bg-white dark:bg-black/30 border border-slate-200 dark:border-white/10 px-3.5 py-2.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 outline-none focus:border-brand-500 shadow-xs"
            />
          </div>

          {/* Error / Success Toast */}
          {errorMsg && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 text-xs font-medium">
              <AlertCircle size={15} className="shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
          {successMsg && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-medium">
              <CheckCircle2 size={15} className="shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Save Button */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-gradient-to-r from-brand-500 to-indigo-600 hover:from-brand-600 hover:to-indigo-700 disabled:opacity-50 text-white font-bold text-xs shadow-md shadow-brand-500/25 active:scale-[0.98] transition-all touch-manipulation mt-2"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Vectorizing & Ingesting...</span>
              </>
            ) : (
              <>
                <Plus size={16} />
                <span>Save to Knowledge Base</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
