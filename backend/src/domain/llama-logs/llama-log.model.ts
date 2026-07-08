import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Persisted capture of one HTTP call to the inference server, for the **LLM Debug** page.
 *
 * Two collections share this schema:
 * - `llama_calls_debug` — a **capped** ring buffer (last 50) the page reads by default. Its request
 *   copy has image data URLs truncated to placeholders to keep the buffer small.
 * - `llama_calls_archive` — an **uncapped**, durable copy that keeps the full request (untruncated
 *   base64 images) and raw streamed chunks.
 *
 * fine-tuning: `llama_calls_archive` is the future dataset source. Every record carries the full
 * `request.messages`, `tools`, assembled `response` (incl. tool calls), plus `session_id` /
 * `agent_id` / `depth` / `source` so calls can be grouped + ordered into conversations and filtered
 * (e.g. drop `title-gen`). The export feature is not built yet — this schema is its seam.
 */
const LlamaLogSchema = new Schema(
  {
    /** Correlates the live start→delta→end stream with the persisted record. */
    call_id: { type: String, required: true, index: true },
    source: { type: String, enum: ['chat-turn', 'title-gen', 'identity', 'vision'], required: true, index: true },
    endpoint: { type: String, required: true },
    model: { type: String, required: true, index: true },
    /** Linkage (null for side tasks that run outside a live session). */
    session_id: { type: String, default: null, index: true },
    agent_id: { type: String, default: null },
    agent_name: { type: String, default: null },
    depth: { type: Number, default: null },
    status: { type: String, enum: ['success', 'error'], required: true },
    /** Full outgoing request body (sampling + messages + tool schemas). Images truncated in the debug copy. */
    request: { type: Schema.Types.Mixed, required: true },
    /** Assembled response: `{ text, toolCalls, finishReason }`. */
    response: { type: Schema.Types.Mixed, required: true },
    /** Raw text deltas exactly as streamed (empty for non-streaming `complete`). */
    raw_chunks: { type: [String], default: [] },
    /** Tool schemas sent with the request (denormalized for quick display / dataset reproduction). */
    tools: { type: Schema.Types.Mixed, default: null },
    usage: { type: Schema.Types.Mixed, default: null },
    duration_ms: { type: Number, required: true },
    first_token_ms: { type: Number, default: null },
    error: { type: String, default: null },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'llama_calls_debug', minimize: false },
);

export type LlamaLog = InferSchemaType<typeof LlamaLogSchema>;
export type LlamaLogDoc = HydratedDocument<LlamaLog>;

/** Capped debug tier (`llama_calls_debug`) — the page's default fast read. */
export const LlamaCallDebugModel = model('LlamaCallDebug', LlamaLogSchema, 'llama_calls_debug');

/** Uncapped durable tier (`llama_calls_archive`) — deep history + future fine-tuning export. */
export const LlamaCallArchiveModel = model('LlamaCallArchive', LlamaLogSchema, 'llama_calls_archive');
