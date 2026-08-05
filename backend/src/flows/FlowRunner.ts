import { createLogger } from '../config/logger';
import { eventBus } from '../core/event-bus/EventBus';
import type { EventContext } from '../core/event-bus/events.types';
import { resourceRepository } from '../domain/resources/resource.repository';
import { flowRunRepository } from '../domain/flows/flow-run.repository';
import type { FlowNodeState, FlowTrigger } from '../domain/flows/flow-run.model';
import type { FlowDoc, FlowEdge, FlowNode, FlowValue } from '../domain/flows/flow.model';
import { flowApprovalBroker } from './FlowApprovalBroker';
import { RunLogBuffer } from './RunLogBuffer';
import { clearFlowDepth, setFlowDepth } from './flow-depth';
import { getHandler, inputPorts, outputPorts, NON_EXECUTING_TYPES } from './nodes';
import { asHandles, asList, asText, coerce, jsonValue, textValue, type PortType } from './port-types';
import { primary, renderConfig, type NodeOutputs, type TemplateScope } from './template';
import { isRunnable, loopBody, validateFlow } from './validate';
import type { FlowNodeContext } from './types';

const log = createLogger('flow-runner');

/** How much of a node's text output is kept in the run document (spec §6 — it's a trace, not a store). */
const MAX_PERSISTED_TEXT = 4000;

/** How many independent branches may execute at once. */
const BRANCH_CONCURRENCY = 4;

/** Ceiling on nested `run_flow` invocations, mirroring `HopGuard`'s cap on agent hops. */
export const MAX_FLOW_DEPTH = 3;

export class FlowAbortedError extends Error {
  constructor() {
    super('the run was stopped');
    this.name = 'FlowAbortedError';
  }
}

export interface StartRunInput {
  flow: FlowDoc;
  trigger: FlowTrigger;
  /** Values for the flow's `input` nodes, keyed by each node's `key` (or its id). */
  inputs?: Record<string, unknown>;
  /** Nested-flow depth; the `run_flow` tool passes its caller's depth + 1. */
  depth?: number;
  /**
   * Fired the instant the run document exists, before any node executes.
   *
   * The HTTP route answers with the run id without waiting for the run — a flow with a video node
   * takes minutes. Looking the id up afterwards is a race the caller loses whenever run creation is
   * slower than the route's grace period, and it answers with no id at all. This hands the id over at
   * the only moment it is knowable and unambiguous.
   */
  onRunCreated?: (runId: string) => void;
}

export interface RunOutcome {
  runId: string;
  status: 'success' | 'error' | 'aborted';
  /** Text rendering of the `output` node's value. */
  output: string;
  /** Resource handles the output carries. */
  handles: string[];
  error?: string;
}

/** Per-node bookkeeping the scheduler needs but the run document doesn't. */
interface NodeRuntime {
  outputs: NodeOutputs;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
}

/**
 * Executes a flow graph (flows spec §4).
 *
 * The deterministic counterpart to `AgentRunner`: where that one lets a model choose what happens
 * next, this walks a graph the operator drew. Both emit their whole trace on the EventBus, so the
 * debugger drawer and the flow canvas are looking at the same kind of stream.
 */
export class FlowRunner {
  /** In-flight runs, so `stop` can abort one and a second `run` can't reuse an id. */
  private readonly active = new Map<string, AbortController>();

  /** Fail runs orphaned by a restart (spec §4). Called once at boot. */
  async sweepInterrupted(): Promise<void> {
    const failed = await flowRunRepository.failInterrupted();
    if (failed > 0) log.warn({ failed }, 'failed flow runs left in flight by a restart');
  }

  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Stop a run: aborts its agent turns and ComfyUI jobs, and rejects any pending approval gate. */
  stop(runId: string): boolean {
    const controller = this.active.get(runId);
    if (!controller) return false;
    flowApprovalBroker.cancel(runId);
    controller.abort();
    return true;
  }

