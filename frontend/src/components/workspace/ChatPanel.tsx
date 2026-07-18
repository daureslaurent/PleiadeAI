import { useEffect, useMemo, useRef, useState } from 'react';
import { SendHorizontal, Bug, MessagesSquare, Gauge, MessageCircleQuestion, Square, Monitor, ImagePlus, X, Play, Repeat, Pencil, Mic } from 'lucide-react';
import { Blocks, ThinkingRow, activityLabel } from './Blocks';
import { ContainerBanner } from './ContainerBanner';
import { TodoPanel } from './TodoPanel';
import { useStream, buildBlocks, type ContextUsage, type RecalledMemory, type Turn, type TurnScore } from '../../store/stream';
import { agentColor, agentIcon, agentInitial } from '../../lib/agentColor';
import { iconFor } from '../../lib/agentIcons';
import { ScoreBadge } from '../ScoreBadge';
import { MemoriesBadge } from '../MemoriesBadge';
import type { Agent } from '../../lib/api';

/**
 * Hybrid message layout: the user speaks in a compact right-aligned gradient bubble; the agent
 * answers full-width, document-style (avatar + name header, then an open content column) so
 * tool cards, sub-agent bubbles, and code get the whole line to breathe.
 *
 * In a *generated* conversation the right-hand speaker isn't the operator but the Conversation
 * Generator's interviewer, so the bubble is named and re-tinted — the layout is the same chat, but it
 * must never read as something the operator said.
 */
function MessageRow({
  role,
  agentName,
  score,
  memories,
  generated,
  children,
}: {
  role: Turn['role'];
  agentName: string;
  /** Conversation Quality score for an assistant turn (renders a tiny badge next to the name). */
  score?: TurnScore;
  /** Memories auto-recalled into this turn's prompt — an inspectable pill next to the name. */
  memories?: RecalledMemory[];
  /** This session was produced by the Conversation Generator → the "user" turns are the interviewer. */
  generated?: boolean;
  children: React.ReactNode;
}) {
  if (role === 'user') {
    return (
      <div className="flex animate-fade-up flex-col items-end pl-10">
        {generated && (
          <div className="mb-1 flex items-center gap-1 pr-1 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-300/80">
            <Mic size={11} /> Interviewer
          </div>
        )}
        <div
          className={`min-w-0 max-w-[78%] overflow-hidden break-words rounded-2xl rounded-br-md px-4 py-2.5 text-sm text-white ${
            generated
              ? 'bg-gradient-to-br from-fuchsia-500/80 via-fuchsia-500/65 to-purple-500/70 shadow-[0_4px_20px_rgba(217,70,239,0.22)]'
              : 'bg-gradient-to-br from-accent/90 via-accent/75 to-indigo-500/80 shadow-[0_4px_20px_rgba(59,130,246,0.25)]'
          }`}
        >
          {children}
        </div>
      </div>
    );
  }
  // Agent: full-width document flow, its identity color threading avatar → name → glow.
  const color = agentColor(agentName);
  const Icon = iconFor(agentIcon(agentName));
  return (
    <div className="animate-fade-up">
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-slate-950 shadow-[0_0_12px_var(--glow)]"
          style={{ background: color.accent, ['--glow' as string]: `${color.accent}55` }}
        >
          {Icon ? <Icon size={15} /> : agentInitial(agentName)}
        </span>
        <span className="text-xs font-semibold tracking-wide" style={{ color: color.accent }}>
          {agentName}
        </span>
        {score && <ScoreBadge score={score} size="xs" />}
        {memories && memories.length > 0 && <MemoriesBadge memories={memories} />}
      </div>
      <div className="min-w-0 overflow-hidden break-words pl-9 text-sm text-slate-100">
        {children}
      </div>
    </div>
  );
}

interface Props {
  agent: Agent | null;
  hasSession: boolean;
  /** The open session was produced by the Conversation Generator (its "user" turns are the interviewer). */
  generatedSession?: boolean;
  debuggerOpen: boolean;
  onToggleDebugger: () => void;
  onOpenVisual: () => void;
  onSend: (text: string, images?: string[]) => void;
}

/**
 * Read image files into downscaled JPEG data URLs (longest side ≤ MAX_DIM) so payloads stay sane for
 * the socket + persistence while keeping enough resolution for the vision model.
 */
const MAX_DIM = 1568;
async function fileToDataUrl(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null;
  const raw = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('decode failed'));
    im.src = raw;
  });
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  if (scale === 1 && raw.length < 500_000) return raw; // small enough already
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return raw;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Default nudge sent by the Continue button / auto-continue. Editable + persisted per browser. */
const DEFAULT_CONTINUE = 'Continue where you left off and complete the task. Do not stop until it is done.';
const CONTINUE_KEY = 'pleiades.continuePhrase';
/** Safety ceiling on consecutive auto-continues so a stuck agent can't loop forever unattended. */
const MAX_AUTO_CONTINUE = 25;

