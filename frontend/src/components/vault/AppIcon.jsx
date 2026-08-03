import { useState } from "react";

export default function AppIcon({ app, className = "w-10 h-10" }) {
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
        alt={`${app.name} logo`}
        onError={() => setFailed(true)}
        className="w-full h-full object-contain"
      />
    </div>
  );
}
