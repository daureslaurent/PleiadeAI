import { useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Plus,
  MessageSquare,
  Trash2,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Loader2,
  GitBranch,
  Mic,
} from 'lucide-react';
import type { Agent, Session } from '../../lib/api';
import { agentColor } from '../../lib/agentColor';
import { iconFor } from '../../lib/agentIcons';

/** Compact relative-time label (e.g. "3m", "2h", "Apr 5"). */
function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Pulsing dot marking an agent that's currently executing (direct run or `ask_agent` delegation). */
function WorkingPin() {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" title="working">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
    </span>
  );
}

interface Props {
  collapsed: boolean;
  onToggleCollapse: () => void;
  groupOpen: boolean;
  onToggleGroup: () => void;
  agents: Agent[];
  expandedAgentIds: Set<string>;
  onToggleAgent: (agent: Agent) => void;
  sessionsByAgent: Record<string, Session[]>;
  workingAgentNames: Set<string>;
  workingSessionIds: Set<string>;
  titlingSessionIds: Set<string>;
  activeSessionId: string | null;
  onSelectSession: (agent: Agent, session: Session) => void;
  onNewSession: (agent: Agent) => void;
  onDeleteSession: (agent: Agent, session: Session) => void;
}

/**
 * The Workspace navigator (spec §2): a collapsible "Workspace" group whose members are split into
 * two sections — top-level **Agents** (orchestrators) and delegatable **Subagents** — so the role of
 * each entity is visually obvious at a glance. Both kinds can open/create sessions identically; the
 * distinction is purely cosmetic (a `sub` pill, a rounded avatar, and a branch glyph on subagents).
 * Each agent independently expands to reveal its sessions + a New-session action (multi-open). A
 * pulse pin marks any agent with an in-flight run — including one invoked via `ask_agent`.
 */
