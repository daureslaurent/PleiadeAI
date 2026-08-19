import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AtSign, BellOff, CheckCircle2, MessageSquare, Play, X } from 'lucide-react';
import { forumApi, type ForumMention } from '../../lib/api';
import { useForum } from '../../store/forum';
import { agentColor } from '../../lib/agentColor';
import { Button, Callout, EmptyState, Section, Spinner } from '../../components/ui';
import { ago, AuthorAvatar } from './forumBits';

type Filter = 'pending' | 'answered' | 'dismissed' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Open' },
  { key: 'answered', label: 'Answered' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
];

/**
 * The mention triage list (`FORUM_PLAN.md` §11.4) — every open ask on the board in one place.
 *
 * The chip inside a post is where a mention is *read*; this is where it is *worked through*, which
 * is a different job: an operator who has been away wants the queue, not a tour of forty threads.
 * Grouped by who was addressed, because "scout has six open asks" is the observation that actually
 * changes what you do next — you run them together, or you go fix why scout is being paged so much.
 */
export function MentionsView() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('pending');
  const [rows, setRows] = useState<ForumMention[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);

  const lastMentionAt = useForum((s) => s.lastMentionAt);
  const refreshMentions = useForum((s) => s.refreshMentions);
  const wire = useForum((s) => s.wire);

  const load = useCallback(async () => {
    try {
      const list = await forumApi.mentions({ status: filter });
      if (!mounted.current) return;
      setRows(list);
      setError(false);
    } catch {
      if (mounted.current) setError(true);
    }
  }, [filter]);

  useEffect(() => {
    mounted.current = true;
    wire();
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load, wire]);

  useEffect(() => {
    if (lastMentionAt) void load();
  }, [lastMentionAt, load]);

  async function run(mention: ForumMention) {
    setBusy(mention.id);
    try {
      const { sessionId } = await forumApi.runMention(mention.id);
      refreshMentions();
      navigate(`/workspace?session=${sessionId}`);
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(mention: ForumMention, status: 'pending' | 'dismissed') {
    setBusy(mention.id);
    try {
      await forumApi.setMentionStatus(mention.id, status);
      refreshMentions();
      await load();
    } finally {
      setBusy(null);
    }
  }

  // Group by target, preserving the newest-first order the API returned.
  const groups: { name: string; rows: ForumMention[] }[] = [];
  for (const row of rows ?? []) {
    const name = row.target.display_name;
    const group = groups.find((g) => g.name === name);
    if (group) group.rows.push(row);
    else groups.push({ name, rows: [row] });
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<ArrowLeft size={13} />} onClick={() => navigate('/forum')}>
            Board
          </Button>
          <div className="ml-auto flex items-center gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
                  filter === f.key
                    ? 'bg-accent/15 text-accent'
                    : 'text-slate-500 hover:bg-white/[0.05] hover:text-slate-300'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {error && <Callout tone="error">Could not load mentions.</Callout>}
        {!rows ? (
          <Spinner />
        ) : !rows.length ? (
          <EmptyState icon={<AtSign size={28} />}>
            {filter === 'pending'
              ? 'Nobody is waiting on an answer. Mention an agent in a thread with @ to ask it something.'
              : 'Nothing here.'}
          </EmptyState>
        ) : (
          groups.map((group) => (
            <Section
              key={group.name}
              title={group.name}
              icon={<AtSign size={13} />}
              right={
                <span className="text-[11px] text-slate-500">
                  {group.rows.length} mention{group.rows.length === 1 ? '' : 's'}
                </span>
              }
            >
              <div className="space-y-2">
                {group.rows.map((m) => (
                  <MentionRow
                    key={m.id}
                    mention={m}
                    busy={busy === m.id}
                    onOpen={() => navigate(`/forum/t/${m.threadId}`)}
                    onRun={() => void run(m)}
                    onDismiss={() => void setStatus(m, 'dismissed')}
                    onReopen={() => void setStatus(m, 'pending')}
                    onSession={() => navigate(`/workspace?session=${m.sessionId}`)}
                  />
                ))}
              </div>
            </Section>
          ))
        )}
      </div>
    </div>
  );
}

function MentionRow({
  mention,
  busy,
  onOpen,
  onRun,
  onDismiss,
  onReopen,
  onSession,
}: {
  mention: ForumMention;
  busy: boolean;
  onOpen: () => void;
  onRun: () => void;
  onDismiss: () => void;
  onReopen: () => void;
  onSession: () => void;
}) {
  const answered = mention.status === 'answered';
  const isAgent = mention.target.kind === 'agent';
  return (
    <div className="glass-card rounded-2xl border border-white/[0.06] p-3">
      <div className="flex items-start gap-3">
        <AuthorAvatar author={mention.author} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
            <span style={{ color: agentColor(mention.author.display_name).accent }}>
              {mention.author.display_name}
            </span>
            <span>mentioned</span>
            <span style={{ color: agentColor(mention.target.display_name).accent }}>
              {mention.target.display_name}
            </span>
            <span>· {ago(mention.createdAt)}</span>
            {!mention.notified && (
              <span className="inline-flex items-center gap-1 text-amber-400/80" title="mentions muted for this agent">
                <BellOff size={10} /> muted
              </span>
            )}
            {answered && (
              <span className="inline-flex items-center gap-1 text-emerald-400/80">
                <CheckCircle2 size={10} /> answered
              </span>
            )}
          </div>

          <button
            onClick={onOpen}
            className="mt-0.5 block max-w-full truncate text-left text-sm font-medium text-slate-100 hover:text-accent"
          >
            {mention.threadTitle}
          </button>
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{mention.excerpt}</p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {isAgent && !answered && (
              <Button variant="accentSoft" icon={<Play size={11} />} loading={busy} onClick={onRun}>
                Run
              </Button>
            )}
            {mention.status === 'pending' && (
              <Button icon={<X size={11} />} onClick={onDismiss}>
                Dismiss
              </Button>
            )}
            {mention.status === 'dismissed' && <Button onClick={onReopen}>Reopen</Button>}
            {mention.sessionId && (
              <Button icon={<MessageSquare size={11} />} onClick={onSession}>
                Conversation
              </Button>
            )}
            <Button onClick={onOpen}>Thread</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
