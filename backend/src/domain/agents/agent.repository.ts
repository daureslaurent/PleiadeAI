import { Types } from 'mongoose';
import { AgentModel, type AgentDoc } from './agent.model';

/** Escape a string so it can be embedded literally inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Data-access for agents. Kept thin — Mongoose already provides typing/validation — but
 * centralised so the JIT builder, tools, and transport layer never touch the model directly.
 */
export const agentRepository = {
  findById(id: string | Types.ObjectId): Promise<AgentDoc | null> {
    return AgentModel.findById(id).exec();
  },

  findByName(name: string): Promise<AgentDoc | null> {
    return AgentModel.findOne({ name }).exec();
  },

  /**
   * Resolve a delegation target the way a model actually refers to it. `ask_agent` targets come
   * straight from an LLM, which routinely gets the exact identifier slightly wrong: wrong case
   * (`WebSearch`), or the qdrant namespace (`websearch_agent`) instead of the display name
   * (`websearch`). Strict `findByName` returns null for all of those and the hop errors with
   * "agent not found", so the delegation silently dies. This resolver widens the match while
   * keeping it deterministic: exact name → exact namespace → case-insensitive name → case-insensitive
   * namespace. Exact-name always wins, so a real agent can never be shadowed by a fuzzy match.
   */
  async resolveByName(ref: string): Promise<AgentDoc | null> {
    const needle = ref.trim();
    if (!needle) return null;

    const exact = await AgentModel.findOne({ name: needle }).exec();
    if (exact) return exact;

    const byNamespace = await AgentModel.findOne({ qdrant_namespace: needle }).exec();
    if (byNamespace) return byNamespace;

    // Anchored, case-insensitive fallback. `escapeRegExp` keeps a name with regex metacharacters
    // (unlikely, but cheap to guard) from being interpreted as a pattern.
    const ci = new RegExp(`^${escapeRegExp(needle)}$`, 'i');
    return AgentModel.findOne({ $or: [{ name: ci }, { qdrant_namespace: ci }] }).exec();
  },

  list(): Promise<AgentDoc[]> {
    return AgentModel.find().sort({ name: 1 }).exec();
  },

  create(input: {
    name: string;
    description?: string;
    subagent?: boolean;
    system_prompt: string;
    tools_allowed?: string[];
    qdrant_namespace: string;
    parameters?: Record<string, string>;
    endpoint_id?: string | null;
    model?: string;
    color?: number | null;
    icon?: string;
  }): Promise<AgentDoc> {
    return AgentModel.create({
      ...input,
      parameters: input.parameters
        ? new Map(Object.entries(input.parameters))
        : new Map<string, string>(),
    });
  },

  /**
   * Atomically upsert a single KV parameter (backs the `set_agent_parameter` core tool).
   * Uses dot-path `$set` so concurrent mutations to different keys don't clobber each other.
   */
  async setParameter(
    id: string | Types.ObjectId,
    key: string,
    value: string,
  ): Promise<AgentDoc | null> {
    return AgentModel.findByIdAndUpdate(
      id,
      { $set: { [`parameters.${key}`]: value } },
      { new: true },
    ).exec();
  },

  update(
    id: string | Types.ObjectId,
    patch: Partial<
      Pick<
        AgentDoc,
        | 'system_prompt'
        | 'tools_allowed'
        | 'name'
        | 'description'
        | 'subagent'
        | 'agents_md'
        | 'notebook'
        | 'isolation_id'
        | 'isolation_volume_mode'
        | 'endpoint_id'
        | 'model'
        | 'color'
        | 'icon'
      >
    >,
  ): Promise<AgentDoc | null> {
    return AgentModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  /** All agents currently assigned to a given isolation profile (for build/teardown fan-out). */
  listByIsolation(isolationId: string | Types.ObjectId): Promise<AgentDoc[]> {
    return AgentModel.find({ isolation_id: isolationId }).exec();
  },

  /** Clear the isolation assignment on every agent using a profile (called when it's deleted). */
  async unassignIsolation(isolationId: string | Types.ObjectId): Promise<void> {
    await AgentModel.updateMany({ isolation_id: isolationId }, { $set: { isolation_id: null } }).exec();
  },

  /** Replace the agent's own notebook wholesale (backs `update_notebook` in replace mode). */
  setNotebook(id: string | Types.ObjectId, content: string): Promise<AgentDoc | null> {
    return AgentModel.findByIdAndUpdate(id, { $set: { notebook: content } }, { new: true }).exec();
  },

  /** Remove a single KV parameter (backs the parameter grid's delete action). */
  removeParameter(id: string | Types.ObjectId, key: string): Promise<AgentDoc | null> {
    return AgentModel.findByIdAndUpdate(
      id,
      { $unset: { [`parameters.${key}`]: '' } },
      { new: true },
    ).exec();
  },

  delete(id: string | Types.ObjectId): Promise<AgentDoc | null> {
    return AgentModel.findByIdAndDelete(id).exec();
  },
};
