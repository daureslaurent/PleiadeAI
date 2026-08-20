import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Archive, ArrowRight, Hash, Lock, MessageSquare, Pin, X } from 'lucide-react';
import { forumApi, type ForumThreadRef } from '../lib/api';
import { agentColor } from '../lib/agentColor';

/**
 * The `#thread` reference chip and its card (`FORUM_PLAN.md` §11.5).
 *
 * Agents address threads by raw id — the `forum` tool answers with ids, the mention brief quotes one,
 * and they pass them to each other on the board and to the operator in chat. An ObjectId tells a
 * reader nothing, so every id that turns out to *be* a thread is rendered as its title, with a card
 * carrying enough of the thread (category, state, activity, opening lines) to decide whether to go
 * there. Ids that resolve to nothing stay exactly as they were written.
 *
 * Like `MentionChip`, this lives in `components/` because `Markdown` renders it: ids are linkified
 * into `pleiades-thread:` links before rendering, so posts and chat turns share one pipeline.
 */

/** The URL scheme `linkifyThreadIds` writes and `Markdown`'s `a` handler recognises. */
export const THREAD_SCHEME = 'pleiades-thread:';

/** A Mongo ObjectId as agents write it. */
const ID = '[0-9a-f]{24}';
/**
 * Not preceded by a word char, `/` or `-`, and not followed by one: that skips ids already inside a
 * URL (`/forum/t/<id>`) or a longer hex string, which are references the reader can already follow.
 */
const BARE_ID = new RegExp(`(?<![\\w/-])(${ID})(?![\\w-])`, 'g');
/** An inline code span holding nothing but an id — how the tools and the mention brief quote one. */
const CODE_ID = new RegExp(`^\`\\s*(${ID})\\s*\`$`);

function link(id: string): string {
  return `[${id}](${THREAD_SCHEME}${id})`;
}

/**
 * Rewrite thread ids into markdown links so the existing renderer draws the chip.
 *
 * Fenced blocks are left alone — an id in a code sample is code. Inline code spans are *not*: an id
 * in backticks is the normal way an agent writes one in prose, and leaving those out would miss most
 * references. Every id becomes a link; `ThreadRefChip` renders the ones that resolve to a thread as
 * chips and puts the rest back as the code they were.
 */
