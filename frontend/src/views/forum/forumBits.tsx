import { useEffect, useRef, useState } from 'react';
import {
  AtSign,
  BellOff,
  CornerDownLeft,
  Download,
  FileArchive,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Paperclip,
  X,
} from 'lucide-react';
import { agentColor, agentInitial } from '../../lib/agentColor';
import { Button, Chip } from '../../components/ui';
import {
  forumApi,
  type ForumAuthor,
  type ForumAutoRun,
  type ForumFile,
  type ForumWorkState,
  type MentionTarget,
} from '../../lib/api';

/**
 * The built-in moderator's agent name, mirroring `domain/agents/builtin-agents.ts`. Used only to
 * badge its posts: a merge notice or a deletion proposal must not read as one more agent's opinion.
 * A soft match — if the operator's DB took a suffixed name, the badge is what degrades, nothing else.
 */
export const MODERATOR_NAME = 'forum_keeper';

export function isModerator(author: ForumAuthor): boolean {
  return author.kind === 'agent' && author.display_name.startsWith(MODERATOR_NAME);
}

/**
 * How each work state reads on the board. Colour carries the meaning at a glance — `blocked` is the
 * one the operator has to act on, so it is the only warm colour in the set.
 */
export const WORK_STATE_LABELS: Record<ForumWorkState, { label: string; className: string }> = {
  todo: { label: 'todo', className: '!text-slate-400' },
  in_progress: { label: 'in progress', className: '!text-sky-400/90' },
  blocked: { label: 'blocked', className: '!text-amber-400' },
  done: { label: 'done', className: '!text-emerald-400/80' },
};

export function WorkStateChip({ state }: { state: ForumWorkState }) {
  const spec = WORK_STATE_LABELS[state];
  return <Chip className={spec.className}>{spec.label}</Chip>;
}

/**
 * The same vocabulary at a glance, for rows too dense to carry a chip: the board's activity strip
 * shows dozens of threads at 11px, where a full word per state would be all the operator sees.
 */
const WORK_STATE_DOTS: Record<ForumWorkState, string> = {
  todo: 'bg-slate-500',
  in_progress: 'bg-sky-400',
  blocked: 'bg-amber-400',
  done: 'bg-emerald-400',
};

