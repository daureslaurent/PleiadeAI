import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Archive, Lock, MessageSquare, Pin, Plus } from 'lucide-react';
import { forumApi, type ForumCategory, type ForumThread } from '../../lib/api';
import { useForum } from '../../store/forum';
import { Button, Callout, Chip, EmptyState, Field, Input, Row, Section, Spinner } from '../../components/ui';
import { ago, AuthorAvatar, Composer } from './forumBits';

/** One category's thread list: sticky threads first, then most recently active (FORUM_PLAN.md §5). */
export function CategoryView() {
  const { categoryId = '' } = useParams();
  const navigate = useNavigate();
  const [category, setCategory] = useState<ForumCategory | null>(null);
  const [threads, setThreads] = useState<ForumThread[] | null>(null);
  const [error, setError] = useState(false);
  const [composing, setComposing] = useState(false);
  const mounted = useRef(true);

  const lastEventAt = useForum((s) => s.lastEventAt);
  const wire = useForum((s) => s.wire);

  const load = useCallback(async () => {
    try {
      const [cats, list] = await Promise.all([forumApi.categories(), forumApi.threads(categoryId, 100)]);
      if (!mounted.current) return;
      setCategory(cats.find((c) => c.id === categoryId) ?? null);
      setThreads(list);
      setError(false);
    } catch {
      if (mounted.current) setError(true);
    }
  }, [categoryId]);

  useEffect(() => {
    mounted.current = true;
    wire();
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load, wire]);

  useEffect(() => {
    if (lastEventAt) void load();
  }, [lastEventAt, load]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="flex items-center gap-2">
          <Button icon={<ArrowLeft size={13} />} onClick={() => navigate('/forum')}>
            Board
          </Button>
          <span className="truncate text-sm text-slate-400">{category?.name ?? '…'}</span>
          <Button
            className="ml-auto"
            variant="primary"
            icon={<Plus size={13} />}
            onClick={() => setComposing((v) => !v)}
          >
            New thread
          </Button>
        </div>

        {error && <Callout tone="error">Could not load this category.</Callout>}
        {category?.description && (
          <p className="px-1 text-[11px] leading-relaxed text-slate-500">{category.description}</p>
        )}

        {composing && (
          <NewThreadForm
            categoryId={categoryId}
            onCancel={() => setComposing(false)}
            onCreated={(threadId) => navigate(`/forum/t/${threadId}`)}
          />
        )}

        <Section title="Threads" icon={<MessageSquare size={13} />}>
          {!threads ? (
            <Spinner />
          ) : threads.length === 0 ? (
            <EmptyState icon={<MessageSquare size={28} />}>
              Nothing here yet. Start the first thread.
            </EmptyState>
          ) : (
            <div className="space-y-2">
              {threads.map((t) => (
                <ThreadRow key={t.id} thread={t} onClick={() => navigate(`/forum/t/${t.id}`)} />
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function ThreadRow({ thread, onClick }: { thread: ForumThread; onClick: () => void }) {
  return (
    <Row onClick={onClick} className="flex items-center gap-3 p-3">
      <AuthorAvatar author={thread.author} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {thread.pinned && <Pin size={11} className="shrink-0 text-accent" />}
          {thread.status === 'locked' && <Lock size={11} className="shrink-0 text-amber-400" />}
          {thread.status === 'archived' && <Archive size={11} className="shrink-0 text-slate-600" />}
          <span className="truncate text-sm text-slate-100">{thread.title}</span>
          {thread.resolvedPostId && (
            <Chip className="!text-emerald-400/80">resolved</Chip>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-slate-500">
          started by {thread.author.display_name} · {ago(thread.createdAt)}
        </span>
      </span>

      <span className="hidden shrink-0 text-right text-[11px] text-slate-500 sm:block">
        <span className="block font-mono text-slate-400">{Math.max(0, thread.postCount - 1)}</span>
        <span className="block">replies</span>
      </span>

      <span className="w-32 shrink-0 border-l border-white/[0.06] pl-3 text-[11px] text-slate-500">
        <span className="block truncate text-slate-400">{thread.lastPostAuthor || '—'}</span>
        <span className="block">{ago(thread.lastPostAt)}</span>
      </span>
    </Row>
  );
}

function NewThreadForm({
  categoryId,
  onCreated,
  onCancel,
}: {
  categoryId: string;
  onCreated: (threadId: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [err, setErr] = useState('');

  return (
    <div className="space-y-3">
      <Field label="Title" hint="Be specific — a vague title is one nobody finds again.">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="delay_moov drops the AAC decoder config"
          autoFocus
        />
      </Field>
      {err && <Callout tone="error">{err}</Callout>}
      <Composer
        placeholder="Write the opening post…"
        submitLabel="Post thread"
        onCancel={onCancel}
        onSubmit={async (body) => {
          if (!title.trim()) {
            setErr('A title is required.');
            return;
          }
          try {
            const thread = await forumApi.createThread({ category: categoryId, title: title.trim(), body });
            onCreated(thread.id);
          } catch (e) {
            setErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Could not post it.');
          }
        }}
      />
    </div>
  );
}
