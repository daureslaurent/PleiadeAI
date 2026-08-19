import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileJson, Hash, Layers, RefreshCw, ScrollText, X } from 'lucide-react';
import { llmDebugApi, type Agent, type LlamaCallRecord, type PromptTokenBreakdown } from '../../lib/api';
import { useStream } from '../../store/stream';

/**
 * A message exactly as it was captured in the outgoing request. Mirrors the backend's `ChatMessage`
 * but stays defensive — this is replayed archive data, not a freshly built object.
 */
interface CapturedMessage {
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

const ROLE_TINT: Record<string, { text: string; ring: string; bar: string }> = {
  system: { text: 'text-amber-300', ring: 'ring-amber-500/20', bar: 'bg-amber-300' },
  user: { text: 'text-sky-300', ring: 'ring-sky-500/20', bar: 'bg-sky-300' },
  assistant: { text: 'text-emerald-300', ring: 'ring-emerald-500/20', bar: 'bg-emerald-300' },
  tool: { text: 'text-reasoning', ring: 'ring-purple-500/20', bar: 'bg-reasoning' },
};
const DEFAULT_TINT = { text: 'text-slate-300', ring: 'ring-white/10', bar: 'bg-slate-400' };

/** Flatten a captured message's content to displayable text (image parts arrive as placeholders). */
function contentText(msg: CapturedMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => (p.type === 'text' ? (p.text ?? '') : (p.image_url?.url ?? '[image]')))
      .join('\n');
  }
  return '';
}

