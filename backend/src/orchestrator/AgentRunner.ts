import { randomUUID } from 'node:crypto';
import { createLogger } from '../config/logger';
import { eventBus } from '../core/event-bus/EventBus';
import type { EventContext, ImageBlock, SubagentTaskInfo, ToolBatchInfo } from '../core/event-bus/events.types';
import { agentRepository } from '../domain/agents/agent.repository';
import { buildUserMessage, type ChatMessage } from '../domain/agents/jit-builder';
import { assembleSystemMessage, assembleUserText } from '../modules/assemble';
import { moduleStateFrom } from '../modules/state.service';
import type { AutoLoopPromptState, ModuleScope, PromptContext, SubagentsPromptState } from '../modules/types';
import { agentMemory, embedRecallQuery } from '../domain/memory/agent-memory.service';
import { memoryDistiller } from '../domain/memory/memory-distiller';
import { forumRecall } from '../domain/forum/forum-recall.service';
import { settingsService } from '../domain/settings/settings.service';
import { llamaClient, type ToolSchema, type TokenUsage } from '../inference/LlamaClient';
import { scoringService } from '../domain/scoring/scoring.service';
import { resolveInference, resolveFallbacks, type ResolvedInference } from '../inference/inference-resolver';
import { runWithCaptureContext } from '../inference/capture-context';
import { ReasoningParser } from './streaming/ReasoningParser';
import { parseFallbackToolCalls, detectNarratedTools } from './streaming/ToolCallFallbackParser';
import { resolveTools, ANDROID_TOOL_NAMES, OBSERVATION_TOOL_NAMES, VISUAL_TOOL_NAMES } from '../tools/registry';
import { annuaire } from '../tools/core/annuaire';
import { askAgent } from '../tools/core/askAgent';
import { analyzeImage } from '../tools/core/analyzeImage';
import { visualClick } from '../tools/core/visual';
import { resolveScreenControlMode } from '../tools/core/screen-analysis';
import { data } from '../tools/core/data';
import { guide } from '../tools/core/guide';
import { todoWrite } from '../tools/core/todo';
import { loopDone } from '../tools/core/loopDone';
import { todoRepository } from '../domain/todos/todo.repository';
import { remember } from '../tools/core/remember';
import { forget } from '../tools/core/forget';
import { board } from '../tools/core/board';
import { forum } from '../tools/core/forum';
import { read } from '../tools/core/fs/read';
import { askParent } from '../tools/core/askParent';
import { askUser } from '../tools/core/askUser';
import { askUserBroker } from '../transport/ws/AskUserBroker';
import type { Tool, ToolContext } from '../tools/types';
import { isParallelSafe, mayRead } from '../tools/parallel-safety';
import { task } from '../tools/core/task';
import type { AgentDoc } from '../domain/agents/agent.model';
import type { EffectiveSettings } from '../domain/settings/settings.service';
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
 * Evict a stale live screen frame from the in-flight context (see `ImageBlock.frameKeep`): drop its
 * pixels — the expensive part, and by now a picture of a screen that has since changed — and replace
 * the "…shown here, read it yourself" note with a stub, so the agent isn't told an image it can no
 * longer see is in front of it. The handle survives, so the frame is still reachable by id.
 */
function evictFrame(message: ChatMessage, handles: string): void {
  message.content =
    `[An earlier screenshot (${handles}) was here and has been dropped from your context to make ` +
    `room. You can no longer see it. Capture a fresh one if you need to look at the screen again.]`;
}

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
  /**
   * Groups every llama call of this user turn — set once for the depth-0 run and propagated to every
   * sub-agent hop so the whole turn (including delegations) shares one grouping id.
   * Generated in `run()` when absent (the top-level entry).
   */
  turnId?: string;
  /**
   * This agent-run's id (the scored unit). `hop` mints a fresh one per sub-agent invocation and passes
   * it here; the depth-0 entry leaves it unset and `run()` generates it.
   */
  runId?: string;
  userText: string;
  images?: ImageBlock[];
  /**
   * Set when this run is one iteration of a self-driving conversation (`AUTO_AGENT_PLAN.md`), by
   * `AutoLoopRunner` — never by the socket layer. Carries the standing goal and the progress recap
   * folded into the prompt, plus the watermark for the "new on the forum since your last turn"
   * digest. Its presence is also what grants `loop_done`: only the loop's own turns may end it, so
   * an ordinary message typed into the same conversation can't.
   */
  autoLoop?: AutoLoopPromptState & { forumSeenAt: Date };
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
  /**
   * Whether this turn is distilled into the agent's long-term memory afterwards (default `true`).
   * The Conversation Generator passes `false`: its conversations are synthetic training data, and
   * writing them back would flood the agent's Qdrant namespace with souvenirs of chats it never
   * really had. Recall is unaffected — the agent still answers with everything it genuinely knows.
   */
  persistMemory?: boolean;
  /**
   * Run this turn on an endpoint/model that is not the agent's own
   * (`BOARD_SUBAGENT_MODEL_PLAN.md`). Set by the work board so a task's *work* turn runs on a cheap
   * model while the same agent, reached any other way, still answers on the model it was configured
   * with — the override belongs to the dispatch, not to the agent.
   *
   * Deliberately absent from `hop`'s `Pick`, so an `ask_agent` delegation inside an overridden turn
   * lands on the target's own model: the caller is asking a specialist a question, and the
   * specialist was configured with the model it needs. Same rule the picked inference modes follow.
   */
  inference?: { endpointId?: string | null; model?: string } | null;
  /**
   * Set when this run is a `task` subagent of its caller — a fresh-context copy of the same agent
   * (`SUBAGENT_PLAN.md` §2), set only by `makeTaskInvoker`. It is what narrows the run: no delegation
   * tools and no operator back-channel, read-only tools in `explore`, and the subagent module profile
   * instead of the ordinary switches.
   */
  task?: { mode: 'explore' | 'work'; description: string; reportMaxChars: number; parentName: string };
}

/**
 * The tools a `task` subagent never holds. Delegation (`task`, `ask_agent`, `annuaire`, `ask_parent`)
 * because a child is one level deep by construction; `ask_user` because several children asking the
 * operator at once is a queue of modals nobody ordered, and a child is told to assume and report;
 * `todowrite` because the checklist is keyed on the agent + session and would overwrite the parent's;
 * `loop_done` because only the loop's own turns may end the loop.
 */
const TASK_WITHHELD_TOOLS = new Set([
  task.name,
  askAgent.name,
  annuaire.name,
  askParent.name,
  askUser.name,
  todoWrite.name,
  loopDone.name,
]);

