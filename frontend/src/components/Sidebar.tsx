import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Bot, Box, Bug, Cpu, Database, Gauge, LogOut, MessagesSquare, Package, PanelLeftClose, PanelLeftOpen, Settings2, Sparkles, Terminal, Users, Wrench, Blocks } from 'lucide-react';
import { useAuth } from '../store/auth';
import { usePersistentState } from '../hooks/usePersistentState';
import { hostApi } from '../lib/api';
import { APP_VERSION } from '../version';

export interface NavItem {
  to: string;
  label: string;
  icon: typeof Bot;
}

interface NavGroup {
  /** Uppercase section label (DIRECT_ART §5); collapses to a hairline divider in icon-only mode. */
  label: string;
  items: NavItem[];
}

/**
 * Primary nav, clustered by operator intent. `Settings` lives apart (pinned above the account
 * footer) because it carries the "update available" pin and reads as chrome, not a workspace area.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { to: '/workspace', label: 'Workspace', icon: MessagesSquare },
      { to: '/agents', label: 'Agents', icon: Users },
      { to: '/skills', label: 'Skills', icon: Wrench },
      { to: '/tools', label: 'Tools', icon: Blocks },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { to: '/images', label: 'Images', icon: Package },
      { to: '/isolation', label: 'Isolation', icon: Box },
      { to: '/memory', label: 'Memory Vault', icon: Database },
      { to: '/autonomy', label: 'Autonomy', icon: Bot },
    ],
  },
  {
    label: 'Model',
    items: [
      { to: '/llm', label: 'LLM', icon: Cpu },
      { to: '/llm-debug', label: 'LLM Debug', icon: Bug },
      { to: '/scoring', label: 'Scoring', icon: Gauge },
      { to: '/finetuning', label: 'Fine-Tuning', icon: Sparkles },
    ],
  },
];

const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings', icon: Settings2 };

/** Flat list of every nav destination — consumed by `App.tsx`'s `PageHeader` to resolve titles. */
export const NAV_ITEMS: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), SETTINGS_ITEM];

/** Left navigation rail — brand, grouped primary nav, pinned Settings, account footer. */
export function Sidebar() {
  const logout = useAuth((s) => s.logout);
  const [collapsed, setCollapsed] = usePersistentState('sidebar:collapsed', false);
  const [updateCount, setUpdateCount] = useState(0);

  // Poll the host bridge so the "update available" pin survives reloads and refreshes while the
  // app is open. No-op unless updates are enabled + the watcher has written a status.
  useEffect(() => {
    let alive = true;
    const poll = () =>
      hostApi
        .getUpdate()
        .then((u) => alive && setUpdateCount(u.updateAvailable ? u.status?.behindBy ?? 0 : 0))
        .catch(() => undefined);
    poll();
    const id = setInterval(poll, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const renderItem = ({ to, label, icon: Icon }: NavItem) => (
    <NavLink
      key={to}
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        [
          'group relative flex items-center rounded-lg py-2 text-sm transition-colors duration-150',
          collapsed ? 'justify-center px-2' : 'gap-3 px-3',
          isActive
            ? 'bg-accent/15 font-medium text-accent'
            : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-100',
        ].join(' ')
      }
    >
      {({ isActive }) => {
        const showPin = to === '/settings' && updateCount > 0;
        return (
          <>
            {/* 2px inset accent rail on the active item (DIRECT_ART §7 nav treatment). */}
            <span
              className={`absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent transition-all duration-200 ${
                isActive ? 'opacity-100' : 'opacity-0'
              }`}
            />
            <span className="relative shrink-0">
              <Icon
                size={17}
                className={`transition-transform duration-150 ${isActive ? '' : 'group-hover:scale-110'}`}
              />
              {showPin && collapsed && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-[#161b22]" />
              )}
            </span>
            {!collapsed && <span className="truncate">{label}</span>}
            {showPin && !collapsed && (
              <span
                title={`${updateCount} update${updateCount === 1 ? '' : 's'} available`}
                className="ml-auto rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400"
              >
                {updateCount}
              </span>
            )}
          </>
        );
      }}
    </NavLink>
  );

  return (
    <aside
      className={`glass flex h-full shrink-0 flex-col border-r transition-[width] duration-200 ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      {/* Brand + collapse toggle */}
      <div className={`flex items-center py-4 ${collapsed ? 'justify-center px-2' : 'gap-2.5 px-4'}`}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent ring-1 ring-inset ring-accent/20">
          <Terminal size={18} />
        </div>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="font-mono text-sm font-semibold text-slate-100">PleiadeAI</div>
            <div className="truncate text-[10px] uppercase tracking-wider text-slate-500">
              Command Center · <span className="normal-case tracking-normal text-slate-600">v{APP_VERSION}</span>
            </div>
          </div>
        )}
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            className="ml-auto rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            <PanelLeftClose size={16} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          className="mx-auto mb-1 rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}

      {/* Primary nav — grouped by intent; sections become hairline dividers when collapsed. */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {NAV_GROUPS.map((group, i) =>
          collapsed ? (
            <div key={group.label}>
              {i > 0 && <div className="mx-2 my-2 border-t border-white/[0.06]" />}
              <div className="space-y-0.5">{group.items.map(renderItem)}</div>
            </div>
          ) : (
            <div key={group.label} className={i > 0 ? 'mt-4' : ''}>
              <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                {group.label}
              </div>
              <div className="space-y-0.5">{group.items.map(renderItem)}</div>
            </div>
          ),
        )}
      </nav>

      {/* Pinned Settings — separated from the scrollable groups. */}
      <div className="border-t border-white/[0.06] px-2 py-2">{renderItem(SETTINGS_ITEM)}</div>

      {/* Account footer */}
      <div className="border-t border-white/[0.06] p-3">
        {!collapsed && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.06] text-xs font-semibold text-slate-300">
              A
            </div>
            <div className="min-w-0 text-xs">
              <div className="truncate text-slate-300">admin</div>
              <div className="flex items-center gap-1 text-[10px] text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> connected
              </div>
            </div>
          </div>
        )}
        <button
          onClick={logout}
          title={collapsed ? 'Sign out' : undefined}
          className={`flex w-full items-center rounded-lg py-2 text-xs text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-slate-100 ${
            collapsed ? 'justify-center px-2' : 'gap-2 px-3'
          }`}
        >
          <LogOut size={15} /> {!collapsed && 'Sign out'}
        </button>
      </div>
    </aside>
  );
}
