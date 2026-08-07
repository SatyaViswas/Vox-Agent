import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Link2, Zap } from "lucide-react";
import ApiAppsTab from "../components/vault/ApiAppsTab";
import WebSessionsTab from "../components/vault/WebSessionsTab";
import WebhooksTab from "../components/vault/WebhooksTab";

const TABS = [
  { id: "apps", labelKey: "vault.apiApps", icon: Zap },
  { id: "sessions", labelKey: "vault.webSessions", icon: Globe },
  { id: "webhooks", labelKey: "vault.customWebhooks", icon: Link2 },
];

export default function AppVault() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState("apps");

  return (
    <div className="flex flex-col gap-5 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("vault.title")}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {t("vault.subtitle")}
        </p>
      </div>

      <div className="inline-flex glass-panel p-1 gap-1 w-fit overflow-x-auto scrollbar-none">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === id
                ? "bg-brand-500 text-white"
                : "text-slate-600 dark:text-slate-300 hover:bg-slate-900/5 dark:hover:bg-white/5"
            }`}
          >
            <Icon size={15} />
            {t(labelKey)}
          </button>
        ))}
      </div>

      {activeTab === "apps" && <ApiAppsTab />}
      {activeTab === "sessions" && <WebSessionsTab />}
      {activeTab === "webhooks" && <WebhooksTab />}
    </div>
  );
}
