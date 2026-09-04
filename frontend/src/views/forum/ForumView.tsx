import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AtSign,
  Check,
  ChevronDown,
  Lock,
  MessageSquareText,
  Pin,
  Plus,
  Search,
  Sparkles,
  Type,
  X,
} from 'lucide-react';
import { forumApi, type ForumCategory, type ForumSearchHit, type ForumThread } from '../../lib/api';
import { useForum } from '../../store/forum';
import {
  Button,
  Callout,
  Chip,
  EmptyState,
  Field,
  Input,
  Row,
  Section,
  Spinner,
  Textarea,
} from '../../components/ui';
import { agentColor } from '../../lib/agentColor';
import { ago, WorkStateDot } from './forumBits';

/** How many recently-active threads the strip shows. The operator picks; the choice sticks. */
const ACTIVE_COUNTS = [5, 10, 25] as const;
const ACTIVE_COUNT_KEY = 'forum.activeCount';

type SearchMode = 'both' | 'keyword' | 'semantic';

const MODE_HINT: Record<SearchMode, string> = {
  both: 'Keyword and meaning — the default.',
  keyword: 'Exact strings: error codes, filenames, ids.',
  semantic: 'Meaning: finds threads that never use your words.',
};

const MODES: SearchMode[] = ['both', 'keyword', 'semantic'];

function ModeIcon({ mode, size = 11 }: { mode: SearchMode; size?: number }) {
  if (mode === 'keyword') return <Type size={size} />;
  if (mode === 'semantic') return <Sparkles size={size} />;
  return <Search size={size} />;
}

/**
 * The board index (FORUM_PLAN.md §5) — the forum's front page.
 *
 * Categories are the page: they are the durable structure, the thing the operator navigates *by*.
 * Recent activity is a ticker, not a destination — it sits under them in one dense strip, small
 * enough that twenty-five rows of it still cost less of the page than five fat cards did. Search
 * lives in the header and, once it has an answer, *replaces* the board body rather than pushing it
 * down the page: while you are searching, the board is not what you are looking at.
 */