/**
 * One parent run's subagent machinery, resolved once per run that holds `task`: where the children
 * run, and the limiter that decides how many run at once.
 */
interface SubagentRuntime {
  /** What a child passes as its `RunInput.inference`, or null to run on the agent's own model. */
  override: { endpointId?: string | null; model?: string } | null;
  model: string;
  differentModel: boolean;
  /** How many children may be running at once. */
  slots: number;
  limiter: Semaphore;
  /** Most characters one report may be before the per-batch context budget narrows it further. */
  reportMaxChars: number;
}

/**
 * The outcome of one run: the agent's final text answer, plus any images it acquired during the turn
 * (read from disk, produced by a skill, or handed back by its own sub-agents). A delegated run hands
 * those images back to its caller so pictures flow *both* ways across an `ask_agent` hop — the caller
 * forwards images down, and the sub-agent can return images up. Top-level callers use `.text` only.
 */
export interface RunResult {
  text: string;
  /**
   * Everything the agent actually said this turn: the prose it emitted *alongside* its tool calls,
   * followed by the final answer. `text` alone is only the last, tool-free message — an agent that
   * writes its answer and then fires one last bookkeeping call (`todowrite`, `remember`) ends the
   * turn on a throwaway line like "digest delivered above", and that is all a caller would receive.
   * Cross-agent hops return this instead (see `hop`); a depth-0 run keeps `text`, since the UI has
   * already streamed the interim prose as its own blocks and would otherwise render it twice.
   */
  fullText: string;
  images: ImageBlock[];
  /** The id grouping this turn's llama calls — surfaced so the caller can persist it + correlate runs. */
  turnId: string;
  /** This agent-run's id (the scored unit) — the depth-0 run id links the top-level turn's score. */
  runId: string;
  /** The run exhausted its tool rounds before the model gave a final answer. */
  truncated: boolean;
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

    // Two ids for the Conversation Quality Scorer:
    //  • `turnId` groups the whole user turn — minted by the depth-0 entry, propagated to every hop.
    //  • `runId` identifies THIS agent-run — the scored unit. Minted fresh per run (depth 0 and each
    //    sub-agent hop, via `input.runId` set by `hop`), so a delegated sub-agent is scored on its own
    //    conversation instead of being folded into the parent's score.
    const turnId = input.turnId ?? randomUUID();
    const runId = input.runId ?? randomUUID();

