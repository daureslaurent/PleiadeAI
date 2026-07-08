import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { createLogger } from '../config/logger';
import { settingsService } from '../domain/settings/settings.service';
import { endpointGate } from './endpoint-gate';
import { eventBus } from '../core/event-bus/EventBus';
import { getCaptureContext } from './capture-context';
import { truncateRequestImages } from './truncate-images';
import type { ResolvedInference } from './inference-resolver';
import type { ChatMessage } from '../domain/agents/jit-builder';
import type {
  LlamaCallSource,
  LlamaRequestCapture,
  LlamaResponseCapture,
  LlamaUsage,
} from '../core/event-bus/events.types';

const log = createLogger('llama-client');

/**
 * Thin wrapper over the official OpenAI SDK pointed at the remote llama.cpp server's
 * OpenAI-compatible `/v1/chat/completions` endpoint. Handles streaming token deltas and
 * incremental assembly of tool calls (which arrive fragmented across chunks).
 */

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

/** A fully-assembled tool call the model requested by the end of a streamed turn. */
export interface AssembledToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string as emitted by the model. */
  argsJson: string;
}

export interface StreamCallbacks {
  /** Fires for each text delta (already excludes tool-call deltas). */
  onToken: (delta: string) => void;
}

/** Token accounting for one inference pass, as reported by the server's `usage` object. */
export interface TokenUsage {
  /** Tokens in the prompt fed to the model this pass — i.e. the live context size. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamResult {
  /** Concatenated assistant text (may be empty if the turn was purely tool calls). */
  text: string;
  /** Tool calls the model wants executed before continuing. */
  toolCalls: AssembledToolCall[];
  finishReason: string | null;
  /** Token usage for this pass, when the server reports it (`stream_options.include_usage`). */
  usage: TokenUsage | null;
}

/** Normalise an OpenAI `message.content` (string, null, or an array of content parts) to plain text. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '',
      )
      .join('');
  }
  return '';
}

const norm = (url: string): string => url.replace(/\/$/, '');

/**
 * A capture handle for one HTTP call to the inference server. Emits `llama:call_start` on creation,
 * `llama:call_delta` per streamed token, and `llama:call_end` on completion — feeding the LLM Debug
 * page's live view and its Mongo persistence subscriber. Everything here is best-effort: a throw in a
 * capture path must never affect the inference call, so callers wrap `end()` / `pushChunk()` in the
 * try/finally of the real request and swallow errors (see `safe`).
 */
class CallCapture {
  readonly id = randomUUID();
  private readonly startedAt = Date.now();
  private firstTokenMs: number | null = null;
  private readonly rawChunks: string[] = [];
  /**
   * How many messages were in the request AT SEND TIME. The caller (AgentRunner) reuses and *appends*
   * to the same `messages` array across a turn's tool loop, and the request is serialized to Mongo
   * only later — so by then the array holds messages that were NOT part of this call. We slice back to
   * this count on `end()` so the stored request is a faithful snapshot of what was actually sent.
   */
  private readonly sentMessageCount: number;

  private constructor(
    private readonly source: LlamaCallSource,
    private readonly endpoint: string,
    private readonly model: string,
    private readonly request: LlamaRequestCapture,
  ) {
    this.sentMessageCount = Array.isArray(request.messages) ? request.messages.length : 0;
  }

  /** The request as actually sent (messages sliced to their send-time count — see {@link sentMessageCount}). */
  private snapshotRequest(): LlamaRequestCapture {
    return { ...this.request, messages: this.request.messages.slice(0, this.sentMessageCount) };
  }

  /** Build a capture for a call and emit `llama:call_start` (with images truncated for the live UI). */
  static begin(target: ResolvedInference, request: LlamaRequestCapture): CallCapture {
    const cc = getCaptureContext();
    const cap = new CallCapture(cc?.source ?? 'chat-turn', norm(target.url), target.model, request);
    safe(() =>
      eventBus.emit('llama:call_start', {
        ctx: cc && cc.sessionId ? { sessionId: cc.sessionId, agentId: cc.agentId ?? '', agentName: cc.agentName ?? '', depth: cc.depth ?? 0 } : undefined,
        id: cap.id,
        source: cap.source,
        model: cap.model,
        endpoint: cap.endpoint,
        requestPreview: truncateRequestImages(cap.snapshotRequest()),
      }),
    );
    return cap;
  }

  /** Record + relay one streamed text delta. */
  pushChunk(delta: string, isReasoning: boolean): void {
    if (this.firstTokenMs === null) this.firstTokenMs = Date.now() - this.startedAt;
    this.rawChunks.push(delta);
    safe(() => eventBus.emit('llama:call_delta', { id: this.id, delta, isReasoning }));
  }

