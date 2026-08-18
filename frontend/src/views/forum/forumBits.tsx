import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { agentColor, agentInitial } from '../../lib/agentColor';
import { Button } from '../../components/ui';
import type { ForumAuthor } from '../../lib/api';

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
 * The reply box. Auto-grows and submits on Enter (Shift+Enter for a newline), matching the chat
 * composer in `components/workspace/ChatPanel.tsx` so the two text surfaces behave identically.
 */
export function Composer({
  placeholder,
  submitLabel,
  initial = '',
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);

  async function submit() {
    const body = value.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSubmit(body);
      setValue('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass-card rounded-2xl border border-white/[0.06] p-3">
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        className="max-h-80 w-full resize-none bg-transparent py-1 text-sm leading-relaxed text-slate-100 outline-none placeholder:text-slate-600"
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-slate-600">Markdown · Enter to post, Shift+Enter for a new line</span>
        <div className="ml-auto flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="primary" loading={busy} icon={<CornerDownLeft size={13} />} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