    const ctx: EventContext = {
      sessionId: input.sessionId,
      agentId: String(agent._id),
      agentName: agent.name,
      depth: input.depth,
      // Every event this run emits names it, so parallel subagents land in their own bubbles.
      runId,
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
    // A `task` child is seeded too: it is the same agent working in the same session, and its brief
    // may name a handle (`blob_3`) the parent was holding.
    const priorResources =
      (input.depth === 0 && !input.caller) || input.task
        ? await this.priorResourceBlocks(input.sessionId)
        : [];
    // The turn's live resource pool: seeded with prior handles (so counters continue the session
    // sequence and old handles resolve), then this turn's attachments/forwards, then grown by any
    // resource a tool/skill acquires. Shared by reference across every tool call so a resource acquired
    // in one call is reachable — by handle — in a later one (analyze_image / ask_agent / write).
    const imagePool = new TurnImagePool(priorResources, 'tool');
    // Keep the stamped copies: these carry the `img_N` handles the pool just assigned, which is what
    // the tools take. Handle numbering continues the session's sequence, so this turn's attachment is
    // rarely `img_1` — the note below has to name it rather than let the model guess.
    const pooledImages = imagePool.addMany(attachedImages, 'attachment');

    // Resolve the inference target before picking tools: whether the agent's own model is multimodal
    // decides both what enters its context (raw pixels vs. a note) and whether it is granted
    // `analyze_image` at all. (Failover chain resolved alongside.)
    // Inference modes (`MODES_PLAN.md`): the operator's per-conversation picks, read from the session
    // rather than passed in, so an auto-loop tick and a `continue` nudge run in the same modes the
    // chips show. Depth 0 only — a *picked* mode is the operator's choice for this chat, not an
    // instruction inherited by every agent the turn delegates to. A standing (`default_on`) mode is
    // exactly the opposite claim and needs nothing here: the resolver folds it into every call,
    // subagent hops included.
    const picked =
      input.depth === 0
        ? await sessionRepository.modeSelection(input.sessionId)
        : { on: [], off: [] };
    const inference = await resolveInference(agent, picked.on, picked.off, input.inference);
    const fallbacks = await resolveFallbacks(inference.url);

    // Resolve the agent's isolation profile (if any) up front: its image's `visual` flag decides
    // whether we auto-grant the visual-desktop tools below, and the profile drives container boot.
    const iso = agent.isolation_id ? await isolationRepository.findById(agent.isolation_id) : null;
    const image = iso?.image_id ? await imageRepository.findById(iso.image_id) : null;
    // A visual image auto-grants the visual-desktop control tools (like the delegation tools below),
    // so the operator needn't list them in `tools_allowed`. The global kill-switch still applies.
    const visualTools = image?.visual ? [...VISUAL_TOOL_NAMES] : [];
    // Being linked to a device in the registry is what makes an agent an "Android agent", so the
    // trigger here is the link rather than the image: one Android image backs any number of agents
    // pointed at different phones, which is exactly the case the `visual` flag can't express.
    const androidTools = agent.android_device_id ? [...ANDROID_TOOL_NAMES] : [];
    // `analyze_image` exists so a *text-only* agent can still read an image: it routes the pixels
    // through the separate Vision endpoint and hands back a description. An agent whose own model is
    // multimodal has no use for it — every image in its scope is fed to it as raw pixels (this turn's
    // attachments and carried-over session images below; tool-acquired ones as they land) — so the
    // tool is withheld rather than tempting the model into a pointless round-trip through a second,
    // weaker model. Text-only agents keep it whenever an image is in scope now (attached / carried
    // over) or could be `read` into the pool mid-run; handles let them then name it by id, never path.
    // The same argument governs the GUI-control tools. In **modal** screen control the agent reads
    // its own screen, so `visual_click` — whose entire job is to keep a *blind* agent out of
    // coordinate-handling by asking the Vision endpoint where a described element is — would route
    // the click through a weaker model's guess than the one the agent just made itself. It is
    // withheld there, exactly as `analyze_image` is. Read per turn, so flipping the setting binds on
    // the next turn without a restart. See `VISUAL_MODAL_PLAN.md`.
    const screenMode = await resolveScreenControlMode({ supportsVision: inference.supportsVision });
    const canReadImages = agent.tools_allowed.includes(read.name);
    const imageTools =
      !inference.supportsVision && (attachedImages.length || canReadImages)
        ? [analyzeImage.name]
        : [];

    // Top-level agents orchestrate, so they always get the delegation tools even if the operator
    // didn't tick them in `tools_allowed` (a subagent honours its explicit list as before). The
    // global kill-switch in resolveTools still wins if either tool is disabled fleet-wide.
    // A `task` child is never an orchestrator, whatever its agent is: it was handed one job.
    const isTask = !!input.task;
    const orchestrationTools = agent.subagent || isTask
      ? [...agent.tools_allowed, ...visualTools, ...androidTools, ...imageTools]
      : [
          ...agent.tools_allowed,
          annuaire.name,
          askAgent.name,
          ...visualTools,
          ...androidTools,
          ...imageTools,
        ];
    // An agent that can write memory must be able to retire one: without `forget`, a memory that
    // turns out to be wrong is recalled forever alongside its own correction, and the model is handed
    // the contradiction with no way to resolve it. Granted with `remember`, never on its own.
    const memoryTools = agent.tools_allowed.includes(remember.name) ? [forget.name] : [];
    // Subagents (`SUBAGENT_PLAN.md`): every run that may still spawn one holds `task` — the module
    // switch and the Tools page gate it in `resolveTools`, like `data` and `guide`. Not a child (one
    // level deep by construction), and not a run with no hop depth left to give it.
    const taskTools = !isTask && (await hopGuard.canHop(input.depth + 1)) ? [task.name] : [];
    // Every agent can reach the operator via `ask_user`; only a delegated run (has a caller) gets
    // `ask_parent` to bounce a question back up. Every agent also gets `data` so it can see, save,
    // and store the session's shared resource pool — that's how a delegate reaches a blob/image its
    // caller handed it by handle. The global kill-switch in resolveTools still wins.
    const effectiveTools = [
      ...new Set([
        ...orchestrationTools,
        ...memoryTools,
        askUser.name,
        data.name,
        guide.name,
        todoWrite.name,
        ...taskTools,
        ...(input.autoLoop ? [loopDone.name] : []),
        ...(input.caller ? [askParent.name] : []),
      ]),
    ].filter(
      (name) => !(isTask && TASK_WITHHELD_TOOLS.has(name)),
    ).filter(
      // A multimodal agent never gets `analyze_image` — not even if the operator ticked it in
      // `tools_allowed`. It sees the pixels itself; the tool would only route them through the
      // Vision endpoint's model and hand back a worse, second-hand description.
      (name) =>
        !(inference.supportsVision && name === analyzeImage.name) &&
        !(screenMode === 'modal' && name === visualClick.name),
    );
    // A child applies the subagent module profile on top of the ordinary switches — to its tools here
    // and to its prompt blocks below — so a module left out of the profile costs a child nothing.
    const scope: ModuleScope = isTask ? 'subagent' : 'turn';
    const resolved = await resolveTools(effectiveTools, scope);
    // An `explore` child keeps only the tools that can read; each call is checked again before it runs.
    const tools = input.task?.mode === 'explore' ? resolved.filter(mayRead) : resolved;
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const toolSchemas: ToolSchema[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // Which modules are live (`MODULES_PLAN.md` §7). Read per turn, from the same settings document
    // the rest of this block already needs, so a switch on Settings → Modules binds every agent on
    // its next turn without a restart. Everything below is gated on it *before* the query runs: a
    // module that is off costs no embedding, no Qdrant round-trip and no forum find, which is the
    // saving that matters — the tokens are the smaller half.
    const settings = await settingsService.get();
    const mods = moduleStateFrom(settings as unknown as Record<string, unknown>);

    // Auto-RAG: pull the most relevant memories for this query and inject them as a block ahead of
    // the conversation. Recall applies a similarity floor and a composite rerank (see
    // agent-memory.service), so an irrelevant turn legitimately retrieves *nothing* — the block is
    // absent rather than padded with noise. Best-effort: an embeddings outage yields none.
    // One embedding, two searches: memory and the forum index are both queried with this vector, so
    // it is computed when *either* module is on and skipped entirely when neither is.
    const wantsMemory = mods.enabled('memory', scope);
    const hasForum = mods.enabled('forum', scope) && tools.some((t) => t.name === forum.name);
    // The board half is gated separately from the forum half: an agent may hold one without the
    // other, and a task line telling it to `submit` with a tool it does not have is worse than no
    // line. `FORUM_WORKBOARD_PLAN.md` §8.
    const hasBoard = mods.enabled('board', scope) && tools.some((t) => t.name === board.name);

    const recallQuery = buildRecallQuery(input);
    const recallVector = wantsMemory || hasForum ? await embedRecallQuery(recallQuery) : null;
    const recalled = wantsMemory
      ? await agentMemory.recall(agent.qdrant_namespace, recallQuery, undefined, recallVector ?? undefined)
      : [];

    // Passive forum awareness (FORUM_PLAN.md §8), for agents that actually hold the `forum` tool —
    // never point an agent at a thread it has no way to open. Pointers only (thread id + title): the
    // agent still has to call `forum` to read one, which is what keeps the board from flooding the
    // context.
    //
    // An auto-loop turn is the exception to the opt-in: it forces the reply pointers on and adds a
    // time-scoped digest of everything new since its last turn. A looping agent has no operator to
    // tick a box for it, and the whole reason it can follow a *shared* goal is that it notices what
    // the other agents posted while it was working.
    //
    // Mentions and unanswered replies ride *every* turn, and neither is behind the composer toggle.
    // Both are a question with a sender waiting on it — somebody named this agent, or answered a
    // thread it is in — unlike a related thread, which is only ever a suggestion. Together they cost
    // one indexed find plus one distinct (§11.2). Assignments ride every turn for a different reason
    // than either: a mention stops being pending the moment it is answered, but a work item this
    // agent owns is still its problem until it is marked done.
    const boardWork = hasBoard && ctx.agentId ? await forumRecall.work(ctx.agentId) : { tasks: [], reviews: [] };
    const [forumRelated, forumReplyPointers, forumDigest, forumMentions, forumAssigned, forumRoster] =
      hasForum
        ? await Promise.all([
            forumRecall.pointers(recallVector),
            forumRecall.unansweredReplies(ctx.agentId, agent.name),
            input.autoLoop
              ? forumRecall.digest(input.autoLoop.forumSeenAt, agent.name)
              : Promise.resolve([]),
            forumRecall.mentions(ctx.agentId),
            forumRecall.assigned(ctx.agentId),
            forumRecall.roster(agent.name),
          ])
        : [[], [], [], [], [], []];

    // Surface what memory actually put in the prompt, so the operator can see (and distrust) the
    // recall instead of guessing. Only fires when something was injected — the badge's presence in
    // the chat is itself the signal that this turn was shaped by memory.
    if (recalled.length) {
      eventBus.emit('agent:memory_recall', {
        ctx,
        runId,
        memories: recalled.map((m) => ({
          text: m.payload.text,
          score: m.score,
          similarity: m.similarity,
          kind: m.payload.kind,
          subject: m.payload.subject || undefined,
          importance: m.payload.importance,
          source: m.payload.source,
          createdAt: m.payload.created_at,
        })),
      });
    }

    // The agent's own checklist rides into the prompt too. Read per turn (not cached with the agent
    // doc) because `todowrite` mutates it mid-turn — and because an item left `in_progress` when the
    // last turn ended is exactly what that block exists to put back in front of the model.
    const todos = mods.enabled('todo', scope) ? await todoRepository.get(ctx.sessionId, ctx.agentId) : [];

    // Where this run's `task` children would run and how many at once — resolved only for a run that
    // actually holds the tool, since it costs an endpoint lookup.
    const subagents = toolMap.has(task.name)
      ? await this.subagentRuntime(agent, settings, inference)
      : null;

    /**
     * Everything the enabled modules render from. Modules render, they never fetch — which is why
     * every query above could be skipped by its own switch before we got here.
     */
    const promptCtx: PromptContext = {
      agent,
      // Fleet-wide AGENTS.md house rules, ahead of the agent's own charter.
      houseRules: settings.agents_md,
      todos,
      autoLoop: input.autoLoop ?? null,
      memories: recalled,
      forum: hasForum
        ? {
            related: forumRelated,
            replies: forumReplyPointers,
            digest: forumDigest,
            mentions: forumMentions,
            assigned: forumAssigned,
            roster: forumRoster,
            // Which of the two mention paragraphs the block writes: telling an agent it can wake
            // somebody while the fleet switch is off promises an answer that never arrives.
            autoReply: settings.forum_auto_reply === true,
          }
        : null,
      board: hasBoard ? boardWork : null,
      images: {
        supportsVision: inference.supportsVision,
        current: currentImages,
        session: sessionImages,
        pooled: pooledImages,
      },
      modes: { system: inference.promptSuffixes.system, user: inference.promptSuffixes.user },
      // What the batching block is allowed to promise: the same two settings the runner obeys below,
      // so the prompt never tells an agent its calls overlap on an instance where they don't.
      toolParallel: {
        enabled: settings.tool_parallel_enabled !== false,
        max: Math.max(0, Math.trunc(Number(settings.tool_parallel_max ?? 4))),
      },
      task: input.task ?? null,
      subagents: subagents
        ? ({
            slots: subagents.slots,
            parallel: settings.tool_parallel_enabled !== false,
            model: subagents.model,
            differentModel: subagents.differentModel,
          } satisfies SubagentsPromptState)
        : null,
    };

    const systemMessage = assembleSystemMessage(mods, promptCtx, scope);

    // The user turn: the operator's own words plus whatever the enabled modules append — the image
    // note that makes an attachment reachable, and any mode whose placement is `user_suffix` (the
    // only position llama.cpp chat templates honour a control token like `/no_think` in).
    // Raw images enter the model context only for a multimodal agent — a text-only endpoint would
    // choke on them (it reaches an image via `analyze_image` instead).
    const userTextWithNote = assembleUserText(
      mods,
      { ...promptCtx, modes: { system: promptCtx.modes.system, user: [] } },
      input.userText,
      scope,
    );
    const modedUserText = assembleUserText(mods, promptCtx, input.userText, scope);
    const userMessage = buildUserMessage(
      modedUserText,
      inference.supportsVision ? attachedImages : undefined,
    );

    // The clean conversational context to hand any sub-agent this run delegates to: everything up to
    // (and including) this turn's user message, but *not* the in-flight tool activity. Threaded down
    // so a sub-agent's `ask_parent` re-runs this agent with a well-formed, context-aware history.
    // Built without this turn's mode suffix: a control token aimed at *this* model would read as
    // gibberish quoted into another agent's conversation.
    const callerHistory: ChatMessage[] = [
      ...(input.history ?? []),
      inference.promptSuffixes.user.length
        ? buildUserMessage(userTextWithNote, inference.supportsVision ? attachedImages : undefined)
        : userMessage,
    ];

    const messages: ChatMessage[] = [systemMessage, ...(input.history ?? []), userMessage];

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
    // Prose the model emitted in the same message as a tool call. Kept so the turn's real content
    // survives to `fullText` (above) even when the closing message carries none of it.
    const interimTexts: string[] = [];
    // Latest usage across tool iterations; the final pass reflects the full session context size.
    let lastUsage: TokenUsage | null = null;

    // Per-agent tool-round ceiling (falls back to the global Settings default). The loop breaks
    // cleanly once the model stops calling tools; if instead it exhausts every round we mark the turn
    // `truncated` and signal the UI so a "continue" (manual or auto) can pick the run back up.
    const maxIterations =
      typeof agent.max_tool_iterations === 'number' && agent.max_tool_iterations > 0
        ? agent.max_tool_iterations
        : inference.maxToolIterations;
    let finishedCleanly = false;

    // Results of tool calls already run this turn, keyed by name+args. If the model re-issues an
    // *identical* call (a common failure mode that shows up as a sub-agent "repeating itself" — the
    // same `ask_agent` fired every iteration), we short-circuit with the earlier result instead of
    // re-running the tool. Combined with the tool-round cap this breaks the repeat loop.
    const toolResultCache = new Map<string, string>();

    // Live screen frames (desktop/device screenshots) currently holding pixels in `messages`, oldest
    // first. `executeToolCall` trims this to the capturing tool's `frameKeep` budget so a GUI turn
    // doesn't accumulate one full frame per tool iteration. See `ImageBlock.frameKeep`.
    const liveFrames: Array<{ msg: ChatMessage; handles: string }> = [];

    // Times we've nudged the model back onto the native tool channel this turn (see below).
    let narrationRetries = 0;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) throw new RunAbortedError();
      // Clear any draft tool call the previous pass streamed but never executed (the duplicate-call
      // short-circuit below is the usual cause) so it doesn't sit half-written in the UI forever.
      eventBus.emit('agent:tool_call_stream', { ctx, phase: 'reset' });
      const { text, toolCalls: nativeCalls, usage } = await this.streamTurn(
        messages,
        toolSchemas,
        ctx,
        turnId,
        runId,
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

      if (assistantText.trim()) interimTexts.push(assistantText.trim());

      // The model emitted these calls *together* because it judged them independent — that is what a
      // tool-call array means. Running them one after another therefore spends the sum of their
      // durations for nothing: two 120s `bash` probes cost four minutes. Group the consecutive
      // parallel-safe ones and overlap them (Settings → Fleet), leaving everything else exactly as
      // it was. Ordering is never at stake: results are appended in the model's emission order.
      const parallelEnabled = settings.tool_parallel_enabled !== false;
      const parallelMax = Math.max(0, Math.trunc(Number(settings.tool_parallel_max ?? 4)));
      const groups = planToolGroups(toolCalls, toolMap, parallelEnabled);
      // Every `task` call in this reply shares the parent's remaining context, so each report's share
      // shrinks with how many were asked for together.
      const taskCount = toolCalls.filter((c) => c.name === task.name).length;

      for (const group of groups) {
        // A group of one is a plain serial call, whatever its tool declares — no batch to report.
        const batchId = group.length > 1 ? randomUUID() : null;
        // Each call writes into its own buffer instead of straight into `messages`: concurrent calls
        // finish in whatever order they finish, and a tool result that landed before the assistant's
        // *earlier* tool_call message would be malformed chat. The buffers are spliced in below, in
        // emission order, so the transcript is byte-identical to the sequential one.
        const sinks: ChatMessage[][] = group.map(() => []);

        const runOne = async (call: (typeof group)[number], i: number): Promise<void> => {
          const sink = sinks[i]!;
          const cacheKey = `${call.name}${call.argsJson}`;
          // An observation tool is exempt: re-reading a screen after acting on it is the loop, not a
          // repeat (see `OBSERVATION_TOOL_NAMES`).
          const cached = OBSERVATION_TOOL_NAMES.has(call.name) ? undefined : toolResultCache.get(cacheKey);
          if (cached !== undefined) {
            log.warn(
              { agent: agent.name, tool: call.name },
              'duplicate tool call short-circuited (identical args already executed this turn)',
            );
            sink.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                ok: false,
                error:
                  'Duplicate call: this exact tool and arguments already ran this turn. Do not repeat it — use the previous result and continue.',
                previous_result: safeParse(cached),
              }),
            });
            return;
          }
          const toolMsg = await this.executeToolCall(call, toolMap, ctx, sink, resolveExec, {
            callerHistory,
            caller: input.caller,
            signal,
            turnId,
            pool: imagePool,
            supportsVision: inference.supportsVision,
            frames: liveFrames,
            persistMemory: input.persistMemory !== false,
            batch: batchId ? { id: batchId, index: i, size: group.length } : undefined,
            readOnly: input.task?.mode === 'explore',
            subagents: subagents
              ? {
                  runtime: subagents,
                  agentName: agent.name,
                  reportMaxChars: reportBudget(
                    subagents.reportMaxChars,
                    inference.contextWindow,
                    lastUsage?.promptTokens ?? 0,
                    taskCount,
                  ),
                }
              : undefined,
          });
          // executeToolCall already appended the tool message (and any following image message) to
          // the sink in the correct order; here we only cache its content for the duplicate short-circuit.
          if (typeof toolMsg.content === 'string') toolResultCache.set(cacheKey, toolMsg.content);
        };

        if (batchId) {
          log.info(
            { agent: agent.name, tools: group.map((c) => c.name), max: parallelMax || 'unlimited' },
            'running tool batch in parallel',
          );
          await runWithConcurrency(group, parallelMax, runOne);
        } else {
          await runOne(group[0]!, 0);
        }
        for (const sink of sinks) messages.push(...sink);
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

    // Distil the exchange into long-term memory: the agent's own model rewrites what just happened
    // into zero or more standalone souvenirs (see docs/memory-souvenirs.md), instead of the raw
    // `"User: …\nAgent: …"` transcript being embedded verbatim as one point — which produced a
    // vector that pointed nowhere and fed the agent's own past prose back to it as fact.
    // Fire and forget: a memory write must never delay or fail the response returned to the caller.
    if (finalText.trim() && input.persistMemory !== false) {
      memoryDistiller.distillTurn({
        agent,
        userText: input.userText,
        agentText: finalText,
        sessionId: input.sessionId,
        turnId,
      });
    }

    // Hand back the images this turn *acquired* (source `tool`: read from disk, produced by a skill,
    // or returned by its own sub-agents) — not the ones a caller forwarded in (those are already the
    // caller's). A delegated run's caller folds these into its own turn via `ask_agent`; a top-level
    // caller ignores them (the images already rendered in this agent's own turn).
    const handBack = imagePool.all().filter((i) => i.source === 'tool');

    // Conversation Quality Scorer: once the user-facing turn has fully settled, auto-score every
    // agent-run in it — the top-level agent AND each delegated sub-agent get their own score (gated on
    // `scoring_enabled`, fire-and-forget). Only the depth-0 run triggers the fan-out; sub-agent runs
    // completed earlier and their records are already in the archive. Deferred slightly so the
    // depth-0 run's own fire-and-forget capture writes land before the scorer reads them back.
    if (ctx.depth === 0) {
      const tid = turnId;
      setTimeout(() => scoringService.autoScoreTurn(tid), 1500);
    }

    const fullText = [...interimTexts, finalText.trim()].filter(Boolean).join('\n\n');

    return { text: finalText, fullText, images: handBack, turnId, runId, truncated: !finishedCleanly };
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
    turnId: string,
    runId: string,
    inference: ResolvedInference,
    fallbacks: ResolvedInference[],
    signal?: AbortSignal,
  ): ReturnType<typeof llamaClient.streamChat> {
    const parser = new ReasoningParser();
    const result = await runWithCaptureContext(
      { source: 'chat-turn', sessionId: ctx.sessionId, agentId: ctx.agentId, agentName: ctx.agentName, depth: ctx.depth, turnId, runId },
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
            // Server-split thinking (llama-server's default `--reasoning-format deepseek`): already
            // tagged as reasoning by the server, so it bypasses the `<think>`-tag parser entirely.
            onReasoning: (delta) => {
              eventBus.emit('agent:stream_chunk', { ctx, content: delta, isReasoning: true });
            },
            // The tool call as it is being written. The UI draws a draft block from these and settles
            // it on the matching `agent:tool_invoke` below, so a long argument payload streams
            // instead of holding the turn on a bare spinner.
            onToolCall: (frag) => {
              eventBus.emit('agent:tool_call_stream', {
                ctx,
                phase: 'delta',
                index: frag.index,
                callId: frag.id,
                tool: frag.name,
                argsDelta: frag.argsDelta,
              });
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
    /**
     * Where this call's messages are appended — its tool result, then any image note. A serial call
     * is handed the turn's `messages` directly; a call running as part of a parallel batch is handed
     * its own buffer, which the caller splices in at the right place once the whole batch settles.
     */
    messages: ChatMessage[],
    resolveExec: (() => Promise<AgentExecutor>) | null,
    delegation: {
      callerHistory: ChatMessage[];
      caller?: RunInput['caller'];
      signal?: AbortSignal;
      /** The turn's id, propagated into any sub-agent hop this tool call spawns. */
      turnId: string;
      /** The turn's live image pool, shared across every tool call (grown as tools acquire images). */
      pool: TurnImagePool;
      /** Whether the agent's model can see raw pixels — gates folding tool images into its context. */
      supportsVision: boolean;
      /**
       * The live screen frames currently holding pixels in `messages`, oldest first (with the handles
       * their stub should name), so a new capture can evict the ones beyond the tool's `frameKeep`
       * budget. Per-turn only: history is text-only, so a frame never survives into the next turn's
       * message array anyway.
       */
      frames: Array<{ msg: ChatMessage; handles: string }>;
      /** Carried into any sub-agent hop, so a synthetic turn doesn't write memories anywhere. */
      persistMemory: boolean;
      /** Set when this call is one of several running concurrently; echoed to the UI on both events. */
      batch?: ToolBatchInfo;
      /** An `explore` subagent: a call that is not a read is refused instead of executed. */
      readOnly?: boolean;
      /** This run may start `task` subagents: where they run, and this call's report budget. */
      subagents?: { runtime: SubagentRuntime; agentName: string; reportMaxChars: number };
    },
  ): Promise<ChatMessage> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.argsJson) as Record<string, unknown>;
    } catch {
      log.warn({ tool: call.name, argsJson: call.argsJson }, 'unparseable tool args');
    }

    eventBus.emit('agent:tool_invoke', {
      ctx,
      callId: call.id,
      tool: call.name,
      args,
      batch: delegation.batch,
    });

    const startedAt = Date.now();

    // Take this call's place in the subagent queue *now*, before the first await below: calls of one
    // batch reach this line in the order the model issued them, and nothing after it is ordered. A
    // `task` that waits for a slot then starts in emission order instead of whichever call's setup
    // happened to resolve first. Released when the call ends, whether or not a child ever ran.
    const taskSlot =
      delegation.subagents && call.name === task.name ? delegation.subagents.runtime.limiter.acquire(delegation.signal) : null;
    try {
      return await this.runToolCall(call, toolMap, args, startedAt, ctx, messages, resolveExec, delegation, taskSlot);
    } finally {
      taskSlot?.then((release) => release()).catch(() => undefined);
    }
  }

  /** The body of {@link executeToolCall}, once the call holds its place in any subagent queue. */
  private async runToolCall(
    call: { id: string; name: string; argsJson: string },
    toolMap: Map<string, Tool>,
    args: Record<string, unknown>,
    startedAt: number,
    ctx: EventContext,
    messages: ChatMessage[],
    resolveExec: (() => Promise<AgentExecutor>) | null,
    delegation: Parameters<AgentRunner['executeToolCall']>[5],
    taskSlot: Promise<() => void> | null,
  ): Promise<ChatMessage> {
    const tool = toolMap.get(call.name);
    if (!tool) {
      const result = { ok: false, error: `unknown tool: ${call.name}` };
      eventBus.emit('tool:execution_complete', {
        ctx,
        callId: call.id,
        tool: call.name,
        status: 'error',
        result,
        durationMs: 0,
        startedAt,
        batch: delegation.batch,
      });
      // Appended like every other result: an assistant tool_call with no answer is malformed chat, and
      // a model that never sees the error simply issues the same call again.
      const unknown: ChatMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
      messages.push(unknown);
      return unknown;
    }

    // An `explore` subagent was promised read-only tools. Its toolset is already narrowed to tools that
    // *can* read, but verb-style tools read or write by argument — so the call itself is checked here,
    // before any container boots or any side effect can happen.
    if (delegation.readOnly && !isParallelSafe(tool, args)) {
      const result = {
        ok: false,
        error:
          `read-only task: \`${call.name}\` with these arguments would change something, and this ` +
          'subagent is an explore task. Report what should be changed instead of changing it.',
      };
      eventBus.emit('tool:execution_complete', {
        ctx,
        callId: call.id,
        tool: call.name,
        status: 'error',
        result,
        durationMs: 0,
        startedAt,
        batch: delegation.batch,
      });
      const refused: ChatMessage = { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
      messages.push(refused);
      return refused;
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
    const canSpawn = await hopGuard.canHop(ctx.depth + 1);
    const toolCtx: ToolContext = {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      depth: ctx.depth,
      invokeSubAgent: canSpawn
        ? this.makeInvoker(ctx, delegation.callerHistory, delegation.turnId, delegation.signal, delegation.persistMemory)
        : undefined,
      askParent:
        canSpawn && delegation.caller
          ? this.makeParentAsker(
              ctx,
              delegation.caller,
              delegation.turnId,
              delegation.signal,
              delegation.persistMemory,
            )
          : undefined,
      askUser: (question) => askUserBroker.ask(ctx, question),
      invokeTask:
        canSpawn && delegation.subagents
          ? this.makeTaskInvoker(ctx, delegation.subagents, call.id, delegation.turnId, delegation.signal, taskSlot)
          : undefined,
      callId: call.id,
      emitOutput: (chunk) =>
        eventBus.emit('tool:output_chunk', { ctx, callId: call.id, chunk }),
      emitVision: (payload) =>
        eventBus.emit('tool:vision', { ctx, callId: call.id, ...payload }),
      emitVisualAct: (payload) =>
        eventBus.emit('tool:visual_act', { ctx, callId: call.id, ...payload }),
      emitMediaGen: (payload) =>
        eventBus.emit('agent:media_generated', { ctx, callId: call.id, ...payload }),
      emitProgress: (payload) =>
        eventBus.emit('tool:progress', { ctx, callId: call.id, ...payload }),
      emitTodo: (items) => eventBus.emit('agent:todo_update', { ctx, callId: call.id, items }),
      // Long-running tools (a ComfyUI video is ~10 minutes) honour the same abort the turn does, so
      // stopping a turn also stops the GPU work nobody is waiting on any more.
      signal: delegation.signal,
      attachedImages: delegation.pool.all(),
      // Lets a tool that would otherwise route pixels through the Vision endpoint hand the frame to
      // the agent instead (`visual_screenshot` / `android_screenshot` in describe mode).
      supportsVision: delegation.supportsVision,
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
      startedAt,
      batch: delegation.batch,
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
          delegation.supportsVision
            ? // The pixels ride along in this very message, and a multimodal agent holds no
              // `analyze_image` to be pointed at anyway.
              `${pics.length} image${pics.length > 1 ? 's' : ''} loaded as ${ids} and shown here — ` +
                `read ${pics.length > 1 ? 'them' : 'it'} yourself, or forward with \`ask_agent\` (image_ids).`
            : `${pics.length} image${pics.length > 1 ? 's' : ''} loaded as ${ids} — analyse with ` +
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
      const framed = buildUserMessage(note, delegation.supportsVision ? pics : undefined);
      messages.push(framed);
      // A GUI turn captures a frame per tool iteration, so without a cap the agent's context fills
      // with near-identical screens. A live screen frame carries `frameKeep`: keep the most recent
      // that many, and strip the pixels out of the older ones (their text note stays, so the agent
      // still knows the handle and that it looked). Only frames are evicted — an image a tool
      // *produced* (a generated picture, a file read) is content, not a transient observation.
      const keep = pics.find((p) => p.frameKeep != null)?.frameKeep ?? 0;
      if (delegation.supportsVision && keep > 0) {
        delegation.frames.push({
          msg: framed,
          handles: pics.map((i) => i.id).filter(Boolean).join(', '),
        });
        while (delegation.frames.length > keep) {
          const stale = delegation.frames.shift()!;
          evictFrame(stale.msg, stale.handles);
        }
      }
    }
    return toolMsg;
  }

  /**
   * Build the guarded cross-agent dispatcher passed to `ask_agent`. `callerHistory` is the calling
   * agent's clean conversation, threaded onto the child as `caller` so the child can `ask_parent`.
   */
  private makeInvoker(
    parentCtx: EventContext,
    callerHistory: ChatMessage[],
    turnId: string,
    signal: AbortSignal | undefined,
    persistMemory: boolean,
  ) {
    return (targetAgentName: string, query: string, images?: ImageBlock[]): Promise<RunResult> =>
      this.hop(parentCtx, targetAgentName, query, {
        userText: query,
        images,
        caller: { agentName: parentCtx.agentName, task: query, history: callerHistory },
        signal,
        turnId,
        persistMemory,
      });
  }

  /**
   * Resolve where this run's `task` children run and how many may run at once (`SUBAGENT_PLAN.md` §2).
   *
   * The model is the agent's own subagent override if it set one, else the fleet default, else
   * nothing — the child then runs on the agent's own model. Concurrency is that endpoint's Parallel
   * streams, because that is how many turns the box can actually stream; the fleet's
   * `tool_parallel_*` settings can only narrow it. One slot means strictly one child after another.
   */
  private async subagentRuntime(
    agent: AgentDoc,
    settings: EffectiveSettings,
    parent: ResolvedInference,
  ): Promise<SubagentRuntime> {
    const own = agent.subagent_endpoint_id || agent.subagent_model;
    const endpointId = own ? agent.subagent_endpoint_id : settings.subagent_endpoint_id;
    const model = own ? agent.subagent_model : settings.subagent_model;
    const override =
      endpointId || model
        ? { endpointId: endpointId ? String(endpointId) : null, model: model || undefined }
        : null;
    const child = override ? await resolveInference(agent, [], [], override) : parent;

    const parallel = settings.tool_parallel_enabled !== false;
    const fleetMax = Math.max(0, Math.trunc(Number(settings.tool_parallel_max ?? 4)));
    const slots = parallel ? Math.max(1, Math.min(child.parallelSlots, fleetMax > 0 ? fleetMax : Infinity)) : 1;

    return {
      override,
      model: child.model,
      differentModel: child.model !== parent.model || child.url !== parent.url,
      slots,
      limiter: new Semaphore(slots),
      reportMaxChars: Math.max(500, Math.trunc(Number(settings.subagent_report_max_chars ?? 6000))),
    };
  }

  /**
   * Build the `task` dispatcher for one tool call: run a fresh-context copy of the calling agent on
   * the brief, and hand back its report cut to fit.
   *
   * The limiter is held for the child's *whole* run, not per inference call. The endpoint gate would
   * already stop two streams sharing a slot, but a child spends most of its wall clock between
   * streams, in tools — per-call metering would interleave the children round by round, where one
   * slot is meant to mean one child after another.
   */
  private makeTaskInvoker(
    parentCtx: EventContext,
    subagents: { runtime: SubagentRuntime; agentName: string; reportMaxChars: number },
    callId: string,
    turnId: string,
    signal: AbortSignal | undefined,
    /** The place this call already took in the queue; absent only if the caller reserved none. */
    slot: Promise<() => void> | null,
  ): NonNullable<ToolContext['invokeTask']> {
    const { runtime, agentName, reportMaxChars } = subagents;
    return async ({ description, prompt, mode }) => {
      // Release is idempotent, so letting the child go here and again when the call ends is safe —
      // and letting it go here frees the slot before the parent's tool bookkeeping finishes.
      const release = await (slot ?? runtime.limiter.acquire(signal));
      try {
        if (signal?.aborted) throw new RunAbortedError();
        const info: SubagentTaskInfo = { description, mode, model: runtime.model };
        const answer = await this.hop(
          parentCtx,
          agentName,
          description,
          { userText: prompt, signal, turnId, persistMemory: false },
          {
            inference: runtime.override,
            task: { mode, description, reportMaxChars, parentName: agentName },
            callId,
            info,
          },
        );
        const full = answer.text.trim();
        const truncated = full.length > reportMaxChars;
        const report = truncated
          ? `${full.slice(0, reportMaxChars).trimEnd()}\n\n[…report truncated at ${reportMaxChars} characters]`
          : full || '(the subagent returned no report)';
        return { model: runtime.model, report, truncated, cut_off: answer.truncated };
      } finally {
        release();
      }
    };
  }

  /**
   * Build the `ask_parent` dispatcher for a delegated run: re-runs the caller as a fresh turn seeded
   * with its original conversation and a framed question, so it answers with full context. The caller
   * gets no `caller` of its own here → it can't ask *its* parent while answering (no infinite ladder).
   */
  private makeParentAsker(
    childCtx: EventContext,
    caller: NonNullable<RunInput['caller']>,
    turnId: string,
    signal: AbortSignal | undefined,
    persistMemory: boolean,
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
        turnId,
        persistMemory,
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
    run: Pick<
      RunInput,
      'userText' | 'history' | 'caller' | 'signal' | 'images' | 'turnId' | 'persistMemory'
    >,
    /**
     * Only for a `task` subagent. Kept out of `run`'s allowlist on purpose: an `ask_agent` hop must
     * never carry an inference override or a task framing into the specialist it asks.
     */
    subagent?: {
      inference: RunInput['inference'];
      task: NonNullable<RunInput['task']>;
      callId: string;
      info: SubagentTaskInfo;
    },
  ): Promise<RunResult> {
    const childDepth = fromCtx.depth + 1;
    if (!(await hopGuard.canHop(childDepth))) {
      throw new Error(`max agent hop depth (${await hopGuard.max()}) exceeded`);
    }
    log.info(
      { from: fromCtx.agentName, to: targetAgentName, depth: childDepth },
      'ask_agent hop',
    );
    // Mint the sub-agent's run id here so it can ride the ask_agent event (the UI tags the bubble
    // with it) AND be handed to the child run below — both must agree so the bubble's live score lands.
    const childRunId = randomUUID();
    eventBus.emit('agent:ask_agent', {
      ctx: fromCtx,
      from: fromCtx.agentName,
      to: targetAgentName,
      depth: childDepth,
      query,
      childRunId,
      ...(subagent ? { callId: subagent.callId, task: subagent.info } : {}),
    });
    try {
      const answer = await this.run({
        agentName: targetAgentName,
        sessionId: fromCtx.sessionId,
        depth: childDepth,
        runId: childRunId,
        ...run,
        ...(subagent ? { inference: subagent.inference, task: subagent.task } : {}),
      });
      eventBus.emit('agent:ask_agent_done', {
        ctx: fromCtx,
        from: fromCtx.agentName,
        to: targetAgentName,
        depth: childDepth,
        status: 'success',
        childRunId,
      });
      // A hop hands back everything the delegate said, not just its closing message: an agent that
      // writes its answer alongside a final `todowrite`/`remember` would otherwise return only the
      // leftover "done, see above" line, and the caller — having never seen the answer — redoes the
      // work. The UI is unaffected: it renders the sub-agent's prose from the streamed blocks.
      return { ...answer, text: answer.fullText || answer.text };
    } catch (err) {
      eventBus.emit('agent:ask_agent_done', {
        ctx: fromCtx,
        from: fromCtx.agentName,
        to: targetAgentName,
        depth: childDepth,
        status: 'error',
        childRunId,
      });
      throw err;
    }
  }
}

/** Below this, a message is too short to embed to anything meaningful on its own. */
const ANAPHORIC_QUERY_CHARS = 30;

/**
 * The text we embed to search memory. The raw user message alone is a poor query for a follow-up:
 * "and the second one?" carries no topic, embeds to mush, and retrieves noise. When the message is
 * short enough to be anaphoric, prepend the previous user message so the query keeps the subject
 * the operator is still talking about.
 */
function buildRecallQuery(input: { userText: string; history?: ChatMessage[] }): string {
  const text = input.userText.trim();
  if (text.length >= ANAPHORIC_QUERY_CHARS || !input.history?.length) return text;

  const priorUser = [...input.history]
    .reverse()
    .find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!priorUser || typeof priorUser.content !== 'string') return text;
  return `${priorUser.content.trim()}\n${text}`;
}

