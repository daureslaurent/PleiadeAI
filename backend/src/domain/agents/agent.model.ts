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
    /**
     * Marks an agent the app ships and owns, by role slug (`''` for ordinary operator-made agents).
     *
     * A built-in agent is seeded by migration and cannot be deleted or renamed: privileged tools bind
     * their authorisation to this slug, so a rename would silently strip the agent's powers and a
     * delete would leave a tool nobody can call. Everything else — prompt, charter, model, tools,
     * isolation — stays fully editable, because a moderator you can't retune is one you can't fix.
     */
    builtin: { type: String, default: '', index: true },
    system_prompt: { type: String, required: true },
    /**
     * Auto agent mode (`AUTO_AGENT_PLAN.md`): unlocks the Workspace composer's Loop panel, where the
     * operator hands this agent a standing goal and an interval and leaves it to drive its own
     * conversation. Purely a capability gate — a loop is armed per conversation, never fleet-wide, so
     * flipping this on does not by itself make the agent do anything.
     */
    auto_mode: { type: Boolean, default: false },
    /**
     * Starting values for this agent's Loop panel (`AUTO_AGENT_PLAN.md` §5). Not the running loop —
     * that lives in `auto_loops` — just what the form opens with, so an agent built for a standing
     * job (the built-in `developer`) arms in one click instead of the operator retyping its brief.
     *
     * Kept off the `parameters` map on purpose: parameters are injected into the prompt, and a
     * *default* goal sitting in the context next to the *actual* goal of a running loop is exactly
     * the kind of near-duplicate instruction a model resolves the wrong way.
     */
    loop_defaults: {
      type: {
        _id: false,
        goal: { type: String, default: '' },
        continue_text: { type: String, default: '' },
        interval_sec: { type: Number, default: 0 },
      },
      default: () => ({ goal: '', continue_text: '', interval_sec: 0 }),
    },
    tools_allowed: { type: [String], default: [] },
    qdrant_namespace: { type: String, required: true, unique: true },
    parameters: { type: Map, of: String, default: () => new Map<string, string>() },
    /**
     * This agent's AGENTS.md — its operator-authored charter. Injected JIT into the prompt and
     * editable *only* by the operator (Agents page / API): no tool can write it, so an agent can
     * never overwrite the standing instructions it was given. Complements the fleet-wide house
     * rules in `settings.agents_md`. The agent's own writable scratchpad is `notebook`.
     */
    agents_md: { type: String, default: '' },
    /**
     * Free-form Markdown scratchpad the agent owns and rewrites itself (via `update_notebook`).
     * Unlike `agents_md` / `system_prompt`, this is a living document — persisted learnings,
     * conventions, TODOs — injected JIT *after* the authored prompt so it reads as the agent's own
     * notes rather than as instruction. The operator may also correct it from the Agents page.
     */
    notebook: { type: String, default: '' },
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
    /**
     * The Android device (`android_devices` collection) this agent drives, or null. Setting it is
     * what makes an agent an "Android agent": `AgentRunner` auto-grants the `android_*` tools (the
     * way a `visual` image grants the desktop tools) and the Workspace offers the live phone mirror.
     * The agent still needs an isolation profile whose image carries the Android layer — that is
     * where `adb` runs. One device per agent: the tools address exactly one screen.
     */
    android_device_id: { type: Schema.Types.ObjectId, ref: 'AndroidDevice', default: null },
    /**
     * Ids of the linked Gmail mailboxes (`mail_accounts` collection) this agent may read via the
     * `list_mail`/`read_mail` tools. Operator-granted on the Agents page; an empty list means the
     * mail tools refuse even if they appear in `tools_allowed`. Read access only — the tools are
     * built on the `gmail.readonly` scope and never alter read-state.
     */
    mail_accounts: { type: [String], default: [] },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'agents',
  },
);

export type Agent = InferSchemaType<typeof AgentSchema>;
export type AgentDoc = HydratedDocument<Agent>;

export const AgentModel = model('Agent', AgentSchema);
