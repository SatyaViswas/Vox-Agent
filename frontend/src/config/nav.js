import { Bot, Brain, KeyRound, Notebook, Zap } from "lucide-react";

export const NAV_ITEMS = [
  { to: "/studio", labelKey: "nav.studio", shortLabelKey: "nav.studioShort", icon: Zap },
  { to: "/agents", labelKey: "nav.agents", shortLabelKey: "nav.agentsShort", icon: Bot },
  { to: "/vault", labelKey: "nav.vault", shortLabelKey: "nav.vaultShort", icon: KeyRound },
  { to: "/notes", labelKey: "nav.notes", shortLabelKey: "nav.notesShort", icon: Notebook },
  { to: "/knowledge", labelKey: "nav.knowledge", shortLabelKey: "nav.knowledgeShort", icon: Brain },
];
