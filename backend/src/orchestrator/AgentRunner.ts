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
import { ReasoningParser } from './streaming/ReasoningParser';
import { parseFallbackToolCalls, detectNarratedTools } from './streaming/ToolCallFallbackParser';
import { resolveTools } from '../tools/registry';
import { annuaire } from '../tools/core/annuaire';
import { askAgent } from '../tools/core/askAgent';
import { askParent } from '../tools/core/askParent';
import { askUser } from '../tools/core/askUser';
import { askUserBroker } from '../transport/ws/AskUserBroker';
import type { Tool, ToolContext } from '../tools/types';
import { hopGuard } from './HopGuard';
import {
  agentContainerManager,
  type AgentExecutor,
  type IsolatedAgent,
  type IsolationProfile,
} from '../isolation/AgentContainerManager';
import { isolationRepository } from '../domain/isolations/isolation.repository';

const log = createLogger('agent-runner');

/** Hard cap on tool round-trips within a single turn, guarding against tool loops. */
const MAX_TOOL_ITERATIONS = 8;

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
 * Executes a single agent's turn: streams tokens (split into reasoning/output), runs any tool
 * calls through the sandbox, and recurses across `ask_agent` hops. Emits the full event trace
 * on the EventBus so the WS bridge and Pino logs get identical transparency.
 */
export class AgentRunner {
  async run(input: RunInput): Promise<string> {
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

    // Top-level agents orchestrate, so they always get the delegation tools even if the operator
    // didn't tick them in `tools_allowed` (a subagent honours its explicit list as before). The
    // global kill-switch in resolveTools still wins if either tool is disabled fleet-wide.
    const orchestrationTools = agent.subagent
      ? agent.tools_allowed
      : [...agent.tools_allowed, annuaire.name, askAgent.name];
    // Every agent can reach the operator via `ask_user`; only a delegated run (has a caller) gets
    // `ask_parent` to bounce a question back up. The global kill-switch in resolveTools still wins.
    const effectiveTools = [
      ...new Set([
        ...orchestrationTools,
        askUser.name,
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

    const userMessage = buildUserMessage(input.userText, input.images);
    const messages: ChatMessage[] = [systemMessage, ...(input.history ?? []), userMessage];

    // The clean conversational context to hand any sub-agent this run delegates to: everything up to
    // (and including) this turn's user message, but *not* the in-flight tool activity. Threaded down
    // so a sub-agent's `ask_parent` re-runs this agent with a well-formed, context-aware history.
    const callerHistory: ChatMessage[] = [...(input.history ?? []), userMessage];

    // Isolation: when the agent is assigned an isolation profile, lazily bring up its container on
    // first tool use and reuse the executor for the rest of the turn (memoised so parallel tool
    // calls share one boot). No assignment → tools run on the backend as before.
    const iso = agent.isolation_id ? await isolationRepository.findById(agent.isolation_id) : null;
    let execPromise: Promise<AgentExecutor> | undefined;
    const resolveExec = iso
      ? () =>
          (execPromise ??= agentContainerManager.ensureReady(
            agent as unknown as IsolatedAgent,
            iso as unknown as IsolationProfile,
          ))
      : null;

    const { signal } = input;

    // Resolve this agent's inference target once per turn: its assigned endpoint + model (or the
    // fleet default) plus global sampling. Threaded into every streamed pass below.
    const inference = await resolveInference(agent);
    // Ordered failover chain, resolved once per turn. Empty unless endpoints opt into fallback.
    const fallbacks = await resolveFallbacks(inference.url);

    let finalText = '';
    // Latest usage across tool iterations; the final pass reflects the full session context size.
    let lastUsage: TokenUsage | null = null;

    // Results of tool calls already run this turn, keyed by name+args. If the model re-issues an
    // *identical* call (a common failure mode that shows up as a sub-agent "repeating itself" — the
    // same `ask_agent` fired every iteration), we short-circuit with the earlier result instead of
    // re-running the tool. Combined with MAX_TOOL_ITERATIONS this breaks the repeat loop.
    const toolResultCache = new Map<string, string>();

    // Times we've nudged the model back onto the native tool channel this turn (see below).
    let narrationRetries = 0;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
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
        break;
      }

      for (const call of toolCalls) {
        const cacheKey = `${call.name} ${call.argsJson}`;
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
        });
        if (typeof toolMsg.content === 'string') toolResultCache.set(cacheKey, toolMsg.content);
        messages.push(toolMsg);
      }

      // A sub-agent hop's abort surfaces here as a swallowed tool error; bail immediately so a
      // stopped run doesn't grind on through the remaining iterations.
      if (signal?.aborted) throw new RunAbortedError();
    }

    // Report this run's live context size to the UI. Every agent emits (the payload carries its
    // identity + depth): the user-facing agent (depth 0) drives the chat header, while a sub-agent
    // hop's usage is attributed to its own bubble so the operator can see how much context each
    // delegated run consumed.
    if (lastUsage) {
      eventBus.emit('agent:context_usage', {
        ctx,
        promptTokens: lastUsage.promptTokens,
        completionTokens: lastUsage.completionTokens,
        totalTokens: lastUsage.totalTokens,
        contextWindow: inference.contextWindow,
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

    return finalText;
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
    const result = await llamaClient.streamChat(
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
    delegation: { callerHistory: ChatMessage[]; caller?: RunInput['caller']; signal?: AbortSignal },
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
      exec,
      isolationError,
    };

    let status: 'success' | 'error' = 'success';
    let payload: unknown;
    let images: ImageBlock[] | undefined;
    try {
      const res = await tool.execute(args, toolCtx);
      payload = res.result;
      images = res.images;
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

    // Tool-acquired images: fold into context so the agent analyses them automatically (spec §1).
    if (images?.length) {
      messages.push(buildUserMessage('', images));
    }

    return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(payload) };
  }

  /**
   * Build the guarded cross-agent dispatcher passed to `ask_agent`. `callerHistory` is the calling
   * agent's clean conversation, threaded onto the child as `caller` so the child can `ask_parent`.
   */
  private makeInvoker(parentCtx: EventContext, callerHistory: ChatMessage[], signal?: AbortSignal) {
    return (targetAgentName: string, query: string): Promise<string> =>
      this.hop(parentCtx, targetAgentName, query, {
        userText: query,
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
    return (question: string): Promise<string> => {
      const framed =
        `You previously delegated this task to your sub-agent "${childCtx.agentName}":\n` +
        `"${caller.task}"\n\n` +
        `The sub-agent needs clarification before it can continue:\n"${question}"\n\n` +
        'Answer its question directly so it can proceed.';
      return this.hop(childCtx, caller.agentName, question, {
        userText: framed,
        history: caller.history,
        signal,
      });
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
    run: Pick<RunInput, 'userText' | 'history' | 'caller' | 'signal'>,
  ): Promise<string> {
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