/** Compact tokens value: 1234 → "1.2K", 512 → "512". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n);
}

/**
 * Session context-size meter for the chat header. Two readings against the model's real context
 * window (n_ctx):
 *  - `total` (blue): the last completed turn's peak — the settled size, persisted and restored.
 *  - `live` (amber): the in-flight size while a turn runs, climbing per tool iteration. When present
 *    it takes over the fill and the label, and a faint "ghost" tick marks where `total` sits so you
 *    can see the current turn grow past (or start below) the previous total. It clears on turn end,
 *    letting the blue total retake the bar.
 */
function ContextMeter({ total, live }: { total: ContextUsage | null; live: ContextUsage | null }) {
  const contextWindow = total?.contextWindow || live?.contextWindow || 0;
  const totalTokens = total?.promptTokens ?? 0;
  const totalPct = contextWindow > 0 ? Math.min(100, (totalTokens / contextWindow) * 100) : 0;

  const liveActive = live != null;
  const shownTokens = liveActive ? live.promptTokens : totalTokens;
  const shownPct = contextWindow > 0 ? Math.min(100, (shownTokens / contextWindow) * 100) : 0;

  // Blue while settled; amber for the live overlay; both warm to red near the ceiling.
  const tone = shownPct >= 90 ? 'bg-red-500' : liveActive ? 'bg-amber-500' : shownPct >= 75 ? 'bg-amber-500' : 'bg-accent';
  const label = contextWindow > 0 ? `${fmtTokens(shownTokens)} / ${fmtTokens(contextWindow)}` : fmtTokens(shownTokens);

  return (
    <div
      className="glass flex items-center gap-2 rounded-full border px-3 py-1.5"
      title={`Session context: ${shownTokens.toLocaleString()}${
        contextWindow > 0 ? ` of ${contextWindow.toLocaleString()} tokens (${Math.round(shownPct)}%)` : ' tokens'
      }${liveActive ? ` — live this turn (last total ${totalTokens.toLocaleString()})` : ''}`}
    >
      <Gauge size={13} className={`shrink-0 ${liveActive ? 'text-amber-400' : 'text-slate-500'}`} />
      <div className="relative hidden h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.06] sm:block">
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${shownPct}%` }} />
        {/* Ghost tick at the settled total, shown only while a live reading is overlaying it. */}
        {liveActive && contextWindow > 0 && (
          <div className="absolute top-0 h-full w-px bg-slate-400/70" style={{ left: `${totalPct}%` }} />
        )}
      </div>
      <span className={`font-mono text-[11px] ${liveActive ? 'text-amber-400' : 'text-slate-400'}`}>{label}</span>
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
    <div className="px-4 pt-3">
      <div
        className="glass-card mx-auto max-w-3xl animate-fade-up rounded-2xl border p-3 animate-glow-pulse"
        style={{ ['--glow' as string]: `${agentColor(agent).accent}30` }}
      >
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium" style={{ color: agentColor(agent).accent }}>
          <MessageCircleQuestion size={13} /> {agent} is asking you
        </div>
        <p className="mb-2 whitespace-pre-wrap px-1 text-sm text-slate-100">{question}</p>
        <div className="flex items-end gap-2 rounded-xl border border-accent/40 bg-black/20 px-3 py-2 transition-colors focus-within:border-accent">
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition-all hover:bg-accent/90 hover:shadow-[0_0_14px_rgba(59,130,246,0.5)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendHorizontal size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Center column: the conversation plus the composer. Modern bubble layout with auto-scroll. */
export function ChatPanel({ agent, hasSession, generatedSession, debuggerOpen, onToggleDebugger, onOpenVisual, onSend }: Props) {
  const { turns, liveItems, liveFrames, frameStack, liveReasoning, streaming, contextUsage, liveContext, pendingAsk, lastTurnTruncated, todos, activeSessionId, answerAsk, stop } =
    useStream();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Continue controls: the (editable, persisted) nudge text and the auto-continue toggle.
  const [continuePhrase, setContinuePhrase] = useState(
    () => localStorage.getItem(CONTINUE_KEY) || DEFAULT_CONTINUE,
  );
  const [autoContinue, setAutoContinue] = useState(false);
  const [editingContinue, setEditingContinue] = useState(false);
  // Budget for consecutive auto-continues; reset on any manual send / toggle-off.
  const autoCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentName = agent?.name ?? 'agent';

  async function addFiles(files: Iterable<File>) {
    const urls = (await Promise.all([...files].map(fileToDataUrl))).filter(
      (u): u is string => Boolean(u),
    );
    if (urls.length) setAttachments((a) => [...a, ...urls]);
  }

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

  // Persist the continue phrase so the operator's wording survives reloads.
  useEffect(() => {
    localStorage.setItem(CONTINUE_KEY, continuePhrase);
  }, [continuePhrase]);

  // Whether the composer's continue controls apply right now: idle, with history, and not blocked on
  // an ask_user prompt (which has its own answer box).
  const canContinue = hasSession && !streaming && !pendingAsk && turns.length > 0;

  function continueNow() {
    const text = continuePhrase.trim();
    if (!agent || !text) return;
    autoCountRef.current = 0; // a manual continue refreshes the auto budget
    onSend(text);
  }

  // Auto-continue: when armed, re-nudge the agent each time it stops *mid-task* (the backend's
  // `truncated` signal), never after a clean finish — up to a safety budget. Fires as the run ends;
  // `onSend` clears `lastTurnTruncated` and starts the next turn, so this won't double-fire.
  useEffect(() => {
    if (!autoContinue) {
      autoCountRef.current = 0;
      return;
    }
    if (streaming || !lastTurnTruncated || !canContinue) return;
    if (autoCountRef.current >= MAX_AUTO_CONTINUE) return;
    const text = continuePhrase.trim();
    if (!text) return;
    autoCountRef.current += 1;
    onSend(text);
  }, [autoContinue, streaming, lastTurnTruncated, canContinue, continuePhrase, onSend]);

  function submit() {
    const text = input.trim();
    if (!agent || (!text && attachments.length === 0)) return;
    autoCountRef.current = 0; // a fresh manual message refreshes the auto budget
    onSend(text, attachments.length ? attachments : undefined);
    setInput('');
    setAttachments([]);
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {/* Header — frosted glass floating over the starfield */}
      <div className="glass z-10 flex items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-wide text-slate-100">
            {agent?.name ?? 'Workspace'}
          </div>
          {streaming ? (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span
                className={`h-1.5 w-1.5 animate-pulse rounded-full ${activeAgent ? '' : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'}`}
                style={
                  activeAgent
                    ? {
                        background: agentColor(activeAgent).accent,
                        boxShadow: `0 0 8px ${agentColor(activeAgent).accent}`,
                      }
                    : undefined
                }
              />
              {activeAgent ? (
                <span className="text-shimmer" style={{ color: agentColor(activeAgent).accent }}>
                  {activeAgent} working…
                </span>
              ) : (
                <span className="text-shimmer text-emerald-400">thinking…</span>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-slate-500">
              {hasSession ? 'Ready' : 'Select or start a session'}
            </div>
          )}
        </div>
        {hasSession && (contextUsage || liveContext) && (
          <div className="ml-auto">
            <ContextMeter total={contextUsage} live={liveContext} />
          </div>
        )}
        {agent?.visual && (
          <button
            onClick={onOpenVisual}
            title="Open the agent's live desktop (Visual)"
            className={[
              'flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200',
              !(hasSession && (contextUsage || liveContext)) ? 'ml-auto' : '',
            ].join(' ')}
          >
            <Monitor size={14} /> Desktop
          </button>
        )}
        <button
          onClick={onToggleDebugger}
          className={[
            'flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition-colors',
            !(hasSession && (contextUsage || liveContext)) && !agent?.visual ? 'ml-auto' : '',
            debuggerOpen
              ? 'bg-reasoning/15 text-reasoning shadow-[0_0_12px_rgba(168,85,247,0.2)]'
              : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200',
          ].join(' ')}
        >
          <Bug size={14} /> Debugger
        </button>
      </div>

      {/* Isolation warning: stopped / unbuilt container for the active agent (best-effort, self-hiding) */}
      <ContainerBanner agent={agent} />

      {/* Messages — a centered reading column floating over the starfield */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-6">
        {!hasSession ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-slate-500">
            <div className="relative mb-4">
              <div className="absolute inset-0 rounded-full bg-accent/20 blur-2xl" />
              <MessagesSquare size={40} className="relative text-slate-600" />
            </div>
            <p className="text-sm">Pick a session or start a new one to begin chatting.</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {turns.map((t, i) => (
              <MessageRow
                key={i}
                role={t.role}
                agentName={agentName}
                generated={generatedSession}
                score={t.role === 'assistant' ? t.score : undefined}
                memories={t.role === 'assistant' ? t.memories : undefined}
              >
                {t.role === 'user' ? (
                  <div className="space-y-1.5">
                    {t.images && t.images.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {t.images.map((src, j) => (
                          <a key={j} href={src} target="_blank" rel="noreferrer">
                            <img
                              src={src}
                              alt={`attachment ${j + 1}`}
                              className="max-h-40 rounded-md border border-border object-contain"
                            />
                          </a>
                        ))}
                      </div>
                    )}
                    {t.blocks[0].text && (
                      <span className="whitespace-pre-wrap break-words leading-relaxed">{t.blocks[0].text}</span>
                    )}
                  </div>
                ) : (
                  <Blocks blocks={t.blocks} />
                )}
              </MessageRow>
            ))}
            {streaming && (
              <MessageRow role="assistant" agentName={agentName} memories={liveFrames.root?.memories}>
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
          </div>
        )}
      </div>

      {/* The agent's live plan, pinned so steps stay visible while the turn runs */}
      {activeSessionId && <TodoPanel items={todos} sessionId={activeSessionId} />}

      {/* Human-in-the-loop prompt (an agent called ask_user) */}
      {pendingAsk && (
        <AskUserPrompt agent={pendingAsk.agent} question={pendingAsk.question} onAnswer={answerAsk} />
      )}

      {/* Composer — a floating glass card, not a full-bleed bar */}
      <div className="px-4 pb-4 pt-3">
        <div
          className={[
            'glass-card mx-auto max-w-3xl rounded-2xl border px-3 py-2 transition-all duration-300',
            dragOver
              ? 'border-accent shadow-[0_0_24px_rgba(59,130,246,0.35)]'
              : 'focus-within:border-accent/50 focus-within:shadow-[0_0_20px_rgba(59,130,246,0.18)]',
          ].join(' ')}
          onDragOver={(e) => {
            if (!hasSession) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (!hasSession) return;
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
          }}
        >
          {/* Attachment thumbnails */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((src, i) => (
                <div key={i} className="group relative h-16 w-16 overflow-hidden rounded-md border border-border">
                  <img src={src} alt={`attachment ${i + 1}`} className="h-full w-full object-cover" />
                  <button
                    onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                    title="Remove"
                    className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!hasSession}
              title="Attach image"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ImagePlus size={17} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <textarea
              rows={1}
              className="max-h-40 flex-1 resize-none bg-transparent py-1 text-sm text-slate-100 outline-none placeholder:text-slate-600"
              placeholder={hasSession ? `Message ${agentName}… (drop or paste an image)` : 'Start a session first…'}
              value={input}
              disabled={!hasSession}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = [...e.clipboardData.items]
                  .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => Boolean(f));
                if (files.length) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
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
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500 text-white transition-all animate-glow-pulse hover:bg-red-500/90"
                style={{ ['--glow' as string]: 'rgba(239,68,68,0.4)' }}
              >
                <Square size={14} className="fill-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!hasSession || (!input.trim() && attachments.length === 0)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent via-indigo-500 to-reasoning bg-[length:200%_200%] text-white transition-all animate-gradient-x hover:shadow-[0_0_16px_rgba(99,102,241,0.5)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-none"
              >
                <SendHorizontal size={16} />
              </button>
            )}
          </div>

          {/* Continue controls: nudge a stalled agent onward. Manual button + auto-continue toggle;
              the pencil edits the (persisted) message. Only shown when idle with history. */}
          {canContinue && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2">
              <button
                onClick={continueNow}
                title="Send the continue message to resume the agent"
                className={[
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  lastTurnTruncated
                    ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
                    : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200',
                ].join(' ')}
              >
                <Play size={13} /> Continue
              </button>
              <button
                onClick={() => setAutoContinue((a) => !a)}
                aria-pressed={autoContinue}
                title="Auto-continue: re-send the continue message whenever the agent stops mid-task (up to a safety limit)"
                className={[
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  autoContinue
                    ? 'bg-accent/15 text-accent hover:bg-accent/25'
                    : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200',
                ].join(' ')}
              >
                <Repeat size={13} /> Auto{autoContinue ? ' on' : ''}
              </button>
              <button
                onClick={() => setEditingContinue((o) => !o)}
                title="Edit the continue message"
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
              >
                <Pencil size={13} />
              </button>
              {lastTurnTruncated && (
                <span className="ml-auto text-[11px] text-amber-500/80">
                  stopped mid-task — hit the tool-step limit
                </span>
              )}
            </div>
          )}

          {canContinue && editingContinue && (
            <textarea
              value={continuePhrase}
              onChange={(e) => setContinuePhrase(e.target.value)}
              rows={2}
              placeholder={DEFAULT_CONTINUE}
              className="mt-2 w-full resize-none rounded-md border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-200 outline-none focus:border-accent/60"
            />
          )}
        </div>
      </div>
    </section>
  );
}
