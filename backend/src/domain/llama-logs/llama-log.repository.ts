import mongoose from 'mongoose';
import { truncateRequestImages } from '../../inference/truncate-images';
import { LlamaCallDebugModel, LlamaCallArchiveModel, type LlamaLogDoc } from './llama-log.model';
import type { LlamaCallEndPayload } from '../../core/event-bus/events.types';

/** Storage size + document count for one collection. */
export interface CollectionSize {
  bytes: number;
  count: number;
}

export interface LlamaLogStats {
  archive: CollectionSize;
  debug: CollectionSize;
  /** Whole-database storage size in bytes. */
  dbBytes: number;
}

/** Shape a `llama:call_end` payload into the persisted document (shared by both tiers). */
function toRecord(p: LlamaCallEndPayload) {
  return {
    call_id: p.id,
    source: p.source,
    endpoint: p.endpoint,
    model: p.model,
    session_id: p.ctx?.sessionId ?? null,
    turn_id: p.turnId ?? null,
    agent_id: p.ctx?.agentId ?? null,
    agent_name: p.ctx?.agentName ?? null,
    depth: p.ctx?.depth ?? null,
    status: p.status,
    request: p.request,
    response: p.response,
    raw_chunks: p.rawChunks,
    tools: p.request.tools ?? null,
    usage: p.usage,
    duration_ms: p.durationMs,
    first_token_ms: p.firstTokenMs,
    error: p.error ?? null,
    created_at: new Date(p.startedAt),
  };
}

export const llamaLogRepository = {
  /**
   * Persist one captured call into both tiers: the durable archive keeps the full request (base64
   * images intact); the capped debug buffer stores a copy with image data URLs truncated.
   */
  async insert(payload: LlamaCallEndPayload): Promise<void> {
    const full = toRecord(payload);
    const debug = { ...full, request: truncateRequestImages(payload.request), tools: full.tools };
    // Independent writes — a failure in one tier shouldn't lose the other.
    await Promise.allSettled([LlamaCallArchiveModel.create(full), LlamaCallDebugModel.create(debug)]);
  },

  /** Last `limit` calls from the fast capped debug buffer, newest first. */
  listDebug(limit: number): Promise<LlamaLogDoc[]> {
    return LlamaCallDebugModel.find().sort({ created_at: -1 }).limit(limit).exec();
  },

  /** Last `limit` calls from the uncapped archive (deep history), newest first. */
  listArchive(limit: number): Promise<LlamaLogDoc[]> {
    return LlamaCallArchiveModel.find().sort({ created_at: -1 }).limit(limit).exec();
  },

  /** The full archive record (untruncated images + raw chunks) for one call. */
  getArchive(callId: string): Promise<LlamaLogDoc | null> {
    return LlamaCallArchiveModel.findOne({ call_id: callId }).exec();
  },

  /** All archive records of one turn, oldest first — the input to the Conversation Quality Scorer. */
  listByTurn(turnId: string): Promise<LlamaLogDoc[]> {
    return LlamaCallArchiveModel.find({ turn_id: turnId }).sort({ created_at: 1 }).exec();
  },

  /**
   * Distinct `turn_id`s present in the archive (only scoreable `chat-turn` calls), newest turn first.
   * Backs the "score all" batch and JSONL export. Side-task calls (title/identity/vision) carry no
   * turn_id and are excluded.
   */
  async listTurnIds(limit = 5000): Promise<string[]> {
    const rows = await LlamaCallArchiveModel.aggregate<{ _id: string; last: Date }>([
      { $match: { turn_id: { $ne: null }, source: 'chat-turn' } },
      { $group: { _id: '$turn_id', last: { $max: '$created_at' } } },
      { $sort: { last: -1 } },
      { $limit: limit },
    ]).exec();
    return rows.map((r) => r._id);
  },

  /** Wipe the durable archive (guarded behind a UI confirm). The capped debug buffer is untouched. */
  async purgeArchive(): Promise<number> {
    const res = await LlamaCallArchiveModel.deleteMany({}).exec();
    return res.deletedCount ?? 0;
  },

  /** Collection sizes + counts for the LLM Debug page's DB size readout. */
  async stats(): Promise<LlamaLogStats> {
    const db = mongoose.connection.db;
    if (!db) return { archive: { bytes: 0, count: 0 }, debug: { bytes: 0, count: 0 }, dbBytes: 0 };
    const collSize = async (name: string): Promise<CollectionSize> => {
      try {
        const s = (await db.command({ collStats: name })) as { size?: number; count?: number };
        return { bytes: s.size ?? 0, count: s.count ?? 0 };
      } catch {
        // Collection may not exist yet (before first write / migration) — report zeros.
        return { bytes: 0, count: 0 };
      }
    };
    const [archive, debug, dbStats] = await Promise.all([
      collSize('llama_calls_archive'),
      collSize('llama_calls_debug'),
      db.command({ dbStats: 1 }).catch(() => ({ dataSize: 0 }) as { dataSize?: number }),
    ]);
    return { archive, debug, dbBytes: (dbStats as { dataSize?: number }).dataSize ?? 0 };
  },
};

export type { LlamaLogDoc };