export function WorkspaceNav({
  collapsed,
  onToggleCollapse,
  groupOpen,
  onToggleGroup,
  agents,
  expandedAgentIds,
  onToggleAgent,
  sessionsByAgent,
  workingAgentNames,
  workingSessionIds,
  titlingSessionIds,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
}: Props) {
  // The two role sections collapse independently (local, cosmetic state).
  const [agentsSectionOpen, setAgentsSectionOpen] = useState(true);
  const [subsSectionOpen, setSubsSectionOpen] = useState(true);

  const topAgents = agents.filter((a) => !a.subagent);
  const subAgents = agents.filter((a) => a.subagent);

  if (collapsed) {
    return (
      <div className="glass flex shrink-0 flex-col items-center border-r py-3">
        <button
          onClick={onToggleCollapse}
          title="Show workspace"
          className="rounded-md p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-slate-200"
        >
          <PanelLeftOpen size={16} />
        </button>
        <LayoutGrid size={16} className="mt-3 text-accent" />
      </div>
    );
  }

  /** One agent row + (when expanded) its session list. `isSub` toggles the subagent cosmetics. */
  const renderAgent = (agent: Agent, isSub: boolean) => {
    const open = expandedAgentIds.has(agent._id);
    const working = workingAgentNames.has(agent.name);
    const sessions = sessionsByAgent[agent._id] ?? [];
    return (
      <div key={agent._id} className="mb-0.5">
        {/* Agent row */}
        <button
          onClick={() => onToggleAgent(agent)}
          className="group flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-white/[0.05]"
        >
          {open ? (
            <ChevronDown size={14} className="shrink-0 text-slate-500" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-slate-500" />
          )}
          {(() => {
            const c = agentColor(agent.name, agent.color);
            const Icon = iconFor(agent.icon);
            return (
              <span
                className={[
                  'flex h-6 w-6 shrink-0 items-center justify-center text-[10px] font-semibold text-slate-950',
                  // Subagents read as "derived": circular avatar + a faint ring; orchestrators stay square.
                  isSub ? 'rounded-full opacity-90 ring-1 ring-inset ring-white/10' : 'rounded-md',
                ].join(' ')}
                style={{ background: c.accent }}
              >
                {Icon ? <Icon size={13} /> : agent.name.slice(0, 2).toUpperCase()}
              </span>
            );
          })()}
          <span
            className={[
              'min-w-0 flex-1 truncate text-sm',
              isSub ? 'text-slate-300' : 'text-slate-200',
            ].join(' ')}
          >
            {agent.name}
          </span>
          {isSub && (
            <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-slate-500">
              <GitBranch size={9} />
              sub
            </span>
          )}
          {working && <WorkingPin />}
        </button>

        {/* Sessions */}
        {open && (
          <div className="ml-3 border-l border-border pl-1.5">
            <button
              onClick={() => onNewSession(agent)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-accent hover:bg-accent/10"
            >
              <Plus size={13} /> New session
            </button>

            {sessions.map((sn) => {
              const active = sn._id === activeSessionId;
              const busy = workingSessionIds.has(sn._id);
              const titling = titlingSessionIds.has(sn._id);
              // Generated by the Conversation Generator: the same chat, but the Interviewer is the one
              // talking. Marked with a mic so it reads apart from a conversation the operator had.
              const generated = sn.origin === 'synthetic';
              const SessionIcon = generated ? Mic : MessageSquare;
              return (
                <div
                  key={sn._id}
                  onClick={() => onSelectSession(agent, sn)}
                  className={[
                    'group flex cursor-pointer items-start gap-1.5 rounded-md px-2 py-1.5 transition-colors',
                    active ? 'bg-accent/15 shadow-[inset_2px_0_0_0_rgba(59,130,246,0.7)]' : 'hover:bg-white/[0.05]',
                  ].join(' ')}
                >
                  <span
                    className="mt-0.5 shrink-0"
                    title={generated ? 'generated conversation (Interviewer)' : undefined}
                  >
                    <SessionIcon
                      size={13}
                      className={
                        active ? 'text-accent' : generated ? 'text-fuchsia-400/70' : 'text-slate-500'
                      }
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={[
                          'truncate text-xs',
                          active ? 'font-medium text-slate-100' : 'text-slate-300',
                        ].join(' ')}
                      >
                        {sn.title || 'New session'}
                      </span>
                      {titling && (
                        <Loader2
                          size={11}
                          className="shrink-0 animate-spin text-slate-500"
                          aria-label="Generating title"
                        />
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
                      <span>{ago(sn.updated_at)}</span>
                      {busy && (
                        <span className="flex items-center gap-1 text-emerald-400">
                          <span className="h-1 w-1 animate-pulse rounded-full bg-emerald-400" />
                          working
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(agent, sn);
                    }}
                    title="Delete session"
                    className="shrink-0 rounded p-0.5 text-slate-600 opacity-0 transition hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}

            {!sessions.length && (
              <p className="px-2 py-1.5 text-[11px] text-slate-600">No sessions yet.</p>
            )}
          </div>
        )}
      </div>
    );
  };

  /** A collapsible role section ("Agents" / "Subagents") wrapping a set of agent rows. */
  const renderSection = (
    label: string,
    count: number,
    sectionOpen: boolean,
    onToggleSection: () => void,
    icon: React.ReactNode,
    body: React.ReactNode,
  ) => (
    <div className="mb-1">
      <button
        onClick={onToggleSection}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-white/[0.05]/50"
      >
        {sectionOpen ? (
          <ChevronDown size={13} className="shrink-0 text-slate-600" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-slate-600" />
        )}
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          {label}
        </span>
        <span className="ml-auto text-[10px] text-slate-600">{count}</span>
      </button>
      {sectionOpen && <div className="mt-0.5">{body}</div>}
    </div>
  );

  return (
    <aside className="glass flex w-64 shrink-0 flex-col border-r">
      {/* Group header */}
      <div className="flex items-center pr-1.5 hover:bg-white/[0.05]/50">
        <button
          onClick={onToggleGroup}
          className="flex flex-1 items-center gap-2 px-3 py-3 text-left"
        >
          {groupOpen ? (
            <ChevronDown size={15} className="text-slate-500" />
          ) : (
            <ChevronRight size={15} className="text-slate-500" />
          )}
          <LayoutGrid size={15} className="text-accent" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
            Workspace
          </span>
          <span className="ml-auto text-[10px] text-slate-600">{agents.length}</span>
        </button>
        <button
          onClick={onToggleCollapse}
          title="Hide workspace"
          className="rounded-md p-1.5 text-slate-500 hover:bg-white/[0.06] hover:text-slate-200"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {groupOpen && (
        <div className="flex-1 overflow-y-auto px-1.5 pb-2">
          {topAgents.length > 0 &&
            renderSection(
              'Agents',
              topAgents.length,
              agentsSectionOpen,
              () => setAgentsSectionOpen((o) => !o),
              <LayoutGrid size={12} className="shrink-0 text-accent" />,
              topAgents.map((a) => renderAgent(a, false)),
            )}

          {subAgents.length > 0 &&
            renderSection(
              'Subagents',
              subAgents.length,
              subsSectionOpen,
              () => setSubsSectionOpen((o) => !o),
              <GitBranch size={12} className="shrink-0 text-slate-500" />,
              subAgents.map((a) => renderAgent(a, true)),
            )}

          {!agents.length && (
            <p className="px-3 py-4 text-xs text-slate-600">No agents yet. Create one in Agents.</p>
          )}
        </div>
      )}
    </aside>
  );
}
