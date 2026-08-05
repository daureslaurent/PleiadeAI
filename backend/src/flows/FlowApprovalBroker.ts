import { createLogger } from '../config/logger';
import { eventBus } from '../core/event-bus/EventBus';
import { flowRunRepository } from '../domain/flows/flow-run.repository';
import type { EventContext } from '../core/event-bus/events.types';

const log = createLogger('flow-approval');

/** How long a gate waits for the operator before failing the run. */
const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface Pending {
  runId: string;
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The human gate in a flow (flows spec §3).
 *
 * `AskUserBroker` is the model, with one deliberate difference: the pending question is *also*
 * persisted on the run document, and the answer arrives over HTTP rather than the socket. A chat
 * question belongs to the socket that asked it; a flow can sit paused for a day, so its gate has to
 * survive a page reload, a different browser, and the operator going home — everything except a
 * backend restart, which the boot sweep fails honestly.
 */
class FlowApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  /** Block until the operator answers. `runId` keys the gate — one pause per run at a time. */
  async ask(
    ctx: EventContext,
    input: { runId: string; nodeId: string; question: string; artifacts: string[] },
  ): Promise<boolean> {
    await flowRunRepository.setPending(input.runId, {
      node_id: input.nodeId,
      kind: 'approval',
      question: input.question,
      artifacts: input.artifacts,
      asked_at: new Date(),
    });

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(input.runId);
        reject(new Error('the operator did not answer the approval gate in time'));
      }, APPROVAL_TIMEOUT_MS);
      // A pending gate holds a promise for up to a day; `unref` keeps it from pinning the process
      // alive during a shutdown that would fail the run anyway.
      timer.unref?.();

      this.pending.set(input.runId, { runId: input.runId, resolve, reject, timer });
      eventBus.emit('flow:awaiting_approval', {
        ctx,
        runId: input.runId,
        nodeId: input.nodeId,
        question: input.question,
        artifacts: input.artifacts,
      });
      log.info({ runId: input.runId, nodeId: input.nodeId }, 'flow run awaiting approval');
    });
  }

  /** Deliver the operator's decision. Returns false when no gate was waiting (already answered). */
  async answer(runId: string, approved: boolean): Promise<boolean> {
    const gate = this.pending.get(runId);
    if (!gate) return false;
    clearTimeout(gate.timer);
    this.pending.delete(runId);
    await flowRunRepository.setPending(runId, null);
    gate.resolve(approved);
    return true;
  }

  /** Abandon a run's gate (the operator stopped the run). */
  cancel(runId: string): void {
    const gate = this.pending.get(runId);
    if (!gate) return;
    clearTimeout(gate.timer);
    this.pending.delete(runId);
    gate.reject(new Error('the run was stopped'));
  }

  /** Whether a run is currently parked on a gate — used by the routes to answer 409 vs 200. */
  isWaiting(runId: string): boolean {
    return this.pending.has(runId);
  }
}

export const flowApprovalBroker = new FlowApprovalBroker();
