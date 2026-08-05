import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '../../lib/socket';
import { flowsApi, type FlowLogSource, type FlowRunDetail } from '../../lib/api';
import type { NodeRunState } from './FlowNodeCard';
import type {
  FlowArtifactEvent,
  FlowAwaitingApprovalEvent,
  FlowNodeEndEvent,
  FlowNodeOutputEvent,
  FlowNodeProgressEvent,
  FlowNodeStartEvent,
  FlowRunEndEvent,
} from '../../lib/ws-events.types';

/**
 * One line of the Debug stream. Mirrors the backend's persisted entry, with a client-side `id` so
 * React can key a list that only ever grows at the end.
 */
export interface LogLine {
  id: number;
  at: string;
  nodeId: string;
  source: FlowLogSource;
  text: string;
  iteration?: number | null;
}

/** One artifact a run produced, in the order it was produced. */
export interface RunArtifact {
  handle: string;
  nodeId: string;
  kind: 'image' | 'blob';
  mime: string;
  size: number;
  filename?: string;
  iteration?: number;
  /** Absent for artifacts recovered from a finished run — only live ones are timed. */
  at?: string;
}

/** Live view of one flow run: per-node status, the debug stream, and the pending approval gate. */
export interface LiveRun {
  runId: string;
  detail: FlowRunDetail | null;
  states: Map<string, NodeRunState>;
  /** Chronological across every node — filtering by node happens in the view (spec §6.2). */
  logs: LogLine[];
  /** Everything the run has produced so far, appended as each file lands. */
  artifacts: RunArtifact[];
  pending: { nodeId: string; question: string; artifacts: string[] } | null;
  finished: { status: string; output?: string; handles?: string[]; error?: string } | null;
}

const EMPTY: Omit<LiveRun, 'runId'> = {
  detail: null,
  states: new Map(),
  logs: [],
  artifacts: [],
  pending: null,
  finished: null,
};

let lineId = 0;

/**
 * Append a line, coalescing into the previous one when it is the same node and source. Streaming
 * agent tokens arrive a few characters at a time; one row per token would be unreadable.
 */
function appendLine(
  lines: LogLine[],
  nodeId: string,
  source: FlowLogSource,
  text: string,
  coalesce = false,
): LogLine[] {
  if (!text) return lines;
  const last = lines[lines.length - 1];
  if (coalesce && last && last.nodeId === nodeId && last.source === source) {
    const next = lines.slice(0, -1);
    next.push({ ...last, text: last.text + text });
    return next;
  }
  return [
    ...lines,
    { id: ++lineId, at: new Date().toISOString(), nodeId, source, text },
  ];
}

/**
 * Subscribe to a flow run.
 *
 * The run's socket room is its own id (FLOWS_PLAN.md §1.1), so watching a run uses the very same
 * `session:subscribe` a chat does — which is also why the agent tokens and ComfyUI progress emitted
 * by nodes *inside* the run arrive on this connection with no extra wiring.
 */
