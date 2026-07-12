/**
 * Shape of a "souvenir" — one distilled memory in an agent's Qdrant namespace (see
 * `docs/memory-souvenirs.md`). The store is Qdrant-only: everything a memory needs to be
 * reranked, reinforced, superseded or inspected lives in the point payload.
 */

/**
 * What kind of thing this memory is. Drives how it's grouped when injected — a durable fact and
 * a recollection of something that happened read very differently to the model.
 */
export type MemoryKind = 'fact' | 'preference' | 'episode' | 'procedure';

export const MEMORY_KINDS: MemoryKind[] = ['fact', 'preference', 'episode', 'procedure'];

/** Where the memory came from. `auto_turn` is the legacy raw-transcript dump (no longer written). */
export type MemorySource = 'distiller' | 'remember_tool' | 'auto_turn';

export interface MemoryPayload {
  text: string;
  kind: MemoryKind;
  /** Short topic/entity key ("gpu-broker", "operator", "image-gen"). Groups a subject's history. */
  subject: string;
  /** 1 = trivia, 5 = load-bearing. Weighs into recall ranking. */
  importance: number;
  tags: string[];
  source: MemorySource;
  /** A superseded memory is kept (audit trail) but never recalled again. */
  status: 'active' | 'superseded';
  superseded_by: string | null;
  created_at: string;
  last_recalled_at: string | null;
  /** How often this memory was actually injected into a prompt. Useful memories get stickier. */
  recall_count: number;
  /** How often the distiller re-derived this same memory (near-duplicate collapsed into it). */
  reinforced_count: number;
  session_id?: string;
  turn_id?: string;
}

export const MAX_IMPORTANCE = 5;

/**
 * Read back a point payload written by any era of this system. Pre-souvenir points (the raw
 * `auto_turn` transcripts, and `remember_tool` writes from before typing) carry only `text` —
 * default them to a low-importance episode so a half-wiped namespace still reads cleanly.
 */
export function normalizePayload(raw: Record<string, unknown>): MemoryPayload {
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
  const kind = str(raw.kind) as MemoryKind;
  return {
    text: str(raw.text),
    kind: MEMORY_KINDS.includes(kind) ? kind : 'episode',
    subject: str(raw.subject),
    importance: Math.min(MAX_IMPORTANCE, Math.max(1, num(raw.importance, 2))),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    source: (str(raw.source, 'auto_turn') as MemorySource) ?? 'auto_turn',
    status: raw.status === 'superseded' ? 'superseded' : 'active',
    superseded_by: typeof raw.superseded_by === 'string' ? raw.superseded_by : null,
    created_at: str(raw.created_at, new Date(0).toISOString()),
    last_recalled_at: typeof raw.last_recalled_at === 'string' ? raw.last_recalled_at : null,
    recall_count: num(raw.recall_count, 0),
    reinforced_count: num(raw.reinforced_count, 0),
    session_id: typeof raw.session_id === 'string' ? raw.session_id : undefined,
    turn_id: typeof raw.turn_id === 'string' ? raw.turn_id : undefined,
  };
}

/** A candidate the distiller proposes, before dedup/supersede resolution. */
export interface MemoryCandidate {
  text: string;
  kind: MemoryKind;
  subject: string;
  importance: number;
  /** Ids of existing memories this one replaces (the model names them; see the distiller prompt). */
  supersedes: string[];
}

/** A memory selected for injection, carrying the rerank score that got it there. */
export interface RecalledMemory {
  id: string | number;
  payload: MemoryPayload;
  /** Raw cosine similarity from Qdrant. */
  similarity: number;
  /** Composite rerank score (similarity + recency + importance + usage). */
  score: number;
}
