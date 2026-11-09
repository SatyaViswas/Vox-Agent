import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Tag,
  ShieldCheck,
  MessageSquare,
  CheckCircle2,
  Clock,
  Pencil,
  Plus,
  Mic,
  Loader2,
  Save,
  X,
  Sparkles,
  AlertCircle,
} from "lucide-react";
import { saveBusinessPillar, getKnowledgeSourceContent } from "../../api/knowledge";
import { useSpeechRecognition } from "../../hooks/useSpeechRecognition";
import { useVoiceLanguage } from "../../hooks/useVoiceLanguage";
import VoiceLanguagePicker from "../shared/VoiceLanguagePicker";

export const BUSINESS_PILLARS = [
  {
    key: "profile",
    title: "Business Profile & Hours",
    icon: Building2,
    gradient: "from-blue-500 to-indigo-600",
    badgeBg: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    description: "Business name, contact details, operating hours, and brand tone.",
    defaultTemplate: `Business Name: My Business
Industry: Services / Retail
Contact Email: support@mybusiness.com
Phone / WhatsApp: +1 (555) 123-4567
Operating Hours: Monday to Friday 9:00 AM - 6:00 PM, Saturday 10:00 AM - 2:00 PM, Sunday Closed.
Location / Service Area: Citywide / Online
Brand Voice: Warm, professional, concise, and helpful.`,
  },
  {
    key: "pricing",
    title: "Services, Products & Pricing",
    icon: Tag,
    gradient: "from-emerald-500 to-teal-600",
    badgeBg: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    description: "Core offerings, prices, packages, and deliverables.",
    defaultTemplate: `Core Offerings & Pricing:
- Standard Consultation / Service: $100 (Includes intake assessment and roadmap)
- Premium Service / Comprehensive Care: $250
- Follow-up Session: $50
- Discounts: 10% discount on packages paid upfront.
- Payment Methods: Credit/Debit card, Bank Transfer, Stripe, UPI.`,
  },
  {
    key: "policies",
    title: "Policies & Refund Rules",
    icon: ShieldCheck,
    gradient: "from-amber-500 to-orange-600",
    badgeBg: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    description: "Refund terms, cancellation rules, rescheduling notice, and SLA.",
    defaultTemplate: `Refund Policy:
- Full refunds are eligible within 7 days of purchase with original receipt.
- Completed consultations and digital downloads are non-refundable.

Cancellation & Rescheduling:
- Cancellations or changes must be made with at least 24 hours prior notice.
- Cancellations made under 24 hours may incur a 25% rebooking fee.

Delivery & Response SLA:
- Customer inquiries are answered within 2 business hours.
- Orders/deliverables are fulfilled within 24 to 48 business hours.`,
  },
  {
    key: "faq",
    title: "Customer FAQs & Templates",
    icon: MessageSquare,
    gradient: "from-purple-500 to-violet-600",
    badgeBg: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
    description: "Common customer questions and approved message templates.",
    defaultTemplate: `Q: How do I book an appointment or order?
A: You can reply with your preferred date/time or visit our online booking link.

Q: Do you offer weekend or emergency support?
A: We are open Saturday 10 AM to 2 PM. Sunday inquiries are answered first thing Monday morning.

Customer Reply Template:
"Hi {name}, thanks for reaching out to {business_name}! Regarding your inquiry..."`,
  },
];