export function useFlowRun(runId: string | null): LiveRun & { refresh: () => void; reset: () => void } {
  const [state, setState] = useState<Omit<LiveRun, 'runId'>>(EMPTY);
  const runIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    if (!runId) return;
    flowsApi
      .getRun(runId)
      .then((detail) =>
        setState((prev) => ({
          ...prev,
          detail,
          // Seed from the persisted trace so opening a finished (or already-running) run shows its
          // node states immediately, rather than only what arrives from here on.
          states: mergeStates(prev.states, detail),
          // Same for the debug stream: a run you weren't watching replays from what was persisted.
          // Live lines win when there are any, since they are strictly fresher than the last flush.
          logs: prev.logs.length
            ? prev.logs
            : (detail.logs ?? []).map((e) => ({
                id: ++lineId,
                at: typeof e.at === 'string' ? e.at : new Date(e.at).toISOString(),
                nodeId: e.node_id,
                source: e.source,
                text: e.text,
                iteration: e.iteration,
              })),
          // The run's stored resources are authoritative for a finished run; live arrivals win while
          // one is in flight, since they carry the producing node and arrive in production order.
          artifacts: mergeArtifacts(prev.artifacts, detail),
          pending: detail.pending
            ? {
                nodeId: detail.pending.node_id,
                question: detail.pending.question,
                artifacts: detail.pending.artifacts,
              }
            : prev.pending,
        })),
      )
      .catch(() => undefined);
  }, [runId]);

  const reset = useCallback(() => setState(EMPTY), []);

  useEffect(() => {
    if (!runId) {
      setState(EMPTY);
      runIdRef.current = null;
      return;
    }
    if (runIdRef.current !== runId) {
      runIdRef.current = runId;
      setState(EMPTY);
    }

    const socket = getSocket();
    socket.emit('session:subscribe', { sessionId: runId });
    refresh();

    const patch = (nodeId: string, next: Partial<NodeRunState>) =>
      setState((prev) => {
        const states = new Map(prev.states);
        states.set(nodeId, { status: 'running', ...states.get(nodeId), ...next });
        return { ...prev, states };
      });

    const onStart = (e: FlowNodeStartEvent) => {
      currentNode = e.nodeId;
      patch(e.nodeId, {
        status: 'running',
        percent: null,
        message: undefined,
        error: undefined,
        iteration: e.iteration,
      });
    };

    const onProgress = (e: FlowNodeProgressEvent) =>
      patch(e.nodeId, {
        status: 'running',
        percent: e.percent ?? null,
        message: e.message,
        // Keep the last frame when a tick arrives without one, so the thumbnail doesn't flicker.
        ...(e.preview ? { preview: e.preview } : {}),
      });

    // The node currently executing, so the ambient agent/tool events (which carry the *agent's*
    // identity, not the node's) can be attributed — the same best-effort rule the backend applies.
    let currentNode = 'flow';

    const line = (nodeId: string, source: FlowLogSource, text: string, coalesce = false) =>
      setState((prev) => ({ ...prev, logs: appendLine(prev.logs, nodeId, source, text, coalesce) }));

    const onOutput = (e: FlowNodeOutputEvent) => line(e.nodeId, 'node', e.chunk, true);

    // A flow run's socket room already carries everything the nodes emit internally (spec §1.1), so
    // the agent's reasoning and each tool call land in the same ordered stream as the node output.
    const onStreamChunk = (e: { content: string; is_reasoning: boolean }) =>
      line(currentNode, 'agent', e.content, true);
    const onToolStart = (e: { tool: string; args: Record<string, unknown> }) =>
      line(currentNode, 'tool', `→ ${e.tool}`);
    const onToolEnd = (e: { tool: string; status: string }) =>
      line(currentNode, 'tool', `← ${e.tool} ${e.status}`);
    const onToolOutput = (e: { chunk: string }) => line(currentNode, 'tool', e.chunk, true);
    const onMediaGen = (e: { phase: string; kind: string; workflow: string; prompt: string }) => {
      if (e.phase !== 'start') return;
      line(currentNode, 'media', `${e.kind} · ${e.workflow} · "${(e.prompt ?? '').slice(0, 120)}"`);
    };

    const onEnd = (e: FlowNodeEndEvent) => {
      if (e.status === 'error' && e.error) line(e.nodeId, 'system', `✗ ${e.error}`);
      else if (e.status === 'success') line(e.nodeId, 'system', `✓ done (${Math.round(e.durationMs)}ms)`);
      patch(e.nodeId, {
        status: e.status,
        percent: e.status === 'success' ? 100 : null,
        summary: e.summary,
        error: e.error,
        preview: undefined,
        message: undefined,
      });
    };

    const onRunEnd = (e: FlowRunEndEvent) => {
      setState((prev) => ({
        ...prev,
        pending: null,
        finished: { status: e.status, output: e.output, handles: e.handles, error: e.error },
      }));
      refresh();
    };

    const onArtifact = (e: FlowArtifactEvent) =>
      setState((prev) =>
        prev.artifacts.some((a) => a.handle === e.handle)
          ? prev
          : {
              ...prev,
              artifacts: [
                ...prev.artifacts,
                {
                  handle: e.handle,
                  nodeId: e.nodeId,
                  kind: e.kind,
                  mime: e.mime,
                  size: e.size,
                  filename: e.filename,
                  iteration: e.iteration,
                  at: new Date().toISOString(),
                },
              ],
            },
      );

    const onApproval = (e: FlowAwaitingApprovalEvent) =>
      setState((prev) => ({
        ...prev,
        pending: { nodeId: e.nodeId, question: e.question, artifacts: e.artifacts },
      }));

    socket.on('flow_node_start', onStart);
    socket.on('flow_node_progress', onProgress);
    socket.on('flow_node_output', onOutput);
    socket.on('flow_node_end', onEnd);
    socket.on('flow_run_end', onRunEnd);
    socket.on('flow_awaiting_approval', onApproval);
    socket.on('flow_artifact', onArtifact);
    // Emitted by the agent/tool/media work happening *inside* the run's nodes.
    socket.on('stream_chunk', onStreamChunk);
    socket.on('tool_start', onToolStart);
    socket.on('tool_end', onToolEnd);
    socket.on('tool_output', onToolOutput);
    socket.on('media_gen', onMediaGen);

    return () => {
      socket.off('flow_node_start', onStart);
      socket.off('flow_node_progress', onProgress);
      socket.off('flow_node_output', onOutput);
      socket.off('flow_node_end', onEnd);
      socket.off('flow_run_end', onRunEnd);
      socket.off('flow_awaiting_approval', onApproval);
      socket.off('flow_artifact', onArtifact);
      socket.off('stream_chunk', onStreamChunk);
      socket.off('tool_start', onToolStart);
      socket.off('tool_end', onToolEnd);
      socket.off('tool_output', onToolOutput);
      socket.off('media_gen', onMediaGen);
    };
  }, [runId, refresh]);

  return { runId: runId ?? '', ...state, refresh, reset };
}