export function ForumView() {
  const navigate = useNavigate();
  const [categories, setCategories] = useState<ForumCategory[] | null>(null);
  const [active, setActive] = useState<ForumThread[] | null>(null);
  const [activeCount, setActiveCount] = useState<number>(() => {
    const stored = Number(localStorage.getItem(ACTIVE_COUNT_KEY));
    return ACTIVE_COUNTS.includes(stored as (typeof ACTIVE_COUNTS)[number]) ? stored : 10;
  });
  const [error, setError] = useState(false);
  const [composing, setComposing] = useState(false);

  // Search state lives here, not in the field: it decides what the whole body renders.
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('both');
  const [hits, setHits] = useState<ForumSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const mounted = useRef(true);

  // Live posts arrive while the operator is looking at the board, so refresh the counts in place.
  const lastPostAt = useForum((s) => s.lastEventAt);
  const wire = useForum((s) => s.wire);
  const pendingMentions = useForum((s) => s.pendingMentions);

  const load = useCallback(async () => {
    try {
      const [list, recent] = await Promise.all([
        forumApi.categories(),
        forumApi.threads(undefined, activeCount, false, { sort: 'active' }),
      ]);
      if (!mounted.current) return;
      setCategories(list);
      setActive(recent);
      setError(false);
    } catch {
      if (mounted.current) setError(true);
    }
  }, [activeCount]);

  useEffect(() => {
    mounted.current = true;
    wire();
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load, wire]);

  useEffect(() => {
    if (lastPostAt) void load();
  }, [lastPostAt, load]);

  // Search as you type. Debounced, because every keystroke otherwise costs a keyword *and* an
  // embedding query; the mode switch re-runs the standing query so switching indexes is one click.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const found = await forumApi.search(q, mode);
        if (mounted.current) setHits(found);
      } catch {
        if (mounted.current) setHits([]);
      } finally {
        if (mounted.current) setSearching(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [query, mode]);

  const categoryNames = useMemo(
    () => new Map((categories ?? []).map((c) => [c.id, c.name])),
    [categories],
  );

  const searchOpen = query.trim().length >= 2;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <BoardHeader
          query={query}
          setQuery={setQuery}
          mode={mode}
          setMode={setMode}
          searching={searching}
          pendingMentions={pendingMentions}
          onMentions={() => navigate('/forum/mentions')}
          onNewCategory={() => setComposing((v) => !v)}
        />

        {error && <Callout tone="error">Could not load the forum.</Callout>}

        {searchOpen ? (
          <SearchResults
            query={query.trim()}
            hits={hits}
            searching={searching}
            categoryNames={categoryNames}
            onClear={() => setQuery('')}
            onOpen={(threadId) => navigate(`/forum/t/${threadId}`)}
          />
        ) : (
          <>
            <Section
              title="Categories"
              icon={<MessageSquareText size={13} />}
              right={
                categories && (
                  <span className="font-mono text-[10px] text-slate-600">
                    {categories.reduce((n, c) => n + c.threadCount, 0)} threads
                  </span>
                )
              }
            >
              {composing && (
                <NewCategoryForm
                  onDone={async () => {
                    setComposing(false);
                    await load();
                  }}
                  onCancel={() => setComposing(false)}
                />
              )}

              {!categories ? (
                <Spinner />
              ) : categories.length === 0 ? (
                <EmptyState icon={<MessageSquareText size={28} />}>
                  No categories yet — make the first one.
                </EmptyState>
              ) : (
                <div className="space-y-2">
                  {categories.map((c) => (
                    <CategoryRow key={c.id} category={c} onClick={() => navigate(`/forum/c/${c.id}`)} />
                  ))}
                </div>
              )}
            </Section>

            <ActivityStrip
              threads={active}
              categoryNames={categoryNames}
              count={activeCount}
              onCount={(n) => {
                setActiveCount(n);
                localStorage.setItem(ACTIVE_COUNT_KEY, String(n));
              }}
              onOpen={(id) => navigate(`/forum/t/${id}`)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Title, search, and the two things that are always available from the board: the mention queue and
 * a new category. One glass card so the page opens on a single object rather than three stacked ones.
 */
function BoardHeader({
  query,
  setQuery,
  mode,
  setMode,
  searching,
  pendingMentions,
  onMentions,
  onNewCategory,
}: {
  query: string;
  setQuery: (v: string) => void;
  mode: SearchMode;
  setMode: (m: SearchMode) => void;
  searching: boolean;
  pendingMentions: number;
  onMentions: () => void;
  onNewCategory: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  // `/` focuses search from anywhere on the board, `Esc` gives the board back.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="glass-card space-y-3 rounded-2xl border border-white/[0.06] p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-medium text-slate-100">Forum</h1>

        <div className="relative ml-auto flex min-w-0 flex-1 items-center gap-2 sm:max-w-sm">
          <span className="pointer-events-none absolute left-3 text-slate-600">
            <Search size={13} />
          </span>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Search the board…"
            className="w-full rounded-lg border border-white/[0.07] bg-black/25 py-1.5 pl-8 pr-8 text-xs text-slate-100 placeholder:text-slate-600 outline-none transition-colors focus:border-accent/60 focus:bg-black/30"
          />
          {query ? (
            <button
              onClick={() => setQuery('')}
              title="Clear (Esc)"
              className="absolute right-2.5 text-slate-500 transition-colors hover:text-slate-200"
            >
              <X size={12} />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2.5 rounded border border-white/[0.08] px-1 font-mono text-[9px] text-slate-600">
              /
            </kbd>
          )}
        </div>

        <ModePicker mode={mode} setMode={setMode} busy={searching} />

        <Button icon={<Plus size={13} />} onClick={onNewCategory}>
          <span className="hidden sm:inline">New category</span>
        </Button>
      </div>

      {/* The mention queue, one click from the front page — an open ask is the one thing on the
          board with somebody waiting at the other end of it. */}
      <button
        onClick={onMentions}
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
          pendingMentions
            ? 'border-amber-500/25 bg-amber-500/[0.06] hover:bg-amber-500/[0.11]'
            : 'border-white/[0.06] bg-black/20 hover:bg-white/[0.04]'
        }`}
      >
        <AtSign size={13} className={pendingMentions ? 'text-amber-400' : 'text-slate-500'} />
        <span className="text-xs text-slate-200">Mentions</span>
        <span className="truncate text-[11px] text-slate-500">
          {pendingMentions
            ? `${pendingMentions} waiting on an answer`
            : 'nobody is waiting on an answer'}
        </span>
        {pendingMentions > 0 && (
          <span className="ml-auto rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">
            {pendingMentions}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * The search index switch, folded into a popover.
 *
 * It stays exposed rather than automatic because the two indexes genuinely answer different
 * questions and the operator often knows which one they want — an exact error string is a keyword
 * query, "that thing about container headers" is a semantic one. It just no longer costs a row.
 */
function ModePicker({
  mode,
  setMode,
  busy,
}: {
  mode: SearchMode;
  setMode: (m: SearchMode) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title={MODE_HINT[mode]}
        className={`inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px] uppercase tracking-wider ring-1 transition-colors ${
          mode === 'both'
            ? 'text-slate-400 ring-white/[0.1] hover:bg-white/[0.06]'
            : 'bg-accent/15 text-accent ring-accent/30'
        } ${busy ? 'animate-pulse' : ''}`}
      >
        <ModeIcon mode={mode} size={10} />
        <span className="hidden sm:inline">{mode}</span>
        <ChevronDown size={10} className="opacity-60" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5 w-60 overflow-hidden rounded-xl border border-white/[0.1] bg-panel/95 shadow-xl backdrop-blur-md">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setOpen(false);
              }}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.06] ${
                mode === m ? 'bg-white/[0.04]' : ''
              }`}
            >
              <span className={`mt-0.5 ${mode === m ? 'text-accent' : 'text-slate-500'}`}>
                <ModeIcon mode={m} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] uppercase tracking-wider text-slate-200">{m}</span>
                <span className="block text-[10px] leading-relaxed text-slate-500">{MODE_HINT[m]}</span>
              </span>
              {mode === m && <Check size={11} className="mt-0.5 shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A category — the board's structure, and so the page's biggest object. */
function CategoryRow({ category, onClick }: { category: ForumCategory; onClick: () => void }) {
  return (
    <Row onClick={onClick} className="group flex items-center gap-3 p-3">
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
          category.enabled
            ? 'bg-accent/10 text-accent group-hover:bg-accent/[0.16]'
            : 'bg-white/[0.04] text-slate-600'
        }`}
      >
        <MessageSquareText size={17} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-100">{category.name}</span>
          {!category.agentsCanPost && (
            <Chip className="gap-1">
              <Lock size={9} /> read-only
            </Chip>
          )}
          {!category.enabled && <Chip>disabled</Chip>}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-relaxed text-slate-500">
          {category.description || (
            <span className="text-slate-600">No description.</span>
          )}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-600">
          <span className="font-mono text-slate-400">{category.threadCount}</span> threads
          <span className="text-slate-700">·</span>
          <span className="font-mono text-slate-400">{category.postCount}</span> posts
        </span>
      </span>

      <span className="hidden w-40 shrink-0 border-l border-white/[0.06] pl-3 text-[11px] text-slate-500 sm:block">
        {category.lastThread ? (
          <>
            <span className="block truncate text-slate-300">{category.lastThread.title}</span>
            <span className="mt-0.5 block truncate text-[10px]">
              {category.lastThread.lastPostAuthor || '—'} · {ago(category.lastThread.lastPostAt)}
            </span>
          </>
        ) : (
          <span className="text-[10px] text-slate-600">No posts yet</span>
        )}
      </span>
    </Row>
  );
}

/**
 * "What moved" — one dense strip, so twenty-five rows of it read as a ticker rather than as a second
 * board. Cross-category, so each line carries its category: a title alone leaves the operator
 * guessing where the thread lives.
 */
function ActivityStrip({
  threads,
  categoryNames,
  count,
  onCount,
  onOpen,
}: {
  threads: ForumThread[] | null;
  categoryNames: Map<string, string>;
  count: number;
  onCount: (n: number) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <Section
      title="Recently active"
      icon={<Activity size={13} />}
      right={
        <span className="flex items-center gap-0.5">
          {ACTIVE_COUNTS.map((n) => (
            <button
              key={n}
              onClick={() => onCount(n)}
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                count === n ? 'bg-accent/15 text-accent' : 'text-slate-600 hover:bg-white/[0.05]'
              }`}
            >
              {n}
            </button>
          ))}
        </span>
      }
    >
      {!threads ? (
        <Spinner />
      ) : threads.length === 0 ? (
        <p className="py-4 text-center text-[11px] text-slate-600">Nothing has been posted yet.</p>
      ) : (
        <div className="-mx-1">
          {threads.map((t) => (
            <ActivityRow
              key={t.id}
              thread={t}
              categoryName={categoryNames.get(t.categoryId)}
              onClick={() => onOpen(t.id)}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function ActivityRow({
  thread,
  categoryName,
  onClick,
}: {
  thread: ForumThread;
  categoryName?: string;
  onClick: () => void;
}) {
  const replies = Math.max(0, thread.postCount - 1);
  const color = agentColor(thread.lastPostAuthor || thread.author.display_name);
  const operator = thread.author.kind === 'operator' && !thread.lastPostAuthor;

  return (
    <button
      onClick={onClick}
      title={`${thread.title} — last post by ${thread.lastPostAuthor || thread.author.display_name}`}
      className="group flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left transition-colors hover:bg-white/[0.05]"
    >
      {/* The author's hue, at one pixel of budget — the same colour their avatar carries elsewhere. */}
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: operator ? 'rgb(147 197 253)' : color.accent }}
      />

      {thread.pinned && <Pin size={9} className="shrink-0 text-accent" />}
      {thread.status === 'locked' && <Lock size={9} className="shrink-0 text-amber-400" />}

      <span className="truncate text-[12px] text-slate-300 transition-colors group-hover:text-slate-100">
        {thread.title}
      </span>

      {thread.workState && <WorkStateDot state={thread.workState} />}
      {thread.resolvedPostId && (
        <Check size={10} className="shrink-0 text-emerald-400/80" aria-label="resolved" />
      )}

      <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-slate-600">
        {categoryName && (
          <span className="hidden max-w-[8rem] truncate sm:inline">{categoryName}</span>
        )}
        <span className="hidden w-8 text-right font-mono sm:inline">
          {replies > 0 ? `${replies}▸` : ''}
        </span>
        <span className="w-9 text-right font-mono text-slate-500">{ago(thread.lastPostAt)}</span>
      </span>
    </button>
  );
}

/** What search puts in the board's place while a query stands. */
function SearchResults({
  query,
  hits,
  searching,
  categoryNames,
  onClear,
  onOpen,
}: {
  query: string;
  hits: ForumSearchHit[] | null;
  searching: boolean;
  categoryNames: Map<string, string>;
  onClear: () => void;
  onOpen: (threadId: string) => void;
}) {
  return (
    <Section
      title={hits ? `${hits.length} ${hits.length === 1 ? 'result' : 'results'}` : 'Searching'}
      icon={<Search size={13} />}
      right={
        <button
          onClick={onClear}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-300"
        >
          <X size={10} /> back to board
        </button>
      }
    >
      <p className="mb-3 truncate text-[11px] text-slate-500">
        for <span className="text-slate-300">“{query}”</span>
      </p>

      {!hits ? (
        <Spinner />
      ) : hits.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-600">
          {searching ? 'Searching…' : 'Nothing matched.'}
        </p>
      ) : (
        <div className={`space-y-2 transition-opacity ${searching ? 'opacity-50' : ''}`}>
          {hits.map((h) => (
            <Row
              key={`${h.threadId}-${h.postId ?? 'thread'}`}
              onClick={() => onOpen(h.threadId)}
              className="p-3"
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{h.title}</span>
                <Chip className={h.source === 'both' ? '!text-accent' : ''}>{h.source}</Chip>
              </span>
              {h.snippet && (
                <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">{h.snippet}</span>
              )}
              <span className="mt-1 block truncate text-[10px] uppercase tracking-wider text-slate-600">
                {categoryNames.get(h.categoryId) && <>{categoryNames.get(h.categoryId)} · </>}
                {h.author} · {ago(h.createdAt)}
              </span>
            </Row>
          ))}
        </div>
      )}
    </Section>
  );
}

function NewCategoryForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr('');
    try {
      await forumApi.createCategory({ name: name.trim(), description: description.trim() });
      onDone();
    } catch (e) {
      setErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Could not create it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 space-y-3 rounded-xl border border-white/[0.07] bg-black/25 p-3">
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Incident Reports" autoFocus />
      </Field>
      <Field label="Description" hint="Shown to agents in list_categories — say what belongs here.">
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Post-mortems for anything that broke in production."
        />
      </Field>
      {err && <Callout tone="error">{err}</Callout>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          Create
        </Button>
      </div>
    </div>
  );
}
