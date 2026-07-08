import { AgentModel } from '../agents/agent.model';
import { IsolationModel } from '../isolations/isolation.model';
import { EndpointModel } from '../endpoints/endpoint.model';
import { SessionModel } from '../sessions/session.model';
import { MessageModel } from '../sessions/message.model';
import { ConversationScoreModel } from '../scoring/conversation-score.model';
import { LlamaCallArchiveModel, LlamaCallDebugModel } from '../llama-logs/llama-log.model';
import { createLogger } from '../../config/logger';

const log = createLogger('clone-service');

export const CLONE_TYPE = 'pleiade-clone';
export const CLONE_VERSION = 1;

/** Cap on cloned inference calls — the archive is unbounded and each row carries prompt+completion. */
export const DEFAULT_LOG_LIMIT = 200;

/** Same heuristic as the portable config export: never let a secret-looking parameter travel. */
const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|access[_-]?key|private|credential|auth)/i;

export interface CloneBundle {
  type: string;
  version: number;
  exported_at: string;
  counts: Record<string, number>;
  /** Prod `endpoint_id` → endpoint name, so import can relink agents to a same-named local endpoint. */
  endpoint_names: Record<string, string>;
  agents: Record<string, unknown>[];
  isolations: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  scores: Record<string, unknown>[];
  llama_logs: Record<string, unknown>[];
}

export interface CloneSummary {
  wiped: Record<string, number>;
  inserted: Record<string, number>;
  warnings: string[];
}

/**
 * A **mirror** of one instance's operational data, distinct from the portable `pleiade-config`
 * export in `transfer.routes.ts`.
 *
 * The difference is `_id` preservation. `import/config` carries agents *by name* and mints fresh
 * ObjectIds, which is correct for merging one agent into a foreign fleet — but sessions reference
 * `agent_id`, messages reference `session_id`, and scores/llama-logs carry those ids as strings. A
 * bundle that renumbered them would arrive with every cross-reference dangling. So a clone copies
 * ids verbatim and, necessarily, **replaces** the target's data rather than merging into it.
 *
 * Not cloned: endpoints (they hold inference credentials), images, skills, settings, api_keys,
 * Qdrant vectors. Agents are relinked to endpoints by name where possible; `isolation.image_id` is
 * dropped, since the target won't have that image built.
 */
