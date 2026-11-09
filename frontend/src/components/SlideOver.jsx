import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

export default function SlideOver({ open, onClose, title, children }) {
  const { t } = useTranslation();
  return (
    <div
      className={`fixed inset-0 z-50 transition-opacity duration-200 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-xs" onClick={onClose} />
      <div
        className={`absolute top-0 right-0 h-full w-full sm:w-[460px] glass-panel border-l border-slate-200/70 dark:border-white/10 transition-transform duration-300 ease-out flex flex-col shadow-2xl ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between h-16 px-5 border-b border-slate-200/70 dark:border-white/10 shrink-0 pt-[env(safe-area-inset-top,0px)]">
          <h2 className="font-semibold text-base sm:text-lg tracking-tight">{title}</h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-10 h-10 rounded-xl text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-900/5 dark:hover:bg-white/5 active:scale-95 transition-all touch-manipulation"
            aria-label={t("slideOver.closePanel")}
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 pb-[calc(env(safe-area-inset-bottom,0px)+5.5rem)]">
          {children}
        </div>
      </div>
    </div>
  );
}
