import type { FlowDoc, FlowEdge, FlowNode } from '../domain/flows/flow.model';
import { getHandler, inputPorts, outputPorts, NON_EXECUTING_TYPES } from './nodes';
import { canConnect, connectionError, type PortType } from './port-types';
import { referencedNodesDeep } from './template';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  /** The node or edge the issue belongs to, so the canvas can highlight it. */
  nodeId?: string;
  edgeId?: string;
}

/**
 * Static checks a flow must pass before it can run (flows spec §4).
 *
 * Run on save *and* immediately before every execution, because a flow can rot between the two: the
 * ComfyUI workflow a media node points at may have been deleted on the Media page, and the agent an
 * `ask_agent` node names may have been renamed. Catching that here costs a millisecond; catching it
 * eight minutes into a video render costs the render.
 */
export function validateFlow(flow: Pick<FlowDoc, 'nodes' | 'edges'>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = (flow.nodes ?? []) as FlowNode[];
  const edges = (flow.edges ?? []) as FlowEdge[];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (nodes.length === 0) {
    return [{ level: 'error', message: 'the flow is empty' }];
  }

  // --- nodes ---------------------------------------------------------------------------------
  const seenIds = new Set<string>();
  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      issues.push({ level: 'error', nodeId: node.id, message: `duplicate node id "${node.id}"` });
    }
    seenIds.add(node.id);

    const handler = getHandler(node.type);
    if (!handler) {
      issues.push({ level: 'error', nodeId: node.id, message: `unknown node type "${node.type}"` });
      continue;
    }
    for (const message of handler.validate?.(node) ?? []) {
      issues.push({ level: 'error', nodeId: node.id, message: `${labelOf(node)}: ${message}` });
    }

    // Dangling `{{refs}}`: an unresolved reference renders empty, which silently produces a wrong
    // prompt rather than an error — exactly the failure a graph is supposed to make impossible.
    for (const ref of referencedNodesDeep(node.config ?? {})) {
      if (!byId.has(ref)) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `${labelOf(node)}: references {{${ref}}}, which is not a node in this flow`,
        });
      }
    }
  }

  // --- edges ---------------------------------------------------------------------------------
  const incoming = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      issues.push({ level: 'error', edgeId: edge.id, message: 'an edge points at a node that no longer exists' });
      continue;
    }
    const outPort = outputPorts(source).find((p) => p.name === edge.source_port);
    const inPort = inputPorts(target).find((p) => p.name === edge.target_port);
    if (!outPort) {
      issues.push({
        level: 'error',
        edgeId: edge.id,
        message: `${labelOf(source)} has no output "${edge.source_port}"`,
      });
      continue;
    }
    if (!inPort) {
      issues.push({
        level: 'error',
        edgeId: edge.id,
        message: `${labelOf(target)} has no input "${edge.target_port}"`,
      });
      continue;
    }
    const sourceType = outPort.types[0] as PortType;
    if (!inPort.types.some((t) => canConnect(sourceType, t as PortType))) {
      issues.push({
        level: 'error',
        edgeId: edge.id,
        message: `${labelOf(source)} → ${labelOf(target)}: ${connectionError(sourceType, inPort.types[0] as PortType)}`,
      });
      continue;
    }
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }

  // --- required inputs -----------------------------------------------------------------------
  for (const node of nodes) {
    for (const port of inputPorts(node)) {
      if (!port.required) continue;
      const wired = (incoming.get(node.id) ?? []).some((e) => e.target_port === port.name);
      if (!wired) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          message: `${labelOf(node)}: input "${port.name}" is required but nothing is wired to it`,
        });
      }
    }
  }

  // --- structure -----------------------------------------------------------------------------
  const outputs = nodes.filter((n) => n.type === 'output');
  if (outputs.length === 0) {
    issues.push({ level: 'warning', message: 'no Output node — the run will not produce a result' });
  } else if (outputs.length > 1) {
    issues.push({ level: 'error', message: 'a flow can have only one Output node' });
  }

  for (const cycle of findCycles(nodes, edges)) {
    issues.push({
      level: 'error',
      message: `the graph has a cycle: ${cycle.map((id) => labelOf(byId.get(id)!)).join(' → ')}`,
    });
  }

  issues.push(...validateLoops(nodes, edges, byId));

  // --- reachability --------------------------------------------------------------------------
  for (const node of nodes) {
    if (NON_EXECUTING_TYPES.has(node.type) || node.type === 'input') continue;
    const hasIncoming = (incoming.get(node.id) ?? []).length > 0;
    if (!hasIncoming && inputPorts(node).length > 0) {
      issues.push({
        level: 'warning',
        nodeId: node.id,
        message: `${labelOf(node)} has nothing wired into it`,
      });
    }
  }

  return issues;
}

