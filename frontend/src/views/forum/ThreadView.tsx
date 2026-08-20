import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Archive,
  AtSign,
  Check,
  CheckCircle2,
  CornerUpLeft,
  Lock,
  LockOpen,
  Pencil,
  Pin,
  Play,
  Trash2,
  X,
} from 'lucide-react';
import {
  forumApi,
  type ForumFile,
  type ForumMention,
  type ForumPost,
  type ForumThreadDetail,
  type ForumWorkState,
} from '../../lib/api';
import { useForum } from '../../store/forum';
import { Markdown } from '../../components/Markdown';
import { linkifyMentions, MentionProvider } from '../../components/Mention';
import { Button, Callout, Chip, Spinner, StatusBadge, useConfirm } from '../../components/ui';
import { agentColor } from '../../lib/agentColor';
import {
  ago,
  AttachmentList,
  AuthorAvatar,
  AuthorName,
  AutoRunNotice,
  Composer,
  isModerator,
  useMentionRoster,
  WORK_STATE_LABELS,
  WorkStateChip,
} from './forumBits';

const PAGE_SIZE = 50;

/**
 * The operator's half of work tracking: agents set their own threads' state through the `forum`
 * tool, and this is the same field from the other side — for a thread whose owning agent got it
 * wrong, or one the operator opened by hand.
 *
 * Deliberately a row of toggles rather than a dropdown: with four states the whole vocabulary fits
 * on one line, and the board's value comes from these being cheap enough to keep honest.
 */
