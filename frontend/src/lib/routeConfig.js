import { Globe, Plug, Webhook, GitBranch, Sparkles, Send, Rocket } from "lucide-react";

export const ROUTE_CONFIG = {
  browser_agent: {
    label: "Browser Agent",
    icon: Globe,
    classes: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 border-fuchsia-500/30",
    dot: "bg-fuchsia-500",
  },
  composio_api: {
    label: "Composio API",
    icon: Plug,
    classes: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
    dot: "bg-blue-500",
  },
  http_webhook: {
    label: "HTTP Webhook",
    icon: Webhook,
    classes: "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/30",
    dot: "bg-teal-500",
  },
  git_client: {
    label: "Local Git",
    icon: GitBranch,
    classes: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    dot: "bg-emerald-500",
  },
  deploy_client: {
    label: "Cloud Deploy",
    icon: Rocket,
    classes: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
    dot: "bg-cyan-500",
  },
  ai_generate: {
    label: "VoxAgent AI",
    icon: Sparkles,
    classes: "bg-brand-500/10 text-brand-600 dark:text-brand-400 border-brand-500/30",
    dot: "bg-brand-500",
  },
  telegram_client: {
    label: "Telegram Client",
    icon: Send,
    classes: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30",
    dot: "bg-sky-500",
  },
};

export function getRouteConfig(route) {
  return (
    ROUTE_CONFIG[route] || {
      label: route || "Unknown",
      icon: Webhook,
      classes: "bg-slate-500/10 text-slate-500 border-slate-500/30",
      dot: "bg-slate-400",
    }
  );
}
