import { useState } from "react";
import { useTranslation } from "react-i18next";

export default function AppIcon({ app, className = "w-10 h-10" }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const iconUrl = app.logo || `https://logos.composio.dev/api/${app.slug}`;

  if (failed || !iconUrl) {
    return (
      <div
        className={`flex items-center justify-center ${className} rounded-xl bg-brand-500/10 text-brand-500 font-semibold`}
      >
        {app.name[0]}
      </div>
    );
  }

  return (
    <div className={`flex items-center justify-center ${className} rounded-xl bg-white p-1.5 border border-slate-200/70 dark:border-white/10`}>
      <img
        src={iconUrl}
        alt={t("vault.appIcon.logoAlt", { name: app.name })}
        onError={() => setFailed(true)}
        className="w-full h-full object-contain"
      />
    </div>
  );
}
