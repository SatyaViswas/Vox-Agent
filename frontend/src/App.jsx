import { Route, Routes } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import AgentStudio from "./pages/AgentStudio";
import MyAgents from "./pages/MyAgents";
import AppVault from "./pages/AppVault";
import VaultNotes from "./pages/VaultNotes";
import KnowledgeBase from "./pages/KnowledgeBase";

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth" element={<Auth />} />
      <Route element={<AppShell />}>
        <Route path="/studio" element={<AgentStudio />} />
        <Route path="/agents" element={<MyAgents />} />
        <Route path="/vault" element={<AppVault />} />
        <Route path="/notes" element={<VaultNotes />} />
        <Route path="/knowledge" element={<KnowledgeBase />} />
      </Route>
    </Routes>
  );
}

export default App;
