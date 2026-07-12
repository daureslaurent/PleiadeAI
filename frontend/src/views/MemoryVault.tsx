import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Database, Search, Trash2 } from 'lucide-react';
import { agentsApi, memoryApi, type Agent } from '../lib/api';
import {
  Callout,
  Chip,
  EmptyState,
  GlassCard,
  Input,
  Select,
  Spinner,
  useConfirm,
} from '../components/ui';

type Point = { id: string | number; payload: Record<string, unknown> };

/**
 * A memory point's payload (`docs/memory-souvenirs.md`). Legacy points predate most of these fields
 * — a raw `auto_turn` transcript carries only `text` — so every field is defaulted, mirroring
 * `normalizePayload` on the backend.
 */
interface MemoryFields {
  text: string;
  created_at: string | null;
  source: string | null;
  kind: string | null;
  subject: string | null;
  importance: number | null;
  status: string;
  recall_count: number;
  tags: string[];
}

function fields(payload: Record<string, unknown>): MemoryFields {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    text: typeof payload.text === 'string' ? payload.text : '',
    created_at: str(payload.created_at),
    source: str(payload.source),
    kind: str(payload.kind),
    subject: str(payload.subject),
    importance: typeof payload.importance === 'number' ? payload.importance : null,
    status: payload.status === 'superseded' ? 'superseded' : 'active',
    recall_count: typeof payload.recall_count === 'number' ? payload.recall_count : 0,
    tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
  };
}

/**
 * A point with no `kind` is pre-souvenir: a raw whole-turn transcript dumped in by the old auto-store
 * (or an untyped `remember` write). These are the ones worth clearing out — they embed to nothing
 * useful and drag down recall. The `legacy` filter + bulk delete exist to make that a one-click job.
 */
function isLegacy(f: MemoryFields): boolean {
  return f.source === 'auto_turn' || !f.kind;
}

type KindFilter = 'all' | 'fact' | 'preference' | 'procedure' | 'episode' | 'legacy' | 'superseded';

/** Compact relative age ("3m", "5h", "2d"); falls back to the locale date beyond a month. */
function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Memory Vault (spec §4): select an agent, inspect its *isolated* Qdrant vector block, and
 * explicitly delete corrupted memories. The namespace is resolved server-side from the agent,
 * so the UI can never cross agent boundaries.
 */
