import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Link2, Zap } from "lucide-react";
import ApiAppsTab from "../components/vault/ApiAppsTab";
import WebSessionsTab from "../components/vault/WebSessionsTab";
import WebhooksTab from "../components/vault/WebhooksTab";

const TABS = [
  { id: "apps", labelKey: "vault.apiApps", icon: Zap, label: "500+ SaaS Apps" },
  { id: "sessions", labelKey: "vault.webSessions", icon: Globe, label: "Web Sessions" },
  { id: "webhooks", labelKey: "vault.customWebhooks", icon: Link2, label: "Webhooks" },
];

export default function AppVault() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState("apps");

  return (
    <div className="flex flex-col gap-3.5 sm:gap-5 max-w-6xl mx-auto pb-16 sm:pb-6 animate-fade-in">
      {/* 1. App Bar Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              {t("vault.title")}
            </h1>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400 border border-brand-500/20">
              500+ Integrations
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Connect your SaaS APIs, browser cookies, and webhooks for autonomous AI execution.
          </p>
        </div>
      </div>

      {/* 2. Horizontally Swipeable Native Segmented Pill Tabs */}
      <div className="flex w-full sm:w-fit glass-panel p-1 gap-1 overflow-x-auto scrollbar-none rounded-2xl shrink-0">
        {TABS.map(({ id, labelKey, icon: Icon, label }) => {
          const isSelected = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs sm:text-sm font-bold whitespace-nowrap transition-all touch-manipulation min-h-[42px] active:scale-95 ${
                isSelected
                  ? "bg-brand-500 text-white shadow-sm shadow-brand-500/25"
                  : "text-slate-600 dark:text-slate-300 hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              <Icon size={15} className={`shrink-0 ${isSelected ? "text-white" : "text-brand-500"}`} />
              <span>{t(labelKey) || label}</span>
            </button>
          );
        })}
      </div>

      {/* 3. Tab Contents */}
      <div className="pt-1">
        {activeTab === "apps" && <ApiAppsTab />}
        {activeTab === "sessions" && <WebSessionsTab />}
        {activeTab === "webhooks" && <WebhooksTab />}
      </div>
    </div>
  );
}
