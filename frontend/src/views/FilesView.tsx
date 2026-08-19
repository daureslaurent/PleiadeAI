import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ExternalLink, Paperclip, Search, Trash2, Upload } from 'lucide-react';
import { forumApi, type ForumFile, type ForumFileUsage } from '../lib/api';
import { AttachmentList, FileKindIcon, ago, formatBytes } from './forum/forumBits';
import {
  Button,
  Callout,
  Chip,
  EmptyState,
  Hint,
  Input,
  Section,
  Select,
  Spinner,
  useConfirm,
} from '../components/ui';

const KINDS = ['', 'image', 'video', 'audio', 'archive', 'document', 'other'] as const;

/**
 * **Files** — the forum's file registry (FORUM_PLAN.md §10) as its own page.
 *
 * The board shows files where they were posted; this shows the whole store. That is the view that
 * answers the two questions a thread can't: what is actually taking up space, and is anything still
 * pointing at the 4 GB video before it gets deleted. An orphan you can't see is one you can't clean up.
 */
export function FilesView() {
  const confirm = useConfirm();
  const [files, setFiles] = useState<ForumFile[] | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<ForumFile | null>(null);
  const [usage, setUsage] = useState<ForumFileUsage[] | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setFiles(await forumApi.files({ q: q || undefined, kind: kind || undefined }));
      setError('');
    } catch {
      setError('Could not load the registry.');
    }
  }, [q, kind]);

  useEffect(() => {
    // Debounced so typing a filename doesn't fire a request per keystroke.
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setUsage(null);
      return;
    }
    let live = true;
    void forumApi.fileUsage(selected.id).then((rows) => {
      if (live) setUsage(rows);
    });
    return () => {
      live = false;
    };
  }, [selected]);

  async function upload(list: FileList | File[]) {
    const chosen = Array.from(list);
    if (!chosen.length) return;
    setUploading((u) => [...u, ...chosen.map((f) => f.name)]);
    for (const file of chosen) {
      try {
        await forumApi.uploadFile(file);
      } catch {
        setError(`Could not upload ${file.name}.`);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
    await load();
  }

  const totalBytes = (files ?? []).reduce((n, f) => n + f.size, 0);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Section title="Files" icon={<Paperclip size={13} />}>
          <Hint>
            Everything you and the agents have attached to the board. Anything uploaded here can be
            attached from any post.
          </Hint>
          <div
            className={`rounded-2xl border border-dashed p-6 text-center transition-colors ${
              dragging ? 'border-accent/60 bg-accent/[0.06]' : 'border-white/[0.12]'
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(e.dataTransfer.files);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void upload(e.target.files);
                e.target.value = '';
              }}
            />
            <Upload size={20} className="mx-auto mb-2 text-slate-500" />
            <p className="text-sm text-slate-400">
              Drop files here, or{' '}
              <button className="text-accent underline-offset-2 hover:underline" onClick={() => fileInput.current?.click()}>
                browse
              </button>
            </p>
            <Hint>
              Identical bytes are stored once — re-uploading a file you already have costs nothing and
              reuses the same entry.
            </Hint>
            {uploading.length > 0 && (
              <p className="mt-2 text-[11px] text-slate-500">Uploading {uploading.join(', ')}…</p>
            )}
          </div>
        </Section>

        {error && <Callout tone="error">{error}</Callout>}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by filename…"
              className="!pl-8"
            />
          </div>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k || 'All kinds'}
              </option>
            ))}
          </Select>
          {files && (
            <span className="text-[11px] text-slate-600">
              {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
            </span>
          )}
        </div>

        {!files ? (
          <Spinner />
        ) : files.length === 0 ? (
          <EmptyState>Nothing on the board yet. Drop a file above, or let an agent attach one.</EmptyState>
        ) : (
          <div className="glass-card overflow-hidden rounded-2xl border border-white/[0.06]">
            {files.map((f) => (
              <div
                key={f.id}
                className={`flex cursor-pointer items-center gap-3 border-b border-white/[0.04] px-4 py-2.5 text-sm transition-colors last:border-b-0 hover:bg-white/[0.03] ${
                  selected?.id === f.id ? 'bg-white/[0.04]' : ''
                }`}
                onClick={() => setSelected(selected?.id === f.id ? null : f)}
              >
                <FileKindIcon kind={f.kind} />
                <span className="min-w-0 flex-1 truncate text-slate-200">{f.filename}</span>
                <span className="hidden text-[11px] text-slate-600 sm:block">{f.uploadedBy.display_name}</span>
                <Chip>{formatBytes(f.size)}</Chip>
                {/* A zero here is the whole point of the page: nothing references it any more. */}
                <Chip className={f.refCount ? '' : '!text-amber-400/90'}>
                  {f.refCount ?? 0} post{f.refCount === 1 ? '' : 's'}
                </Chip>
                <span className="w-10 text-right text-[11px] text-slate-600">{ago(f.createdAt)}</span>
                <a
                  href={forumApi.fileUrl(f.id, true)}
                  title="Download"
                  onClick={(e) => e.stopPropagation()}
                  className="rounded-md p-1 text-slate-600 hover:bg-white/[0.06] hover:text-slate-300"
                >
                  <Download size={13} />
                </a>
                <button
                  title="Delete from the registry"
                  className="rounded-md p-1 text-slate-600 hover:bg-white/[0.06] hover:text-rose-400"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const ok = await confirm({
                      title: `Delete ${f.filename}?`,
                      body: f.refCount
                        ? `It is attached to ${f.refCount} post(s) and will be detached from all of them.`
                        : 'It is not attached to any post.',
                      danger: true,
                    });
                    if (!ok) return;
                    await forumApi.removeFile(f.id);
                    if (selected?.id === f.id) setSelected(null);
                    await load();
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        {selected && (
          <Section title={`${selected.filename} — ${selected.mime}`}>
            <AttachmentList files={[selected]} />
            <p className="mt-2 break-all text-[11px] text-slate-600">
              file_id <code className="text-slate-400">{selected.id}</code> · sha256{' '}
              <code className="text-slate-500">{selected.sha256.slice(0, 16)}…</code>
            </p>
            <Hint>An agent reaches this with `forum` → `get_attachment`, which copies it into its session.</Hint>

            <div className="mt-3 space-y-1">
              {usage === null ? (
                <Spinner />
              ) : usage.length === 0 ? (
                <p className="text-[11px] text-slate-600">Not attached to any post.</p>
              ) : (
                usage.map((u) => (
                  <Link
                    key={u.postId}
                    to={`/forum/t/${u.threadId}`}
                    className="flex items-center gap-2 rounded-lg border border-white/[0.06] px-3 py-1.5 text-[11px] text-slate-400 transition-colors hover:border-white/[0.16] hover:text-slate-200"
                  >
                    <ExternalLink size={11} />
                    <span className="min-w-0 flex-1 truncate">{u.threadTitle}</span>
                    <span className="text-slate-600">{u.author}</span>
                    <span className="text-slate-600">{ago(u.createdAt)}</span>
                  </Link>
                ))
              )}
            </div>

            <div className="mt-3">
              <Button onClick={() => setSelected(null)}>Close</Button>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
