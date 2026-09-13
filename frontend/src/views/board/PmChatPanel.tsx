import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, MessagesSquare, PanelRightClose, SendHorizontal, Square } from 'lucide-react';
import { sessionsApi, type BoardPlan, type BoardProposal, type BoardTask } from '../../lib/api';
import { buildBlocks, useStream } from '../../store/stream';
import { useStickyScroll } from '../../hooks/useStickyScroll';
import { AskUserPrompt, Conversation } from '../../components/workspace/ChatPanel';
import { Callout, Spinner } from '../../components/ui';
import { ProposalCard } from './ProposalCard';

/** Turns kept unfolded at the tail — a long project history opens on what was said last. */
const RECENT_TURNS = 10;

/**
 * The conversation with a board item's manager (`BOARD_REFACTOR_PLAN.md` §5 of the frontend).
 *
 * It is the item's ordinary PM session, rendered through the same conversation views and the same
 * stream store as the Workspace — so tool cards, thinking and a turn resumed after a reload all
 * behave identically, and the board's own planning turns stream into it live. The store holds one
 * active session, which is fine here: this page and the Workspace are never on screen together.
 *
 * What differs is only what sits around it: a compact composer, and the manager's pending proposal
 * pinned above it, since a proposal is the one thing in this conversation that waits on the operator.
 */
export function PmChatPanel({
  plan,
  tasks,
  proposal,
  onProposalDecided,
  onTurnSettled,
  onCollapse,
}: {
  plan: BoardPlan;
  tasks: BoardTask[];
  proposal: BoardProposal | null;
  onProposalDecided: (p: BoardProposal) => void;
  /** A turn in this conversation just ended — the board and its proposals may have moved. */
  onTurnSettled: () => void;
  onCollapse: () => void;
}) {
  const {
    turns,
    liveItems,
    liveFrames,
    streaming,
    activeSessionId,
    pendingAsk,
    hydrate,
    clearActive,
    send,
    stop,
    answerAsk,
  } = useStream();
  const sessionId = plan.chatSessionId;
  const managerName = plan.manager.display_name;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [showAll, setShowAll] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoaded(false);
    sessionsApi
      .messages(sessionId)
      .then((msgs) => {
        if (cancelled) return;
        hydrate(sessionId, msgs, plan.manager.agent_id ?? '');
        setLoaded(true);
      })
      .catch((err) => setError(String(err?.response?.data?.error ?? err)));
    return () => {
      cancelled = true;
      clearActive();
    };
    // Re-hydrate only when the conversation itself changes, not on every plan poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const onScreen = loaded && activeSessionId === sessionId;

  // A turn ending is when the manager may have proposed something, or (a board turn) filed tasks.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) onTurnSettled();
    wasStreaming.current = streaming;
  }, [streaming, onTurnSettled]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const liveBlocks = useMemo(() => buildBlocks('root', liveItems, liveFrames), [liveItems, liveFrames]);
  const { ref: scrollRef, onScroll } = useStickyScroll<HTMLDivElement>([turns, liveBlocks, streaming, proposal?.id], {
    behavior: 'smooth',
  });

  const hiddenTurns = showAll ? 0 : Math.max(0, turns.length - RECENT_TURNS);
  const shownTurns = hiddenTurns ? turns.slice(hiddenTurns) : turns;

  const submit = () => {
    const text = input.trim();
    if (!text || !sessionId || streaming) return;
    send(managerName, text, sessionId);
    setInput('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b hairline px-3 py-2">
        <MessagesSquare size={14} className="shrink-0 text-slate-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-slate-100">Chat with {managerName}</div>
          <div className="text-[10px] text-slate-500">
            {streaming ? <span className="text-shimmer text-emerald-400">working…</span> : 'project manager · proposes, you apply'}
          </div>
        </div>
        {sessionId ? (
          <Link
            to={`/workspace?session=${sessionId}`}
            title="Open this conversation in the Workspace, with the debugger"
            className="rounded-md p-1 text-slate-500 transition-colors hover:raise-2 hover:text-slate-200"
          >
            <ExternalLink size={13} />
          </Link>
        ) : null}
        <button
          onClick={onCollapse}
          title="Hide the chat"
          className="hidden rounded-md p-1 text-slate-500 transition-colors hover:raise-2 hover:text-slate-200 lg:block"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4">
        {!sessionId ? (
          <Callout tone="warn">
            This item has no manager conversation — its manager agent no longer exists. Pick another in
            Settings or recreate the item.
          </Callout>
        ) : error ? (
          <Callout tone="error">{error}</Callout>
        ) : !onScreen ? (
          <Spinner />
        ) : !turns.length && !streaming ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-slate-500">
            <MessagesSquare size={22} className="opacity-50" />
            Ask {managerName} how it is going, or what should change — a new feature, a different owner, a
            task to drop. Changes come back as a proposal you apply.
          </div>
        ) : (
          <Conversation
            turns={turns}
            shownTurns={shownTurns}
            hiddenTurns={hiddenTurns}
            showAllTurns={showAll}
            onShowAll={() => setShowAll(true)}
            onFoldBack={() => setShowAll(false)}
            recentTurns={RECENT_TURNS}
            agentName={managerName}
            streaming={streaming}
            liveBlocks={liveBlocks}
            liveMemories={liveFrames.root?.memories}
          />
        )}
      </div>

      {proposal?.state === 'pending' ? (
        <div className="max-h-[45%] overflow-y-auto border-t hairline px-3 py-2">
          <ProposalCard proposal={proposal} tasks={tasks} onDecided={onProposalDecided} />
        </div>
      ) : null}

      {pendingAsk && onScreen ? (
        <AskUserPrompt agent={pendingAsk.agent} question={pendingAsk.question} onAnswer={answerAsk} />
      ) : null}

      <div className="p-3">
        <div className="flex items-end gap-2 rounded-xl border hairline well px-3 py-2 transition-colors focus-within:border-accent/50">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            disabled={!sessionId || !onScreen}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={streaming ? `${managerName} is working…` : `Message ${managerName}…`}
            className="max-h-40 flex-1 resize-none overflow-y-auto bg-transparent py-1 text-sm text-slate-100 outline-none placeholder:text-slate-600"
          />
          {streaming ? (
            <button
              onClick={stop}
              title="Stop"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-red-400 transition-colors hover:bg-red-500/10"
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!input.trim() || !onScreen}
              title="Send"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-oncolor transition active:scale-95 disabled:opacity-40"
            >
              <SendHorizontal size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
