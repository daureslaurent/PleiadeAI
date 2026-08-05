import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '../../lib/socket';
import { flowsApi, type FlowRunDetail } from '../../lib/api';
import type { NodeRunState } from './FlowNodeCard';
import type {
  FlowAwaitingApprovalEvent,
  FlowNodeEndEvent,
  FlowNodeOutputEvent,
  FlowNodeProgressEvent,
  FlowNodeStartEvent,
  FlowRunEndEvent,
} from '../../lib/ws-events.types';

/** Live view of one flow run: per-node status, per-node log, and the pending approval gate. */
export interface LiveRun {
  runId: string;
  detail: FlowRunDetail | null;
  states: Map<string, NodeRunState>;
  logs: Map<string, string>;
  pending: { nodeId: string; question: string; artifacts: string[] } | null;
  finished: { status: string; output?: string; handles?: string[]; error?: string } | null;
}

const EMPTY: Omit<LiveRun, 'runId'> = {
  detail: null,
  states: new Map(),
  logs: new Map(),
  pending: null,
  finished: null,
};

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

    const onStart = (e: FlowNodeStartEvent) =>
      patch(e.nodeId, {
        status: 'running',
        percent: null,
        message: undefined,
        error: undefined,
        iteration: e.iteration,
      });

    const onProgress = (e: FlowNodeProgressEvent) =>
      patch(e.nodeId, {
        status: 'running',
        percent: e.percent ?? null,
        message: e.message,
        // Keep the last frame when a tick arrives without one, so the thumbnail doesn't flicker.
        ...(e.preview ? { preview: e.preview } : {}),
      });

    const onOutput = (e: FlowNodeOutputEvent) =>
      setState((prev) => {
        const logs = new Map(prev.logs);
        logs.set(e.nodeId, `${logs.get(e.nodeId) ?? ''}${e.chunk}`);
        return { ...prev, logs };
      });

    const onEnd = (e: FlowNodeEndEvent) =>
      patch(e.nodeId, {
        status: e.status,
        percent: e.status === 'success' ? 100 : null,
        summary: e.summary,
        error: e.error,
        preview: undefined,
        message: undefined,
      });

    const onRunEnd = (e: FlowRunEndEvent) => {
      setState((prev) => ({
        ...prev,
        pending: null,
        finished: { status: e.status, output: e.output, handles: e.handles, error: e.error },
      }));
      refresh();
    };

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

    return () => {
      socket.off('flow_node_start', onStart);
      socket.off('flow_node_progress', onProgress);
      socket.off('flow_node_output', onOutput);
      socket.off('flow_node_end', onEnd);
      socket.off('flow_run_end', onRunEnd);
      socket.off('flow_awaiting_approval', onApproval);
    };
  }, [runId, refresh]);

  return { runId: runId ?? '', ...state, refresh, reset };
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