  async start(input: StartRunInput): Promise<RunOutcome> {
    const { flow, trigger } = input;
    const flowId = String(flow._id);

    const issues = validateFlow(flow);
    if (!isRunnable(issues)) {
      const first = issues.find((i) => i.level === 'error');
      throw new Error(`the flow has validation errors and cannot run: ${first?.message ?? 'unknown'}`);
    }

    const nodes = (flow.nodes ?? []) as FlowNode[];
    const edges = (flow.edges ?? []) as FlowEdge[];
    const executable = nodes.filter((n) => !NON_EXECUTING_TYPES.has(n.type));

    // Nodes inside a `for_each` body get one row *per iteration*, appended as the loop runs — a single
    // pre-created row would either sit `pending` forever or be overwritten by the last pass.
    const inLoop = loopBodyNodes(executable, edges);

    const run = await flowRunRepository.create({
      flow_id: flowId,
      flow_name: flow.name,
      trigger,
      inputs: (input.inputs ?? {}) as Record<string, unknown>,
      nodes: executable
        .filter((n) => !inLoop.has(n.id))
        .map<FlowNodeState>((n) => ({ node_id: n.id, status: 'pending' })),
    });
    const runId = String(run._id);
    input.onRunCreated?.(runId);

    const controller = new AbortController();
    this.active.set(runId, controller);

    // The run's debug trace. Attached before the first node so an agent node's very first token is
    // already being captured (see RunLogBuffer).
    const logs = new RunLogBuffer(runId);
    logs.attach();
    // Register the nesting depth against the run's session *before* anything executes: an agent node
    // that calls `run_flow` inherits this session, and that inheritance is the only thing the guard
    // can see (see flows/flow-depth.ts).
    setFlowDepth(runId, input.depth ?? 0);

    const ctx: EventContext = {
      // The run *is* its own session (spec §1.1): resources, the socket room and every nested agent
      // turn all key off this one id.
      sessionId: runId,
      agentId: flowId,
      agentName: flow.name,
      depth: 0,
    };
    const startedAt = Date.now();

    eventBus.emit('flow:run_start', { ctx, runId, flowId, flowName: flow.name, trigger });
    log.info({ runId, flow: flow.name, trigger }, 'flow run started');

    const runtime = new Map<string, NodeRuntime>(
      executable.map((n) => [n.id, { outputs: {}, status: 'pending' as const }]),
    );

    try {
      await this.executeRegion({
        ctx,
        runId,
        flow,
        nodes: executable,
        edges,
        runtime,
        signal: controller.signal,
        depth: input.depth ?? 0,
        inputs: (input.inputs ?? {}) as Record<string, unknown>,
        region: new Set(executable.map((n) => n.id)),
        scopeItem: undefined,
        scopeIndex: undefined,
        logs,
      });

      const outputNode = executable.find((n) => n.type === 'output');
      const value = outputNode ? primary(runtime.get(outputNode.id)?.outputs) : undefined;
      const output = asText(value);
      const handles = asHandles(value);

      await flowRunRepository.finish(runId, 'success', {
        output: outputNode ? truncateOutputs(runtime.get(outputNode.id)!.outputs) : null,
      });
      eventBus.emit('flow:run_end', {
        ctx,
        runId,
        status: 'success',
        durationMs: Date.now() - startedAt,
        output: output.slice(0, MAX_PERSISTED_TEXT),
        handles,
      });
      log.info({ runId, ms: Date.now() - startedAt }, 'flow run complete');
      return { runId, status: 'success', output, handles };
    } catch (err) {
      const aborted = err instanceof FlowAbortedError || controller.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      await flowRunRepository.finish(runId, aborted ? 'aborted' : 'error', { error: message });
      eventBus.emit('flow:run_end', {
        ctx,
        runId,
        status: aborted ? 'aborted' : 'error',
        durationMs: Date.now() - startedAt,
        error: message,
      });
      log.warn({ runId, err: message }, 'flow run failed');
      return { runId, status: aborted ? 'aborted' : 'error', output: '', handles: [], error: message };
    } finally {
      this.active.delete(runId);
      flowApprovalBroker.cancel(runId);
      clearFlowDepth(runId);
      await logs.close();
    }
  }

