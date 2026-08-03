import { getRouteConfig } from "../../lib/routeConfig";

export function getUniqueRoutes(blueprint) {
  const steps = blueprint?.steps || [];
  return [...new Set(steps.map((s) => s.route))];
}

export default function RouteBadges({ blueprint, className = "" }) {
  const routes = getUniqueRoutes(blueprint);
  if (routes.length === 0) return null;

  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`}>
      {routes.map((route) => {
        const config = getRouteConfig(route);
        const Icon = config.icon;
        return (
          <span
            key={route}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${config.classes}`}
          >
            <Icon size={11} />
            {config.label}
          </span>
        );
      })}
    </div>
  );
}
