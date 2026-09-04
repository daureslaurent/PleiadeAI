import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Archive, Lock, MessageSquare, Pin, Plus } from 'lucide-react';
import {
  forumApi,
  type ForumCategory,
  type ForumThread,
  type MentionTarget,
  type SummonsOutcome,
} from '../../lib/api';
import { useForum } from '../../store/forum';
import {
  Button,
  Callout,
  Checkbox,
  Chip,
  EmptyState,
  Field,
  Input,
  Row,
  Section,
  Spinner,
} from '../../components/ui';
import { ago, AuthorAvatar, Composer, useMentionRoster, WorkStateChip } from './forumBits';

/** One category's thread list: sticky threads first, then most recently active (FORUM_PLAN.md §5). */
export function CategoryView() {
  const { categoryId = '' } = useParams();
  const navigate = useNavigate();
  const [category, setCategory] = useState<ForumCategory | null>(null);
  const [threads, setThreads] = useState<ForumThread[] | null>(null);
  const [error, setError] = useState(false);
  const [composing, setComposing] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const mounted = useRef(true);

  const lastEventAt = useForum((s) => s.lastEventAt);
  const wire = useForum((s) => s.wire);

  const load = useCallback(async () => {
    try {
      const [cats, list] = await Promise.all([
        forumApi.categories(),
        forumApi.threads(categoryId, 100, showArchived),
      ]);
      if (!mounted.current) return;
      setCategory(cats.find((c) => c.id === categoryId) ?? null);
      setThreads(list);
      setError(false);
    } catch {
      if (mounted.current) setError(true);
    }
  }, [categoryId, showArchived]);

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
      <div className="mx-auto max-w-5xl space-y-4 p-6">
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

        <Section
          title="Threads"
          icon={<MessageSquare size={13} />}
          right={
            <Checkbox checked={showArchived} onChange={setShowArchived}>
              Show archived
            </Checkbox>
          }
        >
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
    <Row
      onClick={onClick}
      className={`flex items-center gap-3 p-3 ${thread.status === 'archived' ? 'opacity-60' : ''}`}
    >
      <AuthorAvatar author={thread.author} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {thread.pinned && <Pin size={11} className="shrink-0 text-accent" />}
          {thread.status === 'locked' && <Lock size={11} className="shrink-0 text-amber-400" />}
          {thread.status === 'archived' && <Archive size={11} className="shrink-0 text-slate-600" />}
          <span className="truncate text-sm text-slate-100">{thread.title}</span>
          {thread.workState && <WorkStateChip state={thread.workState} />}
          {thread.resolvedPostId && (
            <Chip className="!text-emerald-400/80">resolved</Chip>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-slate-500">
          started by {thread.author.display_name} · {ago(thread.createdAt)}
          {thread.assignee && <> · owned by {thread.assignee.display_name}</>}
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

/**
 * Handing a task to an agent, in the same call that describes it.
 *
 * Writing `@name` in the body already summons — a human typing a name means it, which is the one
 * place the address/summons split (§11.7) does not apply. What was missing is everything around it:
 * the name had to be spelled correctly into prose to mean anything, ownership had to be set
 * afterwards from the thread header, and the composer never said whether anybody was actually woken.
 * A post that summoned nobody looked exactly like one that did.
 *
 * So: `wake` names agents to run whether or not the prose mentions them, `assignee` and `state` make
 * the thread a work item at the moment it is written — the two are deliberately different, and a
 * task needs both, since assigning wakes nobody and waking leaves no owner behind once the turn ends
 * — and the result reports back what happened.
 */
function TaskControls({
  roster,
  wake,
  setWake,
  assignee,
  setAssignee,
  hubThreadId,
  setHubThreadId,
  hubs,
}: {
  roster: MentionTarget[];
  wake: string[];
  setWake: (names: string[]) => void;
  assignee: string;
  setAssignee: (name: string) => void;
  hubThreadId: string;
  setHubThreadId: (id: string) => void;
  hubs: ForumThread[];
}) {
  // The operator is addressable but never runnable, so it has no place in either picker.
  const agents = roster.filter((t) => t.kind === 'agent');

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <Field label="Run now" hint="Each name is a full turn on the GPU.">
        <div className="flex flex-wrap gap-1.5">
          {agents.map((t) => {
            const on = wake.includes(t.name);
            // An agent excluded from auto-reply on its own page cannot be run by naming it here —
            // the ask would be recorded and then wait for you, which is not what this button says.
            const runnable = t.autoReply !== false;
            return (
              <button
                key={t.name}
                type="button"
                disabled={!runnable}
                onClick={() => setWake(on ? wake.filter((n) => n !== t.name) : [...wake, t.name])}
                className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                  on
                    ? 'border-accent/50 bg-accent/15 text-accent'
                    : 'border-white/[0.08] text-slate-400 hover:text-slate-200'
                } ${runnable ? '' : 'cursor-not-allowed opacity-40'}`}
                title={
                  runnable
                    ? t.description || t.name
                    : `${t.name} is excluded from automatic runs on its agent page — assign it instead, or run the mention by hand.`
                }
              >
                {t.name}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="Assign to" hint="Keeps it in their work items every turn. Does not wake them.">
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[12px] text-slate-200"
        >
          <option value="">nobody</option>
          {agents.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Part of" hint="Threads sharing a hub are one project, on one budget.">
        <select
          value={hubThreadId}
          onChange={(e) => setHubThreadId(e.target.value)}
          className="max-w-[220px] rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[12px] text-slate-200"
        >
          <option value="">nothing</option>
          {hubs.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </Field>
    </div>
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
  const [wake, setWake] = useState<string[]>([]);
  const [assignee, setAssignee] = useState('');
  const [hubThreadId, setHubThreadId] = useState('');
  const [hubs, setHubs] = useState<ForumThread[]>([]);
  // What the post did, when it did not do what was asked. Holding the navigation is the point: this
  // is the one moment the operator can still tell that nothing was woken.
  const [outcome, setOutcome] = useState<{ threadId: string; summons: SummonsOutcome } | null>(null);
  const roster = useMentionRoster();

  useEffect(() => {
    // Candidate hubs are threads that are not themselves inside a project — the one-level rule.
    forumApi
      .threads(undefined, 200)
      .then((all) => setHubs(all.filter((t) => !t.hubThreadId)))
      .catch(() => setHubs([]));
  }, []);

  if (outcome) {
    return (
      <div className="space-y-3">
        <Callout tone="warn">
          The thread was posted, but nothing was woken. It is waiting for the board to get to it, or
          for you to press Run on the mention.
          {outcome.summons.notWoken.length > 0 && (
            <ul className="mt-2 space-y-1">
              {outcome.summons.notWoken.map((n) => (
                <li key={n.agent}>
                  <strong>@{n.agent}</strong> — {n.reason}
                </li>
              ))}
            </ul>
          )}
        </Callout>
        <Button onClick={() => onCreated(outcome.threadId)}>Open the thread</Button>
      </div>
    );
  }

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
      <TaskControls
        roster={roster}
        wake={wake}
        setWake={setWake}
        assignee={assignee}
        setAssignee={setAssignee}
        hubThreadId={hubThreadId}
        setHubThreadId={setHubThreadId}
        hubs={hubs}
      />
      {err && <Callout tone="error">{err}</Callout>}
      <Composer
        placeholder="Write the opening post…"
        submitLabel="Post thread"
        onCancel={onCancel}
        onSubmit={async (body, attachments) => {
          if (!title.trim()) {
            setErr('A title is required.');
            return;
          }
          try {
            const thread = await forumApi.createThread({
              category: categoryId,
              title: title.trim(),
              body,
              attachments,
              wake,
              assignee: assignee || null,
              // Assigning it is what makes it a work item; without a state it would sit outside every
              // "what is still open" query, which is the one thing an assignee is for.
              workState: assignee ? 'todo' : null,
              hubThreadId: hubThreadId || null,
            });
            // Asked for a run and got none: stop here and say so, rather than navigating away from
            // the only screen that knows the request was made.
            const asked = wake.length > 0;
            if (asked && thread.summons.woke.length === 0) {
              setOutcome({ threadId: thread.id, summons: thread.summons });
              return;
            }
            onCreated(thread.id);
          } catch (e) {
            setErr((e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Could not post it.');
          }
        }}
      />
    </div>
  );
}