  /**
   * Schedule and execute a set of nodes.
   *
   * Used for the whole graph and, recursively, for a `for_each` body — the loop is *scheduling*, not a
   * node behaviour, so the same code drives both and a nested branch inside a loop keeps working.
   *
   * A node becomes ready when every incoming edge has settled. An edge is **satisfied** when its
   * source produced a value on that port, and **dead** when the source was skipped or took a
   * different branch — a node all of whose incoming edges are dead is skipped in turn, which is how
   * the untaken side of a condition disappears without any explicit reachability pass.
   */
  private async executeRegion(exec: RegionExecution): Promise<void> {
    const { region, edges, runtime } = exec;
    const nodes = exec.nodes.filter((n) => region.has(n.id));

    // Nodes owned by a loop are driven by their `for_each`, not by this scheduler — the body *and*
    // the `collect` that closes it, whose value the loop writes directly. They stay visible to
    // `settle` (that's what `loopOwned` is for) so downstream nodes still see the collect complete.
    const loopOwned = new Set<string>();
    for (const node of nodes) {
      if (node.type !== 'for_each') continue;
      const collectId = String(node.config?.collect_node ?? '').trim();
      const body = collectId ? loopBody(node.id, collectId, edges) : null;
      for (const id of body ?? []) loopOwned.add(id);
      if (body && collectId) loopOwned.add(collectId);
    }

    const pending = new Set(nodes.filter((n) => !loopOwned.has(n.id)).map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));

