import { useEffect, useMemo, useRef, useState } from 'react';
import { SendHorizontal, Bug, MessagesSquare, Gauge, MessageCircleQuestion, Square, Monitor } from 'lucide-react';
import { Blocks, ThinkingRow, activityLabel } from './Blocks';
import { ContainerBanner } from './ContainerBanner';
import { useStream, buildBlocks, type ContextUsage, type Turn } from '../../store/stream';
import { agentColor, agentIcon, agentInitial } from '../../lib/agentColor';
import { iconFor } from '../../lib/agentIcons';
import type { Agent } from '../../lib/api';

function Avatar({ role, agentName }: { role: Turn['role']; agentName: string }) {
  if (role === 'user') {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-panel text-xs font-semibold text-slate-300">
        You
      </span>
    );
  }
  // The directly-addressed agent wears its own identity color + icon, matching nested sub-agent bubbles.
  const color = agentColor(agentName);
  const Icon = iconFor(agentIcon(agentName));
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-slate-950"
      style={{ background: color.accent }}
    >
      {Icon ? <Icon size={17} /> : agentInitial(agentName)}
    </span>
  );
}

interface MessageRowProps {
  role: Turn['role'];
  agentName: string;
  children: React.ReactNode;
}
function MessageRow({ role, agentName, children }: MessageRowProps) {
  const isUser = role === 'user';
  const color = agentColor(agentName);
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <Avatar role={role} agentName={agentName} />
      <div className={`flex min-w-0 flex-1 flex-col ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className="mb-1 px-1 text-[11px] font-medium"
          style={isUser ? undefined : { color: color.accent }}
        >
          {isUser ? 'You' : agentName}
        </div>
        <div
          className={[
            'w-full min-w-0 overflow-hidden break-words rounded-2xl px-4 py-2.5 text-sm',
            isUser
              ? 'rounded-tr-sm bg-accent/15 text-slate-100'
              : 'rounded-tl-sm bg-surface text-slate-100 ring-1 ring-border',
          ].join(' ')}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

interface Props {
  agent: Agent | null;
  hasSession: boolean;
  debuggerOpen: boolean;
  onToggleDebugger: () => void;
  onOpenVisual: () => void;
  onSend: (text: string) => void;
}

/** Compact tokens value: 1234 → "1.2K", 512 → "512". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n);
}

/**
 * Session context-size meter for the chat header: prompt tokens of the last turn against the
 * model's context window, with a fill bar that warms to amber/red as the window fills up.
 */
function ContextMeter({ usage }: { usage: ContextUsage }) {
  const { promptTokens, contextWindow } = usage;
  const pct = contextWindow > 0 ? Math.min(100, (promptTokens / contextWindow) * 100) : 0;
  const tone = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-accent';
  const label = contextWindow > 0 ? `${fmtTokens(promptTokens)} / ${fmtTokens(contextWindow)}` : fmtTokens(promptTokens);
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border bg-panel px-2.5 py-1.5"
      title={`Session context: ${promptTokens.toLocaleString()}${
        contextWindow > 0 ? ` of ${contextWindow.toLocaleString()} tokens (${Math.round(pct)}%)` : ' tokens'
      }`}
    >
      <Gauge size={13} className="shrink-0 text-slate-500" />
      <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface sm:block">
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[11px] text-slate-400">{label}</span>
    </div>
  );
}

/**
 * Human-in-the-loop prompt: an agent called `ask_user` and its run is blocked until the operator
 * answers here. Rendered as a banner above the composer so the whole conversation stays visible.
 */
function AskUserPrompt({
  agent,
  question,
  onAnswer,
}: {
  agent: string;
  question: string;
  onAnswer: (answer: string) => void;
}) {
  const [reply, setReply] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  function submit() {
    const text = reply.trim();
    if (!text) return;
    onAnswer(text);
    setReply('');
  }

  return (
    <div className="border-t border-accent/40 bg-accent/5 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium" style={{ color: agentColor(agent).accent }}>
        <MessageCircleQuestion size={13} /> {agent} is asking you
      </div>
      <p className="mb-2 whitespace-pre-wrap px-1 text-sm text-slate-100">{question}</p>
      <div className="flex items-end gap-2 rounded-xl border border-accent/50 bg-panel px-3 py-2 focus-within:border-accent">
        <textarea
          ref={ref}
          rows={1}
          className="max-h-40 flex-1 resize-none bg-transparent py-1 text-sm text-slate-100 outline-none placeholder:text-slate-600"
          placeholder="Type your answer…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          onClick={submit}
          disabled={!reply.trim()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </div>
  );
}

/** Center column: the conversation plus the composer. Modern bubble layout with auto-scroll. */
export function ChatPanel({ agent, hasSession, debuggerOpen, onToggleDebugger, onOpenVisual, onSend }: Props) {
  const { turns, liveItems, liveFrames, frameStack, liveReasoning, streaming, contextUsage, pendingAsk, answerAsk, stop } =
    useStream();
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentName = agent?.name ?? 'agent';

  // Fold the flat live log into the nested block tree the same way `chat:done` persists it, so the
  // in-flight turn and the reloaded turn render through one identical code path.
  const liveBlocks = useMemo(
    () => buildBlocks('root', liveItems, liveFrames),
    [liveItems, liveFrames],
  );

  // The agent that currently owns the floor: the deepest open frame. When it's a delegated
  // sub-agent (not the root), the header calls it out so the user sees who is doing the work.
  const activeFrameId = frameStack[frameStack.length - 1];
  const activeAgent =
    activeFrameId && activeFrameId !== 'root' ? liveFrames[activeFrameId]?.agent : undefined;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, liveBlocks, liveReasoning, streaming]);

  function submit() {
    const text = input.trim();
    if (!text || !agent) return;
    onSend(text);
    setInput('');
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-panel">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-100">{agent?.name ?? 'Workspace'}</div>
          {streaming ? (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span
                className={`h-1.5 w-1.5 animate-pulse rounded-full ${activeAgent ? '' : 'bg-emerald-400'}`}
                style={activeAgent ? { background: agentColor(activeAgent).accent } : undefined}
              />
              {activeAgent ? (
                <span style={{ color: agentColor(activeAgent).accent }}>{activeAgent} working…</span>
              ) : (
                <span className="text-emerald-400">thinking…</span>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-slate-500">
              {hasSession ? 'Ready' : 'Select or start a session'}
            </div>
          )}
        </div>
        {hasSession && contextUsage && (
          <div className="ml-auto">
            <ContextMeter usage={contextUsage} />
          </div>
        )}
        {agent?.isolation_id && (
          <button
            onClick={onOpenVisual}
            title="Open the agent's live desktop (Visual)"
            className={[
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-panel hover:text-slate-200',
              !(hasSession && contextUsage) ? 'ml-auto' : '',
            ].join(' ')}
          >
            <Monitor size={14} /> Desktop
          </button>
        )}
        <button
          onClick={onToggleDebugger}
          className={[
            'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
            !(hasSession && contextUsage) && !agent?.isolation_id ? 'ml-auto' : '',
            debuggerOpen
              ? 'bg-reasoning/15 text-reasoning'
              : 'text-slate-400 hover:bg-panel hover:text-slate-200',
          ].join(' ')}
        >
          <Bug size={14} /> Debugger
        </button>
      </div>

      {/* Isolation warning: stopped / unbuilt container for the active agent (best-effort, self-hiding) */}
      <ContainerBanner agent={agent} />

      {/* Messages */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-6 py-6">
        {!hasSession ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-slate-500">
            <MessagesSquare size={40} className="mb-3 text-slate-700" />
            <p className="text-sm">Pick a session or start a new one to begin chatting.</p>
          </div>
        ) : (
          <>
            {turns.map((t, i) => (
              <MessageRow key={i} role={t.role} agentName={agentName}>
                {t.role === 'user' ? (
                  <span className="whitespace-pre-wrap break-words leading-relaxed">{t.blocks[0].text}</span>
                ) : (
                  <Blocks blocks={t.blocks} />
                )}
              </MessageRow>
            ))}
            {streaming && (
              <MessageRow role="assistant" agentName={agentName}>
                <Blocks blocks={liveBlocks} live />
                {/* Root spinner: shows the top-level agent's live activity, but stays silent while a
                    delegated sub-agent owns the floor (its own bubble spins instead). */}
                {activityLabel(liveBlocks) && (
                  <ThinkingRow
                    label={activityLabel(liveBlocks)!}
                    color={agentColor(agentName).accent}
                  />
                )}
              </MessageRow>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Human-in-the-loop prompt (an agent called ask_user) */}
      {pendingAsk && (
        <AskUserPrompt agent={pendingAsk.agent} question={pendingAsk.question} onAnswer={answerAsk} />
      )}

      {/* Composer */}
      <div className="border-t border-border bg-surface p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-panel px-3 py-2 focus-within:border-accent/60">
          <textarea
            rows={1}
            className="max-h-40 flex-1 resize-none bg-transparent py-1 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            placeholder={hasSession ? `Message ${agentName}…` : 'Start a session first…'}
            value={input}
            disabled={!hasSession}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {streaming ? (
            <button
              onClick={stop}
              title="Stop"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500 text-white transition-colors hover:bg-red-500/90"
            >
              <Square size={14} className="fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!hasSession || !input.trim()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SendHorizontal size={16} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
