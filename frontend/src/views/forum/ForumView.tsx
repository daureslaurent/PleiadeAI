import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign, Lock, MessageSquareText, Plus, Search, Sparkles, Type } from 'lucide-react';
import { forumApi, type ForumCategory, type ForumSearchHit } from '../../lib/api';
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
import { ago } from './forumBits';

type SearchMode = 'both' | 'keyword' | 'semantic';

const MODE_HINT: Record<SearchMode, string> = {
  both: 'Keyword and meaning — the default.',
  keyword: 'Exact strings: error codes, filenames, ids.',
  semantic: 'Meaning: finds threads that never use your words.',
};

/**
 * The board index (FORUM_PLAN.md §5) — the forum's front page. Categories with their thread and post
 * counts and a "last post by … · 4m ago" column, plus board-wide search across every category.
 */
export function ForumView() {
  const navigate = useNavigate();
  const [categories, setCategories] = useState<ForumCategory[] | null>(null);
  const [error, setError] = useState(false);
  const [composing, setComposing] = useState(false);
  const mounted = useRef(true);

  // Live posts arrive while the operator is looking at the board, so refresh the counts in place.
  const lastPostAt = useForum((s) => s.lastEventAt);
  const wire = useForum((s) => s.wire);
  const pendingMentions = useForum((s) => s.pendingMentions);

  const load = useCallback(async () => {
    try {
      const list = await forumApi.categories();
      if (!mounted.current) return;
      setCategories(list);
      setError(false);
    } catch {
      if (mounted.current) setError(true);
    }
  }, []);

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

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <BoardSearch onOpen={(threadId) => navigate(`/forum/t/${threadId}`)} />

        {/* The mention queue, one click from the board's front page — an open ask is the one thing on
            here with somebody waiting at the other end of it. */}
        <button
          onClick={() => navigate('/forum/mentions')}
          className={`glass-card flex w-full items-center gap-2.5 rounded-2xl border px-4 py-3 text-left transition-colors ${
            pendingMentions
              ? 'border-amber-500/25 bg-amber-500/[0.05] hover:bg-amber-500/[0.09]'
              : 'border-white/[0.06] hover:bg-white/[0.03]'
          }`}
        >
          <AtSign size={14} className={pendingMentions ? 'text-amber-400' : 'text-slate-500'} />
          <span className="text-sm text-slate-200">Mentions</span>
          <span className="text-[11px] text-slate-500">
            {pendingMentions
              ? `${pendingMentions} waiting on an answer`
              : 'nobody is waiting on an answer'}
          </span>
          {pendingMentions > 0 && (
            <span className="ml-auto rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              {pendingMentions}
            </span>
          )}
        </button>

        {error && <Callout tone="error">Could not load the forum.</Callout>}

        <Section
          title="Categories"
          icon={<MessageSquareText size={13} />}
          right={
            <Button icon={<Plus size={13} />} onClick={() => setComposing((v) => !v)}>
              New category
            </Button>
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
            <EmptyState icon={<MessageSquareText size={28} />}>No categories yet.</EmptyState>
          ) : (
            <div className="space-y-2">
              {categories.map((c) => (
                <CategoryRow key={c.id} category={c} onClick={() => navigate(`/forum/c/${c.id}`)} />
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function CategoryRow({ category, onClick }: { category: ForumCategory; onClick: () => void }) {
  return (
    <Row onClick={onClick} className="flex items-center gap-3 p-3">
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          category.enabled ? 'bg-accent/10 text-accent' : 'bg-white/[0.04] text-slate-600'
        }`}
      >
        <MessageSquareText size={16} />
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
        {category.description && (
          <span className="mt-0.5 block truncate text-[11px] leading-relaxed text-slate-500">
            {category.description}
          </span>
        )}
      </span>

      <span className="hidden shrink-0 text-right text-[11px] text-slate-500 sm:block">
        <span className="block font-mono text-slate-400">{category.threadCount}</span>
        <span className="block">threads</span>
      </span>

      <span className="w-36 shrink-0 border-l border-white/[0.06] pl-3 text-[11px] text-slate-500">
        {category.lastThread ? (
          <>
            <span className="block truncate text-slate-400">{category.lastThread.title}</span>
            <span className="block truncate">
              {category.lastThread.lastPostAuthor || '—'} · {ago(category.lastThread.lastPostAt)}
            </span>
          </>
        ) : (
          <span className="text-slate-600">No posts yet</span>
        )}
      </span>
    </Row>
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

/**
 * Board-wide search. The mode switch is exposed rather than hidden because the two indexes genuinely
 * answer different questions, and the operator (like the agents) sometimes knows which one they want:
 * an exact error string is a keyword query, "that thing about container headers" is a semantic one.
 */
function BoardSearch({ onOpen }: { onOpen: (threadId: string) => void }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('both');
  const [hits, setHits] = useState<ForumSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    setBusy(true);
    try {
      setHits(await forumApi.search(q, mode));
    } catch {
      setHits([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Search the board" icon={<Search size={13} />}>
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run()}
          placeholder="What are you looking for?"
        />
        <Button variant="primary" loading={busy} onClick={() => void run()}>
          Search
        </Button>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        {(['both', 'keyword', 'semantic'] as SearchMode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            title={MODE_HINT[m]}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider transition-colors ${
              mode === m ? 'bg-accent/15 text-accent' : 'text-slate-500 hover:bg-white/[0.05]'
            }`}
          >
            {m === 'keyword' ? <Type size={10} /> : m === 'semantic' ? <Sparkles size={10} /> : null}
            {m}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-600">{MODE_HINT[mode]}</span>
      </div>

      {hits && (
        <div className="mt-3 space-y-2">
          {hits.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-slate-600">Nothing matched.</p>
          ) : (
            hits.map((h) => (
              <Row key={`${h.threadId}-${h.postId ?? 'thread'}`} onClick={() => onOpen(h.threadId)} className="p-3">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{h.title}</span>
                  <Chip>{h.source}</Chip>
                </span>
                {h.snippet && (
                  <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">{h.snippet}</span>
                )}
                <span className="mt-1 block text-[10px] uppercase tracking-wider text-slate-600">
                  {h.author} · {ago(h.createdAt)}
                </span>
              </Row>
            ))
          )}
        </div>
      )}
    </Section>
  );
}