    while (pending.size > 0) {
      this.checkAborted(exec.signal);

      const ready: FlowNode[] = [];
      for (const id of pending) {
        const node = byId.get(id)!;
        const settled = this.settle(node, edges, runtime, region, loopOwned);
        if (settled === 'wait') continue;
        if (settled === 'skip') {
          pending.delete(id);
          await this.markSkipped(exec, node);
          continue;
        }
        ready.push(node);
      }

      if (ready.length === 0) {
        if (pending.size === 0) break;
        // Nothing can advance: every remaining node waits on a node that will never settle. Skipping
        // them is the honest outcome — a deadlock would leave the run "running" forever.
        for (const id of [...pending]) {
          pending.delete(id);
          await this.markSkipped(exec, byId.get(id)!);
        }
        break;
      }

      for (const node of ready) pending.delete(node.id);

      // Independent branches run together, bounded — two ComfyUI renders at once is already a lot for
      // one GPU, and a hundred would just queue.
      for (let i = 0; i < ready.length; i += BRANCH_CONCURRENCY) {
        const batch = ready.slice(i, i + BRANCH_CONCURRENCY);
        await Promise.all(batch.map((node) => this.executeNode(exec, node)));
      }
    }
  }

  /** Whether a node can run yet: `run` (ready), `wait` (upstream unfinished) or `skip` (branch dead). */
  private settle(
    node: FlowNode,
    edges: FlowEdge[],
    runtime: Map<string, NodeRuntime>,
    region: Set<string>,
    loopOwned: Set<string>,
  ): 'run' | 'wait' | 'skip' {
    const incoming = edges.filter((e) => e.target === node.id && (region.has(e.source) || loopOwned.has(e.source)));
    if (incoming.length === 0) return 'run';

    let satisfied = 0;
    for (const edge of incoming) {
      const source = runtime.get(edge.source);
      if (!source) continue; // an edge from outside this region (a loop body reading its loop node)
      if (source.status === 'pending' || source.status === 'running') return 'wait';
      if (source.status === 'success' && source.outputs[edge.source_port] !== undefined) satisfied += 1;
    }
    if (satisfied === 0) return 'skip';

    const anySatisfied = (port: string): boolean =>
      incoming
        .filter((e) => e.target_port === port)
        .some((e) => {
          const source = runtime.get(e.source);
          return source?.status === 'success' && source.outputs[e.source_port] !== undefined;
        });

    for (const port of inputPorts(node)) {
      const wired = incoming.some((e) => e.target_port === port.name);
      if (!wired) continue;
      // A required input whose branch died means this node cannot do its job.
      if (port.required && !anySatisfied(port.name)) return 'skip';
      // A wired `signal` port is a *gate*: it exists only to say "run now". If the branch feeding it
      // was not taken, this node must not run — even if its data inputs are all sitting there ready.
      // Without this rule a condition could never gate a node that also takes data from upstream,
      // which is the whole point of putting a condition in front of one.
      if (port.types.includes('signal') && !anySatisfied(port.name)) return 'skip';
    }
    return 'run';
  }

  /** Execute one node: build its context, run the handler, record the outcome. */
  private async executeNode(exec: RegionExecution, node: FlowNode): Promise<void> {
    const { ctx, runId, runtime, edges } = exec;
    const handler = getHandler(node.type);
    if (!handler) throw new Error(`unknown node type "${node.type}"`);

    const state = runtime.get(node.id)!;
    state.status = 'running';
    const startedAt = Date.now();
    // Ambient agent/tool events carry the agent's identity, not the node's, so tell the trace which
    // node is executing before anything can emit (see RunLogBuffer.setCurrentNode).
    exec.logs.setCurrentNode(node.id);

    await flowRunRepository.patchNode(
      runId,
      node.id,
      { status: 'running', started_at: new Date() },
      exec.scopeIndex,
    );
    eventBus.emit('flow:node_start', {
      ctx,
      runId,
      nodeId: node.id,
      nodeType: node.type,
      label: labelOf(node),
      iteration: exec.scopeIndex,
    });

    try {
      this.checkAborted(exec.signal);

      const scope = this.scopeFor(exec);
      const inputs = this.gatherInputs(node, edges, runtime);
      const config = this.configFor(exec, node, scope);
      const nodeCtx = this.nodeContext(exec, node, scope, startedAt);

      const result =
        node.type === 'for_each'
          ? await this.runLoop(exec, node, inputs, nodeCtx)
          : await handler.run(nodeCtx, inputs, config);

      const outputs = normalizeOutputs(result, handler.outputs[0]?.name ?? 'default');
      state.outputs = outputs;
      state.status = 'success';

      const value = primary(outputs);
      exec.logs.append(
        node.id,
        'system',
        `✓ ${labelOf(node)} (${Math.round(Date.now() - startedAt)}ms)`,
        { iteration: exec.scopeIndex },
      );
      await flowRunRepository.patchNode(
        runId,
        node.id,
        { status: 'success', ended_at: new Date(), output: truncateOutputs(outputs) },
        exec.scopeIndex,
      );
      eventBus.emit('flow:node_end', {
        ctx,
        runId,
        nodeId: node.id,
        status: 'success',
        durationMs: Date.now() - startedAt,
        summary: asText(value).slice(0, 400),
        handles: asHandles(value),
      });
    } catch (err) {
      state.status = 'error';
      const aborted = err instanceof FlowAbortedError || exec.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      exec.logs.append(node.id, 'system', `✗ ${labelOf(node)}: ${message}`, { iteration: exec.scopeIndex });
      await flowRunRepository.patchNode(
        runId,
        node.id,
        { status: 'error', ended_at: new Date(), error: message },
        exec.scopeIndex,
      );
      eventBus.emit('flow:node_end', {
        ctx,
        runId,
        nodeId: node.id,
        status: 'error',
        durationMs: Date.now() - startedAt,
        error: message,
      });
      // A failed node fails the run: silently continuing would hand downstream nodes an empty value
      // and produce a plausible-looking wrong result, which is worse than stopping.
      throw aborted ? new FlowAbortedError() : new Error(`${labelOf(node)}: ${message}`);
    }
  }

  /**
   * Drive a `for_each`: publish each item, re-execute the body, and hand the joined result to the
   * paired `collect`. Iterations are sequential by default — each one may be a ten-minute render.
   */
  private async runLoop(
    exec: RegionExecution,
    node: FlowNode,
    inputs: Record<string, FlowValue>,
    nodeCtx: FlowNodeContext,
  ): Promise<Record<string, FlowValue>> {
    const collectId = String(node.config?.collect_node ?? '').trim();
    const body = collectId ? loopBody(node.id, collectId, exec.edges) : null;
    const collect = exec.nodes.find((n) => n.id === collectId);
    if (!body || !collect) throw new Error('this loop has no paired Collect node');

    const maxItems = clampInt(node.config?.max_items, 1, 200, 20);
    const concurrency = clampInt(node.config?.concurrency, 1, 4, 1);
    const all = asList(inputs.list);
    const items = all.slice(0, maxItems);
    if (all.length > items.length) {
      nodeCtx.emitOutput(`list has ${all.length} items — running the first ${items.length}\n`);
    }
    nodeCtx.emitOutput(`iterating ${items.length} item(s)\n`);

    const collected: unknown[] = [];
    const handles: string[] = [];
    let lastRuntime: Map<string, NodeRuntime> | undefined;

    for (let start = 0; start < items.length; start += concurrency) {
      this.checkAborted(exec.signal);
      const batch = items.slice(start, start + concurrency);
      const results = await Promise.all(
        batch.map((item, offset) => this.runIteration(exec, node, body, collect, item, start + offset)),
      );
      for (const { value, runtime } of results) {
        lastRuntime = runtime;
        if (!value) continue;
        collected.push(value.json ?? asText(value));
        handles.push(...asHandles(value));
      }
    }

    // Publish the final iteration's body state into the outer runtime. Nothing downstream *should*
    // read a body node directly (validation warns about it), but leaving them `pending` forever would
    // deadlock anything that does, and the last pass is the only defensible value to show.
    if (lastRuntime) {
      for (const id of body) {
        const state = lastRuntime.get(id);
        if (state) exec.runtime.set(id, state);
      }
    }

    // The loop node itself reports the last item; `collect`'s value is written straight into the
    // runtime so the main scheduler sees it as an ordinary completed node.
    const collectOutputs: NodeOutputs = {
      default: handles.length
        ? { type: 'file', handles, json: collected, text: handles.join(', ') }
        : jsonValue(collected),
      text: textValue(collected.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('\n')),
      done: { type: 'signal' },
    };
    const collectState = exec.runtime.get(collect.id);
    if (collectState) {
      collectState.outputs = collectOutputs;
      collectState.status = 'success';
      await flowRunRepository.patchNode(exec.runId, collect.id, {
        status: 'success',
        ended_at: new Date(),
        output: truncateOutputs(collectOutputs),
      });
      eventBus.emit('flow:node_end', {
        ctx: exec.ctx,
        runId: exec.runId,
        nodeId: collect.id,
        status: 'success',
        durationMs: 0,
        summary: `${collected.length} iteration(s)`,
        handles,
      });
    }

    return {
      default: items[items.length - 1] ?? textValue(''),
      index: textValue(String(Math.max(0, items.length - 1))),
    };
  }

  /** One pass of a loop body, with its own value scope so iterations don't see each other's outputs. */
  private async runIteration(
    exec: RegionExecution,
    loop: FlowNode,
    body: Set<string>,
    collect: FlowNode,
    item: FlowValue,
    index: number,
  ): Promise<{ value: FlowValue | undefined; runtime: Map<string, NodeRuntime> }> {
    // Layer a fresh runtime over the outer one: body nodes start clean each iteration, while reads of
    // nodes *outside* the loop still resolve to their single completed value.
    const runtime = new Map(exec.runtime);
    for (const id of body) runtime.set(id, { outputs: {}, status: 'pending' });
    runtime.set(loop.id, {
      status: 'success',
      // `each` is the per-iteration trigger: a body node whose inputs are all templates still needs
      // an edge from the loop, or it isn't in the body and never runs (see the port's description).
      outputs: { default: item, index: textValue(String(index)), each: { type: 'signal' } },
    });

    for (const id of body) {
      await flowRunRepository.addNode(exec.runId, { node_id: id, status: 'pending', iteration: index });
    }

    await this.executeRegion({
      ...exec,
      runtime,
      region: body,
      scopeItem: item,
      scopeIndex: index,
    });

    // Whatever the body wired into `collect.value` is this iteration's result.
    const edge = exec.edges.find((e) => e.target === collect.id && e.target_port === 'value');
    return { value: edge ? runtime.get(edge.source)?.outputs[edge.source_port] : undefined, runtime };
  }

  /** Values arriving on a node's wired input ports, coerced to the port's declared type. */
  private gatherInputs(
    node: FlowNode,
    edges: FlowEdge[],
    runtime: Map<string, NodeRuntime>,
  ): Record<string, FlowValue> {
    const inputs: Record<string, FlowValue> = {};
    for (const port of inputPorts(node)) {
      const wired = edges.filter((e) => e.target === node.id && e.target_port === port.name);
      const values = wired
        .map((e) => runtime.get(e.source)?.outputs[e.source_port])
        .filter((v): v is FlowValue => v !== undefined);
      if (values.length === 0) continue;

      // Several edges into one port merge: handles concatenate, text joins. Wiring two image sources
      // into an approval gate should show both, not the last one to arrive.
      const merged =
        values.length === 1
          ? values[0]!
          : values.some((v) => v.handles?.length)
            ? {
                type: values[0]!.type,
                handles: values.flatMap((v) => v.handles ?? []),
                text: values.map(asText).join('\n'),
              }
            : textValue(values.map(asText).filter(Boolean).join('\n\n'));

      // Only convert when the port cannot take what arrived. Coercing unconditionally to the port's
      // first declared type would flatten every value on a permissive port — `output` accepts all
      // types and lists `text` first, so an image reaching it would arrive as a string and lose the
      // handles that *are* the result.
      const accepted = port.types as PortType[];
      inputs[port.name] = accepted.includes(merged.type)
        ? merged
        : coerce(merged, accepted[0] ?? 'text');
    }
    return inputs;
  }

  /** The node's config with `{{refs}}` interpolated, plus the run's value for an `input` node. */
  private configFor(
    exec: RegionExecution,
    node: FlowNode,
    scope: TemplateScope,
  ): Record<string, unknown> {
    const config = renderConfig({ ...(node.config ?? {}) }, scope);
    if (node.type === 'input') {
      const key = String(node.config?.key ?? '').trim() || node.id;
      const supplied = exec.inputs[key] ?? exec.inputs[node.id];
      if (supplied !== undefined) config.value = supplied;
    }
    return config;
  }

  /** Template scope: every completed node's outputs, addressable by id *and* by label slug. */
  private scopeFor(exec: RegionExecution): TemplateScope {
    const nodes = new Map<string, NodeOutputs>();
    for (const [id, state] of exec.runtime) {
      if (state.status !== 'success') continue;
      nodes.set(id, state.outputs);
      const node = exec.nodes.find((n) => n.id === id);
      const slug = slugify(node?.label ?? '');
      // Labels are the readable way to write a reference; ids win a collision, since they're unique.
      if (slug && !nodes.has(slug)) nodes.set(slug, state.outputs);
    }
    return { nodes, item: exec.scopeItem, index: exec.scopeIndex };
  }

  /** The narrow context a node handler is given (never the full `ToolContext`). */
  private nodeContext(
    exec: RegionExecution,
    node: FlowNode,
    scope: TemplateScope,
    startedAt: number,
  ): FlowNodeContext {
    const { ctx, runId } = exec;
    return {
      runId,
      sessionId: runId,
      flowId: String(exec.flow._id),
      flowName: exec.flow.name,
      node,
      depth: exec.depth,
      signal: exec.signal,
      scope,
      emitProgress: (payload) =>
        eventBus.emit('flow:node_progress', {
          ctx,
          runId,
          nodeId: node.id,
          phase: payload.phase,
          percent: payload.percent ?? null,
          message: payload.message,
          preview: payload.preview,
          etaMs: payload.etaMs ?? null,
          elapsedMs: Date.now() - startedAt,
        }),
      emitOutput: (chunk) => {
        exec.logs.append(node.id, 'node', chunk, { iteration: exec.scopeIndex });
        eventBus.emit('flow:node_output', { ctx, runId, nodeId: node.id, chunk });
      },
      storeResource: async (inputResource) => {
        const stored = await resourceRepository.store({
          sessionId: runId,
          agentId: String(exec.flow._id),
          bytes: inputResource.bytes,
          kind: inputResource.kind,
          mime: inputResource.mime,
          filename: inputResource.filename,
          source: 'tool',
        });
        return stored.handle;
      },
      readResource: async (handle) => {
        const doc = await resourceRepository.findByHandle(runId, handle);
        if (!doc) return null;
        const bytes = await resourceRepository.readBytes(runId, handle);
        if (!bytes) return null;
        return { bytes, mime: doc.mime || 'application/octet-stream', filename: doc.filename || handle };
      },
      importResource: async (fromSessionId, handle) => {
        if (fromSessionId === runId) return handle;
        const doc = await resourceRepository.findByHandle(fromSessionId, handle);
        if (!doc) return null;
        const bytes = await resourceRepository.readBytes(fromSessionId, handle);
        if (!bytes) return null;
        const stored = await resourceRepository.store({
          sessionId: runId,
          agentId: String(exec.flow._id),
          bytes,
          kind: doc.kind,
          mime: doc.mime,
          filename: doc.filename,
          source: 'attachment',
        });
        return stored.handle;
      },
      askApproval: (question, artifacts) =>
        flowApprovalBroker.ask(ctx, { runId, nodeId: node.id, question, artifacts }),
    };
  }

  private async markSkipped(exec: RegionExecution, node: FlowNode): Promise<void> {
    const state = exec.runtime.get(node.id);
    if (state) state.status = 'skipped';
    await flowRunRepository.patchNode(
      exec.runId,
      node.id,
      { status: 'skipped', ended_at: new Date() },
      exec.scopeIndex,
    );
    eventBus.emit('flow:node_end', {
      ctx: exec.ctx,
      runId: exec.runId,
      nodeId: node.id,
      status: 'skipped',
      durationMs: 0,
    });
  }

  private checkAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new FlowAbortedError();
  }
}