/** Best-effort parse of a cached tool result string; falls back to the raw string. */
/** One tool call as the streaming parser assembled it. */
type PlannedCall = { id: string; name: string; argsJson: string };

/**
 * Cut one batch of tool calls into the runs that may execute together.
 *
 * Consecutive calls whose tool declares itself parallel-safe form one group; everything else is a
 * group of one. Two rules keep this conservative:
 *
 * - **Order across groups is preserved.** A write between two reads splits them, so the reads never
 *   jump over it — the model asked for `read, write, read` and gets exactly that sequence.
 * - **A repeat closes the group.** The duplicate short-circuit answers the second identical call
 *   from a cache the first one fills, which only works if the first has already finished.
 */
function planToolGroups(
  calls: PlannedCall[],
  toolMap: Map<string, Tool>,
  enabled: boolean,
): PlannedCall[][] {
  const groups: PlannedCall[][] = [];
  let groupIsParallel = false;
  const keysInGroup = new Set<string>();

  for (const call of calls) {
    const key = `${call.name}${call.argsJson}`;
    const safe = enabled && isParallelSafe(toolMap.get(call.name), safeParseArgs(call.argsJson));
    const current = groups[groups.length - 1];
    if (safe && groupIsParallel && current && !keysInGroup.has(key)) {
      current.push(call);
      keysInGroup.add(key);
      continue;
    }
    groups.push([call]);
    groupIsParallel = safe;
    keysInGroup.clear();
    keysInGroup.add(key);
  }
  return groups;
}

