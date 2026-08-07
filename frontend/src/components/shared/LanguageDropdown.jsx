import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { INDIAN_LANGUAGES, INTERNATIONAL_LANGUAGES, LANGUAGES } from "../../i18n/languages";

// Shared grouped language picker — used both for the voice-mode speech
// picker (keyed by BCP-47 speechCode) and the site-language settings picker
// (keyed by i18next uiCode). `getCode` selects which field identifies the
// active/selected language.
export default function LanguageDropdown({
  value,
  onChange,
  getCode = (lang) => lang.uiCode,
  trigger,
  align = "right",
  className = "",
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const english = LANGUAGES.find((l) => l.uiCode === "en");

  const renderOption = (lang) => {
    const code = getCode(lang);
    const active = code === value;
    return (
      <button
        key={code}
        type="button"
        onClick={() => {
          onChange(code);
          setOpen(false);
        }}
        className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
          active
            ? "bg-brand-500/10 text-brand-600 dark:text-brand-300"
            : "text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
        }`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">{lang.nativeLabel}</span>
          {lang.nativeLabel !== lang.label && (
            <span className="text-xs text-slate-400 dark:text-slate-500 truncate">({lang.label})</span>
          )}
        </span>
        {active && <Check size={14} className="shrink-0" />}
      </button>
    );
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5 transition-colors"
      >
        {trigger}
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className={`absolute z-50 mt-2 w-64 max-h-80 overflow-y-auto glass-panel p-2 shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Default</div>
          {renderOption(english)}

          <div className="px-2 py-1 mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Indian Languages
          </div>
          {INDIAN_LANGUAGES.map(renderOption)}

          <div className="px-2 py-1 mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            International
          </div>
          {INTERNATIONAL_LANGUAGES.map(renderOption)}
        </div>
      )}
    </div>
  );
}
