import { useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import BottomNav from "./BottomNav";
import Header from "./Header";
import MobileDrawer from "./MobileDrawer";
import GlobalVoiceModal from "./GlobalVoiceModal";
import SettingsModal from "../settings/SettingsModal";
import { useAuth } from "../../context/AuthContext";
import { useBackgroundExecutionMonitor } from "../../hooks/useBackgroundExecutionMonitor";

export default function AppShell() {
  useBackgroundExecutionMonitor();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const { loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-slate-50 dark:bg-slate-900">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500"></div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] max-w-[100vw] overflow-x-hidden bg-slate-50 dark:bg-[#0a0a12]">
      {/* Desktop Sidebar */}
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />

      {/* Mobile Slide-Over Drawer */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {/* Global Voice Assistant Sheet / Modal */}
      <GlobalVoiceModal open={voiceModalOpen} onClose={() => setVoiceModalOpen(false)} />

      {/* Global App Settings Modal */}
      <SettingsModal />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header onMenuClick={() => setDrawerOpen(true)} />
        <main className="flex-1 px-3 md:px-6 py-4 md:py-6 pb-[calc(env(safe-area-inset-bottom,0px)+5.5rem)] md:pb-6 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      {/* Mobile-Native Floating Bottom Nav with Center Voice FAB */}
      <BottomNav
        onVoiceClick={() => setVoiceModalOpen(true)}
        onMoreClick={() => setDrawerOpen(true)}
      />
    </div>
  );
}
