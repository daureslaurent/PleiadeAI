import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `agents` collection (spec §3). One document fully describes an agent: its prompt, the
 * static tools + dynamic skills it may call, its strictly-isolated Qdrant namespace, and a
 * local KV parameter store injected JIT into the system prompt.
 *
 * `parameters` is a Mongoose Map so keys are dynamic and single fields can be mutated
 * atomically via `set_agent_parameter` (`$set parameters.<key>`) without rewriting the doc.
 */
const AgentSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    /**
     * Short human-readable summary of what this agent does. Surfaced by the `annuaire` tool so a
     * delegating agent can pick the right `ask_agent` target without reading each system prompt.
     */
    description: { type: String, default: '' },
    /**
     * Role flag (opencode-style primary/subagent split).
     * `true`  — a *subagent*: listed in the `annuaire` and reachable via `ask_agent` (still
     *           directly chattable in the Workspace).
     * `false` — a *top-level* orchestrator: hidden from the `annuaire` (nothing delegates to it),
     *           auto-granted `annuaire` + `ask_agent`, and pushed by a JIT prompt directive to
     *           consult the directory and delegate to subagents before answering.
     * Defaults to `true` so every pre-existing agent stays visible for delegation.
     */
    subagent: { type: Boolean, default: true },
    system_prompt: { type: String, required: true },
    tools_allowed: { type: [String], default: [] },
    qdrant_namespace: { type: String, required: true, unique: true },
    parameters: { type: Map, of: String, default: () => new Map<string, string>() },
    /**
     * Free-form Markdown notebook the agent owns and rewrites itself (via `update_agents_md`).
     * Unlike the authored `system_prompt`, this is a living scratchpad — persisted learnings,
     * conventions, TODOs — injected JIT into the prompt and editable from the Agents page.
     */
    agents_md: { type: String, default: '' },
    /**
     * Optional assignment to a shared Isolation profile (see `isolations` collection). When set,
     * the agent's `bash` tool and Python/TS skills run in a dedicated container built from that
     * profile's image; when null, execution stays in the backend container.
     */
    isolation_id: { type: Schema.Types.ObjectId, ref: 'Isolation', default: null },
    /**
     * Workspace volume scope for this agent under its isolation:
     * `individual` — its own persistent /workspace (files private to this agent);
     * `shared`     — the isolation profile's shared /workspace (files shared across assigned agents).
     */
    isolation_volume_mode: { type: String, enum: ['individual', 'shared'], default: 'individual' },
    /**
     * Optional inference target. `endpoint_id` picks one of the `endpoints` (null → the fleet
     * default endpoint); `model` picks a model on it (empty → the endpoint's first discovered
     * model, then the global default). Sampling stays global (see `settings`).
     */
    endpoint_id: { type: Schema.Types.ObjectId, ref: 'Endpoint', default: null },
    model: { type: String, default: '' },
    /**
     * Max tool-call rounds the agent may take in a single turn before the run is cut off (see
     * `AgentRunner`'s tool loop). `null` → the global default. Agents that drive long multi-step
     * flows — notably the visual/desktop agents that burn ~2 rounds per screenshot→act cycle — want
     * a higher ceiling so they don't stall mid-task and force a manual "continue".
     */
    max_tool_iterations: { type: Number, default: null },
    /**
     * Visual identity shown wherever the agent surfaces (chat avatar, `ask_agent` bubbles). Operator-
     * chosen on the Agents page; both fall back to a deterministic name-hash color + initial letter
     * when unset. `color` is an HSL hue (0–360, `null` = unset); `icon` is a curated lucide key (see
     * `identity.constants.ts`; `''` = unset).
     */
    color: { type: Number, default: null },
    icon: { type: String, default: '' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'agents',
  },
);

export type Agent = InferSchemaType<typeof AgentSchema>;
export type AgentDoc = HydratedDocument<Agent>;

export const AgentModel = model('Agent', AgentSchema);