/** Run `task` over every item, at most `limit` in flight (`0` = all at once). Order is preserved by
 * the caller writing each result into its own slot, never by completion order. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const width = limit > 0 ? Math.min(limit, items.length) : items.length;
  let next = 0;
  const workers = Array.from({ length: width }, async () => {
    for (let i = next++; i < items.length; i = next++) await task(items[i]!, i);
  });
  await Promise.all(workers);
}

/**
 * The report budget for one `task` call, in characters (`SUBAGENT_PLAN.md` §2).
 *
 * Half of what the parent's context has left, shared across every task in the same reply, at a
 * conservative 3.5 characters per token — so N reports landing together can't overflow a parent
 * with a small window. Never above the fleet ceiling, and never below a floor that still fits a
 * useful finding: a report cut to nothing is worse than a slightly tight context.
 */
function reportBudget(ceiling: number, contextWindow: number, usedTokens: number, tasks: number): number {
  const FLOOR = 1500;
  if (!contextWindow || contextWindow <= 0) return ceiling;
  const freeTokens = Math.max(0, contextWindow - usedTokens);
  const share = Math.floor(((freeTokens * 0.5) / Math.max(1, tasks)) * 3.5);
  return Math.max(Math.min(FLOOR, ceiling), Math.min(ceiling, share));
}

/**
 * A counting semaphore: at most `permits` holders at once, the rest wait in arrival order. Used to
 * cap a parent's concurrent subagents at its endpoint's slots. A waiter whose run is stopped leaves
 * the queue instead of starting a child nobody wants.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly permits: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.permits) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const at = this.waiters.indexOf(wake);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new RunAbortedError());
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand the permit straight to the next waiter, so `active` never dips and lets a newcomer cut in.
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** A call's arguments as an object, for the parallel-safety predicate. Unparseable args → `{}`. */
function safeParseArgs(argsJson: string): Record<string, unknown> {
  const parsed = safeParse(argsJson);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export const agentRunner = new AgentRunner();