/** True when a flow has no blocking problems. */
export function isRunnable(issues: ValidationIssue[]): boolean {
  return !issues.some((i) => i.level === 'error');
}

/**
 * A `for_each` must pair with exactly one `collect`, and the body between them must be a single
 * region entered only through the loop. Anything else — two collects, a branch escaping mid-body —
 * has no well-defined "run this once per item", so it is refused rather than guessed at.
 */
function validateLoops(
  nodes: FlowNode[],
  edges: FlowEdge[],
  byId: Map<string, FlowNode>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const collects = nodes.filter((n) => n.type === 'collect');
  const loops = nodes.filter((n) => n.type === 'for_each');

  for (const loop of loops) {
    const collectId = String(loop.config?.collect_node ?? '').trim();
    const collect = collectId ? byId.get(collectId) : undefined;
    if (!collect) {
      issues.push({
        level: 'error',
        nodeId: loop.id,
        message: `${labelOf(loop)}: no Collect node is paired with this loop (set "Collect node" in the inspector)`,
      });
      continue;
    }
    if (collect.type !== 'collect') {
      issues.push({
        level: 'error',
        nodeId: loop.id,
        message: `${labelOf(loop)}: "${labelOf(collect)}" is not a Collect node`,
      });
      continue;
    }
    const body = loopBody(loop.id, collect.id, edges);
    if (body === null) {
      issues.push({
        level: 'error',
        nodeId: loop.id,
        message: `${labelOf(loop)}: its Collect node is not reachable from it`,
      });
      continue;
    }
    // Anything inside the body that is also fed from outside would run once per item with a value
    // that never changes — almost certainly a wiring mistake, and definitely ambiguous.
    for (const edge of edges) {
      if (body.has(edge.target) && edge.target !== collect.id && !body.has(edge.source) && edge.source !== loop.id) {
        issues.push({
          level: 'warning',
          edgeId: edge.id,
          message: `${labelOf(byId.get(edge.target)!)} is inside a loop but is also fed from outside it`,
        });
      }
    }
  }

  for (const collect of collects) {
    const paired = loops.some((l) => String(l.config?.collect_node ?? '') === collect.id);
    if (!paired) {
      issues.push({
        level: 'error',
        nodeId: collect.id,
        message: `${labelOf(collect)}: no For Each node points at this Collect`,
      });
    }
  }

  return issues;
}

/**
 * Nodes strictly between a `for_each` and its `collect` — the region the runner re-executes per item.
 * `null` when the collect isn't reachable at all.
 */
export function loopBody(loopId: string, collectId: string, edges: FlowEdge[]): Set<string> | null {
  const body = new Set<string>();
  const queue = edges.filter((e) => e.source === loopId).map((e) => e.target);
  let reachesCollect = false;

  while (queue.length) {
    const id = queue.shift()!;
    if (id === collectId) {
      reachesCollect = true;
      continue;
    }
    if (body.has(id)) continue;
    body.add(id);
    for (const edge of edges.filter((e) => e.source === id)) queue.push(edge.target);
  }

  return reachesCollect ? body : null;
}

/** Every simple cycle in the graph (loops are expressed by pairing, never by a back edge). */
function findCycles(nodes: FlowNode[], edges: FlowEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }

  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      const start = stack.indexOf(id);
      if (start >= 0 && cycles.length < 3) cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    stack.pop();
    state.set(id, 'done');
  };

  for (const node of nodes) visit(node.id);
  return cycles;
}

function labelOf(node: FlowNode): string {
  return node.label?.trim() || getHandler(node.type)?.label || node.type;
}
