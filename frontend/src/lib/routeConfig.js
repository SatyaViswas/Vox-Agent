import { Globe, Plug, Webhook } from "lucide-react";

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
