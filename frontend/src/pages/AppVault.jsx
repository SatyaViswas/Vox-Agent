import { useState } from "react";
import { Globe, Link2, Zap } from "lucide-react";
import ApiAppsTab from "../components/vault/ApiAppsTab";
import WebSessionsTab from "../components/vault/WebSessionsTab";
import WebhooksTab from "../components/vault/WebhooksTab";

const TABS = [
  { id: "apps", label: "API Apps", icon: Zap },
  { id: "sessions", label: "Web Sessions & Portals", icon: Globe },
  { id: "webhooks", label: "Custom Webhooks", icon: Link2 },
];

export default function AppVault() {
  const [activeTab, setActiveTab] = useState("apps");

  return (
    <div className="flex flex-col gap-5 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">App Vault</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Connect the apps, sessions, and APIs VoxAgent can act on.
        </p>
      </div>

      <div className="inline-flex glass-panel p-1 gap-1 w-fit overflow-x-auto scrollbar-none">
        {TABS.map(({ id, label, icon: Icon }) => (
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
            {label}
          </button>
        ))}
      </div>

      {activeTab === "apps" && <ApiAppsTab />}
      {activeTab === "sessions" && <WebSessionsTab />}
      {activeTab === "webhooks" && <WebhooksTab />}
    </div>
  );
}
