import { useState } from "react";
import {
  ChevronRight,
  Edit3,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  Mic,
  Trash2,
  Building2,
  Tag,
  ShieldCheck,
  MessageSquare,
} from "lucide-react";

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

function getSourceMeta(source) {
  const isAudio = isAudioSource(source);
  if (isAudio) {
    return {
      icon: Mic,
      label: "Voice Audio",
      color: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 ring-2 ring-fuchsia-500/25",
      badge: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-300 border-fuchsia-500/20",
    };
  }
  const name = typeof source === "object" ? source?.source_name : "";
  const type = typeof source === "object" ? source?.source_type : source;
  if (name === "Business Profile & Hours" || type === "pillar_profile") {
    return {
      icon: Building2,
      label: "Profile Pillar",
      color: "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-2 ring-blue-500/25",
      badge: "bg-blue-500/10 text-blue-600 dark:text-blue-300 border-blue-500/20",
    };
  }
  if (name === "Services, Products & Pricing" || type === "pillar_pricing") {
    return {
      icon: Tag,
      label: "Pricing Pillar",
      color: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-2 ring-emerald-500/25",
      badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/20",
    };
  }
  if (name === "Policies & Refund Rules" || type === "pillar_policies") {
    return {
      icon: ShieldCheck,
      label: "Policy Pillar",
      color: "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-2 ring-amber-500/25",
      badge: "bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/20",
    };
  }
  if (name === "Customer FAQs & Templates" || type === "pillar_faq") {
    return {
      icon: MessageSquare,
      label: "FAQ Pillar",
      color: "bg-purple-500/15 text-purple-600 dark:text-purple-400 ring-2 ring-purple-500/25",
      badge: "bg-purple-500/10 text-purple-600 dark:text-purple-300 border-purple-500/20",
    };
  }
  if (type === "url") {
    return {
      icon: Globe,
      label: "Website",
      color: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 ring-2 ring-cyan-500/25",
      badge: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-300 border-cyan-500/20",
    };
  }
  if (type === "file") {
    return {
      icon: FileSpreadsheet,
      label: "Document",
      color: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-2 ring-emerald-500/25",
      badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/20",
    };
  }
  return {
    icon: FileText,
    label: "Plain Text",
    color: "bg-brand-500/15 text-brand-600 dark:text-brand-400 ring-2 ring-brand-500/25",
    badge: "bg-brand-500/10 text-brand-600 dark:text-brand-300 border-brand-500/20",
  };
}

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function MobileSourceCard({
  source,
  onDelete,
  deleting,
  onRename,
  onView,
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [editName, setEditName] = useState(source.source_name);

  const meta = getSourceMeta(source);
  const Icon = meta.icon;

  const handleRenameSubmit = () => {
    if (editName.trim() && editName.trim() !== source.source_name) {
      onRename(source.source_name, editName.trim());
    }
    setIsRenaming(false);
  };

  return (
    <div
      onClick={() => {
        if (!isRenaming) onView(source.source_name);
      }}
      className="glass-panel rounded-2xl p-3.5 border border-slate-200/80 dark:border-white/10 shadow-sm flex items-center justify-between gap-3 transition-all active:scale-[0.99] touch-manipulation cursor-pointer group"
    >
      {/* 1. Left Avatar Icon */}
      <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${meta.color}`}>
        <Icon size={18} />
      </div>

      {/* 2. Center Content */}
      <div className="flex-1 min-w-0">
        {isRenaming ? (
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleRenameSubmit()}
              onBlur={handleRenameSubmit}
              className="text-xs font-semibold bg-white dark:bg-black/40 border border-brand-500 rounded-lg px-2.5 py-1 outline-none w-full"
            />
          </div>
        ) : (
          <h4 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white truncate leading-snug">
            {source.source_name}
          </h4>
        )}

        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${meta.badge}`}>
            {meta.label}
          </span>
          {source.created_at && (
            <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium truncate">
              {formatDate(source.created_at)}
            </span>
          )}
        </div>
      </div>

      {/* 3. Action Buttons */}
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setIsRenaming(true)}
          className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:text-brand-500 hover:bg-black/5 dark:hover:bg-white/5 active:scale-90 transition-all"
          aria-label="Rename document"
        >
          <Edit3 size={15} />
        </button>

        <button
          type="button"
          onClick={() => onDelete(source.source_name)}
          disabled={deleting === source.source_name}
          className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 active:scale-90 transition-all disabled:opacity-50"
          aria-label="Delete document"
        >
          {deleting === source.source_name ? (
            <Loader2 size={15} className="animate-spin text-red-500" />
          ) : (
            <Trash2 size={15} />
          )}
        </button>

        <ChevronRight size={16} className="text-slate-400 group-hover:text-brand-500 transition-colors ml-0.5" />
      </div>
    </div>
  );
}

