import { createLogger } from '../config/logger';
import { eventBus } from '../core/event-bus/EventBus';
import type { EventContext, ImageBlock } from '../core/event-bus/events.types';
import { agentRepository } from '../domain/agents/agent.repository';
import {
  buildSystemMessage,
  buildMemoryMessage,
  buildUserMessage,
  type ChatMessage,
} from '../domain/agents/jit-builder';
import { agentMemory } from '../domain/memory/agent-memory.service';
import { llamaClient, type ToolSchema, type TokenUsage } from '../inference/LlamaClient';
import { resolveInference, resolveFallbacks, type ResolvedInference } from '../inference/inference-resolver';
import { runWithCaptureContext } from '../inference/capture-context';
import { ReasoningParser } from './streaming/ReasoningParser';
import { parseFallbackToolCalls, detectNarratedTools } from './streaming/ToolCallFallbackParser';
import { resolveTools, VISUAL_TOOL_NAMES } from '../tools/registry';
import { annuaire } from '../tools/core/annuaire';
import { askAgent } from '../tools/core/askAgent';
import { analyzeImage } from '../tools/core/analyzeImage';
import { data } from '../tools/core/data';
import { guide } from '../tools/core/guide';
import { read } from '../tools/core/fs/read';
import { askParent } from '../tools/core/askParent';
import { askUser } from '../tools/core/askUser';
import { askUserBroker } from '../transport/ws/AskUserBroker';
import type { Tool, ToolContext } from '../tools/types';
import { hopGuard } from './HopGuard';
import { TurnImagePool } from './TurnImagePool';
import {
  agentContainerManager,
  type AgentExecutor,
  type IsolatedAgent,
  type IsolationProfile,
} from '../isolation/AgentContainerManager';
import { isolationRepository } from '../domain/isolations/isolation.repository';
import { imageRepository } from '../domain/images/image.repository';
import { sessionRepository } from '../domain/sessions/session.repository';
import { resourceRepository } from '../domain/resources/resource.repository';

const log = createLogger('agent-runner');

/** Decode a `data:<mime>;base64,<payload>` URL to raw bytes (for persisting a tool-acquired image). */
function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(payload, 'base64');
}

/** Pull the MIME type out of a data URL, defaulting to PNG when absent/opaque. */
function dataUrlMime(dataUrl: string): string {
  const m = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return m?.[1] || 'image/png';
}

/** Compact human byte size for the tool-result handle note (e.g. `2.4 MB`). */
function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Default cap on tool round-trips within a single turn, guarding against tool loops. An agent can
 * raise it via `max_tool_iterations` (e.g. visual/desktop agents that take many screenshot→act
 * cycles). When the cap is hit the turn ends without a final answer; the UI surfaces a `truncated`
 * signal so the operator (or auto-continue) can nudge the run onward.
 */
const DEFAULT_MAX_TOOL_ITERATIONS = 20;

/**
 * How many times, per turn, we nudge a model that narrated a tool call as prose (e.g. a bare
 * `[ask_agent]`) back onto the native tool channel before giving up and stripping the leaked text.
 * One retry catches the common transient case without letting a stubborn model burn the iteration cap.
 */
const MAX_NARRATION_RETRIES = 1;

/** Strip leaked `[tool_name]` narration brackets from a final answer so they never reach the user. */
function stripNarratedBrackets(text: string, toolNames: Iterable<string>): string {
  let out = text;
  for (const name of toolNames) {
    out = out.replace(new RegExp(`\\[${name}(?:\\s*(?:→|->|:)[^\\]]*)?\\]`, 'g'), '');
  }
  return out.trim();
}

/**
 * Thrown when the operator stops a run via the UI (or a parent hop is aborted). Carried up through
 * the hop recursion so the top-level socket handler can end the turn cleanly rather than as an error.
 */
export class RunAbortedError extends Error {
  constructor() {
    super('run stopped');
    this.name = 'RunAbortedError';
  }
}

export interface RunInput {
  agentName: string;
  sessionId: string;
  /** Hop depth of this run (0 for the user-facing agent). */
  depth: number;
  userText: string;
  images?: ImageBlock[];
  /** Prior turns in this session (excludes the new user message). */
  history?: ChatMessage[];
  /**
   * Set when this run was spawned by another agent's `ask_agent`. Carries the caller's identity,
   * the task it delegated, and its original conversation — so this sub-agent can call `ask_parent`
   * to bounce a clarifying question back to a caller that still remembers its own context.
   */
  caller?: { agentName: string; task: string; history: ChatMessage[] };
  /**
   * Cooperative cancellation for the whole run (and every sub-agent hop it spawns). When the
   * operator hits "stop" the socket layer aborts this; the runner tears down the in-flight
   * inference stream and bails out of the tool loop instead of finishing the turn.
   */
  signal?: AbortSignal;
}