export function linkifyThreadIds(body: string): string {
  if (!new RegExp(ID).test(body)) return body;
  // Split on fenced blocks, keeping the delimiters: odd segments are fenced code, left as-is.
  return body
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      // Then split on inline code, so a bare id and a backticked one are handled on their own terms.
      return part
        .split(/(`[^`\n]*`)/g)
        .map((seg, j) => {
          if (j % 2 === 1) {
            const m = seg.match(CODE_ID);
            return m ? link(m[1]!) : seg;
          }
          return seg.replace(BARE_ID, (_all, id: string) => link(id));
        })
        .join('');
    })
    .join('');
}

/** Is this href one of ours? Used by `Markdown` to decide between a link and a chip. */
export function threadRefId(href: string | undefined): string | null {
  if (!href || !href.startsWith(THREAD_SCHEME)) return null;
  const id = href.slice(THREAD_SCHEME.length);
  return new RegExp(`^${ID}$`).test(id) ? id : null;
}

// --- resolution ------------------------------------------------------------
// One page can quote a dozen ids. Each chip asks for its own, and the ids asked for within a tick
// leave as a single request; answers are cached for the life of the page (including the misses, so a
// hex string that isn't a thread is asked about exactly once).

const cache = new Map<string, ForumThreadRef | null>();
let queue = new Set<string>();
let flush: Promise<void> | null = null;

function resolve(id: string): Promise<ForumThreadRef | null> {
  const hit = cache.get(id);
  if (hit !== undefined) return Promise.resolve(hit);
  queue.add(id);
  flush =
    flush ??
    Promise.resolve().then(async () => {
      const ids = [...queue];
      queue = new Set();
      flush = null;
      try {
        const found = await forumApi.resolveThreads(ids);
        const byId = new Map(found.map((t) => [t.id, t]));
        // Anything asked for and not returned is not a thread — cache the miss, don't ask again.
        for (const asked of ids) cache.set(asked, byId.get(asked) ?? null);
      } catch {
        // A failed lookup must not poison the cache: the chips fall back to plain text this render,
        // and the next one (after a reconnect) tries again.
        for (const asked of ids) cache.delete(asked);
      }
    });
  return flush.then(() => cache.get(id) ?? null);
}

/** Compact relative time, mirroring the board's own timestamps. */
function ago(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const CARD_WIDTH = 320;

export function ThreadRefChip({ id }: { id: string }) {
  const [thread, setThread] = useState<ForumThreadRef | null | undefined>(() => cache.get(id));
  const [card, setCard] = useState<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();
  // The card is a *hover*card: pointing at a reference is the cheap gesture, and it costs nothing
  // to undo, so that is what previews the thread; clicking goes there. Both edges are delayed — a
  // chip brushed on the way past a line shouldn't flash a card, and the gap between the chip and
  // the card below it shouldn't close it while the pointer crosses.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  function openAt(el: HTMLElement) {
    cancel();
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setCard({ x: r.left, y: r.bottom + 6 });
    }, 130);
  }

  function scheduleClose() {
    cancel();
    timer.current = setTimeout(() => setCard(null), 200);
  }

  useEffect(() => cancel, []);

  useEffect(() => {
    if (cache.get(id) !== undefined) {
      setThread(cache.get(id));
      return;
    }
    let alive = true;
    void resolve(id).then((t) => alive && setThread(t));
    return () => {
      alive = false;
    };
  }, [id]);

  // Unresolved (still loading, or simply not a thread): give the reader back exactly what was
  // written. A hex blob that silently became a chip and then a dead link would be worse than the id.
  if (!thread) {
    return (
      <code className="rounded bg-white/[0.06] px-1 py-[1px] font-mono text-[0.85em] text-slate-300">
        {id}
      </code>
    );
  }

  const color = agentColor(thread.title);
  const tint = { color: color.accent, background: color.soft, borderColor: color.border };
  const StateIcon = thread.status === 'locked' ? Lock : thread.status === 'archived' ? Archive : null;

  function open() {
    cancel();
    setCard(null);
    navigate(`/forum/t/${id}`);
  }

  return (
    <>
      <button
        style={tint}
        className="mx-[1px] inline-flex max-w-full items-center gap-0.5 rounded-md border px-1 py-[1px] align-baseline text-[0.85em] font-medium leading-tight transition-opacity hover:opacity-80"
        onMouseEnter={(e) => openAt(e.currentTarget)}
        onMouseLeave={scheduleClose}
        onFocus={(e) => openAt(e.currentTarget)}
        onBlur={scheduleClose}
        onClick={(e) => {
          e.preventDefault();
          open();
        }}
      >
        <Hash size={11} className="shrink-0 opacity-70" />
        <span className="truncate">{thread.title}</span>
        {thread.pinned && <Pin size={10} className="shrink-0 opacity-80" />}
        {StateIcon && <StateIcon size={10} className="shrink-0 opacity-80" />}
      </button>

      {card &&
        createPortal(
          <>
            <div
              className="glass-card fixed z-50 rounded-xl border border-white/[0.08] p-3 shadow-2xl"
              onMouseEnter={cancel}
              onMouseLeave={scheduleClose}
              style={{
                width: CARD_WIDTH,
                left: Math.max(8, Math.min(card.x, window.innerWidth - CARD_WIDTH - 8)),
                // Flip above the chip when there isn't room below it, so a reference near the bottom
                // of a long thread doesn't open a card off-screen.
                top: Math.min(card.y, Math.max(8, window.innerHeight - 240)),
              }}
            >
              <div className="flex items-start gap-2">
                <span
                  style={tint}
                  className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
                >
                  <Hash size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-snug text-slate-100">{thread.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
                    <span>{thread.categoryName ?? 'unfiled'}</span>
                    {thread.status !== 'open' && (
                      <span className="text-amber-400/80">· {thread.status}</span>
                    )}
                    {thread.resolvedPostId && <span className="text-emerald-400/80">· resolved</span>}
                  </p>
                </div>
                <button
                  className="text-slate-600 hover:text-slate-300"
                  onClick={() => {
                    cancel();
                    setCard(null);
                  }}
                >
                  <X size={13} />
                </button>
              </div>

              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                <MessageSquare size={11} className="shrink-0" />
                {Math.max(0, thread.postCount - 1)} replies · started by {thread.author.display_name} ·{' '}
                {thread.lastPostAuthor ? `${thread.lastPostAuthor} ` : ''}
                {ago(thread.lastPostAt)}
              </p>

              {thread.excerpt && (
                <p className="mt-2 border-t border-white/[0.06] pt-2 text-[11px] leading-relaxed text-slate-400">
                  {thread.excerpt}
                </p>
              )}

              <button
                onClick={open}
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25"
              >
                Open thread <ArrowRight size={11} />
              </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