  /** Emit `llama:call_end` with the assembled response + usage. */
  end(
    response: LlamaResponseCapture,
    usage: LlamaUsage | null,
    status: 'success' | 'error',
    error?: string,
  ): void {
    const cc = getCaptureContext();
    safe(() =>
      eventBus.emit('llama:call_end', {
        ctx: cc && cc.sessionId ? { sessionId: cc.sessionId, agentId: cc.agentId ?? '', agentName: cc.agentName ?? '', depth: cc.depth ?? 0 } : undefined,
        id: this.id,
        turnId: cc?.turnId,
        runId: cc?.runId,
        source: this.source,
        model: this.model,
        endpoint: this.endpoint,
        status,
        startedAt: this.startedAt,
        durationMs: Date.now() - this.startedAt,
        firstTokenMs: this.firstTokenMs,
        usage,
        request: this.snapshotRequest(),
        response,
        rawChunks: this.rawChunks,
        error,
      }),
    );
  }
}

/** Run a capture side effect, swallowing any error so it can never break the inference call. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'llama capture emit failed (ignored)');
  }
}

export class LlamaClient {
  /** Cache one OpenAI client per url+key so failover between targets doesn't rebuild the healthy one. */
  private clients = new Map<string, OpenAI>();
  private embedClient?: OpenAI;
  private embedClientKey = '';

  /** Build (and cache) the OpenAI client for a target; settings/endpoints are runtime-mutable. */
  private clientFor(url: string, apiKey: string): OpenAI {
    const key = `${url}::${apiKey}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new OpenAI({ baseURL: `${url.replace(/\/$/, '')}/v1`, apiKey });
      this.clients.set(key, client);
    }
    return client;
  }

  /** Separate cached client for the (CPU) embeddings endpoint. */
  private embedClientFor(url: string, apiKey: string): OpenAI {
    const key = `${url}::${apiKey}`;
    if (!this.embedClient || this.embedClientKey !== key) {
      this.embedClient = new OpenAI({ baseURL: `${url.replace(/\/$/, '')}/v1`, apiKey });
      this.embedClientKey = key;
    }
    return this.embedClient;
  }

  /**
   * Embed a single string via the dedicated embeddings server (`/v1/embeddings`). Returns the
   * raw vector. Throws on transport/HTTP errors — callers in the agent loop catch and degrade so
   * a missing embeddings service never breaks a turn.
   */
  async embed(text: string): Promise<number[]> {
    const settings = await settingsService.get();
    if (!settings.embedding_url) throw new Error('embeddings endpoint not configured');
    const client = this.embedClientFor(settings.embedding_url, settings.embedding_api_key);
    const res = await client.embeddings.create({
      model: settings.embedding_model,
      input: text,
    });
    const vector = res.data[0]?.embedding;
    if (!vector?.length) throw new Error('embeddings response contained no vector');
    return vector;
  }

  /**
   * One-shot, non-streaming chat completion against a resolved target — returns the full assistant
   * text. Used for side calls that want a single answer rather than a streamed turn (e.g. the vision
   * analysis behind `visual_screenshot`). Goes through the per-endpoint gate for metrics/serialisation.
   * Throws on transport/HTTP failure; callers decide how to degrade.
   */
  async complete(
    target: ResolvedInference,
    messages: ChatMessage[],
    opts: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      /** OpenAI-style penalties (honored by llama-server) to break repetition loops. */
      frequencyPenalty?: number;
      presencePenalty?: number;
    } = {},
  ): Promise<string> {
    const client = this.clientFor(target.url, target.apiKey);
    const gate = await endpointGate.acquire(target.url, target.model);
    try {
      // Pass-through: only send sampling fields the caller actually provided. An omitted (undefined)
      // field is dropped from the JSON, so the server applies its own default (used for the "disabled"
      // vision params). The SDK omits `undefined` keys, so this is safe.
      const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: target.model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: false,
      };
      if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
      if (opts.temperature != null) body.temperature = opts.temperature;
      if (opts.topP != null) body.top_p = opts.topP;
      if (opts.frequencyPenalty != null) body.frequency_penalty = opts.frequencyPenalty;
      if (opts.presencePenalty != null) body.presence_penalty = opts.presencePenalty;
      const capture = CallCapture.begin(target, {
        model: target.model,
        messages,
        stream: false,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        topP: opts.topP,
      });
      let res: OpenAI.Chat.ChatCompletion;
      try {
        res = await client.chat.completions.create(body);
      } catch (err) {
        capture.end({ text: '', toolCalls: [], finishReason: null }, null, 'error', err instanceof Error ? err.message : String(err));
        throw err;
      }
      const capUsage = res.usage
        ? {
            promptTokens: res.usage.prompt_tokens,
            completionTokens: res.usage.completion_tokens,
            totalTokens: res.usage.total_tokens,
          }
        : null;
      gate.success(capUsage);
      const choice = res.choices[0];
      // Extract the answer robustly: `content` may be a plain string or (rarely) an array of parts;
      // some servers/reasoning models leave `content` empty and put the answer in `reasoning_content`.
      const msg = choice?.message as
        | { content?: unknown; reasoning_content?: unknown }
        | undefined;
      let text = extractText(msg?.content);
      if (!text && typeof msg?.reasoning_content === 'string') text = msg.reasoning_content;
      // Drop a `<think>…</think>` block a reasoning model may prepend, keeping the actual answer.
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (!text || text.length < 24) {
        // Nothing (or almost nothing) usable came back. For a vision call this usually means the image
        // wasn't integrated — a mismatched/wrong `mmproj`, or a bad chat template — so the model emits
        // a token or two then EOS. Surface finish_reason + token counts so the cause is visible.
        log.warn(
          {
            url: target.url,
            model: target.model,
            finishReason: choice?.finish_reason,
            usage: res.usage,
            textPreview: text.slice(0, 80),
            rawMessage: JSON.stringify(msg)?.slice(0, 600),
          },
          'complete(): model returned little/no usable text (vision: suspect mmproj/template)',
        );
      }
      capture.end({ text, toolCalls: [], finishReason: choice?.finish_reason ?? null }, capUsage, 'success');
      return text;
    } catch (err) {
      gate.fail();
      throw err;
    }
  }

  /**
   * Exact prompt-token count for a set of chat messages, for the context meter when a server doesn't
   * report streaming `usage` (`stream_options.include_usage` unsupported). Uses llama.cpp's
   * `/apply-template` (messages → the templated prompt string) then `/tokenize` (string → token ids),
   * so the count reflects the real chat-template formatting rather than a naive char estimate.
   *
   * Best-effort: returns `null` if either endpoint is missing (non-llama.cpp server) or errors, and
   * the caller falls back to whatever it had (usually the previous reading).
   */
  async tokenizeMessages(target: ResolvedInference, messages: ChatMessage[]): Promise<number | null> {
    const base = target.url.replace(/\/$/, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
    };
    try {
      const tpl = await fetch(`${base}/apply-template`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages }),
      });
      if (!tpl.ok) return null;
      const { prompt } = (await tpl.json()) as { prompt?: string };
      if (typeof prompt !== 'string') return null;

      const tok = await fetch(`${base}/tokenize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: prompt }),
      });
      if (!tok.ok) return null;
      const { tokens } = (await tok.json()) as { tokens?: unknown[] };
      return Array.isArray(tokens) ? tokens.length : null;
    } catch (err) {
      log.debug({ url: base, err: err instanceof Error ? err.message : String(err) }, 'tokenize fallback failed');
      return null;
    }
  }

  /**
   * Stream one assistant turn. Text deltas are handed to `onToken` as they arrive; tool-call
   * fragments are accumulated and returned assembled once the stream ends.
   *
   * The inference target (url, model, sampling) comes from `inference` when the caller resolved it
   * per-agent (the normal chat path); side tasks that don't have an agent (e.g. title generation)
   * omit it and fall back to the global settings connection + default model.
   */
  async streamChat(
    messages: ChatMessage[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    /** Per-call overrides for lightweight side tasks (e.g. title generation) that shouldn't inherit
     * the agent's full `max_tokens`. Absent → the resolved/configured defaults. */
    overrides?: { maxTokens?: number; temperature?: number },
    /** Per-agent resolved endpoint + model + sampling. Absent → global settings (side tasks). */
    inference?: ResolvedInference,
    /**
     * Ordered failover chain (see `resolveFallbacks`). If the primary target can't be reached
     * *before any token is streamed*, each of these is tried in turn. Empty/absent → no failover.
     */
    fallbacks?: ResolvedInference[],
  ): Promise<StreamResult> {
    const target =
      inference ??
      (await (async () => {
        const s = await settingsService.get();
        return {
          url: s.llama_url,
          apiKey: s.llama_api_key,
          model: s.llama_model,
          contextWindow: s.context_window,
          maxTokens: s.max_tokens,
          temperature: s.temperature,
          topP: s.top_p,
        } as ResolvedInference;
      })());

    const candidates = [target, ...(fallbacks ?? [])];
    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (!cand) continue;
      // Once a token reaches the caller we've committed to this endpoint — the UI has already
      // streamed partial text, so we can't silently restart elsewhere. Track that to gate failover.
      let emitted = false;
      const guarded: StreamCallbacks = {
        onToken: (delta) => {
          emitted = true;
          callbacks.onToken(delta);
        },
      };
      try {
        return await this.attemptStream(cand, messages, tools, guarded, overrides, signal);
      } catch (err) {
        // A user "stop" aborts on purpose — surface it, never mistake it for an endpoint failure.
        if (signal?.aborted) throw err;
        const next = candidates[i + 1];
        if (emitted || !next) throw err;
        lastErr = err;
        log.warn(
          { from: cand.url, to: next.url, err: String(err) },
          'inference target unreachable before streaming — failing over to next endpoint',
        );
      }
    }
    // The loop always returns or throws; this only satisfies the type checker.
    throw lastErr ?? new Error('no inference target available');
  }

  /** One streaming attempt against a single resolved target. Throws on transport/HTTP failure. */
  private async attemptStream(
    target: ResolvedInference,
    messages: ChatMessage[],
    tools: ToolSchema[],
    callbacks: StreamCallbacks,
    overrides: { maxTokens?: number; temperature?: number } | undefined,
    signal: AbortSignal | undefined,
  ): Promise<StreamResult> {
    const client = this.clientFor(target.url, target.apiKey);

    // Count multimodal image parts in the outgoing prompt so it's obvious in the logs whether images
    // (e.g. visual_screenshot output) actually reach the server — a text-only model / a llama.cpp
    // launched without `--mmproj` silently ignores them, which reads as "the model can't see it".
    const imageParts = messages.reduce(
      (n, m) =>
        n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0),
      0,
    );
    if (imageParts > 0) {
      if (target.supportsVision) {
        log.info({ url: target.url, model: target.model, imageParts }, 'sending prompt with image parts');
      } else {
        // The image is on the wire but the endpoint isn't marked multimodal — llama.cpp without
        // `--mmproj` (or a text-only model) silently ignores it. This is the usual "the model can't
        // see the screenshot" cause; flag the endpoint as vision-capable once you've verified it.
        log.warn(
          { url: target.url, model: target.model, imageParts },
          'prompt carries images but endpoint is not marked vision-capable — images will likely be ignored',
        );
      }
    }

    // Serialize per endpoint: a single llama.cpp slot can't stream two turns at once, so wait for
    // any in-flight call to this URL to finish before we start. The gate also tallies the metrics
    // the LLM activity page renders. It MUST be released on every exit path (see finally).
    const call = await endpointGate.acquire(target.url, target.model);
    // Full outgoing request, captured for the LLM Debug page (mirrors the body sent below).
    const wireTools = tools.length
      ? tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;
    const capture = CallCapture.begin(target, {
      model: target.model,
      messages,
      tools: wireTools,
      stream: true,
      maxTokens: overrides?.maxTokens ?? target.maxTokens,
      temperature: overrides?.temperature ?? target.temperature,
      topP: target.topP,
    });
    let text = '';
    let finishReason: string | null = null;
    let usage: TokenUsage | null = null;
    // Tool calls arrive indexed; fragments must be concatenated per index.
    const partials = new Map<number, { id: string; name: string; args: string }>();
    const buildToolCalls = (): AssembledToolCall[] =>
      [...partials.values()]
        .filter((p) => p.name)
        .map((p) => ({ id: p.id, name: p.name, argsJson: p.args || '{}' }));
    try {
      const stream = await client.chat.completions.create(
        {
          model: target.model,
          max_tokens: overrides?.maxTokens ?? target.maxTokens,
          temperature: overrides?.temperature ?? target.temperature,
          top_p: target.topP,
          messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
          stream: true,
          // Ask the server for a final usage-only chunk so we can report live context size.
          stream_options: { include_usage: true },
          tools: wireTools,
        },
        // Passing the abort signal lets a user "stop" tear down the in-flight inference request
        // promptly instead of waiting for the model to finish generating.
        { signal },
      );

      for await (const chunk of stream) {
        // The usage-only chunk carries no choices; capture and move on.
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        const { delta, finish_reason } = choice;
        if (finish_reason) finishReason = finish_reason;

        if (delta?.content) {
          text += delta.content;
          callbacks.onToken(delta.content);
          capture.pushChunk(delta.content, false);
        }

        for (const tc of delta?.tool_calls ?? []) {
          const slot = partials.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          partials.set(tc.index, slot);
        }
      }

      const toolCalls = buildToolCalls();

      log.debug(
        { finishReason, toolCalls: toolCalls.length, chars: text.length, promptTokens: usage?.promptTokens },
        'stream complete',
      );
      call.success(usage);
      capture.end({ text, toolCalls, finishReason }, usage, 'success');
      return { text, toolCalls, finishReason, usage };
    } catch (err) {
      call.fail();
      // Record whatever streamed before the failure/abort so the LLM Debug page shows the partial call.
      capture.end(
        { text, toolCalls: buildToolCalls(), finishReason },
        usage,
        'error',
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }
}

export const llamaClient = new LlamaClient();
