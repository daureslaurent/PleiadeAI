import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { agentsApi, sessionsApi, type Agent, type Session } from '../lib/api';
import { getSocket } from '../lib/socket';
import { registerAgentIdentities } from '../lib/agentColor';
import { useStream } from '../store/stream';
import { usePersistentState } from '../hooks/usePersistentState';
import { WorkspaceNav } from '../components/workspace/WorkspaceNav';
import { ChatPanel } from '../components/workspace/ChatPanel';
import { DebuggerDrawer } from '../components/workspace/DebuggerDrawer';

// Lazy: the noVNC client is only pulled in when an operator actually opens a desktop.
const VisualPanel = lazy(() =>
  import('../components/workspace/VisualPanel').then((m) => ({ default: m.VisualPanel })),
);

/**
 * Agent Workspace (spec §2): an expandable "Workspace" navigator (agents → sessions) feeding a
 * modern chat panel and a session-scoped execution debugger. Agents pulse while running — whether
 * addressed directly or invoked by another agent via `ask_agent`. Sessions and their traces persist
 * across reloads.
 */
export function AgentWorkspace() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, Session[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupOpen, setGroupOpen] = useState(true);
  const [navCollapsed, setNavCollapsed] = usePersistentState('workspaceNav:collapsed', false);
  // Persist the open agent + session so a page reload restores the current chat (with its tool and
  // sub-agent blocks) instead of dropping the operator back onto an empty workspace.
  const [activeAgentId, setActiveAgentId] = usePersistentState<string | null>('workspace:activeAgentId', null);
  const [activeSessionId, setActiveSessionId] = usePersistentState<string | null>('workspace:activeSessionId', null);
  const [drawer, setDrawer] = useState(true);
  const [visualOpen, setVisualOpen] = useState(false);
  // Sessions whose auto-title is currently being generated → render a spinner beside the name.
  const [titlingSessionIds, setTitlingSessionIds] = useState<Set<string>>(new Set());

  const activeAgent = agents.find((a) => a._id === activeAgentId) ?? null;

  const { wire, hydrate, clearActive, send, workingSessions, workingAgents } = useStream();

  const loadSessions = useCallback(async (agentId: string): Promise<Session[]> => {
    const list = await sessionsApi.listByAgent(agentId);
    setSessionsByAgent((prev) => ({ ...prev, [agentId]: list }));
    return list;
  }, []);

  const openSession = useCallback(
    async (agent: Agent, session: Session) => {
      setActiveAgentId(agent._id);
      setActiveSessionId(session._id);
      const msgs = await sessionsApi.messages(session._id);
      hydrate(session._id, msgs);
    },
    [hydrate, setActiveAgentId, setActiveSessionId],
  );

  const toggleAgent = useCallback(
    (agent: Agent) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(agent._id)) next.delete(agent._id);
        else {
          next.add(agent._id);
          if (!sessionsByAgent[agent._id]) void loadSessions(agent._id);
        }
        return next;
      });
    },
    [sessionsByAgent, loadSessions],
  );

  // Boot: wire the socket, load agents, and restore the previously-open session (surviving reloads)
  // — or auto-expand the first agent when there's nothing to restore.
  useEffect(() => {
    wire();
    agentsApi.list().then(async (list) => {
      // Feed chosen colors/icons into the identity registry so name-only stream events (chat avatars,
      // ask_agent bubbles) render each agent's override rather than the default hash color.
      registerAgentIdentities(list);
      setAgents(list);
      const restoreAgent = activeAgentId ? list.find((a) => a._id === activeAgentId) : null;
      if (restoreAgent && activeSessionId) {
        setExpanded(new Set([restoreAgent._id]));
        void loadSessions(restoreAgent._id);
        const msgs = await sessionsApi.messages(activeSessionId).catch(() => []);
        hydrate(activeSessionId, msgs);
      } else if (list[0]) {
        setExpanded(new Set([list[0]._id]));
        void loadSessions(list[0]._id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wire]);

  // Live-apply an auto-generated conversation title (backend emits it after the first turn) to the
  // matching session in the sidebar, without waiting for a session-list reload.
  useEffect(() => {
    const socket = getSocket();
    const onTitle = ({
      sessionId,
      title,
      pending,
    }: {
      sessionId: string;
      title?: string;
      pending?: boolean;
    }) => {
      // Toggle the per-session spinner: `pending` marks generation started; anything else ends it.
      setTitlingSessionIds((prev) => {
        const next = new Set(prev);
        if (pending) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
      if (!title) return;
      setSessionsByAgent((prev) => {
        const next: Record<string, Session[]> = {};
        for (const [agentId, list] of Object.entries(prev)) {
          next[agentId] = list.map((s) => (s._id === sessionId ? { ...s, title } : s));
        }
        return next;
      });
    };
    socket.on('session:title', onTitle);
    return () => {
      socket.off('session:title', onTitle);
    };
  }, []);

  // Refresh any expanded agent's session list when runs start/finish (new titles, reordering).
  const workingCount = workingSessions.length;
  useEffect(() => {
    for (const id of expanded) void loadSessions(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingCount]);

  async function newSession(agent: Agent) {
    const sn = await sessionsApi.create(agent._id);
    setSessionsByAgent((prev) => ({ ...prev, [agent._id]: [sn, ...(prev[agent._id] ?? [])] }));
    setExpanded((prev) => new Set(prev).add(agent._id));
    setActiveAgentId(agent._id);
    setActiveSessionId(sn._id);
    hydrate(sn._id, []);
  }

  async function deleteSession(agent: Agent, sn: Session) {
    await sessionsApi.remove(sn._id);
    setSessionsByAgent((prev) => ({
      ...prev,
      [agent._id]: (prev[agent._id] ?? []).filter((s) => s._id !== sn._id),
    }));
    if (sn._id === activeSessionId) {
      setActiveSessionId(null);
      clearActive();
    }
  }

  async function handleSend(text: string, images?: string[]) {
    if (!activeAgent) return;
    let sid = activeSessionId;
    if (!sid) {
      const sn = await sessionsApi.create(activeAgent._id);
      setSessionsByAgent((prev) => ({
        ...prev,
        [activeAgent._id]: [sn, ...(prev[activeAgent._id] ?? [])],
      }));
      setActiveSessionId(sn._id);
      hydrate(sn._id, []);
      sid = sn._id;
    }
    send(activeAgent.name, text, sid, images);
  }

  const workingAgentNames = new Set(Object.keys(workingAgents));
  const workingSessionSet = new Set(workingSessions);

  return (
    <div className="flex h-full min-h-0">
      <WorkspaceNav
        collapsed={navCollapsed}
        onToggleCollapse={() => setNavCollapsed((c) => !c)}
        groupOpen={groupOpen}
        onToggleGroup={() => setGroupOpen((o) => !o)}
        agents={agents}
        expandedAgentIds={expanded}
        onToggleAgent={toggleAgent}
        sessionsByAgent={sessionsByAgent}
        workingAgentNames={workingAgentNames}
        workingSessionIds={workingSessionSet}
        titlingSessionIds={titlingSessionIds}
        activeSessionId={activeSessionId}
        onSelectSession={openSession}
        onNewSession={newSession}
        onDeleteSession={deleteSession}
      />
      <ChatPanel
        agent={activeAgent}
        hasSession={!!activeSessionId}
        debuggerOpen={drawer}
        onToggleDebugger={() => setDrawer((d) => !d)}
        onOpenVisual={() => setVisualOpen(true)}
        onSend={handleSend}
      />
      {drawer && <DebuggerDrawer onClose={() => setDrawer(false)} agent={activeAgent} />}
      {visualOpen && activeAgent && (
        <Suspense fallback={null}>
          <VisualPanel
            agentId={activeAgent._id}
            agentName={activeAgent.name}
            onClose={() => setVisualOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
