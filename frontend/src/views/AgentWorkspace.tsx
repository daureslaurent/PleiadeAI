import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { agentsApi, sessionsApi, type Agent, type Session } from '../lib/api';
import { getSocket } from '../lib/socket';
import { registerAgentIdentities } from '../lib/agentColor';
import { useStream } from '../store/stream';
import { usePersistentState } from '../hooks/usePersistentState';
import { usePrefs } from '../store/prefs';
import { WorkspaceNav } from '../components/workspace/WorkspaceNav';
import { ChatPanel } from '../components/workspace/ChatPanel';
import { DebuggerDrawer } from '../components/workspace/DebuggerDrawer';
import { PromptDrawer } from '../components/workspace/PromptDrawer';

// Lazy: the noVNC client is only pulled in when an operator actually opens a desktop.
const VisualPanel = lazy(() =>
  import('../components/workspace/VisualPanel').then((m) => ({ default: m.VisualPanel })),
);
const AndroidPanel = lazy(() =>
  import('../components/workspace/AndroidPanel').then((m) => ({ default: m.AndroidPanel })),
);

/**
 * Agent Workspace (spec §2): an expandable "Workspace" navigator (agents → sessions) feeding a
 * modern chat panel and a session-scoped execution debugger. Agents pulse while running — whether
 * addressed directly or invoked by another agent via `ask_agent`. Sessions and their traces persist
 * across reloads.
 */
