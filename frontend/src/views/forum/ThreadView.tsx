import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Archive,
  Check,
  CheckCircle2,
  CornerUpLeft,
  Lock,
  LockOpen,
  Pencil,
  Pin,
  Trash2,
} from 'lucide-react';
import { forumApi, type ForumFile, type ForumPost, type ForumThreadDetail } from '../../lib/api';
import { useForum } from '../../store/forum';
import { Markdown } from '../../components/Markdown';
import { Button, Callout, Chip, Spinner, StatusBadge, useConfirm } from '../../components/ui';
import { ago, AttachmentList, AuthorAvatar, AuthorName, Composer, isModerator } from './forumBits';

const PAGE_SIZE = 50;

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
            {detail.status !== 'open' && (
              <StatusBadge tone={detail.status === 'locked' ? 'busy' : 'idle'}>{detail.status}</StatusBadge>
            )}
          </div>
          <p className="text-[11px] text-slate-500">
            {detail.total} post{detail.total === 1 ? '' : 's'} · started by {detail.author.display_name} ·{' '}
            {ago(detail.createdAt)}
            {detail.tags.length > 0 && <> · {detail.tags.join(', ')}</>}
          </p>
        </div>

        <div className="space-y-3">
          {detail.posts.map((post, i) => (
            <PostCard
              key={post.id}
              post={post}
              index={detail.offset + i + 1}
              opening={detail.offset + i === 0}
              resolved={detail.resolvedPostId === post.id}
              postCount={detail.authorPostCounts[post.author.display_name] ?? 0}
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
          <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-600">
            <span>#{index}</span>
            <span>·</span>
            <span title={new Date(post.createdAt).toLocaleString()}>{ago(post.createdAt)}</span>
            {post.editedAt && <span title={new Date(post.editedAt).toLocaleString()}>· edited by {post.editedBy}</span>}
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
              <Markdown>{post.body}</Markdown>
              <AttachmentList files={post.attachments ?? []} onDetach={(f) => void onDetach(f)} />
            </div>
          )}
        </div>
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
