import { SessionModel } from '../sessions/session.model';
import { MessageModel } from '../sessions/message.model';
import { ConversationScoreModel } from '../scoring/conversation-score.model';
import { LlamaCallArchiveModel, LlamaCallDebugModel } from '../llama-logs/llama-log.model';
import { NotificationModel } from '../notifications/notification.model';
import { RunResultModel } from '../autonomy/run-result.model';
import { FinetuneJobModel } from '../finetune-jobs/finetune-job.model';
import { createLogger } from '../../config/logger';

const log = createLogger('data-reset');

export const BACKUP_TYPE = 'pleiade-data-backup';
export const BACKUP_VERSION = 1;

/**
 * Operator-facing "clear data" reset (Settings → danger zone).
 *
 * Deliberately narrow: it removes *operational history* — conversations, their scores, the raw
 * inference logs, and activity records — while leaving the fleet's identity and knowledge intact.
 * Agents, isolations, images, endpoints, skills, settings, API keys and Qdrant vector memory are
 * **never** touched here (agents/isolations are handled by the destructive clone import instead).
 *
 * Structural typing keeps the registry honest without fighting seven unrelated Mongoose model types:
 * we only ever call `countDocuments`, `find().lean()` and `deleteMany` on each.
 */
interface ResettableModel {
  countDocuments(): Promise<number>;
  find(): { lean(): { exec(): Promise<unknown[]> } };
  deleteMany(filter: Record<string, never>): { exec(): Promise<{ deletedCount?: number }> };
}

export type ResetCategory = 'conversations' | 'scores' | 'logs' | 'activity';

/** Each category maps to the collections it owns. Keys within a category feed the counts UI. */
const REGISTRY: Record<ResetCategory, Record<string, ResettableModel>> = {
  conversations: { sessions: SessionModel, messages: MessageModel },
  scores: { scores: ConversationScoreModel },
  logs: { llama_calls_debug: LlamaCallDebugModel, llama_calls_archive: LlamaCallArchiveModel },
  activity: {
    notifications: NotificationModel,
    autonomy_run_results: RunResultModel,
    finetune_jobs: FinetuneJobModel,
  },
};

export const RESET_CATEGORIES = Object.keys(REGISTRY) as ResetCategory[];

/** Keep only the valid, recognised categories from arbitrary input. */
export function parseCategories(input: unknown): ResetCategory[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [];
  const wanted = new Set(raw.map((s) => String(s).trim()));
  return RESET_CATEGORIES.filter((c) => wanted.has(c));
}

type CountsByCollection = Record<string, number>;

export const dataResetService = {
  /** Row counts per collection, grouped by category — powers the "you are about to delete…" text. */
  async counts(): Promise<Record<ResetCategory, CountsByCollection>> {
    const out = {} as Record<ResetCategory, CountsByCollection>;
    for (const category of RESET_CATEGORIES) {
      out[category] = {};
      for (const [name, model] of Object.entries(REGISTRY[category])) {
        out[category][name] = await model.countDocuments();
      }
    }
    return out;
  },

  /**
   * Serialize the rows in the selected categories into a restorable bundle. Used by the "download a
   * backup first" option before a clear. No secrets live in these collections, so nothing is stripped.
   */
  async exportData(categories: ResetCategory[]): Promise<{
    type: string;
    version: number;
    exported_at: string;
    categories: ResetCategory[];
    data: Record<string, unknown[]>;
  }> {
    const data: Record<string, unknown[]> = {};
    for (const category of categories) {
      for (const [name, model] of Object.entries(REGISTRY[category])) {
        data[name] = await model.find().lean().exec();
      }
    }
    return {
      type: BACKUP_TYPE,
      version: BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      categories,
      data,
    };
  },

  /** **Destructive.** Empties every collection in the selected categories. Returns rows removed. */
  async clear(categories: ResetCategory[]): Promise<{ deleted: CountsByCollection; total: number }> {
    const deleted: CountsByCollection = {};
    let total = 0;
    for (const category of categories) {
      for (const [name, model] of Object.entries(REGISTRY[category])) {
        const res = await model.deleteMany({}).exec();
        const n = res.deletedCount ?? 0;
        deleted[name] = n;
        total += n;
      }
    }
    log.warn({ categories, deleted, total }, 'operator cleared data (destructive)');
    return { deleted, total };
  },
};