function PillarModal({ pillar, currentContent, onClose, onSuccess }) {
  const { t } = useTranslation();
  const { voiceLanguage, setVoiceLanguage } = useVoiceLanguage();
  const [content, setContent] = useState(currentContent || pillar.defaultTemplate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const {
    isSupported: speechSupported,
    isRecording,
    isProcessing: speechProcessing,
    interimTranscript,
    error: speechError,
    toggle: toggleRecording,
  } = useSpeechRecognition({
    lang: voiceLanguage.speechCode,
    onFinalTranscript: (text) => {
      setContent((prev) => (prev ? prev + "\n" + text : text).trim());
    },
  });

  const handleSave = async () => {
    if (!content.trim()) return setError("Content cannot be empty.");
    try {
      setSaving(true);
      setError(null);
      await saveBusinessPillar({
        pillar_key: pillar.key,
        title: pillar.title,
        content: content.trim(),
      });
      onSuccess();
      onClose();
    } catch (err) {
      setError(err.message || "Failed to save pillar.");
    } finally {
      setSaving(false);
    }
  };

  const Icon = pillar.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" onClick={onClose} />
      <div className="relative glass-panel w-full max-w-4xl h-[92vh] sm:h-[88vh] rounded-3xl flex flex-col overflow-hidden shadow-2xl border border-slate-200/80 dark:border-white/15 bg-white dark:bg-slate-900">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200/70 dark:border-white/10 shrink-0 bg-slate-50/60 dark:bg-black/20">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-2xl bg-gradient-to-br ${pillar.gradient} flex items-center justify-center text-white shadow-xs`}>
              <Icon size={20} />
            </div>
            <div>
              <h3 className="font-bold text-sm sm:text-base text-slate-900 dark:text-white">{pillar.title}</h3>
              <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">{pillar.description}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-8 h-8 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5 transition-all"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="px-5 py-2.5 bg-red-500/10 border-b border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-center gap-2 shrink-0">
            <AlertCircle size={14} /> <span>{error}</span>
          </div>
        )}

        {/* Text Area */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 flex flex-col gap-3 bg-slate-50/40 dark:bg-black/20">
          <div className="flex items-center justify-between gap-2 flex-wrap pb-1 shrink-0">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-brand-500" />
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Pillar Details (Edit or Dictate with Voice)
              </span>
              <span className="text-[11px] text-slate-400 dark:text-slate-500 hidden sm:inline">
                • {content ? content.split("\n").length : 0} lines
              </span>
            </div>
            <div className="flex items-center gap-2">
              <VoiceLanguagePicker value={voiceLanguage.speechCode} onChange={setVoiceLanguage} />
              <button
                type="button"
                onClick={toggleRecording}
                disabled={!speechSupported || speechProcessing}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all touch-manipulation min-h-[34px] ${
                  isRecording
                    ? "bg-red-500 text-white animate-pulse"
                    : speechProcessing
                    ? "bg-amber-500 text-white"
                    : "bg-slate-100 dark:bg-white/10 text-slate-700 dark:text-slate-200 hover:bg-brand-500 hover:text-white"
                }`}
              >
                {speechProcessing ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
                <span>{isRecording ? "Listening..." : "Dictate"}</span>
              </button>
            </div>
          </div>

          <textarea
            value={
              isRecording || speechProcessing
                ? (interimTranscript ? `${content}\n${interimTranscript}` : content)
                : content
            }
            onChange={(e) => setContent(e.target.value)}
            placeholder="Type or dictate your business details..."
            className="w-full flex-1 min-h-[380px] rounded-2xl border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-950/70 p-4 sm:p-5 font-mono text-xs sm:text-sm leading-relaxed outline-none focus:ring-2 focus:ring-brand-500/40 shadow-inner resize-none text-slate-900 dark:text-slate-100"
          />

          {speechError && (
            <p className="text-xs text-amber-600 dark:text-amber-400 shrink-0">{speechError}</p>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200/70 dark:border-white/10 shrink-0 bg-slate-50/50 dark:bg-black/20">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-xs sm:text-sm font-semibold bg-brand-500 hover:bg-brand-600 text-white shadow-sm shadow-brand-500/25 active:scale-95 transition-all disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            <span>Save Pillar</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BusinessPillarsGrid({ sources = [], onPillarUpdated }) {
  const [activeModalPillar, setActiveModalPillar] = useState(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [pillarContent, setPillarContent] = useState("");

  const handleOpenPillar = async (pillar) => {
    setActiveModalPillar(pillar);
    // Find matching source by title
    const existing = sources.find(
      (s) => s.source_name === pillar.title || s.source_type === `pillar_${pillar.key}`
    );
    if (existing) {
      setLoadingContent(true);
      try {
        const res = await getKnowledgeSourceContent(existing.source_name);
        setPillarContent(res.content || "");
      } catch (err) {
        setPillarContent(pillar.defaultTemplate);
      } finally {
        setLoadingContent(false);
      }
    } else {
      setPillarContent(pillar.defaultTemplate);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm sm:text-base font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
            <Building2 size={18} className="text-brand-500" />
            <span>Structured Business Knowledge Pillars</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Your agent uses these core business pillars to accurately draft replies, enforce policies, and quote pricing.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {BUSINESS_PILLARS.map((pillar) => {
          const Icon = pillar.icon;
          const configuredSource = sources.find(
            (s) => s.source_name === pillar.title || s.source_type === `pillar_${pillar.key}`
          );
          const isConfigured = Boolean(configuredSource);

          return (
            <div
              key={pillar.key}
              onClick={() => handleOpenPillar(pillar)}
              className="glass-panel p-4 rounded-3xl border border-slate-200/80 dark:border-white/10 hover:border-brand-500/40 hover:shadow-md transition-all duration-200 cursor-pointer flex flex-col justify-between group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-2xl bg-gradient-to-br ${pillar.gradient} flex items-center justify-center text-white shadow-xs shrink-0 group-hover:scale-105 transition-transform`}>
                    <Icon size={19} />
                  </div>
                  <div>
                    <h3 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white group-hover:text-brand-500 transition-colors">
                      {pillar.title}
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">
                      {pillar.description}
                    </p>
                  </div>
                </div>

                <span
                  className={`text-[10px] font-semibold px-2.5 py-0.5 rounded-full shrink-0 flex items-center gap-1 ${
                    isConfigured
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {isConfigured ? (
                    <>
                      <CheckCircle2 size={11} /> <span>Active</span>
                    </>
                  ) : (
                    <span>Setup</span>
                  )}
                </span>
              </div>

              <div className="flex items-center justify-between mt-3.5 pt-3 border-t border-slate-100 dark:border-white/5 text-xs">
                <span className="text-[11px] text-slate-400 flex items-center gap-1">
                  <Clock size={12} />
                  {isConfigured ? "Live in memory" : "Not configured yet"}
                </span>

                <button
                  type="button"
                  className="flex items-center gap-1 text-[11px] font-semibold text-brand-600 dark:text-brand-400 group-hover:underline"
                >
                  {isConfigured ? <Pencil size={12} /> : <Plus size={12} />}
                  <span>{isConfigured ? "Edit Pillar" : "Quick Setup"}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {activeModalPillar && (
        <PillarModal
          pillar={activeModalPillar}
          currentContent={pillarContent}
          onClose={() => setActiveModalPillar(null)}
          onSuccess={() => {
            if (onPillarUpdated) onPillarUpdated();
          }}
        />
      )}
    </div>
  );
}