function MessageCard({
  msg,
  index,
  tokens,
  share,
}: {
  msg: CapturedMessage;
  index: number;
  tokens: number | null;
  share: number;
}) {
  // The system message is the one that's always huge and always the same — start it collapsed so the
  // actual conversation is what you see first.
  const [open, setOpen] = useState(msg.role !== 'system');
  const tint = ROLE_TINT[msg.role] ?? DEFAULT_TINT;
  const text = contentText(msg);
  const calls = msg.tool_calls ?? [];

  return (
    <div className={`rounded-xl bg-black/25 ring-1 backdrop-blur-sm ${tint.ring}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-slate-500" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-slate-500" />
        )}
        <span className={`shrink-0 font-mono text-[11px] uppercase ${tint.text}`}>
          {msg.role}
        </span>
        {msg.name && <span className="shrink-0 font-mono text-[10px] text-slate-500">{msg.name}</span>}
        {!open && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500">
            {text.replace(/\s+/g, ' ').slice(0, 120) ||
              (calls.length ? calls.map((c) => `${c.function.name}()`).join(' ') : '—')}
          </span>
        )}
        <span className="ml-auto shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
          {tokens === null ? `#${index}` : `${tokens.toLocaleString()} tok`}
        </span>
      </button>

      {/* Share-of-context bar: the whole point of the view — which message is eating the window. */}
      {tokens !== null && share > 0 && (
        <div className="mx-3 h-0.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={`h-full ${tint.bar}`}
            style={{ width: `${Math.min(100, share * 100)}%` }}
          />
        </div>
      )}

      {open && (
        <div className="px-3 pb-2.5 pt-2">
          {msg.tool_call_id && (
            <div className="mb-1 font-mono text-[10px] text-slate-600">↳ {msg.tool_call_id}</div>
          )}
          {text && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-400">
              {text}
            </pre>
          )}
          {calls.map((c) => (
            <div key={c.id} className="mt-1.5 rounded-lg bg-white/[0.03] px-2 py-1.5">
              <div className="font-mono text-[11px] text-emerald-300">{c.function.name}</div>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-slate-500">
                {c.function.arguments}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  onClose: () => void;
  sessionId: string | null;
  agent: Agent | null;
}

/**
 * **Prompt** — the conversation as the model received it, per inference call.
 *
 * Every chat turn makes up to `max_tool_iterations` calls, each with a *larger* message array than
 * the last (the tool loop appends its results). This drawer replays the persisted captures for the
 * session (`llama_calls_archive`, the ground truth of what was sent — not a re-assembly), lets the
 * operator step through each pass, and sizes every message so it is visible *which* ones are
 * consuming the context window. That breakdown is the groundwork for compaction.
 *
 * Data refreshes on open and whenever a turn finishes streaming, so the newest pass is one click away.
 */
export function PromptDrawer({ onClose, sessionId, agent }: Props) {
  const { streaming } = useStream();
  const [calls, setCalls] = useState<LlamaCallRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [raw, setRaw] = useState(false);
  const [tokens, setTokens] = useState<PromptTokenBreakdown | null>(null);
  const [tokenizing, setTokenizing] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) {
      setCalls([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await llmDebugApi.bySession(sessionId);
      setCalls(rows);
      // Follow the tail: the last pass carries the fullest context, which is what you came to see.
      setSelected((prev) => (prev && rows.some((r) => r.id === prev) ? prev : (rows.at(-1)?.id ?? null)));
    } catch {
      setCalls([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A finished turn is when new captures exist — the records are persisted at call end.
  useEffect(() => {
    if (!streaming) void load();
  }, [streaming, load]);

  const call = useMemo(() => calls.find((c) => c.id === selected) ?? null, [calls, selected]);
  const messages = useMemo(
    () => ((call?.request.messages ?? []) as CapturedMessage[]),
    [call],
  );

  // Token breakdown is a round trip to the inference host per message — only for the shown call.
  useEffect(() => {
    let cancelled = false;
    setTokens(null);
    if (!call || !messages.length) return;
    setTokenizing(true);
    llmDebugApi
      .tokenize(messages, agent?._id ?? null)
      .then((t) => {
        if (!cancelled) setTokens(t);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setTokenizing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [call, messages, agent?._id]);

  /** Turn ordinal + pass ordinal for each call, so the picker reads as "turn 3 · pass 2". */
  const labels = useMemo(() => {
    const turnOrder: string[] = [];
    const passes = new Map<string, number>();
    return calls.map((c) => {
      const key = c.turnId ?? c.id;
      if (!turnOrder.includes(key)) turnOrder.push(key);
      const pass = (passes.get(key) ?? 0) + 1;
      passes.set(key, pass);
      return { turn: turnOrder.indexOf(key) + 1, pass };
    });
  }, [calls]);

  const sum = tokens?.perMessage.reduce<number>((a, n) => a + (n ?? 0), 0) ?? 0;
  const total = tokens?.total ?? call?.usage?.promptTokens ?? null;
  const window = tokens?.contextWindow ?? 0;

  return (
    <aside className="glass flex w-[26rem] shrink-0 flex-col border-l">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <ScrollText size={14} className="text-accent" />
        <span className="text-xs font-medium text-slate-200">Prompt</span>
        <span className="text-[10px] text-slate-500">as sent to the model</span>
        <button
          onClick={() => void load()}
          title="Refresh"
          className="ml-auto rounded p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-300"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => setRaw((r) => !r)}
          title="Raw request JSON"
          className={`rounded p-1 transition-colors ${
            raw ? 'bg-accent/15 text-accent' : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
          }`}
        >
          <FileJson size={13} />
        </button>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-300"
        >
          <X size={13} />
        </button>
      </div>

      {/* Pass picker — every inference call of the session, oldest first. */}
      {calls.length > 0 && (
        <div className="flex gap-1 overflow-x-auto border-b border-white/[0.06] px-2 py-1.5">
          {calls.map((c, i) => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id)}
              title={`${c.agentName ?? 'agent'} · ${c.model} · ${new Date(c.createdAt).toLocaleTimeString()}`}
              className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] transition-colors ${
                c.id === selected
                  ? 'bg-accent/15 text-accent'
                  : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
              }`}
            >
              t{labels[i]?.turn}·p{labels[i]?.pass}
              {(c.depth ?? 0) > 0 && <span className="ml-1 text-slate-600">↳{c.depth}</span>}
            </button>
          ))}
        </div>
      )}

      {!sessionId || !call ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-slate-500">
          <Layers size={28} className="text-slate-600" />
          <p className="px-6 text-xs">
            {sessionId
              ? 'No inference calls captured for this session yet. Send a message.'
              : 'Pick a session to inspect what it sends to the model.'}
          </p>
        </div>
      ) : (
        <>
          {/* Call summary: model, message count, and the context bill. */}
          <div className="border-b border-white/[0.06] px-3 py-2">
            <div className="flex items-center gap-2 font-mono text-[10px] text-slate-500">
              <span className="truncate text-slate-400">{call.model}</span>
              <span>·</span>
              <span>{messages.length} msg</span>
              {call.tools?.length ? (
                <>
                  <span>·</span>
                  <span>{call.tools.length} tools</span>
                </>
              ) : null}
              <span className="ml-auto flex items-center gap-1 text-slate-400">
                <Hash size={10} />
                {tokenizing ? '…' : total !== null ? total.toLocaleString() : '—'}
                {window > 0 && total !== null && (
                  <span className="text-slate-600">/ {window.toLocaleString()}</span>
                )}
              </span>
            </div>
            {window > 0 && total !== null && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={`h-full ${total / window > 0.8 ? 'bg-red-400' : total / window > 0.5 ? 'bg-amber-400' : 'bg-accent'}`}
                  style={{ width: `${Math.min(100, (total / window) * 100)}%` }}
                />
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {raw ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-slate-400">
                {JSON.stringify(call.request, null, 2)}
              </pre>
            ) : (
              <div className="flex flex-col gap-1.5">
                {messages.map((m, i) => (
                  <MessageCard
                    key={i}
                    msg={m}
                    index={i}
                    tokens={tokens?.perMessage[i] ?? null}
                    share={sum > 0 ? (tokens?.perMessage[i] ?? 0) / sum : 0}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
