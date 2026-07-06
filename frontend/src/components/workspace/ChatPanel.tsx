import { useEffect, useMemo, useRef, useState } from 'react';
import { SendHorizontal, Bug, MessagesSquare, Gauge, MessageCircleQuestion, Square, Monitor, ImagePlus, X, Play, Repeat, Pencil } from 'lucide-react';
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
const CONTINUE_KEY = 'pleiade.continuePhrase';
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
      className="flex items-center gap-2 rounded-md border border-border bg-panel px-2.5 py-1.5"
      title={`Session context: ${shownTokens.toLocaleString()}${
        contextWindow > 0 ? ` of ${contextWindow.toLocaleString()} tokens (${Math.round(shownPct)}%)` : ' tokens'
      }${liveActive ? ` — live this turn (last total ${totalTokens.toLocaleString()})` : ''}`}
    >
      <Gauge size={13} className={`shrink-0 ${liveActive ? 'text-amber-500' : 'text-slate-500'}`} />
      <div className="relative hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface sm:block">
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${shownPct}%` }} />
        {/* Ghost tick at the settled total, shown only while a live reading is overlaying it. */}
        {liveActive && contextWindow > 0 && (
          <div className="absolute top-0 h-full w-px bg-slate-400/70" style={{ left: `${totalPct}%` }} />
        )}
      </div>
      <span className={`font-mono text-[11px] ${liveActive ? 'text-amber-500' : 'text-slate-400'}`}>{label}</span>
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
  const { turns, liveItems, liveFrames, frameStack, liveReasoning, streaming, contextUsage, liveContext, pendingAsk, lastTurnTruncated, answerAsk, stop } =
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
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-panel hover:text-slate-200',
              !(hasSession && (contextUsage || liveContext)) ? 'ml-auto' : '',
            ].join(' ')}
          >
            <Monitor size={14} /> Desktop
          </button>
        )}
        <button
          onClick={onToggleDebugger}
          className={[
            'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
            !(hasSession && (contextUsage || liveContext)) && !agent?.visual ? 'ml-auto' : '',
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
        <div
          className={[
            'rounded-xl border bg-panel px-3 py-2 transition-colors',
            dragOver ? 'border-accent bg-accent/5' : 'border-border focus-within:border-accent/60',
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
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
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
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500 text-white transition-colors hover:bg-red-500/90"
              >
                <Square size={14} className="fill-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!hasSession || (!input.trim() && attachments.length === 0)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SendHorizontal size={16} />
              </button>
            )}
          </div>

          {/* Continue controls: nudge a stalled agent onward. Manual button + auto-continue toggle;
              the pencil edits the (persisted) message. Only shown when idle with history. */}
          {canContinue && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
              <button
                onClick={continueNow}
                title="Send the continue message to resume the agent"
                className={[
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  lastTurnTruncated
                    ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200',
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
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200',
                ].join(' ')}
              >
                <Repeat size={13} /> Auto{autoContinue ? ' on' : ''}
              </button>
              <button
                onClick={() => setEditingContinue((o) => !o)}
                title="Edit the continue message"
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
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
              className="mt-2 w-full resize-none rounded-md border border-border bg-panel px-3 py-2 text-xs text-slate-200 outline-none focus:border-accent/60"
            />
          )}
        </div>
      </div>
    </section>
  );
}
