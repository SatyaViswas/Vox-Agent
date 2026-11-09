import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sparkles,
  HelpCircle,
  Mic,
  Send,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Volume2,
  ArrowRight,
  BookOpen,
} from "lucide-react";
import { testKnowledgeQuery } from "../../api/knowledge";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";
import { useVoiceLanguage } from "../../hooks/useVoiceLanguage";
import VoiceLanguagePicker from "../shared/VoiceLanguagePicker";

const SAMPLE_QUESTIONS = [
  "Can a customer get a refund after 10 days?",
  "What are our weekend opening hours?",
  "How much do we charge for standard consultation?",
  "What is our appointment cancellation policy?",
];

export default function KnowledgeTestPlayground({ onNavigateToPillar }) {
  const { t } = useTranslation();
  const { voiceLanguage, setVoiceLanguage } = useVoiceLanguage();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [showSnippets, setShowSnippets] = useState(false);
  const [error, setError] = useState(null);

  const {
    isSupported: speechSupported,
    isRecording,
    isProcessing: speechProcessing,
    interimTranscript,
    toggle: toggleRecording,
  } = useSpeechRecognition({
    lang: voiceLanguage.speechCode,
    onFinalTranscript: (text) => {
      setQuery(text.trim());
      handleRunQuery(text.trim());
    },
  });

  const handleRunQuery = async (queryToRun) => {
    const q = (queryToRun || query).trim();
    if (!q) return;

    try {
      setLoading(true);
      setError(null);
      const res = await testKnowledgeQuery({
        query: q,
        language: voiceLanguage.uiCode || "en",
      });
      setResult(res);
      setShowSnippets(false);
    } catch (err) {
      setError(err.message || "Failed to test query.");
    } finally {
      setLoading(false);
    }
  };

  const speakAnswer = (text) => {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (voiceLanguage?.speechCode) {
      utterance.lang = voiceLanguage.speechCode;
    }
    window.speechSynthesis.speak(utterance);
  };

  return (
    <div className="glass-panel p-4 sm:p-5 rounded-3xl border border-slate-200/80 dark:border-white/10 shadow-sm flex flex-col gap-4 bg-gradient-to-br from-white/90 via-slate-50/70 to-indigo-50/20 dark:from-slate-900/90 dark:via-slate-900/70 dark:to-indigo-950/20">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-xs shrink-0">
            <Sparkles size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm sm:text-base text-slate-900 dark:text-white">
                Live Knowledge Playground
              </h3>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                Instant Verification
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Ask any customer question to verify how your AI agent will reply using your business rules.
            </p>
          </div>
        </div>

        <VoiceLanguagePicker value={voiceLanguage.speechCode} onChange={setVoiceLanguage} />
      </div>

      {/* Sample Query Chips */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
        <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 shrink-0 mr-1 flex items-center gap-1">
          <HelpCircle size={12} /> Try:
        </span>
        {SAMPLE_QUESTIONS.map((sample, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => {
              setQuery(sample);
              handleRunQuery(sample);
            }}
            className="text-[11px] font-medium px-2.5 py-1 rounded-xl bg-white/70 dark:bg-white/5 border border-slate-200/70 dark:border-white/10 text-slate-700 dark:text-slate-300 hover:border-brand-500/50 hover:text-brand-600 dark:hover:text-brand-400 transition-all shrink-0 active:scale-95 touch-manipulation"
          >
            "{sample}"
          </button>
        ))}
      </div>

      {/* Input Box */}
      <div className="flex items-center gap-2 bg-white/80 dark:bg-black/30 border border-slate-200 dark:border-white/10 rounded-2xl p-1.5 focus-within:ring-2 focus-within:ring-brand-500/40 transition-all">
        <input
          type="text"
          value={
            isRecording || speechProcessing
              ? (interimTranscript ? `${query} ${interimTranscript}` : query)
              : query
          }
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleRunQuery()}
          placeholder="Ask a question (e.g. Can a customer return an item after 10 days?)"
          className="flex-1 bg-transparent px-3 py-2 text-xs sm:text-sm outline-none placeholder-slate-400 dark:placeholder-slate-500"
        />

        <button
          type="button"
          onClick={toggleRecording}
          disabled={!speechSupported || speechProcessing}
          aria-label="Dictate test question"
          className={`flex items-center justify-center w-9 h-9 rounded-xl transition-all shrink-0 ${
            isRecording
              ? "bg-red-500 text-white animate-pulse"
              : speechProcessing
              ? "bg-amber-500 text-white"
              : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 hover:text-brand-500"
          }`}
        >
          {speechProcessing ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
        </button>

        <button
          type="button"
          onClick={() => handleRunQuery()}
          disabled={loading || !query.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-500 hover:bg-brand-600 text-white font-semibold text-xs sm:text-sm shadow-xs transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0 active:scale-95"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          <span>Ask AI</span>
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-xl">
          {error}
        </div>
      )}

      {/* Result Display */}
      {result && (
        <div className="glass-panel p-4 rounded-2xl border border-slate-200/90 dark:border-white/15 flex flex-col gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span
              className={`text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1.5 ${
                result.grounded
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
              }`}
            >
              {result.grounded ? (
                <>
                  <CheckCircle2 size={13} />
                  <span>
                    Grounded in: {result.sources?.join(", ") || "Business Knowledge"}
                  </span>
                  {result.confidence > 0 && (
                    <span className="text-[10px] font-normal opacity-80">
                      ({Math.round(result.confidence * 100)}% match)
                    </span>
                  )}
                </>
              ) : (
                <>
                  <AlertTriangle size={13} />
                  <span>No Specific Policy Found</span>
                </>
              )}
            </span>

            <button
              type="button"
              onClick={() => speakAnswer(result.answer)}
              className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-brand-500 transition-colors"
            >
              <Volume2 size={14} /> <span>Listen</span>
            </button>
          </div>

          <div className="text-xs sm:text-sm text-slate-800 dark:text-slate-200 leading-relaxed font-sans bg-white/50 dark:bg-black/20 p-3 rounded-xl border border-slate-100 dark:border-white/5">
            {result.answer}
          </div>

          {/* Collapsible raw snippets */}
          {result.snippets && result.snippets.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setShowSnippets(!showSnippets)}
                className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:text-brand-500 transition-colors"
              >
                <BookOpen size={12} />
                <span>
                  {showSnippets ? "Hide retrieved knowledge snippets" : `View ${result.snippets.length} retrieved knowledge snippets`}
                </span>
                {showSnippets ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>

              {showSnippets && (
                <div className="mt-2 flex flex-col gap-1.5 animate-in fade-in duration-150">
                  {result.snippets.map((snip, sIdx) => (
                    <div
                      key={sIdx}
                      className="text-[11px] font-mono text-slate-600 dark:text-slate-300 bg-slate-100/70 dark:bg-white/5 p-2.5 rounded-xl border border-slate-200/50 dark:border-white/5 whitespace-pre-wrap"
                    >
                      {snip}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