export const cloneService = {
  /** Read the whole mirror. Secrets are stripped here, not at the transport layer. */
  async exportClone(logLimit = DEFAULT_LOG_LIMIT): Promise<CloneBundle> {
    // `.lean()` gives plain objects; `select('-...')` is unnecessary for ssh_private_key_enc /
    // vpn_config / sudo_password, which are `select: false` and so never loaded by a default query.
    const [agents, isolations, endpoints, sessions, messages, scores, llamaLogs] = await Promise.all([
      AgentModel.find().lean().exec(),
      IsolationModel.find().lean().exec(),
      EndpointModel.find().select('_id name').lean().exec(),
      SessionModel.find().lean().exec(),
      MessageModel.find().lean().exec(),
      ConversationScoreModel.find().lean().exec(),
      LlamaCallArchiveModel.find().sort({ created_at: -1 }).limit(logLimit).lean().exec(),
    ]);

    const bundle: CloneBundle = {
      type: CLONE_TYPE,
      version: CLONE_VERSION,
      exported_at: new Date().toISOString(),
      counts: {},
      endpoint_names: Object.fromEntries(endpoints.map((e) => [String(e._id), e.name])),
      agents: agents.map((a) => ({ ...a, parameters: sanitizeParameters(a.parameters) })),
      isolations: isolations as Record<string, unknown>[],
      sessions: sessions as Record<string, unknown>[],
      messages: messages as Record<string, unknown>[],
      scores: scores as Record<string, unknown>[],
      llama_logs: llamaLogs as Record<string, unknown>[],
    };

    bundle.counts = {
      agents: bundle.agents.length,
      isolations: bundle.isolations.length,
      sessions: bundle.sessions.length,
      messages: bundle.messages.length,
      scores: bundle.scores.length,
      llama_logs: bundle.llama_logs.length,
    };
    return bundle;
  },

  /**
   * **Destructive.** Drops the target's agents, isolations, sessions, messages, scores and inference
   * logs, then inserts the bundle verbatim (ids and timestamps preserved). Callers must have already
   * obtained explicit operator confirmation — this method does not ask.
   */
  async importClone(bundle: CloneBundle): Promise<CloneSummary> {
    if (bundle?.type !== CLONE_TYPE) throw new Error(`not a ${CLONE_TYPE} bundle`);

    const warnings: string[] = [];

    // Relink agents to local endpoints by name; a prod endpoint id is meaningless here.
    const localEndpoints = await EndpointModel.find().select('_id name').lean().exec();
    const localIdByName = new Map(localEndpoints.map((e) => [e.name, String(e._id)]));

    const agents = bundle.agents.map((a) => {
      const prodEndpointId = a.endpoint_id ? String(a.endpoint_id) : null;
      let endpoint_id: string | null = null;
      if (prodEndpointId) {
        const name = bundle.endpoint_names?.[prodEndpointId];
        endpoint_id = (name && localIdByName.get(name)) || null;
        if (!endpoint_id) {
          warnings.push(`agent "${a.name}": endpoint "${name ?? prodEndpointId}" not found locally — using fleet default`);
        }
      }
      return { ...a, endpoint_id };
    });

    // Images aren't cloned, so a carried image_id would dangle and the profile could never launch.
    const isolations = bundle.isolations.map((i) => {
      if (i.image_id) warnings.push(`isolation "${i.name}": image not cloned — assign one on the Isolations page`);
      return { ...i, image_id: null };
    });

    const wiped = {
      agents: (await AgentModel.deleteMany({})).deletedCount ?? 0,
      isolations: (await IsolationModel.deleteMany({})).deletedCount ?? 0,
      sessions: (await SessionModel.deleteMany({})).deletedCount ?? 0,
      messages: (await MessageModel.deleteMany({})).deletedCount ?? 0,
      scores: (await ConversationScoreModel.deleteMany({})).deletedCount ?? 0,
      llama_logs:
        ((await LlamaCallArchiveModel.deleteMany({})).deletedCount ?? 0) +
        ((await LlamaCallDebugModel.deleteMany({})).deletedCount ?? 0),
    };

    // Isolations before agents, so an agent's `isolation_id` resolves to a row that already exists.
    const inserted = {
      isolations: await insert(IsolationModel, 'isolations', isolations, warnings),
      agents: await insert(AgentModel, 'agents', agents, warnings),
      sessions: await insert(SessionModel, 'sessions', bundle.sessions, warnings),
      messages: await insert(MessageModel, 'messages', bundle.messages, warnings),
      scores: await insert(ConversationScoreModel, 'scores', bundle.scores, warnings),
      llama_logs: await insert(LlamaCallArchiveModel, 'llama_logs', bundle.llama_logs, warnings),
    };

    log.warn({ wiped, inserted, warnings: warnings.length }, 'clone import complete (destructive)');
    return { wiped, inserted, warnings };
  },
};

function sanitizeParameters(parameters: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  // `.lean()` yields a plain object for a Map-typed path.
  for (const [k, v] of Object.entries((parameters ?? {}) as Record<string, string>)) {
    out[k] = SECRET_KEY.test(k) ? '' : v;
  }
  return out;
}

/**
 * Bulk insert preserving `_id` and the source's timestamps (`timestamps: false` stops Mongoose
 * stamping "now" over `created_at`).
 *
 * `ordered: false` lets good rows land even when one is malformed — but Mongoose still *rejects* on
 * any failure rather than returning a partial count, so the successes are recovered from the thrown
 * error's `insertedDocs` and the failures become warnings. A clone of a drifted schema thus imports
 * as much as it can and tells the operator what it dropped.
 */
async function insert(
  // Six unrelated Mongoose models; only `insertMany` is used, so structural typing is enough.
  Model: { insertMany: (docs: unknown[], opts: object) => Promise<unknown[]> },
  label: string,
  docs: Record<string, unknown>[],
  warnings: string[],
): Promise<number> {
  if (docs.length === 0) return 0;
  try {
    const written = await Model.insertMany(docs, { ordered: false, timestamps: false });
    return written.length;
  } catch (err) {
    const insertedDocs = (err as { insertedDocs?: unknown[] }).insertedDocs ?? [];
    const failed = docs.length - insertedDocs.length;
    warnings.push(`${label}: ${failed} of ${docs.length} rows rejected (${(err as Error).message.slice(0, 160)})`);
    log.error({ err, label, failed }, 'clone insert partially failed');
    return insertedDocs.length;
  }
}
