import { Bot, KeyRound, Notebook, Zap } from "lucide-react";

export const NAV_ITEMS = [
  { to: "/studio", label: "Agent Studio", shortLabel: "Studio", icon: Zap },
  { to: "/agents", label: "My Agents", shortLabel: "Agents", icon: Bot },
  { to: "/vault", label: "App Vault", shortLabel: "Vault", icon: KeyRound },
  { to: "/notes", label: "Vault Notes", shortLabel: "Notes", icon: Notebook },
];
