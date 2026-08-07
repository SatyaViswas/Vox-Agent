import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

export default function SlideOver({ open, onClose, title, children }) {
  const { t } = useTranslation();
  return (
    <div className={`fixed inset-0 z-50 transition-opacity ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`absolute top-0 right-0 h-full w-full sm:w-[420px] glass border-l border-slate-200/70 dark:border-white/10 transition-transform duration-200 flex flex-col ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between h-16 px-5 border-b border-slate-200/70 dark:border-white/10 shrink-0">
          <h2 className="font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-900/5 dark:hover:bg-white/5"
            aria-label={t("slideOver.closePanel")}
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
