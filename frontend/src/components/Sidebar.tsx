import { NavLink } from 'react-router-dom';
import { Bot, Box, Cpu, Database, LogOut, MessagesSquare, PanelLeftClose, PanelLeftOpen, Settings2, Terminal, Users, Wrench, Blocks } from 'lucide-react';
import { useAuth } from '../store/auth';
import { usePersistentState } from '../hooks/usePersistentState';

export interface NavItem {
  to: string;
  label: string;
  icon: typeof Bot;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/workspace', label: 'Workspace', icon: MessagesSquare },
  { to: '/agents', label: 'Agents', icon: Users },
  { to: '/skills', label: 'Skills', icon: Wrench },
  { to: '/tools', label: 'Tools', icon: Blocks },
  { to: '/isolation', label: 'Isolation', icon: Box },
  { to: '/memory', label: 'Memory Vault', icon: Database },
  { to: '/autonomy', label: 'Autonomy', icon: Bot },
  { to: '/llm', label: 'LLM', icon: Cpu },
  { to: '/settings', label: 'Settings', icon: Settings2 },
];

/** Left navigation rail — standard dashboard pattern: brand, primary nav, account footer. */
export function Sidebar() {
  const logout = useAuth((s) => s.logout);
  const [collapsed, setCollapsed] = usePersistentState('sidebar:collapsed', false);

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-border bg-surface transition-all duration-200 ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      {/* Brand + collapse toggle */}
      <div className={`flex items-center py-4 ${collapsed ? 'justify-center px-2' : 'gap-2 px-4'}`}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Terminal size={18} />
        </div>
        {!collapsed && (
          <div className="leading-tight">
            <div className="font-mono text-sm font-semibold text-slate-100">PleiadeAI</div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Command Center</div>
          </div>
        )}
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            className="ml-auto rounded-md p-1.5 text-slate-500 hover:bg-panel hover:text-slate-200"
          >
            <PanelLeftClose size={16} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          className="mx-auto mb-1 rounded-md p-1.5 text-slate-500 hover:bg-panel hover:text-slate-200"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}

      {/* Primary nav */}
      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              [
                'group relative flex items-center rounded-md py-2 text-sm transition-colors',
                collapsed ? 'justify-center px-2' : 'gap-3 px-3',
                isActive
                  ? 'bg-accent/15 font-medium text-accent'
                  : 'text-slate-400 hover:bg-panel hover:text-slate-100',
              ].join(' ')
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`absolute left-0 h-5 w-0.5 rounded-r bg-accent transition-opacity ${
                    isActive ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <Icon size={17} className="shrink-0" />
                {!collapsed && label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Account footer */}
      <div className="border-t border-border p-3">
        {!collapsed && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-panel text-xs font-semibold text-slate-300">
              A
            </div>
            <div className="text-xs">
              <div className="text-slate-300">admin</div>
              <div className="flex items-center gap-1 text-[10px] text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> connected
              </div>
            </div>
          </div>
        )}
        <button
          onClick={logout}
          title={collapsed ? 'Sign out' : undefined}
          className={`flex w-full items-center rounded-md py-2 text-xs text-slate-400 hover:bg-panel hover:text-slate-100 ${
            collapsed ? 'justify-center px-2' : 'gap-2 px-3'
          }`}
        >
          <LogOut size={15} /> {!collapsed && 'Sign out'}
        </button>
      </div>
    </aside>
  );
}