function WorkStatePicker({
  state,
  onPick,
}: {
  state: ForumWorkState | null;
  onPick: (next: ForumWorkState | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      <span className="mr-1 text-[11px] text-slate-600">work state</span>
      {(Object.keys(WORK_STATE_LABELS) as ForumWorkState[]).map((key) => (
        <button
          key={key}
          type="button"
          // Clicking the active state clears it — a thread that turned out not to be a work item
          // should be able to stop being one without a separate "none" button.
          onClick={() => onPick(state === key ? null : key)}
          className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
            state === key
              ? 'bg-white/[0.08] text-slate-100'
              : 'text-slate-600 hover:bg-white/[0.04] hover:text-slate-400'
          }`}
        >
          {WORK_STATE_LABELS[key].label}
        </button>
      ))}
    </div>
  );
}

/**
 * A thread (FORUM_PLAN.md §5): the classic forum post layout — a narrow author column beside the
 * body — plus the operator's moderation controls. `reply_to` renders as a single "in reply to" line
 * rather than nested threading, which stays readable at forty posts and summarises cleanly.
 */
export function ThreadView() {
  const { threadId = '' } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [detail, setDetail] = useState<ForumThreadDetail | null>(null);
  const [error, setError] = useState(false);
  const [offset, setOffset] = useState(0);
  const [replyTo, setReplyTo] = useState<ForumPost | null>(null);
  const [editing, setEditing] = useState<ForumPost | null>(null);
  const mounted = useRef(true);

  const last = useForum((s) => s.last);
  const lastEventAt = useForum((s) => s.lastEventAt);
  const wire = useForum((s) => s.wire);
  const refreshMentions = useForum((s) => s.refreshMentions);
  const roster = useMentionRoster();

  const load = useCallback(async () => {
    try {
      const data = await forumApi.thread(threadId, PAGE_SIZE, offset);
      if (!mounted.current) return;
      setDetail(data);
      setError(false);
    } catch {
      if (mounted.current) setError(true);
    }
  }, [threadId, offset]);

  useEffect(() => {
    mounted.current = true;
    wire();
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load, wire]);

  // Only refetch when the post that landed belongs to *this* thread — otherwise a busy board would
  // reload the page the operator is reading every few seconds for no reason.
  useEffect(() => {
    if (lastEventAt && last?.threadId === threadId) void load();
  }, [lastEventAt, last, threadId, load]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Callout tone="error">Could not load this thread.</Callout>
      </div>
    );
  }
  if (!detail) return <Spinner />;

  const locked = detail.status !== 'open';
  const pageEnd = detail.offset + detail.posts.length;

  async function patch(body: Parameters<typeof forumApi.saveThread>[1]) {
    await forumApi.saveThread(threadId, body);
    await load();
  }

  /**
   * Answer a mention. The run is detached on the backend, so this returns as soon as the session
   * exists — and it takes the operator straight there, because the whole value of a mention run over
   * a plain notification is watching the agent work and being able to keep talking to it.
   */
  async function runMention(mention: ForumMention) {
    const { sessionId } = await forumApi.runMention(mention.id);
    refreshMentions();
    navigate(`/workspace?session=${sessionId}`);
  }

  async function dismissMention(mention: ForumMention) {
    await forumApi.setMentionStatus(mention.id, 'dismissed');
    refreshMentions();
    await load();
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<ArrowLeft size={13} />} onClick={() => navigate(`/forum/c/${detail.categoryId}`)}>
            Back
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              icon={<Pin size={13} />}
              onClick={() => void patch({ pinned: !detail.pinned })}
              className={detail.pinned ? 'text-accent' : ''}
            >
              {detail.pinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              icon={detail.status === 'locked' ? <LockOpen size={13} /> : <Lock size={13} />}
              onClick={() => void patch({ status: detail.status === 'locked' ? 'open' : 'locked' })}
            >
              {detail.status === 'locked' ? 'Unlock' : 'Lock'}
            </Button>
            <Button
              icon={<Archive size={13} />}
              onClick={() => void patch({ status: detail.status === 'archived' ? 'open' : 'archived' })}
            >
              {detail.status === 'archived' ? 'Unarchive' : 'Archive'}
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 size={13} />}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Delete thread?',
                  body: `"${detail.title}" and all ${detail.total} of its posts will be removed for every agent.`,
                  danger: true,
                });
                if (!ok) return;
                await forumApi.removeThread(threadId);
                navigate(`/forum/c/${detail.categoryId}`);
              }}
            >
              Delete
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {detail.pinned && <Pin size={13} className="text-accent" />}
            <h1 className="text-lg font-medium text-slate-100">{detail.title}</h1>
            {detail.workState && <WorkStateChip state={detail.workState} />}
            {detail.status !== 'open' && (
              <StatusBadge tone={detail.status === 'locked' ? 'busy' : 'idle'}>{detail.status}</StatusBadge>
            )}
          </div>
          <p className="text-[11px] text-slate-500">
            {detail.total} post{detail.total === 1 ? '' : 's'} · started by {detail.author.display_name} ·{' '}
            {ago(detail.createdAt)}
            {detail.assignee && <> · owned by {detail.assignee.display_name}</>}
            {detail.tags.length > 0 && <> · {detail.tags.join(', ')}</>}
          </p>
          <WorkStatePicker
            state={detail.workState}
            onPick={(next) => void patch({ workState: next })}
          />
        </div>

        <AutoRunNotice autoRun={detail.autoRun} />

        <div className="space-y-3">
          {detail.posts.map((post, i) => (
            <PostCard
              key={post.id}
              post={post}
              index={detail.offset + i + 1}
              opening={detail.offset + i === 0}
              resolved={detail.resolvedPostId === post.id}
              postCount={detail.authorPostCounts[post.author.display_name] ?? 0}
              mentions={(detail.mentions ?? []).filter((m) => m.postId === post.id)}
              mentionNames={roster.map((t) => t.name)}
              onRunMention={runMention}
              onDismissMention={dismissMention}
              onOpenSession={(m) => navigate(`/workspace?session=${m.sessionId}`)}
              repliedTo={detail.posts.find((p) => p.id === post.replyTo) ?? null}
              editing={editing?.id === post.id}
              onEdit={() => setEditing(post)}
              onCancelEdit={() => setEditing(null)}
              onSaved={async (body, attachments) => {
                await forumApi.savePost(post.id, body, attachments);
                setEditing(null);
                await load();
              }}
              onDetach={async (file) => {
                await forumApi.detachFile(post.id, file.id);
                await load();
              }}
              onReply={() => setReplyTo(post)}
              onResolve={() => void patch({ resolvedPostId: detail.resolvedPostId === post.id ? null : post.id })}
              onDelete={async () => {
                const ok = await confirm({ title: 'Delete post?', body: 'It disappears from the thread and from search.', danger: true });
                if (!ok) return;
                await forumApi.removePost(post.id);
                await load();
              }}
            />
          ))}
        </div>

        {(detail.offset > 0 || pageEnd < detail.total) && (
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <Button disabled={detail.offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Newer
            </Button>
            <span>
              {detail.offset + 1}–{pageEnd} of {detail.total}
            </span>
            <Button disabled={pageEnd >= detail.total} onClick={() => setOffset(offset + PAGE_SIZE)}>
              Older
            </Button>
          </div>
        )}

        {locked ? (
          <Callout tone="warn" icon={<Lock size={13} />}>
            This thread is {detail.status}. Unlock it to post.
          </Callout>
        ) : (
          <div className="space-y-2">
            {replyTo && (
              <div className="flex items-center gap-2 px-1 text-[11px] text-slate-500">
                <CornerUpLeft size={11} />
                Replying to {replyTo.author.display_name}
                <button className="text-slate-400 underline-offset-2 hover:underline" onClick={() => setReplyTo(null)}>
                  clear
                </button>
              </div>
            )}
            <Composer
              placeholder="Write a reply…"
              submitLabel="Reply"
              onSubmit={async (body, attachments) => {
                await forumApi.reply(threadId, body, replyTo?.id ?? null, attachments);
                setReplyTo(null);
                // Jump to the last page so the operator sees what they just wrote.
                const nextOffset = Math.floor(detail.total / PAGE_SIZE) * PAGE_SIZE;
                if (nextOffset !== offset) setOffset(nextOffset);
                else await load();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PostCard({
  post,
  index,
  opening,
  resolved,
  postCount,
  mentions,
  mentionNames,
  onRunMention,
  onDismissMention,
  onOpenSession,
  repliedTo,
  editing,
  onEdit,
  onCancelEdit,
  onSaved,
  onDetach,
  onReply,
  onResolve,
  onDelete,
}: {
  post: ForumPost;
  index: number;
  opening: boolean;
  resolved: boolean;
  postCount: number;
  /** Mentions this post raised, so its chips can act and its pending asks can be surfaced. */
  mentions: ForumMention[];
  /** Every addressable name, for linkifying — an unknown `@foo` stays prose. */
  mentionNames: string[];
  onRunMention: (mention: ForumMention) => Promise<void>;
  onDismissMention: (mention: ForumMention) => Promise<void>;
  onOpenSession: (mention: ForumMention) => void;
  repliedTo: ForumPost | null;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (body: string, attachments: string[]) => Promise<void>;
  onDetach: (file: ForumFile) => Promise<void>;
  onReply: () => void;
  onResolve: () => void;
  onDelete: () => Promise<void>;
}) {
  return (
    <div
      className={`glass-card overflow-hidden rounded-2xl border ${
        resolved ? 'border-emerald-500/30' : 'border-white/[0.06]'
      }`}
    >
      {resolved && (
        <div className="flex items-center gap-1.5 border-b border-emerald-500/20 bg-emerald-500/[0.07] px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
          <CheckCircle2 size={11} /> Accepted answer
        </div>
      )}

      <div className="flex flex-col sm:flex-row">
        {/* The classic forum author column — identity, role and standing, beside the body not above it. */}
        <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] p-4 sm:w-40 sm:flex-col sm:items-start sm:gap-2 sm:border-b-0 sm:border-r">
          <AuthorAvatar author={post.author} size={40} />
          <div className="min-w-0">
            <AuthorName author={post.author} />
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {isModerator(post.author) ? (
                <Chip className="!text-amber-400/90">moderator</Chip>
              ) : (
                <Chip>{post.author.kind}</Chip>
              )}
              {opening && <Chip>OP</Chip>}
            </div>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-600">
              {postCount} post{postCount === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        <div className="min-w-0 flex-1 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
            <span>#{index}</span>
            <span>·</span>
            <span title={new Date(post.createdAt).toLocaleString()}>{ago(post.createdAt)}</span>
            {post.editedAt && <EditedNote post={post} />}
            <div className="ml-auto flex items-center gap-0.5">
              <IconAction title={resolved ? 'Unmark as the answer' : 'Mark as the answer'} onClick={onResolve}>
                <Check size={12} className={resolved ? 'text-emerald-400' : ''} />
              </IconAction>
              <IconAction title="Reply to this post" onClick={onReply}>
                <CornerUpLeft size={12} />
              </IconAction>
              <IconAction title="Edit" onClick={onEdit}>
                <Pencil size={12} />
              </IconAction>
              <IconAction title="Delete" onClick={() => void onDelete()}>
                <Trash2 size={12} />
              </IconAction>
            </div>
          </div>

          {repliedTo && (
            <div className="mb-2 border-l-2 border-white/[0.12] pl-2 text-[11px] text-slate-500">
              in reply to <span className="text-slate-400">{repliedTo.author.display_name}</span>:{' '}
              <span className="italic">{repliedTo.body.replace(/\s+/g, ' ').slice(0, 120)}…</span>
            </div>
          )}

          {editing ? (
            <Composer
              placeholder="Edit the post…"
              submitLabel="Save"
              initial={post.body}
              initialFiles={post.attachments ?? []}
              autoFocus
              onCancel={onCancelEdit}
              onSubmit={onSaved}
            />
          ) : (
            <div className="text-sm leading-relaxed text-slate-200">
              <MentionProvider
                value={{
                  byName: new Map(mentions.map((m) => [m.target.display_name.toLowerCase(), m])),
                  onRun: onRunMention,
                  onDismiss: onDismissMention,
                  onOpenSession,
                }}
              >
                <Markdown>{linkifyMentions(post.body, mentionNames)}</Markdown>
              </MentionProvider>
              <AttachmentList files={post.attachments ?? []} onDetach={(f) => void onDetach(f)} />
              <PendingMentions
                mentions={mentions}
                onRun={onRunMention}
                onDismiss={onDismissMention}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The unanswered asks a post made, spelled out under it.
 *
 * The chip already carries the same actions, but a chip has to be *noticed* — and the one thing a
 * mention must not do is sit unread in a thread the operator scrolled past. Only pending agent
 * mentions appear: an answered one is visible as the reply right below it, and `@Operator` is
 * answered by typing in the composer, not by pressing a button.
 */
/**
 * The "edited by X" byline. The moderator may revise a post it did not write — including the
 * operator's — so an edit has to be inspectable in place: clicking reveals the reason it gave and the
 * body it replaced, which is also how the original text is recovered if you disagree with it.
 */
function EditedNote({ post }: { post: ForumPost }) {
  const [open, setOpen] = useState(false);
  const when = new Date(post.editedAt!).toLocaleString();

  if (!post.editReason && !post.previousBody) {
    return <span title={when}>· edited by {post.editedBy}</span>;
  }
  return (
    <>
      <button
        className="text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-300"
        title={when}
        onClick={() => setOpen((v) => !v)}
      >
        · edited by {post.editedBy}
      </button>
      {open && (
        <div className="basis-full rounded-lg border border-white/[0.08] bg-black/25 p-2">
          {post.editReason && (
            <p className="text-[11px] text-slate-400">
              Reason: <span className="text-slate-300">{post.editReason}</span>
            </p>
          )}
          {post.previousBody && (
            <>
              <p className="mt-1.5 text-[10px] uppercase tracking-wider text-slate-600">Previous version</p>
              <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-400">
                {post.previousBody}
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}

function PendingMentions({
  mentions,
  onRun,
  onDismiss,
}: {
  mentions: ForumMention[];
  onRun: (m: ForumMention) => Promise<void>;
  onDismiss: (m: ForumMention) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const pending = mentions.filter((m) => m.status === 'pending' && m.target.kind === 'agent');
  if (!pending.length) return null;

  async function act(m: ForumMention, fn: (x: ForumMention) => Promise<void>) {
    setBusy(m.id);
    try {
      await fn(m);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2">
      <AtSign size={12} className="shrink-0 text-amber-400/80" />
      <span className="text-[11px] text-amber-200/80">
        Waiting on{' '}
        {pending.map((m, i) => (
          <span key={m.id}>
            {i > 0 && ', '}
            <span className="font-medium" style={{ color: agentColor(m.target.display_name).accent }}>
              {m.target.display_name}
            </span>
            {!m.notified && <span className="text-amber-300/60"> (muted)</span>}
          </span>
        ))}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        {pending.map((m) => (
          <span key={m.id} className="flex items-center gap-1">
            <Button
              variant="accentSoft"
              icon={<Play size={11} />}
              loading={busy === m.id}
              onClick={() => void act(m, onRun)}
            >
              Run {pending.length > 1 ? m.target.display_name : ''}
            </Button>
            <Button icon={<X size={11} />} onClick={() => void act(m, onDismiss)}>
              Dismiss
            </Button>
          </span>
        ))}
      </div>
    </div>
  );
}

function IconAction({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded-md p-1 text-slate-600 transition-colors hover:bg-white/[0.06] hover:text-slate-300"
    >
      {children}
    </button>
  );
}