/**
 * The outcome of one run: the agent's final text answer, plus any images it acquired during the turn
 * (read from disk, produced by a skill, or handed back by its own sub-agents). A delegated run hands
 * those images back to its caller so pictures flow *both* ways across an `ask_agent` hop — the caller
 * forwards images down, and the sub-agent can return images up. Top-level callers use `.text` only.
 */
export interface RunResult {
  text: string;
  images: ImageBlock[];
}

/**
 * Executes a single agent's turn: streams tokens (split into reasoning/output), runs any tool
 * calls through the sandbox, and recurses across `ask_agent` hops. Emits the full event trace
 * on the EventBus so the WS bridge and Pino logs get identical transparency.
 */
export class AgentRunner {
  async run(input: RunInput): Promise<RunResult> {
    // Resolve tolerantly: an `ask_agent` hop's target comes from the model and is often a near-miss
    // of the exact name (wrong case, or the qdrant namespace). `resolveByName` widens the match so
    // the delegation lands instead of throwing "agent not found". Direct (depth-0) runs pass the
    // canonical name from the UI, so this is a no-op for them.
    const agent = await agentRepository.resolveByName(input.agentName);
    if (!agent) throw new Error(`agent "${input.agentName}" not found`);

    const ctx: EventContext = {
      sessionId: input.sessionId,
      agentId: String(agent._id),
      agentName: agent.name,
      depth: input.depth,
    };

    // Resolve the images this turn can work with. Attachments live only for the turn they're sent on
    // (history is text-only), so a follow-up like "forward the last image to X" would otherwise have
    // nothing to act on. When THIS turn carries no attachment, fall back to the most recent image(s)
    // the user attached earlier in the session (persisted on the message docs) — so images are usable
    // across turns. Only the user-facing run (depth 0, no caller) looks them up; a sub-agent acts on
    // exactly the images its parent forwarded to it.
    const currentImages = input.images ?? [];
    const sessionImages =
      currentImages.length === 0 && input.depth === 0 && !input.caller
        ? await this.recentSessionImages(input.sessionId)
        : [];
    // Images reachable by this turn's tools (analyze_image, ask_agent forwarding): this turn's own
    // attachments if present, else the session fallback. Raw pixels still only enter a multimodal
    // model's context for THIS turn's attachments (see userMessage below) — old images aren't re-fed.
    const attachedImages = currentImages.length ? currentImages : sessionImages;
    // Persisted resources acquired earlier in this session (tool-read images, fetched blobs). Seeded
    // as metadata-only handles (no bytes) so a `blob_N`/`img_N` from an earlier turn stays referenceable
    // — writable to a file (`write from_handle`), forwardable, listable in the Data tab. Their bytes are
    // re-read from the resource store on demand, never re-fed into context. Only the top-level run seeds
    // history; a sub-agent works on exactly what its parent forwarded (same session, same handles).
    const priorResources =
      input.depth === 0 && !input.caller ? await this.priorResourceBlocks(input.sessionId) : [];
    // The turn's live resource pool: seeded with prior handles (so counters continue the session
    // sequence and old handles resolve), then this turn's attachments/forwards, then grown by any
    // resource a tool/skill acquires. Shared by reference across every tool call so a resource acquired
    // in one call is reachable — by handle — in a later one (analyze_image / ask_agent / write).
    const imagePool = new TurnImagePool(priorResources, 'tool');
    imagePool.addMany(attachedImages, 'attachment');

    // Resolve the agent's isolation profile (if any) up front: its image's `visual` flag decides
    // whether we auto-grant the visual-desktop tools below, and the profile drives container boot.
    const iso = agent.isolation_id ? await isolationRepository.findById(agent.isolation_id) : null;
    const image = iso?.image_id ? await imageRepository.findById(iso.image_id) : null;
    // A visual image auto-grants the visual-desktop control tools (like the delegation tools below),
    // so the operator needn't list them in `tools_allowed`. The global kill-switch still applies.
    const visualTools = image?.visual ? [...VISUAL_TOOL_NAMES] : [];
    // Auto-grant `analyze_image` so a (possibly text-only) agent can read an image via the Vision
    // endpoint — either because an image is already in scope this turn (attached now / carried over),
    // or because the agent can `read` one into the turn's image pool mid-run. Handles let it then
    // reference that image by id without ever passing a path.
    const canReadImages = agent.tools_allowed.includes(read.name);
    const imageTools = attachedImages.length || canReadImages ? [analyzeImage.name] : [];

    // Top-level agents orchestrate, so they always get the delegation tools even if the operator
    // didn't tick them in `tools_allowed` (a subagent honours its explicit list as before). The
    // global kill-switch in resolveTools still wins if either tool is disabled fleet-wide.
    const orchestrationTools = agent.subagent
      ? [...agent.tools_allowed, ...visualTools, ...imageTools]
      : [...agent.tools_allowed, annuaire.name, askAgent.name, ...visualTools, ...imageTools];
    // Every agent can reach the operator via `ask_user`; only a delegated run (has a caller) gets
    // `ask_parent` to bounce a question back up. Every agent also gets `data` so it can see, save,
    // and store the session's shared resource pool — that's how a delegate reaches a blob/image its
    // caller handed it by handle. The global kill-switch in resolveTools still wins.
    const effectiveTools = [
      ...new Set([
        ...orchestrationTools,
        askUser.name,
        data.name,
        guide.name,
        ...(input.caller ? [askParent.name] : []),
      ]),
    ];
    const tools = await resolveTools(effectiveTools);
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const toolSchemas: ToolSchema[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // Auto-RAG: pull the most relevant memories for this query and inject them as a system
    // block ahead of the conversation. Best-effort — an embeddings outage yields no memories.
    const recalled = await agentMemory.recall(agent.qdrant_namespace, input.userText);
    const memoryMessage = buildMemoryMessage(recalled);

    // Fold recalled memories into the single leading system message rather than injecting a second
    // `system` turn. Many chat templates (including the GGUFs we serve) enforce "System message must
    // be at the beginning" and hard-fail on a second one — merging keeps retrieval visible as a
    // labelled block without breaking the template or the runtime message ordering.
    const systemMessage = buildSystemMessage(agent);
    if (
      memoryMessage &&
      typeof systemMessage.content === 'string' &&
      typeof memoryMessage.content === 'string'
    ) {
      systemMessage.content = `${systemMessage.content}\n\n${memoryMessage.content}`;
    }

    // Resolve the inference target now: whether the agent's own model is multimodal decides whether
    // the raw attached images go into its context. (Failover chain resolved alongside.)
    const inference = await resolveInference(agent);
    const fallbacks = await resolveFallbacks(inference.url);

    // Tell the model, in the user turn, what images it can act on and how — otherwise a model that
    // doesn't get the raw pixels has no signal an image exists and silently ignores it. Two cases:
    //  - this turn's own attachments on a text-only model (multimodal gets the raw pixels instead);
    //  - image(s) carried over from earlier in the session (never fed as raw pixels regardless of
    //    modality, so the note is what makes them reachable via analyze_image / ask_agent).
    const idxRange = (n: number) => (n > 1 ? `..${n - 1}` : '');
    const userText = (() => {
      if (currentImages.length && !inference.supportsVision) {
        const n = currentImages.length;
        return `${input.userText}\n\n[${n} image${n > 1 ? 's are' : ' is'} attached to this message. You cannot see ${
          n > 1 ? 'them' : 'it'
        } directly — call the \`analyze_image\` tool (index 0${idxRange(n)}) to read ${
          n > 1 ? 'each one' : 'it'
        } before answering.]`;
      }
      if (currentImages.length === 0 && sessionImages.length) {
        const n = sessionImages.length;
        return `${input.userText}\n\n[${n} image${n > 1 ? 's' : ''} from earlier in this conversation ${
          n > 1 ? 'are' : 'is'
        } available. You cannot see ${
          n > 1 ? 'them' : 'it'
        } directly — call \`analyze_image\` (index 0${idxRange(n)}) to read ${
          n > 1 ? 'them' : 'it'
        }, or forward ${n > 1 ? 'them' : 'it'} to another agent with \`ask_agent\` (include_image: true).]`;
      }
      return input.userText;
    })();
    // Raw images enter the model context only for a multimodal agent, and only for THIS turn's own
    // attachments — a text-only endpoint would choke on them, and re-feeding old session images every
    // turn would bloat/confuse the context. Carried-over images stay reachable via the tools above.
    const userMessage = buildUserMessage(
      userText,
      inference.supportsVision ? currentImages : undefined,
    );
    const messages: ChatMessage[] = [systemMessage, ...(input.history ?? []), userMessage];

    // The clean conversational context to hand any sub-agent this run delegates to: everything up to
    // (and including) this turn's user message, but *not* the in-flight tool activity. Threaded down
    // so a sub-agent's `ask_parent` re-runs this agent with a well-formed, context-aware history.
    const callerHistory: ChatMessage[] = [...(input.history ?? []), userMessage];

    // Isolation: when the agent is assigned an isolation profile (resolved above), lazily bring up
    // its container on first tool use and reuse the executor for the rest of the turn (memoised so
    // parallel tool calls share one boot). No assignment → tools run on the backend as before.
    let execPromise: Promise<AgentExecutor> | undefined;
    const resolveExec = iso
      ? () =>
          (execPromise ??= agentContainerManager.ensureReady(
            agent as unknown as IsolatedAgent,
            iso as unknown as IsolationProfile,
          ))
      : null;

    const { signal } = input;

    let finalText = '';
    // Latest usage across tool iterations; the final pass reflects the full session context size.
    let lastUsage: TokenUsage | null = null;

    // Per-agent tool-round ceiling (falls back to the global default). The loop breaks cleanly once
    // the model stops calling tools; if instead it exhausts every round we mark the turn `truncated`
    // and signal the UI so a "continue" (manual or auto) can pick the run back up.
    const maxIterations =
      typeof agent.max_tool_iterations === 'number' && agent.max_tool_iterations > 0
        ? agent.max_tool_iterations
        : DEFAULT_MAX_TOOL_ITERATIONS;
    let finishedCleanly = false;

    // Results of tool calls already run this turn, keyed by name+args. If the model re-issues an
    // *identical* call (a common failure mode that shows up as a sub-agent "repeating itself" — the
    // same `ask_agent` fired every iteration), we short-circuit with the earlier result instead of
    // re-running the tool. Combined with the tool-round cap this breaks the repeat loop.
    const toolResultCache = new Map<string, string>();

    // Times we've nudged the model back onto the native tool channel this turn (see below).
    let narrationRetries = 0;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) throw new RunAbortedError();
      const { text, toolCalls: nativeCalls, usage } = await this.streamTurn(
        messages,
        toolSchemas,
        ctx,
        inference,
        fallbacks,
        signal,
      );
      if (usage) lastUsage = usage;

      // Live meter: report this pass's context size immediately so the UI amber reading climbs
      // through a long tool loop (e.g. a DesktopAgent piling up screenshots) instead of only
      // revealing the size once the whole turn settles. The turn's `final` (peak) emit follows below.
      if (usage) {
        eventBus.emit('agent:context_usage', {
          ctx,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          contextWindow: inference.contextWindow,
          phase: 'live',
        });
      }

      // The app relies on native function-calling, but a misconfigured server / unreliable model can
      // narrate a call as prose (e.g. `[ask_user] …`) with no native `tool_calls`. When that happens,
      // recover the intended call from the text so the tool still runs, and drop the leaked prose from
      // the recorded turn so it isn't returned as the final answer. Only fires as a fallback.
      let toolCalls = nativeCalls;
      let assistantText = text;
      if (toolCalls.length === 0 && text.trim()) {
        const recovered = parseFallbackToolCalls(text, tools);
        if (recovered.length) {
          log.warn(
            { agent: agent.name, recovered: recovered.map((c) => c.name) },
            'recovered tool call(s) from assistant prose — model did not use the native tool channel',
          );
          toolCalls = recovered.map((c, i) => ({ id: `fallback_${iteration}_${i}`, ...c }));
          assistantText = '';
        }
      }

      // No native call and nothing recoverable, but the model clearly *narrated* a real tool as prose
      // (a bare `[ask_agent]`, or a multi-arg tool we won't fabricate args for). Returning that leaked
      // bracket as the answer is exactly the "Nova never asks websearch" failure. Instead, nudge it
      // back onto the native tool channel and retry once; if it still narrates, strip the bracket so
      // the user never sees it. Delegation tools (multi-arg) are the main beneficiary.
      const narratedTools =
        toolCalls.length === 0 ? detectNarratedTools(assistantText, tools) : [];

      // Record the assistant turn (with any tool calls) so the model sees its own request.
      messages.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: toolCalls.length
          ? toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.argsJson },
            }))
          : undefined,
      });

      if (toolCalls.length === 0) {
        if (narratedTools.length && narrationRetries < MAX_NARRATION_RETRIES) {
          narrationRetries++;
          log.warn(
            { agent: agent.name, narrated: narratedTools },
            'model narrated a tool call as prose (no native call) — nudging it to use the tool channel',
          );
          messages.push({
            role: 'user',
            content:
              `Your previous message wrote ${narratedTools
                .map((t) => `\`[${t}]\``)
                .join(', ')} as plain text. That does NOT call the tool — it was ignored. ` +
              'Do not describe or narrate tool calls in prose. Re-issue the call now on the native ' +
              'function-calling channel, supplying every required argument (for `ask_agent`, both ' +
              '`agent` and `query`).',
          });
          continue;
        }
        // Give up nudging: strip any leaked narration so it isn't surfaced as the answer.
        finalText = narratedTools.length
          ? stripNarratedBrackets(assistantText, narratedTools)
          : assistantText;
        finishedCleanly = true; // the model produced a final answer — not a cap truncation
        break;
      }

      for (const call of toolCalls) {
        const cacheKey = `${call.name}${call.argsJson}`;
        const cached = toolResultCache.get(cacheKey);
        if (cached !== undefined) {
          log.warn(
            { agent: agent.name, tool: call.name },
            'duplicate tool call short-circuited (identical args already executed this turn)',
          );
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              ok: false,
              error:
                'Duplicate call: this exact tool and arguments already ran this turn. Do not repeat it — use the previous result and continue.',
              previous_result: safeParse(cached),
            }),
          });
          continue;
        }
        const toolMsg = await this.executeToolCall(call, toolMap, ctx, messages, resolveExec, {
          callerHistory,
          caller: input.caller,
          signal,
          pool: imagePool,
          supportsVision: inference.supportsVision,
        });
        // executeToolCall already appended the tool message (and any following image message) to
        // `messages` in the correct order; here we only cache its content for the duplicate short-circuit.
        if (typeof toolMsg.content === 'string') toolResultCache.set(cacheKey, toolMsg.content);
      }

      // A sub-agent hop's abort surfaces here as a swallowed tool error; bail immediately so a
      // stopped run doesn't grind on through the remaining iterations.
      if (signal?.aborted) throw new RunAbortedError();
    }

    // The loop ran out of tool rounds before the model produced a final answer: the turn is cut off
    // mid-task. Signal the user-facing run (depth 0) so the UI can offer / auto-fire a "continue"
    // instead of leaving the operator to notice the stall and retype it.
    if (!finishedCleanly && ctx.depth === 0) {
      eventBus.emit('agent:turn_truncated', { ctx });
    }

    // Report this run's live context size to the UI. Every agent emits (the payload carries its
    // identity + depth): the user-facing agent (depth 0) drives the chat header, while a sub-agent
    // hop's usage is attributed to its own bubble so the operator can see how much context each
    // delegated run consumed.
    // Exactness fallback: a server that doesn't emit streaming `usage` leaves `lastUsage` null, so
    // the meter would never settle. Count the final message set via llama.cpp's tokenizer instead.
    if (!lastUsage) {
      const counted = await llamaClient.tokenizeMessages(inference, messages).catch(() => null);
      if (counted != null) {
        lastUsage = { promptTokens: counted, completionTokens: 0, totalTokens: counted };
      }
    }
    if (lastUsage) {
      eventBus.emit('agent:context_usage', {
        ctx,
        promptTokens: lastUsage.promptTokens,
        completionTokens: lastUsage.completionTokens,
        totalTokens: lastUsage.totalTokens,
        contextWindow: inference.contextWindow,
        phase: 'final',
      });
    }

    // Light auto-storage: persist the exchange so the agent passively accrues context. Fire and
    // forget — never let a memory write delay or fail the response returned to the caller.
    if (finalText.trim()) {
      void agentMemory.remember(
        agent.qdrant_namespace,
        `User: ${input.userText}\n${agent.name}: ${finalText}`,
        { source: 'auto_turn', session_id: input.sessionId },
      );
    }

    // Hand back the images this turn *acquired* (source `tool`: read from disk, produced by a skill,
    // or returned by its own sub-agents) — not the ones a caller forwarded in (those are already the
    // caller's). A delegated run's caller folds these into its own turn via `ask_agent`; a top-level
    // caller ignores them (the images already rendered in this agent's own turn).
    const handBack = imagePool.all().filter((i) => i.source === 'tool');
    return { text: finalText, images: handBack };
  }

  /**
   * The most recent image(s) the user attached earlier in this session, read back from the persisted
   * message docs. Lets a later, image-less turn ("forward the last image to X") still act on them —
   * attachments are otherwise per-turn (history is text-only). Returns the newest user message that
   * carried images; best-effort — a read failure just yields no images.
   */
  private async recentSessionImages(sessionId: string): Promise<ImageBlock[]> {
    try {
      const msgs = await sessionRepository.messages(sessionId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === 'user' && Array.isArray(m.images) && m.images.length) {
          return m.images.map((dataUrl) => ({ dataUrl }));
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), sessionId }, 'failed to load session images');
    }
    return [];
  }

  /**
   * Load the session's persisted resources as metadata-only pool blocks (no bytes) so their handles
   * seed the turn's pool and stay referenceable across turns. Bytes are re-read on demand from the
   * resource store (`write from_handle`, the Data-tab download route). Best-effort.
   */
  private async priorResourceBlocks(sessionId: string): Promise<ImageBlock[]> {
    try {
      const rows = await resourceRepository.listBySession(sessionId);
      return rows.map((r) => ({
        id: r.handle,
        kind: r.kind,
        mime: r.mime,
        size: r.size,
        filename: r.filename || undefined,
        storageId: String(r.gridfs_id),
        source: 'tool' as const,
      }));
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId },
        'failed to load session resources',
      );
      return [];
    }
  }

  /**
   * Register resources a tool acquired into the pool and persist any that aren't already stored.
   * A resource with a `storageId` is already persisted (a blob from its producing tool, or one
   * forwarded across a hop) — just adopt it. A fresh image (carrying `dataUrl` pixels) is stored to
   * the resource store under its assigned handle so it survives the turn and shows in the Data tab.
   */
  private async persistAndPool(
    ctx: EventContext,
    pool: TurnImagePool,
    acquired: ImageBlock[],
  ): Promise<ImageBlock[]> {
    const out: ImageBlock[] = [];
    for (const r of acquired) {
      const kind = r.kind ?? 'image';
      if (r.storageId) {
        out.push(pool.add(r, 'tool'));
        continue;
      }
      const stamped = pool.add({ ...r, kind }, 'tool');
      if (kind === 'image' && r.dataUrl) {
        try {
          const bytes = dataUrlToBuffer(r.dataUrl);
          const mime = dataUrlMime(r.dataUrl);
          const stored = await resourceRepository.store({
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
            bytes,
            kind: 'image',
            mime,
            source: 'tool',
            handle: stamped.id,
          });
          stamped.storageId = String(stored.gridfs_id);
          stamped.mime = mime;
          stamped.size = bytes.length;
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err), handle: stamped.id },
            'failed to persist tool image resource',
          );
        }
      }
      out.push(stamped);
    }
    return out;
  }

  /** One streamed inference pass; forwards reasoning-tagged chunks to the bus. */
  private async streamTurn(
    messages: ChatMessage[],
    toolSchemas: ToolSchema[],
    ctx: EventContext,
    inference: ResolvedInference,
    fallbacks: ResolvedInference[],
    signal?: AbortSignal,
  ): ReturnType<typeof llamaClient.streamChat> {
    const parser = new ReasoningParser();
    const result = await runWithCaptureContext(
      { source: 'chat-turn', sessionId: ctx.sessionId, agentId: ctx.agentId, agentName: ctx.agentName, depth: ctx.depth },
      () =>
        llamaClient.streamChat(
          messages,
          toolSchemas,
          {
            onToken: (delta) => {
              for (const seg of parser.push(delta)) {
                eventBus.emit('agent:stream_chunk', {
                  ctx,
                  content: seg.content,
                  isReasoning: seg.isReasoning,
                });
              }
            },
          },
          signal,
          undefined,
          inference,
          fallbacks,
        ),
    );
    for (const seg of parser.flush()) {
      eventBus.emit('agent:stream_chunk', { ctx, content: seg.content, isReasoning: seg.isReasoning });
    }
    return result;
  }

  /** Invoke one tool, emit invoke/complete events, and return the `tool` role message. */
  private async executeToolCall(
    call: { id: string; name: string; argsJson: string },
    toolMap: Map<string, Tool>,
    ctx: EventContext,
    messages: ChatMessage[],
    resolveExec: (() => Promise<AgentExecutor>) | null,
    delegation: {
      callerHistory: ChatMessage[];
      caller?: RunInput['caller'];
      signal?: AbortSignal;
      /** The turn's live image pool, shared across every tool call (grown as tools acquire images). */
      pool: TurnImagePool;
      /** Whether the agent's model can see raw pixels — gates folding tool images into its context. */
      supportsVision: boolean;
    },
  ): Promise<ChatMessage> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.argsJson) as Record<string, unknown>;
    } catch {
      log.warn({ tool: call.name, argsJson: call.argsJson }, 'unparseable tool args');
    }

    eventBus.emit('agent:tool_invoke', { ctx, callId: call.id, tool: call.name, args });

    const tool = toolMap.get(call.name);
    const startedAt = Date.now();

    if (!tool) {
      const result = { ok: false, error: `unknown tool: ${call.name}` };
      eventBus.emit('tool:execution_complete', {
        ctx,
        callId: call.id,
        tool: call.name,
        status: 'error',
        result,
        durationMs: 0,
      });
      return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
    }

    // Bring up the isolated container (memoised) if this agent runs isolated. A failure here
    // (e.g. image not built) is surfaced to Linux-execution tools as `isolationError` — they must
    // error rather than fall back to the backend.
    let exec: AgentExecutor | undefined;
    let isolationError: string | undefined;
    if (resolveExec) {
      try {
        exec = await resolveExec();
      } catch (err) {
        isolationError = err instanceof Error ? err.message : String(err);
      }
    }

    // Only expose cross-agent hops (delegation + asking the caller back) while a hop remains (§4).
    const canSpawn = hopGuard.canHop(ctx.depth + 1);
    const toolCtx: ToolContext = {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      depth: ctx.depth,
      invokeSubAgent: canSpawn
        ? this.makeInvoker(ctx, delegation.callerHistory, delegation.signal)
        : undefined,
      askParent:
        canSpawn && delegation.caller
          ? this.makeParentAsker(ctx, delegation.caller, delegation.signal)
          : undefined,
      askUser: (question) => askUserBroker.ask(ctx, question),
      callId: call.id,
      emitOutput: (chunk) =>
        eventBus.emit('tool:output_chunk', { ctx, callId: call.id, chunk }),
      emitVision: (payload) =>
        eventBus.emit('tool:vision', { ctx, callId: call.id, ...payload }),
      emitVisualAct: (payload) =>
        eventBus.emit('tool:visual_act', { ctx, callId: call.id, ...payload }),
      attachedImages: delegation.pool.all(),
      availableTools: [...toolMap.values()].map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      exec,
      isolationError,
    };

    let status: 'success' | 'error' = 'success';
    let payload: unknown;
    let images: ImageBlock[] | undefined;
    try {
      const res = await tool.execute(args, toolCtx);
      payload = res.result;
      // Any resource a tool/skill acquired joins the turn's pool with a stable handle, so a later
      // tool call (analyze_image / ask_agent / write) can reach it by id. Images are persisted to the
      // resource store here (blobs arrive already persisted by their producing tool). Stamp the handles
      // onto the tool result so the model learns them directly from what it reads.
      const acquired = [...(res.images ?? []), ...(res.resources ?? [])];
      if (acquired.length) {
        images = await this.persistAndPool(ctx, delegation.pool, acquired);
        if (payload && typeof payload === 'object') {
          const p = payload as Record<string, unknown>;
          const imgIds = images.filter((i) => (i.kind ?? 'image') === 'image').map((i) => i.id);
          const blobIds = images.filter((i) => i.kind === 'blob').map((i) => i.id);
          if (imgIds.length) p.image_ids = imgIds;
          if (blobIds.length) p.resource_ids = blobIds;
        }
      }
    } catch (err) {
      status = 'error';
      payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const durationMs = Date.now() - startedAt;
    eventBus.emit('tool:execution_complete', {
      ctx,
      callId: call.id,
      tool: call.name,
      status,
      result: payload,
      images,
      durationMs,
    });

    // Push the tool result first — it must immediately follow the assistant's tool_call message —
    // then fold any tool-acquired images into a *following* user message so the agent analyses them
    // automatically (spec §1). Ordering matters: an image wedged between the assistant tool_call and
    // its tool response is malformed OpenAI/llama chat, and llama.cpp's multimodal path only reliably
    // embeds an image when it isn't breaking that pairing (a common "the model can't see it" cause).
    const toolMsg: ChatMessage = {
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(payload),
    };
    messages.push(toolMsg);
    if (images?.length) {
      // Announce the handles so the agent acts on resources by id (never a path). A multimodal agent
      // also gets image pixels folded in here; a text-only agent gets only the note (raw pixels would
      // choke its endpoint) and reaches an image via `analyze_image`. Blobs never enter context — the
      // note tells the agent it can save one to a file (`write` from_handle) or forward it.
      const pics = images.filter((i) => (i.kind ?? 'image') === 'image');
      const blobs = images.filter((i) => i.kind === 'blob');
      const parts: string[] = [];
      if (pics.length) {
        const ids = pics.map((i) => i.id).filter(Boolean).join(', ');
        parts.push(
          `${pics.length} image${pics.length > 1 ? 's' : ''} loaded as ${ids} — analyse with ` +
            `\`analyze_image\` (image_id) or forward with \`ask_agent\` (image_ids).`,
        );
      }
      if (blobs.length) {
        const detail = blobs
          .map((b) => `${b.id} (${b.mime ?? 'binary'}, ${formatBytes(b.size ?? 0)})`)
          .join(', ');
        parts.push(
          `${blobs.length} binary resource${blobs.length > 1 ? 's' : ''} saved as ${detail} — not in ` +
            `your context. Use the \`data\` tool: \`data\` (save) writes it to a file, and it persists ` +
            `for the whole session, so to hand it to another agent just name the handle when you ` +
            `\`ask_agent\` (they read it with \`data\`).`,
        );
      }
      const note = `[${parts.join(' ')} Do not pass a file path.]`;
      messages.push(buildUserMessage(note, delegation.supportsVision ? pics : undefined));
    }
    return toolMsg;
  }

  /**
   * Build the guarded cross-agent dispatcher passed to `ask_agent`. `callerHistory` is the calling
   * agent's clean conversation, threaded onto the child as `caller` so the child can `ask_parent`.
   */
  private makeInvoker(parentCtx: EventContext, callerHistory: ChatMessage[], signal?: AbortSignal) {
    return (targetAgentName: string, query: string, images?: ImageBlock[]): Promise<RunResult> =>
      this.hop(parentCtx, targetAgentName, query, {
        userText: query,
        images,
        caller: { agentName: parentCtx.agentName, task: query, history: callerHistory },
        signal,
      });
  }

  /**
   * Build the `ask_parent` dispatcher for a delegated run: re-runs the caller as a fresh turn seeded
   * with its original conversation and a framed question, so it answers with full context. The caller
   * gets no `caller` of its own here → it can't ask *its* parent while answering (no infinite ladder).
   */
  private makeParentAsker(
    childCtx: EventContext,
    caller: NonNullable<RunInput['caller']>,
    signal?: AbortSignal,
  ) {
    return async (question: string): Promise<string> => {
      const framed =
        `You previously delegated this task to your sub-agent "${childCtx.agentName}":\n` +
        `"${caller.task}"\n\n` +
        `The sub-agent needs clarification before it can continue:\n"${question}"\n\n` +
        'Answer its question directly so it can proceed.';
      const { text } = await this.hop(childCtx, caller.agentName, question, {
        userText: framed,
        history: caller.history,
        signal,
      });
      return text;
    };
  }

  /**
   * Shared cross-agent hop: guards depth, emits the `agent:ask_agent`/`_done` trace (from the
   * initiating agent to the target), and runs the target one hop deeper. `query` is the label shown
   * in the UI; `run` carries the actual prompt/context handed to the target.
   */
  private async hop(
    fromCtx: EventContext,
    targetAgentName: string,
    query: string,
    run: Pick<RunInput, 'userText' | 'history' | 'caller' | 'signal' | 'images'>,
  ): Promise<RunResult> {
    const childDepth = fromCtx.depth + 1;
    if (!hopGuard.canHop(childDepth)) {
      throw new Error(`max agent hop depth (${hopGuard.max}) exceeded`);
    }
    log.info(
      { from: fromCtx.agentName, to: targetAgentName, depth: childDepth },
      'ask_agent hop',
    );
    eventBus.emit('agent:ask_agent', {
      ctx: fromCtx,
      from: fromCtx.agentName,
      to: targetAgentName,
      depth: childDepth,
      query,
    });
    try {
      const answer = await this.run({
        agentName: targetAgentName,
        sessionId: fromCtx.sessionId,
        depth: childDepth,
        ...run,
      });
      eventBus.emit('agent:ask_agent_done', {
        ctx: fromCtx,
        from: fromCtx.agentName,
        to: targetAgentName,
        depth: childDepth,
        status: 'success',
      });
      return answer;
    } catch (err) {
      eventBus.emit('agent:ask_agent_done', {
        ctx: fromCtx,
        from: fromCtx.agentName,
        to: targetAgentName,
        depth: childDepth,
        status: 'error',
      });
      throw err;
    }
  }
}

/** Best-effort parse of a cached tool result string; falls back to the raw string. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export const agentRunner = new AgentRunner();