/** Every node that lives inside some `for_each` body (excluding the loop and collect nodes). */
function loopBodyNodes(nodes: FlowNode[], edges: FlowEdge[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'for_each') continue;
    const collectId = String(node.config?.collect_node ?? '').trim();
    if (!collectId) continue;
    for (const id of loopBody(node.id, collectId, edges) ?? []) ids.add(id);
  }
  return ids;
}

/** State threaded through one region's execution (the whole graph, or one loop body). */
interface RegionExecution {
  ctx: EventContext;
  runId: string;
  flow: FlowDoc;
  nodes: FlowNode[];
  edges: FlowEdge[];
  runtime: Map<string, NodeRuntime>;
  signal: AbortSignal;
  depth: number;
  inputs: Record<string, unknown>;
  /** Node ids this pass is allowed to schedule. */
  region: Set<string>;
  scopeItem: FlowValue | undefined;
  scopeIndex: number | undefined;
  /** The run's debug trace, shared by every region (including loop bodies). */
  logs: RunLogBuffer;
}

/** A handler may return one value or a map of them; normalise to the map form. */
function normalizeOutputs(result: unknown, primaryPort: string): NodeOutputs {
  if (result && typeof result === 'object' && 'type' in (result as Record<string, unknown>)) {
    return { [primaryPort]: result as FlowValue };
  }
  return (result ?? {}) as NodeOutputs;
}