export function MemoryVault() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [points, setPoints] = useState<Point[] | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [error, setError] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    agentsApi
      .list()
      .then((a) => {
        setAgents(a);
        if (a[0]) setAgentId(a[0]._id);
        else setPoints([]);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    if (!agentId) return;
    setPoints(null);
    memoryApi
      .list(agentId)
      .then(setPoints)
      .catch(() => setError(true));
  }, [agentId]);

  const agent = agents.find((a) => a._id === agentId);

  // Client-side filter across the rendered text and the raw payload, so a search hits metadata
  // (session_id, tags) that the card only shows behind the raw disclosure.
  const shown = useMemo(() => {
    if (!points) return null;
    const q = query.trim().toLowerCase();
    return points.filter((p) => {
      const f = fields(p.payload);
      if (kind === 'legacy' && !isLegacy(f)) return false;
      if (kind === 'superseded' && f.status !== 'superseded') return false;
      if (kind !== 'all' && kind !== 'legacy' && kind !== 'superseded' && f.kind !== kind) return false;
      if (!q) return true;
      return (
        String(p.id).toLowerCase().includes(q) ||
        JSON.stringify(p.payload).toLowerCase().includes(q)
      );
    });
  }, [points, query, kind]);

  async function remove(p: Point) {
    const { text } = fields(p.payload);
    const ok = await confirm({
      title: 'Delete this memory?',
      body: text ? `“${text.slice(0, 160)}${text.length > 160 ? '…' : ''}”` : String(p.id),
      danger: true,
    });
    if (!ok) return;
    await memoryApi.remove(agentId, [p.id]);
    setPoints((ps) => (ps ? ps.filter((x) => x.id !== p.id) : ps));
  }

  /** Bulk-delete everything currently filtered in — how a namespace of legacy transcripts gets wiped. */
  async function removeShown() {
    if (!shown?.length) return;
    const ok = await confirm({
      title: `Delete ${shown.length} ${shown.length === 1 ? 'memory' : 'memories'}?`,
      body: `Every memory currently listed will be permanently removed from ${
        agent?.qdrant_namespace ?? 'this namespace'
      }. This cannot be undone.`,
      danger: true,
    });
    if (!ok) return;
    const ids = shown.map((p) => p.id);
    await memoryApi.remove(agentId, ids);
    const gone = new Set(ids.map(String));
    setPoints((ps) => (ps ? ps.filter((x) => !gone.has(String(x.id))) : ps));
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Callout tone="error" icon={<AlertTriangle size={14} />}>
          Failed to reach the memory service. Qdrant or the embeddings server may be down.
        </Callout>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        {/* Namespace selector + search */}
        <GlassCard className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Database size={15} className="shrink-0 text-accent" />
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Isolated memory</span>
          <Select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-auto min-w-[14rem] flex-none py-1.5 text-xs"
          >
            {agents.map((a) => (
              <option key={a._id} value={a._id}>
                {a.name} · {a.qdrant_namespace}
              </option>
            ))}
          </Select>

          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as KindFilter)}
            className="w-auto flex-none py-1.5 text-xs"
          >
            <option value="all">All kinds</option>
            <option value="fact">Facts</option>
            <option value="preference">Preferences</option>
            <option value="procedure">How-tos</option>
            <option value="episode">Episodes</option>
            <option value="legacy">Legacy transcripts</option>
            <option value="superseded">Superseded</option>
          </Select>

          <div className="relative ml-auto min-w-[12rem] flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memories…"
              className="py-1.5 pl-8 text-xs"
            />
          </div>

          {shown && (
            <span className="shrink-0 font-mono text-[11px] text-slate-500">
              {shown.length}
              {points && shown.length !== points.length && `/${points.length}`} vectors
            </span>
          )}

          {!!shown?.length && (query.trim() || kind !== 'all') && (
            <button
              onClick={removeShown}
              className="shrink-0 rounded-lg border border-red-500/20 px-2 py-1 text-[10px] font-medium text-red-400/90 transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              Delete {shown.length} shown
            </button>
          )}
        </GlassCard>

        {agent && (
          <p className="px-1 text-[11px] text-slate-600">
            Namespace <span className="font-mono text-slate-500">{agent.qdrant_namespace}</span> is
            strictly siloed — no other agent can read or recall from it.
          </p>
        )}

        {!shown ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <GlassCard>
            <EmptyState icon={<Database size={28} />}>
              {query || kind !== 'all'
                ? 'No memory matches that filter.'
                : 'No vectors in this namespace yet. Memories are distilled from the agent’s turns — most turns produce none.'}
            </EmptyState>
          </GlassCard>
        ) : (
          <div className="space-y-2">
            {shown.map((p) => (
              <MemoryCard key={String(p.id)} point={p} onDelete={() => remove(p)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryCard({ point, onDelete }: { point: Point; onDelete: () => void }) {
  const [raw, setRaw] = useState(false);
  const f = fields(point.payload);
  const { text, created_at, source, tags } = f;
  const legacy = isLegacy(f);
  const retired = f.status === 'superseded';

  return (
    <div
      className={[
        'animate-fade-up rounded-xl border bg-black/25 backdrop-blur-sm transition-colors hover:border-white/[0.12]',
        // A superseded memory is dead weight the agent will never recall again — show it as such.
        retired ? 'border-white/[0.04] opacity-50' : 'border-white/[0.06]',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5">
        <span className="font-mono text-[10px] text-slate-600" title={String(point.id)}>
          {String(point.id).slice(0, 8)}
        </span>
        {f.kind && <Chip className="text-reasoning">{f.kind}</Chip>}
        {f.subject && <Chip className="text-slate-400">{f.subject}</Chip>}
        {legacy && (
          <Chip className="text-amber-400/80">
            legacy transcript
          </Chip>
        )}
        {retired && <Chip className="text-slate-500">superseded</Chip>}
        {source && !legacy && <Chip>{source.replace(/_/g, ' ')}</Chip>}
        {f.importance != null && (
          <span className="font-mono text-[10px] text-slate-600" title="Importance (1–5)">
            i{f.importance}
          </span>
        )}
        {f.recall_count > 0 && (
          <span
            className="font-mono text-[10px] text-slate-600"
            title={`Recalled into a prompt ${f.recall_count}×`}
          >
            ↻{f.recall_count}
          </span>
        )}
        {tags.map((t) => (
          <Chip key={t} className="text-accent">
            {t}
          </Chip>
        ))}
        <span className="ml-auto shrink-0 text-[10px] text-slate-600" title={created_at ?? undefined}>
          {fmtAge(created_at)}
        </span>
        <button
          onClick={onDelete}
          title="Delete memory"
          className="shrink-0 rounded-md p-1 text-slate-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <p className="whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed text-slate-300">
        {text || <span className="italic text-slate-600">(no text field)</span>}
      </p>

      <button
        onClick={() => setRaw((r) => !r)}
        className="flex w-full items-center gap-1 px-3 pb-2 text-[10px] uppercase tracking-wider text-slate-600 transition-colors hover:text-slate-400"
      >
        <ChevronRight size={11} className={`transition-transform ${raw ? 'rotate-90' : ''}`} />
        raw payload
      </button>
      {raw && (
        <pre className="mx-3 mb-3 overflow-x-auto rounded-lg bg-black/40 p-2.5 font-mono text-[10px] leading-relaxed text-slate-400">
          {JSON.stringify(point.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
