import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AtSign, BellOff, CheckCircle2, CornerUpLeft, Loader2, MessageSquare, Play, X } from 'lucide-react';
import { agentColor, agentInitial } from '../lib/agentColor';
import type { ForumMention } from '../lib/api';

/**
 * The `@name` chip and its hovercard (`FORUM_PLAN.md` §11.4).
 *
 * A mention is *read* inside a post, so that is where it should be answerable — the alternative is
 * an operator who sees "@scout, is this the same bug?" and then has to go find the same mention in a
 * list somewhere to act on it.
 *
 * The chip lives in `components/` rather than in the forum views because `Markdown` renders it:
 * mentions are linkified into `mention:` links before rendering, and the markdown `a` handler swaps
 * them for this. That keeps one markdown pipeline instead of a second one for post bodies.
 */

export interface MentionActions {
  /** The mentions raised by the post being rendered, keyed by target name (lower-cased). */
  byName: Map<string, ForumMention>;
  onRun?: (mention: ForumMention) => Promise<void> | void;
  onDismiss?: (mention: ForumMention) => Promise<void> | void;
  onOpenSession?: (mention: ForumMention) => void;
}

const MentionContext = createContext<MentionActions | null>(null);

export function MentionProvider({ value, children }: { value: MentionActions; children: ReactNode }) {
  return <MentionContext.Provider value={value}>{children}</MentionContext.Provider>;
}

/** The URL scheme `linkifyMentions` writes and `Markdown`'s `a` handler recognises. */
export const MENTION_SCHEME = 'pleiades-mention:';

/**
 * Rewrite `@name` into a markdown link so the existing renderer draws the chip.
 *
 * Only *known* names are rewritten, and code spans and fenced blocks are skipped — a board about
 * software is full of `@override` and `user@host`, and a chip on either is a small lie about who was
 * addressed. Longest name first, so `@image smith` can't be eaten by an agent called `image`.
 */
export function linkifyMentions(body: string, names: string[]): string {
  if (!names.length) return body;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  // Split on fenced blocks and inline code, keeping the delimiters: odd segments are code, left as-is.
  const parts = body.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = '';
      let i2 = 0;
      outer: while (i2 < part.length) {
        if (part[i2] === '@' && (i2 === 0 || /[\s([{<,;:"'\n]/.test(part[i2 - 1]!))) {
          for (const name of sorted) {
            const end = i2 + 1 + name.length;
            if (
              part.slice(i2 + 1, end).toLowerCase() === name.toLowerCase() &&
              !/[A-Za-z0-9_-]/.test(part[end] ?? '')
            ) {
              out += `[@${part.slice(i2 + 1, end)}](${MENTION_SCHEME}${encodeURIComponent(name)})`;
              i2 = end;
              continue outer;
            }
          }
        }
        out += part[i2];
        i2++;
      }
      return out;
    })
    .join('');
}

/** Is this href one of ours? Used by `Markdown` to decide between a link and a chip. */
export function mentionName(href: string | undefined): string | null {
  if (!href || !href.startsWith(MENTION_SCHEME)) return null;
  try {
    return decodeURIComponent(href.slice(MENTION_SCHEME.length));
  } catch {
    return href.slice(MENTION_SCHEME.length);
  }
}

const STATUS_LABEL: Record<ForumMention['status'], string> = {
  pending: 'waiting on you',
  answered: 'answered',
  dismissed: 'dismissed',
};

export function MentionChip({ name }: { name: string }) {
  const ctx = useContext(MentionContext);
  const [card, setCard] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const mention = ctx?.byName.get(name.toLowerCase()) ?? null;
  const operator = name.toLowerCase() === 'operator';
  const color = agentColor(name);
  const muted = mention ? !mention.notified : false;
  const answered = mention?.status === 'answered';

  const tint = operator
    ? { color: 'rgb(147 197 253)', background: 'rgba(59,130,246,0.14)', borderColor: 'rgba(59,130,246,0.35)' }
    : { color: color.accent, background: color.soft, borderColor: color.border };

  async function act(fn?: (m: ForumMention) => Promise<void> | void) {
    if (!mention || !fn) return;
    setBusy(true);
    try {
      await fn(mention);
      setCard(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        style={tint}
        className="mx-[1px] inline-flex items-center gap-0.5 rounded-md border px-1 py-[1px] align-baseline text-[0.85em] font-medium leading-tight transition-opacity hover:opacity-80"
        title={mention ? `${name} — ${STATUS_LABEL[mention.status]}` : name}
        onClick={(e) => {
          e.preventDefault();
          const r = (e.target as HTMLElement).getBoundingClientRect();
          setCard((c) => (c ? null : { x: r.left, y: r.bottom + 6 }));
        }}
      >
        <AtSign size={11} className="opacity-70" />
        {name}
        {muted && <BellOff size={10} className="opacity-70" />}
        {answered && <CheckCircle2 size={10} className="opacity-80" />}
      </button>

      {card &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setCard(null)} />
            <div
              className="glass-card fixed z-50 w-72 rounded-xl border border-white/[0.08] p-3 shadow-2xl"
              style={{ left: Math.min(card.x, window.innerWidth - 300), top: card.y }}
            >
              <div className="flex items-center gap-2">
                <span
                  style={tint}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold"
                >
                  {agentInitial(name)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" style={{ color: tint.color }}>
                    {name}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    {operator ? 'operator' : 'agent'}
                    {mention ? ` · ${STATUS_LABEL[mention.status]}` : ' · not recorded'}
                  </p>
                </div>
                <button className="ml-auto text-slate-600 hover:text-slate-300" onClick={() => setCard(null)}>
                  <X size={13} />
                </button>
              </div>

              {muted && (
                <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] p-2 text-[11px] text-amber-300/90">
                  <BellOff size={11} className="mt-0.5 shrink-0" />
                  Mentions are muted for this agent — it was recorded, but raised no alert. It still
                  reaches the agent on its next turn.
                </p>
              )}

              {!mention ? (
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  Written before mentions existed, or the post was edited afterwards. Nothing to run —
                  mention them in a reply to page them.
                </p>
              ) : operator ? (
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  That's you. Answer it in the thread below.
                </p>
              ) : (
                <div className="mt-2.5 space-y-1.5">
                  {mention.status === 'pending' && (
                    <p className="text-[11px] leading-relaxed text-slate-500">
                      Running opens a new conversation with {name} in Chat, and posts its answer back
                      to this thread as a reply.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {mention.status !== 'answered' && (
                      <button
                        disabled={busy}
                        onClick={() => void act(ctx?.onRun)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                        Run
                      </button>
                    )}
                    {mention.status === 'pending' && (
                      <button
                        disabled={busy}
                        onClick={() => void act(ctx?.onDismiss)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                      >
                        <CornerUpLeft size={11} /> Dismiss
                      </button>
                    )}
                    {mention.sessionId && (
                      <button
                        onClick={() => {
                          ctx?.onOpenSession?.(mention);
                          setCard(null);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-2 py-1 text-[11px] text-slate-400 transition-colors hover:bg-white/[0.06]"
                      >
                        <MessageSquare size={11} /> Open conversation
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