/**
 * Fold the run's stored resources into the live artifact list.
 *
 * A live arrival knows which node made it and lands in production order; a stored row knows neither,
 * so it only fills in handles nothing announced — which is every handle when replaying a past run,
 * and none while watching a live one.
 */
function mergeArtifacts(live: RunArtifact[], detail: FlowRunDetail): RunArtifact[] {
  const seen = new Set(live.map((a) => a.handle));
  const extra = (detail.resources ?? [])
    .filter((r) => !seen.has(r.handle))
    .map<RunArtifact>((r) => ({
      handle: r.handle,
      nodeId: '',
      kind: r.kind,
      mime: r.mime,
      size: r.size,
      filename: r.filename,
    }));
  return extra.length ? [...live, ...extra] : live;
}

/** Fold the persisted node trace into the live map without clobbering fresher live state. */
function mergeStates(live: Map<string, NodeRunState>, detail: FlowRunDetail): Map<string, NodeRunState> {
  const merged = new Map(live);
  for (const node of detail.nodes) {
    if (merged.has(node.node_id) && detail.live) continue;
    merged.set(node.node_id, {
      status: node.status,
      summary: summaryOf(node.output),
      error: node.error || undefined,
      iteration: node.iteration ?? undefined,
      percent: node.status === 'success' ? 100 : null,
    });
  }
  return merged;
}

function summaryOf(output: FlowRunDetail['nodes'][number]['output']): string | undefined {
  if (!output) return undefined;
  const first = Object.values(output)[0];
  if (!first) return undefined;
  return (first.text || first.handles?.join(', ') || '').slice(0, 400) || undefined;
}