/** Cap persisted text so a run document stays a readable trace (handles are always kept). */
function truncateOutputs(outputs: NodeOutputs): Record<string, FlowValue> {
  const out: Record<string, FlowValue> = {};
  for (const [port, value] of Object.entries(outputs)) {
    out[port] = {
      ...value,
      text:
        value.text && value.text.length > MAX_PERSISTED_TEXT
          ? `${value.text.slice(0, MAX_PERSISTED_TEXT)}\n… (truncated)`
          : value.text,
      // Structured payloads can be arbitrarily large (a `webfetch` result, a long list); the text
      // rendering above is what the UI shows, so the raw JSON is dropped past a sane size.
      json: estimateSize(value.json) > MAX_PERSISTED_TEXT ? undefined : value.json,
    };
  }
  return out;
}

function estimateSize(json: unknown): number {
  if (json === undefined || json === null) return 0;
  try {
    return JSON.stringify(json).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function labelOf(node: FlowNode): string {
  return node.label?.trim() || getHandler(node.type)?.label || node.type;
}

/** `"Write the prompt"` → `write_the_prompt`, so `{{write_the_prompt}}` works in a template. */
function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export const flowRunner = new FlowRunner();

/** Re-exported so routes can describe a flow's ports without importing the node registry. */
export { outputPorts, inputPorts };
