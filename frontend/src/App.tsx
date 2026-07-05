import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './store/auth';
import { Sidebar, NAV_ITEMS } from './components/Sidebar';
import { AuthGuard } from './views/AuthGuard';
import { AgentWorkspace } from './views/AgentWorkspace';
import { AgentsView } from './views/AgentsView';
import { SkillsView } from './views/SkillsView';
import { ToolsView } from './views/ToolsView';
import { IsolationsView } from './views/IsolationsView';
import { MemoryVault } from './views/MemoryVault';
import { AutonomyInbox } from './views/AutonomyInbox';
import { LLMView } from './views/LLMView';
import { SettingsView } from './views/SettingsView';

function PageHeader() {
  const { pathname } = useLocation();
  const current = NAV_ITEMS.find((n) => pathname.startsWith(n.to));
  const Icon = current?.icon;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-6">
      {Icon && <Icon size={18} className="text-slate-400" />}
      <h1 className="text-sm font-semibold text-slate-100">{current?.label ?? 'PleiadeAI'}</h1>
    </header>
  );
}

export default function App() {
  const token = useAuth((s) => s.token);
  if (!token) return <AuthGuard />;

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Routes>
            <Route path="/workspace" element={<AgentWorkspace />} />
            <Route path="/agents" element={<AgentsView />} />
            <Route path="/skills" element={<SkillsView />} />
            <Route path="/tools" element={<ToolsView />} />
            <Route path="/isolation" element={<IsolationsView />} />
            <Route path="/memory" element={<MemoryVault />} />
            <Route path="/autonomy" element={<AutonomyInbox />} />
            <Route path="/llm" element={<LLMView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/workspace" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