export function WorkStateDot({ state }: { state: ForumWorkState }) {
  return (
    <span
      title={WORK_STATE_LABELS[state].label}
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${WORK_STATE_DOTS[state]}`}
    />
  );
}

/**
 * The "nobody is going to answer this" banner.
 *
 * Rendered only when the allowance is nearly or fully gone, because that is the only time it tells
 * the operator something they cannot see from the thread itself: mentions on an exhausted thread are
 * written, listed, and never run. Silence on the board otherwise looks exactly like agents thinking.
 */
export function AutoRunNotice({ autoRun }: { autoRun: ForumAutoRun | null }) {
  if (!autoRun || autoRun.remaining > 3) return null;
  const resets = autoRun.resetsAt ? new Date(autoRun.resetsAt) : null;
  return (
    <div
      className={`rounded-md border px-3 py-2 text-[12px] ${
        autoRun.exhausted
          ? 'border-amber-500/30 bg-amber-500/[0.07] text-amber-200/90'
          : 'border-white/[0.08] bg-white/[0.02] text-slate-400'
      }`}
    >
      {autoRun.exhausted ? (
        <>
          This thread has spent all {autoRun.budget} of its automatic replies. New <code>@mentions</code>{' '}
          here are recorded but will <strong>not</strong> run — use Run on the mention itself, or raise
          the budget in Settings.
        </>
      ) : (
        <>
          {autoRun.remaining} automatic {autoRun.remaining === 1 ? 'reply' : 'replies'} left on this
          thread ({autoRun.spent}/{autoRun.budget} spent).
        </>
      )}
      {resets && <> Resets {resets.toLocaleString()}.</>}
    </div>
  );
}

/** Compact relative-time label, mirroring `WorkspaceNav`'s so timestamps read the same app-wide. */
export function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * An author's avatar chip. Agents reuse `agentColor`, so an agent's forum identity is the same hue
 * the operator already recognises from chat bubbles and the debugger — the board doesn't invent a
 * second, conflicting identity for the same agent. The operator gets the accent blue.
 */
export function AuthorAvatar({ author, size = 32 }: { author: ForumAuthor; size?: number }) {
  const operator = author.kind === 'operator';
  const color = agentColor(author.display_name);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color: operator ? 'rgb(147 197 253)' : color.accent,
        background: operator ? 'rgba(59,130,246,0.12)' : color.soft,
        border: `1px solid ${operator ? 'rgba(59,130,246,0.35)' : color.border}`,
      }}
      title={author.display_name}
    >
      {agentInitial(author.display_name)}
    </span>
  );
}

/** Author name in their own hue — the fastest way to scan who is saying what down a long thread. */
export function AuthorName({ author }: { author: ForumAuthor }) {
  const operator = author.kind === 'operator';
  return (
    <span
      className="truncate text-sm font-medium"
      style={{ color: operator ? 'rgb(147 197 253)' : agentColor(author.display_name).accent }}
    >
      {author.display_name}
    </span>
  );
}

/**
 * The mention roster, fetched once per page load and shared by every composer on it.
 *
 * A module-level promise rather than per-component state: a thread page mounts one composer plus one
 * more for each post being edited, and none of them should each cost a roster request.
 */
let rosterPromise: Promise<MentionTarget[]> | null = null;

export function useMentionRoster(): MentionTarget[] {
  const [roster, setRoster] = useState<MentionTarget[]>([]);
  useEffect(() => {
    let alive = true;
    rosterPromise = rosterPromise ?? forumApi.mentionRoster().catch(() => []);
    void rosterPromise.then((list) => alive && setRoster(list));
    return () => {
      alive = false;
    };
  }, []);
  return roster;
}

/** Drop the cached roster — after an agent is created or renamed elsewhere in the app. */
export function invalidateMentionRoster(): void {
  rosterPromise = null;
}

/** What the caret is currently typing after an `@`, or null when it isn't in a mention. */
function mentionQuery(value: string, caret: number): { query: string; start: number } | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  // Must start a word, and must not run past the end of a line — a mention is one token, not a
  // paragraph, and a stale picker hanging around three lines later is worse than none.
  if (at > 0 && !/[\s([{<,;:"']/.test(upto[at - 1]!)) return null;
  const query = upto.slice(at + 1);
  if (/[\n]/.test(query) || query.length > 40) return null;
  return { query, start: at };
}

/**
 * The `@` picker (`FORUM_PLAN.md` §11.4). Inserts the *exact* agent name, which is what makes the
 * chip and the backend's resolution agree on who was addressed — a hand-typed near-miss silently
 * addresses nobody.
 *
 * Muted agents stay in the list, marked: you can still address an agent whose alerts you turned off,
 * and saying so beats dropping it and leaving the operator to wonder why it isn't there.
 */
function MentionPicker({
  targets,
  active,
  onPick,
  onHover,
}: {
  targets: MentionTarget[];
  active: number;
  onPick: (t: MentionTarget) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div className="glass-card absolute bottom-full left-0 z-30 mb-1.5 max-h-64 w-72 overflow-auto rounded-xl border border-white/[0.08] p-1 shadow-2xl">
      {targets.map((t, i) => {
        const operator = t.kind === 'operator';
        const color = agentColor(t.name);
        return (
          <button
            key={t.name}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              // mousedown, not click: the textarea must not lose focus before the insert lands.
              e.preventDefault();
              onPick(t);
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
              i === active ? 'bg-accent/15' : 'hover:bg-white/[0.05]'
            }`}
          >
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold"
              style={{
                color: operator ? 'rgb(147 197 253)' : color.accent,
                background: operator ? 'rgba(59,130,246,0.12)' : color.soft,
                borderColor: operator ? 'rgba(59,130,246,0.35)' : color.border,
              }}
            >
              {agentInitial(t.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-200">{t.name}</span>
            {!t.notify && (
              <span title="mentions muted — recorded, but raises no alert">
                <BellOff size={11} className="shrink-0 text-amber-400/70" />
              </span>
            )}
            <span className="text-[10px] uppercase tracking-wider text-slate-600">
              {operator ? 'you' : 'agent'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The reply box. Auto-grows and submits on Enter (Shift+Enter for a newline), matching the chat
 * composer in `components/workspace/ChatPanel.tsx` so the two text surfaces behave identically.
 */
export function Composer({
  placeholder,
  submitLabel,
  initial = '',
  initialFiles = [],
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  initial?: string;
  /** Files the post already carries (edit mode) — the submit sends the list back, minus removals. */
  initialFiles?: ForumFile[];
  autoFocus?: boolean;
  onSubmit: (body: string, attachments: string[]) => Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  // The `@` picker: `at` is where the mention starts in `value`, so an insert replaces exactly the
  // partial handle rather than appending next to it.
  const [mention, setMention] = useState<{ at: number; query: string } | null>(null);
  const [activeMention, setActiveMention] = useState(0);
  const roster = useMentionRoster();
  const [files, setFiles] = useState<ForumFile[]>(initialFiles);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  /**
   * Uploads land in the registry immediately, not on submit. That way a 200 MB video is already
   * stored by the time the operator finishes typing, and a failed upload is a visible error next to
   * the composer rather than a post that silently lost its evidence.
   */
  async function addFiles(list: FileList | File[]) {
    const chosen = Array.from(list);
    if (!chosen.length) return;
    setUploadError('');
    setUploading((u) => [...u, ...chosen.map((f) => f.name)]);
    for (const file of chosen) {
      try {
        const stored = await forumApi.uploadFile(file);
        setFiles((f) => (f.some((x) => x.id === stored.id) ? f : [...f, stored]));
      } catch {
        setUploadError(`Could not upload ${file.name}.`);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);

  // Prefix match on the partial handle, capped — a roster of forty agents must not become a wall.
  const matches = mention
    ? roster
        .filter((t) => t.name.toLowerCase().startsWith(mention.query.toLowerCase()))
        .slice(0, 8)
    : [];

  function syncMention(next: string, caret: number) {
    const found = mentionQuery(next, caret);
    setMention(found ? { at: found.start, query: found.query } : null);
    setActiveMention(0);
  }

  /** Replace the partial `@handle` with the picked name, and leave the caret after the space. */
  function insertMention(target: MentionTarget) {
    if (!mention) return;
    const before = value.slice(0, mention.at);
    const after = value.slice(mention.at + 1 + mention.query.length);
    const next = `${before}@${target.name} ${after.startsWith(' ') ? after.slice(1) : after}`;
    setValue(next);
    setMention(null);
    const caret = before.length + target.name.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
    });
  }

  async function submit() {
    const body = value.trim();
    // A post can be attachments plus a one-word note, but never an empty body — a bare file with no
    // sentence saying what it is helps nobody reading the thread later.
    if (!body || busy || uploading.length) return;
    setBusy(true);
    try {
      await onSubmit(body, files.map((f) => f.id));
      setValue('');
      setFiles([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`glass-card rounded-2xl border p-3 transition-colors ${
        dragging ? 'border-accent/60 bg-accent/[0.06]' : 'border-white/[0.06]'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      <div className="relative">
        {mention && matches.length > 0 && (
          <MentionPicker
            targets={matches}
            active={activeMention}
            onPick={insertMention}
            onHover={setActiveMention}
          />
        )}
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          rows={1}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            setValue(e.target.value);
            syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) => syncMention(value, e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setMention(null)}
          onKeyDown={(e) => {
            // While the picker is open it owns the navigation keys — Enter picks a name rather than
            // posting a half-typed handle, which is the mistake this whole affordance exists to stop.
            if (mention && matches.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveMention((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(matches[activeMention] ?? matches[0]!);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          className="max-h-80 w-full resize-none bg-transparent py-1 text-sm leading-relaxed text-slate-100 outline-none placeholder:text-slate-600"
        />
      </div>
      {(files.length > 0 || uploading.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span
              key={f.id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300"
            >
              <FileKindIcon kind={f.kind} size={11} />
              <span className="max-w-[14rem] truncate">{f.filename}</span>
              <span className="text-slate-600">{formatBytes(f.size)}</span>
              <button
                title="Remove"
                className="text-slate-600 hover:text-slate-300"
                onClick={() => setFiles((list) => list.filter((x) => x.id !== f.id))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {uploading.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 text-[11px] text-slate-500"
            >
              <Paperclip size={11} className="animate-pulse" />
              <span className="max-w-[14rem] truncate">{name}</span>
              uploading…
            </span>
          ))}
        </div>
      )}
      {uploadError && <p className="mt-2 text-[11px] text-rose-400">{uploadError}</p>}

      <div className="mt-2 flex items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          title="Attach files"
          className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-300"
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={13} />
        </button>
        <button
          title="Mention someone"
          className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-300"
          onMouseDown={(e) => {
            e.preventDefault();
            const el = ref.current;
            const caret = el?.selectionStart ?? value.length;
            const next = `${value.slice(0, caret)}@${value.slice(caret)}`;
            setValue(next);
            requestAnimationFrame(() => {
              el?.focus();
              el?.setSelectionRange(caret + 1, caret + 1);
              syncMention(next, caret + 1);
            });
          }}
        >
          <AtSign size={13} />
        </button>
        <span className="text-[11px] text-slate-600">
          Markdown · @ to mention · Enter to post
        </span>
        <div className="ml-auto flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            loading={busy || uploading.length > 0}
            icon={<CornerDownLeft size={13} />}
            onClick={() => void submit()}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- attachments (FORUM_PLAN.md §10) ---------------------------------------

/** One icon per registry kind, so a thread's files are scannable without reading filenames. */
export function FileKindIcon({ kind, size = 13 }: { kind: ForumFile['kind']; size?: number }) {
  const Icon =
    kind === 'image' ? ImageIcon
    : kind === 'video' ? Film
    : kind === 'audio' ? Music
    : kind === 'archive' ? FileArchive
    : FileText;
  return <Icon size={size} className="shrink-0" />;
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * A post's attachments.
 *
 * Images and video render in place — an attached chart nobody opens is a chart nobody read — while
 * everything else is a download chip. Images open a lightbox rather than a new tab so the operator
 * stays in the thread they were reading. `onDetach`, when given, adds the moderator's remove button.
 */
export function AttachmentList({
  files,
  onDetach,
}: {
  files: ForumFile[];
  onDetach?: (file: ForumFile) => void;
}) {
  const [lightbox, setLightbox] = useState<ForumFile | null>(null);
  if (!files.length) return null;

  const images = files.filter((f) => f.kind === 'image');
  const media = files.filter((f) => f.kind === 'video' || f.kind === 'audio');
  const rest = files.filter((f) => !images.includes(f) && !media.includes(f));

  return (
    <div className="mt-3 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((f) => (
            <figure key={f.id} className="group relative">
              <img
                src={forumApi.fileUrl(f.id)}
                alt={f.filename}
                loading="lazy"
                onClick={() => setLightbox(f)}
                className="max-h-64 cursor-zoom-in rounded-xl border border-white/[0.08] object-contain"
              />
              <figcaption className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-600">
                <span className="max-w-[14rem] truncate">{f.filename}</span>
                <span>{formatBytes(f.size)}</span>
                <a href={forumApi.fileUrl(f.id, true)} className="hover:text-slate-300" title="Download">
                  <Download size={10} />
                </a>
                {onDetach && (
                  <button className="hover:text-rose-400" title="Detach" onClick={() => onDetach(f)}>
                    <X size={10} />
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      {media.map((f) =>
        f.kind === 'video' ? (
          <video
            key={f.id}
            src={forumApi.fileUrl(f.id)}
            controls
            preload="metadata"
            className="max-h-80 w-full rounded-xl border border-white/[0.08] bg-black/40"
          />
        ) : (
          <audio key={f.id} src={forumApi.fileUrl(f.id)} controls className="w-full" />
        ),
      )}

      {rest.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rest.map((f) => (
            <a
              key={f.id}
              href={forumApi.fileUrl(f.id, true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300 transition-colors hover:border-white/[0.16] hover:text-slate-100"
            >
              <FileKindIcon kind={f.kind} size={11} />
              <span className="max-w-[16rem] truncate">{f.filename}</span>
              <span className="text-slate-600">{formatBytes(f.size)}</span>
              <Download size={11} className="text-slate-600" />
            </a>
          ))}
          {onDetach &&
            rest.map((f) => (
              <button
                key={`x-${f.id}`}
                title={`Detach ${f.filename}`}
                className="rounded-lg border border-white/[0.08] px-1.5 text-[11px] text-slate-600 hover:text-rose-400"
                onClick={() => onDetach(f)}
              >
                <X size={11} />
              </button>
            ))}
        </div>
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          <img src={forumApi.fileUrl(lightbox.id)} alt={lightbox.filename} className="max-h-full max-w-full rounded-xl" />
          <button className="absolute right-6 top-6 text-slate-300 hover:text-white" title="Close">
            <X size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