export function AgentWorkspace() {
  const [agents, setAgents] = useState<Agent[]>([]);
  // Only a *window* of each agent's conversations is held — the most recent `sessionsPerAgent`,
  // plus whatever "Show more" has paged in. `sessionTotals` is the unwindowed count, so the sidebar
  // can say how many are still hidden without holding them.
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, Session[]>>({});
  const [sessionTotals, setSessionTotals] = useState<Record<string, number>>({});
  const [loadingMoreAgentIds, setLoadingMoreAgentIds] = useState<Set<string>>(new Set());
  // Mirror of the windows, for the paging callbacks — they need the current length without taking a
  // dependency on it (which would re-create them, and the boot effect, on every list change).
  const sessionsRef = useRef<Record<string, Session[]>>({});
  sessionsRef.current = sessionsByAgent;
  // The open conversation, kept whole: once the list is windowed it may sit outside the loaded page
  // (a `?session=` deep link, or a restored session buried under newer ones), and the sidebar still
  // has to show it and the chat still has to know its origin.
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupOpen, setGroupOpen] = useState(true);
  const [navCollapsed, setNavCollapsed] = usePersistentState('workspaceNav:collapsed', false);
  // Persist the open agent + session so a page reload restores the current chat (with its tool and
  // sub-agent blocks) instead of dropping the operator back onto an empty workspace.
  const [activeAgentId, setActiveAgentId] = usePersistentState<string | null>('workspace:activeAgentId', null);
  const [activeSessionId, setActiveSessionId] = usePersistentState<string | null>('workspace:activeSessionId', null);
  const [drawer, setDrawer] = usePersistentState('workspace:debuggerOpen', true);
  // The two right drawers are mutually exclusive — the chat column is too narrow for both.
  const [promptOpen, setPromptOpen] = usePersistentState('workspace:promptOpen', false);
  const [visualOpen, setVisualOpen] = useState(false);
  const [androidOpen, setAndroidOpen] = useState(false);
  // Sessions whose auto-title is currently being generated → render a spinner beside the name.
  const [titlingSessionIds, setTitlingSessionIds] = useState<Set<string>>(new Set());

  const activeAgent = agents.find((a) => a._id === activeAgentId) ?? null;
  // `?session=…` deep-links a conversation — how the forum's "Run this mention" and its Open
  // conversation buttons land the operator in the turn they just started.
  const [searchParams, setSearchParams] = useSearchParams();

  const { wire, hydrate, clearActive, send, workingSessions, workingAgents } = useStream();

  const pageSize = usePrefs((s) => s.sessionsPerAgent);
  // Read through a ref inside callbacks so changing the preference doesn't re-create them (and with
  // them the boot effect), while a later call still uses the new size.
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  /**
   * (Re)load an agent's window from the top. `keepLoaded` re-fetches as many rows as are already on
   * screen — a refresh after a run must not silently collapse a list the operator had expanded.
   */
  const loadSessions = useCallback(
    async (agentId: string, opts: { keepLoaded?: boolean } = {}): Promise<Session[]> => {
      const shown = opts.keepLoaded ? (sessionsRef.current[agentId]?.length ?? 0) : 0;
      const limit = Math.max(pageSizeRef.current, shown);
      const { sessions, total } = await sessionsApi.pageByAgent(agentId, { limit });
      setSessionsByAgent((prev) => ({ ...prev, [agentId]: sessions }));
      setSessionTotals((prev) => ({ ...prev, [agentId]: total }));
      return sessions;
    },
    [],
  );

  /** Collapse a paged-open agent back to a single page — the sidebar's "Show fewer". */
  const showFewerSessions = useCallback((agent: Agent) => {
    setSessionsByAgent((prev) => {
      const current = prev[agent._id];
      if (!current) return prev;
      return { ...prev, [agent._id]: current.slice(0, pageSizeRef.current) };
    });
  }, []);

  /** Append the next page to an agent's window — the sidebar's "Show more". */
  const loadMoreSessions = useCallback(async (agent: Agent) => {
    const agentId = agent._id;
    const skip = sessionsRef.current[agentId]?.length ?? 0;
    setLoadingMoreAgentIds((prev) => new Set(prev).add(agentId));
    try {
      const { sessions, total } = await sessionsApi.pageByAgent(agentId, {
        limit: pageSizeRef.current,
        skip,
      });
      setSessionsByAgent((prev) => {
        const current = prev[agentId] ?? [];
        const seen = new Set(current.map((s) => s._id));
        // A session created (or bumped) since the first page can shift the window and repeat a row.
        return { ...prev, [agentId]: [...current, ...sessions.filter((s) => !seen.has(s._id))] };
      });
      setSessionTotals((prev) => ({ ...prev, [agentId]: total }));
    } finally {
      setLoadingMoreAgentIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }, []);

  const openSession = useCallback(
    async (agent: Agent, session: Session) => {
      setActiveAgentId(agent._id);
      setActiveSessionId(session._id);
      setActiveSession(session);
      const msgs = await sessionsApi.messages(session._id);
      hydrate(session._id, msgs, agent._id);
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
  // — or auto-expand the first agent when there's nothing to restore. A `?session=` in the URL wins
  // over the restored one: the operator asked for that specific conversation just now.
  useEffect(() => {
    wire();
    const wanted = searchParams.get('session');
    agentsApi.list().then(async (list) => {
      // Feed chosen colors/icons into the identity registry so name-only stream events (chat avatars,
      // ask_agent bubbles) render each agent's override rather than the default hash color.
      registerAgentIdentities(list);
      setAgents(list);
      if (wanted) {
        const session = await sessionsApi.get(wanted).catch(() => null);
        const agent = session ? list.find((a) => a._id === session.agent_id) : null;
        if (session && agent) {
          setExpanded(new Set([agent._id]));
          void loadSessions(agent._id);
          await openSession(agent, session);
          // Consume the parameter so a later reload restores normally rather than re-opening this.
          setSearchParams({}, { replace: true });
          return;
        }
        setSearchParams({}, { replace: true });
      }
      const restoreAgent = activeAgentId ? list.find((a) => a._id === activeAgentId) : null;
      if (restoreAgent && activeSessionId) {
        setExpanded(new Set([restoreAgent._id]));
        void loadSessions(restoreAgent._id);
        // Resolved explicitly: the restored conversation can be older than the loaded window.
        const restored = await sessionsApi.get(activeSessionId).catch(() => null);
        if (restored) setActiveSession(restored);
        const msgs = await sessionsApi.messages(activeSessionId).catch(() => []);
        hydrate(activeSessionId, msgs, restoreAgent._id);
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
      setActiveSession((prev) => (prev && prev._id === sessionId ? { ...prev, title } : prev));
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

  // The Conversation Generator opened a new conversation with an agent: drop it into that agent's
  // session list right away, so an interview appears (and can be watched) without a reload. Only for
  // agents whose list we've already loaded — the rest fetch it fresh when expanded.
  useEffect(() => {
    const socket = getSocket();
    const onCreated = (s: {
      sessionId: string;
      agentId: string;
      agentName: string;
      title: string;
      origin: 'user' | 'synthetic' | 'forum';
    }) => {
      setSessionsByAgent((prev) => {
        const list = prev[s.agentId];
        if (!list || list.some((x) => x._id === s.sessionId)) return prev;
        const now = new Date().toISOString();
        const session: Session = {
          _id: s.sessionId,
          agent_id: s.agentId,
          agent_name: s.agentName,
          title: s.title,
          origin: s.origin,
          created_at: now,
          updated_at: now,
        };
        return { ...prev, [s.agentId]: [session, ...list] };
      });
      setSessionTotals((prev) => {
        const known = prev[s.agentId];
        return known === undefined ? prev : { ...prev, [s.agentId]: known + 1 };
      });
    };
    socket.on('session:created', onCreated);
    return () => {
      socket.off('session:created', onCreated);
    };
  }, []);

  // Re-window every open agent when the operator changes the per-agent cap in Settings → Interface,
  // so the new size applies to the lists already on screen rather than only to the next expand.
  useEffect(() => {
    for (const id of expanded) void loadSessions(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize]);

  // Refresh any expanded agent's session list when runs start/finish (new titles, reordering).
  const workingCount = workingSessions.length;
  useEffect(() => {
    for (const id of expanded) void loadSessions(id, { keepLoaded: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingCount]);

  async function newSession(agent: Agent) {
    const sn = await sessionsApi.create(agent._id);
    setSessionsByAgent((prev) => ({ ...prev, [agent._id]: [sn, ...(prev[agent._id] ?? [])] }));
    setSessionTotals((prev) => ({ ...prev, [agent._id]: (prev[agent._id] ?? 0) + 1 }));
    setExpanded((prev) => new Set(prev).add(agent._id));
    setActiveAgentId(agent._id);
    setActiveSessionId(sn._id);
    setActiveSession(sn);
    hydrate(sn._id, [], agent._id);
  }

  async function deleteSession(agent: Agent, sn: Session) {
    await sessionsApi.remove(sn._id);
    setSessionsByAgent((prev) => ({
      ...prev,
      [agent._id]: (prev[agent._id] ?? []).filter((s) => s._id !== sn._id),
    }));
    setSessionTotals((prev) => {
      const known = prev[agent._id];
      return known === undefined ? prev : { ...prev, [agent._id]: Math.max(0, known - 1) };
    });
    if (sn._id === activeSessionId) {
      setActiveSessionId(null);
      setActiveSession(null);
      clearActive();
    }
  }

  /**
   * The active session id, creating the session on first use. Factored out of `handleSend` because
   * arming an auto loop needs one too — and unlike a chat, a loop can be started on a conversation
   * the operator has never typed into (its first turn is the loop's own kickoff message).
   */
  async function ensureSession(): Promise<string> {
    if (!activeAgent) throw new Error('no agent selected');
    if (activeSessionId) return activeSessionId;
    const sn = await sessionsApi.create(activeAgent._id);
    setSessionsByAgent((prev) => ({
      ...prev,
      [activeAgent._id]: [sn, ...(prev[activeAgent._id] ?? [])],
    }));
    setSessionTotals((prev) => ({ ...prev, [activeAgent._id]: (prev[activeAgent._id] ?? 0) + 1 }));
    setActiveSessionId(sn._id);
    setActiveSession(sn);
    hydrate(sn._id, [], activeAgent._id);
    return sn._id;
  }

  async function handleSend(text: string, images?: string[]) {
    if (!activeAgent) return;
    const sid = await ensureSession();
    send(activeAgent.name, text, sid, images);
  }

  const workingAgentNames = new Set(Object.keys(workingAgents));
  const workingSessionSet = new Set(workingSessions);

  // A generated conversation (Conversation Generator) reads as a normal chat, except the right-hand
  // speaker is the interviewer agent — never the operator.
  const generatedSession = activeSession?.origin === 'synthetic';

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
        sessionTotals={sessionTotals}
        loadingMoreAgentIds={loadingMoreAgentIds}
        onLoadMoreSessions={loadMoreSessions}
        onShowFewerSessions={showFewerSessions}
        activeSession={activeSession}
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
        generatedSession={generatedSession}
        forumThreadId={activeSession?.origin === 'forum' ? activeSession.forum_thread_id : null}
        debuggerOpen={drawer}
        onToggleDebugger={() => {
          setDrawer((d) => !d);
          setPromptOpen(false);
        }}
        promptOpen={promptOpen}
        onTogglePrompt={() => {
          setPromptOpen((p) => !p);
          setDrawer(false);
        }}
        onOpenVisual={() => setVisualOpen(true)}
        onOpenAndroid={() => setAndroidOpen(true)}
        onSend={handleSend}
        onEnsureSession={ensureSession}
      />
      {drawer && <DebuggerDrawer onClose={() => setDrawer(false)} agent={activeAgent} />}
      {promptOpen && (
        <PromptDrawer
          onClose={() => setPromptOpen(false)}
          sessionId={activeSessionId}
          agent={activeAgent}
        />
      )}
      {visualOpen && activeAgent && (
        <Suspense fallback={null}>
          <VisualPanel
            agentId={activeAgent._id}
            agentName={activeAgent.name}
            onClose={() => setVisualOpen(false)}
          />
        </Suspense>
      )}
      {androidOpen && activeAgent && (
        <Suspense fallback={null}>
          <AndroidPanel
            agentId={activeAgent._id}
            agentName={activeAgent.name}
            onClose={() => setAndroidOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
