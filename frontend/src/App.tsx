import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './store/auth';
import { Sidebar, NAV_ITEMS } from './components/Sidebar';
import { EndpointBadge } from './components/EndpointBadge';
import { ConfirmProvider } from './components/ui';
import { AuthGuard } from './views/AuthGuard';
import { AgentWorkspace } from './views/AgentWorkspace';
import { AgentsView } from './views/AgentsView';
import { SkillsView } from './views/SkillsView';
import { ToolsView } from './views/ToolsView';
import { IsolationsView } from './views/IsolationsView';
import { ImagesView } from './views/ImagesView';
import { MemoryVault } from './views/MemoryVault';
import { AutonomyView } from './views/autonomy/AutonomyView';
import { LLMView } from './views/LLMView';
import { LLMDebugView } from './views/LLMDebugView';
import { ScoringView } from './views/ScoringView';
import { ConversationsView } from './views/ConversationsView';
import { FineTuningView } from './views/FineTuningView';
import { SettingsView, SettingsCategoryPage } from './views/settings/SettingsLayout';
import { SettingsHome } from './views/settings/SettingsHome';
import { VisualDesktopWindow } from './views/VisualDesktopWindow';

function PageHeader() {
  const { pathname } = useLocation();
  // Match by path segment (not raw prefix) so sibling routes like `/llm` and `/llm-debug` don't
  // collide — `/llm-debug` must not resolve to the `/llm` header.
  const current = NAV_ITEMS.find((n) => pathname === n.to || pathname.startsWith(`${n.to}/`));
  const Icon = current?.icon;
  // z-20: .glass's backdrop-filter makes the header a stacking context, so its popovers
  // (EndpointBadge) can't out-stack later page content unless the header itself is lifted.
  // Full-screen modals are fixed z-50 and still cover it.
  return (
    <header className="glass relative z-20 flex h-14 shrink-0 items-center gap-2 border-b px-6">
      {Icon && <Icon size={18} className="text-slate-400" />}
      <h1 className="text-sm font-semibold text-slate-100">{current?.label ?? 'PleiadesAI'}</h1>
      <div className="ml-auto">
        <EndpointBadge />
      </div>
    </header>
  );
}

/**
 * Main app chrome (sidebar + header) hosting the routed pages via `<Outlet />`.
 *
 * The Pleiades backdrop is mounted **once**, here (DIRECT_ART §1): every routed view floats on it,
 * and the sidebar/header are `.glass` over the same starfield instead of opaque grey slabs. Views
 * must not mount their own `.space-bg` — a second one re-paints the gradient and runs a duplicate
 * pair of twinkling star layers.
 */
function MainLayout() {
  return (
    <div className="space-bg flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const token = useAuth((s) => s.token);
  if (!token) return <AuthGuard />;

  return (
    <ConfirmProvider>
      <Routes>
        {/* Chrome-free popped-out agent desktop (opened via window.open) — no sidebar/header. */}
        <Route path="/desktop/:agentId" element={<VisualDesktopWindow />} />
        <Route element={<MainLayout />}>
          <Route path="/workspace" element={<AgentWorkspace />} />
          <Route path="/agents" element={<AgentsView />} />
          <Route path="/skills" element={<SkillsView />} />
          <Route path="/tools" element={<ToolsView />} />
          <Route path="/images" element={<ImagesView />} />
          <Route path="/isolation" element={<IsolationsView />} />
          <Route path="/memory" element={<MemoryVault />} />
          <Route path="/autonomy" element={<AutonomyView />} />
          <Route path="/llm" element={<LLMView />} />
          <Route path="/llm-debug" element={<LLMDebugView />} />
          <Route path="/conversations" element={<ConversationsView />} />
          <Route path="/scoring" element={<ScoringView />} />
          <Route path="/finetuning" element={<FineTuningView />} />
          {/* Settings is a card index (`/settings`) over one page per category
              (`/settings/inference`, …). The layout route owns the settings doc so switching
              category never refetches — see views/settings/context.tsx. */}
          <Route path="/settings" element={<SettingsView />}>
            <Route index element={<SettingsHome />} />
            <Route path=":category" element={<SettingsCategoryPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/workspace" replace />} />
        </Route>
      </Routes>
    </ConfirmProvider>
  );
}
