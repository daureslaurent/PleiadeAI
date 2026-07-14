import { Agenda, type Job } from 'agenda';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { sessionLock } from '../core/session/SessionLock';
import { agentRunner } from '../orchestrator/AgentRunner';
import { agentRepository } from '../domain/agents/agent.repository';
import { runResultRepository } from '../domain/autonomy/run-result.repository';
import { alertEngine } from '../alerts/AlertEngine';
import { conversationGenService } from '../domain/conversation-gen/conversation-gen.service';
import { generatorRepository } from '../domain/conversation-gen/generator.repository';
import type { ConversationGeneratorDoc } from '../domain/conversation-gen/generator.model';

const log = createLogger('agenda');

export const AUTONOMOUS_RUN_JOB = 'agent:autonomous_run';

/** Conversation Generator tick: one generated conversation with one target agent. */
export const CONVERSATION_GEN_JOB = 'conversation:generate';

/** Payload of a Conversation Generator tick. */
interface ConversationGenJobData {
  generatorId: string;
}

/** Payload persisted with each scheduled autonomous job. */
export interface AutonomousJobData {
  /** The agent the task runs as. */
  agentName: string;
  prompt: string;
  /** Alert on completion (default true). */
  alert?: boolean;
  /**
   * Stable id of the schedule that owns this run, used to group run results in the history.
   * Set to the Agenda job `_id` at creation time and carried through run-now executions so
   * ad-hoc runs share the same history as scheduled ones.
   */
  scheduleId?: string;
  /**
   * The agent that created and owns this task (authority for tool-side CRUD rights). Only set on
   * jobs scheduled by an agent via `schedule_task`; operator-created (UI) jobs leave it unset.
   */
  ownerAgent?: string;
  /**
   * One-shot jobs only: the cron expression the run time was computed from (recurring jobs carry
   * theirs in Agenda's `repeatInterval`). Purely informational — the concrete `nextRunAt` is what
   * fires. `once: true` marks the job as a single-run schedule in list/describe output.
   */
  cron?: string;
  once?: boolean;
}

/** How long a queued cron job waits for a live user session before re-queuing itself. */
const YIELD_TIMEOUT_MS = 5 * 60_000;

let agenda: Agenda | undefined;

/**
 * Configure Agenda against the shared Mongo database and register the autonomous-run job.
 *
 * Concurrency rule (spec §5): before executing, the job yields to any active user session on
 * the same agent. If the agent is still busy after `YIELD_TIMEOUT_MS`, the job re-schedules
 * itself shortly after rather than starving the user or blocking the Agenda worker.
 */
export async function setupAgenda(): Promise<Agenda> {
  agenda = new Agenda({
    db: { address: env.MONGO_URI, collection: 'agenda_jobs' },
    processEvery: '15 seconds',
  });

  agenda.define(AUTONOMOUS_RUN_JOB, async (job: Job<AutonomousJobData>) => {
    const { agentName, prompt, alert = true } = job.attrs.data;
    // Ad-hoc run-now jobs carry the owning schedule's id; scheduled jobs are their own schedule.
    const scheduleId = job.attrs.data.scheduleId ?? String(job.attrs._id);
    const agent = await agentRepository.findByName(agentName);
    if (!agent) {
      log.warn({ agentName }, 'autonomous job skipped: agent not found');
      return;
    }
    const agentId = String(agent._id);

    // Yield to an active user session; re-queue if it stays busy too long.
    const free = await sessionLock.waitUntilFree(agentId, YIELD_TIMEOUT_MS);
    if (!free) {
      log.info({ agentName }, 'agent still busy; re-queuing autonomous job');
      await agenda?.schedule('in 1 minute', AUTONOMOUS_RUN_JOB, job.attrs.data);
      return;
    }

    log.info({ agentName }, 'running autonomous task');
    const startedAt = new Date();
    let answer: string;
    try {
      answer = (
        await agentRunner.run({
          agentName,
          sessionId: `cron-${randomUUID()}`,
          depth: 0,
          userText: prompt,
        })
      ).text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runResultRepository
        .record({
          schedule_id: scheduleId,
          agent_name: agentName,
          prompt,
          status: 'error',
          output: message,
          started_at: startedAt,
        })
        .catch((e) => log.error({ err: e }, 'failed to persist autonomous run result'));
      // A failed run still ran — alert on it too (Telegram + inbox) so failures aren't silent.
      if (alert) {
        await alertEngine
          .dispatch({
            agentId,
            title: `Autonomous task FAILED: ${agentName}`,
            content: message.slice(0, 2000),
          })
          .catch((e) => log.error({ err: e }, 'failed to dispatch failure alert'));
      }
      throw err;
    }

    await runResultRepository
      .record({
        schedule_id: scheduleId,
        agent_name: agentName,
        prompt,
        status: 'success',
        output: answer,
        started_at: startedAt,
      })
      .catch((e) => log.error({ err: e }, 'failed to persist autonomous run result'));

    if (alert) {
      await alertEngine.dispatch({
        agentId,
        title: `Autonomous task complete: ${agentName}`,
        content: answer.slice(0, 2000),
      });
    }
  });

  // Conversation Generator (docs/conversation-generator.md): an interviewer agent chats up a target
  // agent to harvest training data. The service owns the yielding, persistence and error recording —
  // the job is just the clock.
  agenda.define(CONVERSATION_GEN_JOB, async (job: Job<ConversationGenJobData>) => {
    const { generatorId } = job.attrs.data;
    await conversationGenService.runOnce(generatorId);
  });

  agenda.on('fail', (err: Error, job: Job) => {
    log.error({ err, job: job.attrs.name }, 'agenda job failed');
  });

  await agenda.start();
  await syncConversationGenerators();
  log.info('agenda started');
  return agenda;
}

export function getAgenda(): Agenda {
  if (!agenda) throw new Error('Agenda not initialised; call setupAgenda() first');
  return agenda;
}

/**
 * (Re)register one generator's repeating job: cancels whatever was scheduled for it, then re-creates
 * the tick when it's enabled. Called on every create/update/delete so the schedule in Mongo always
 * matches the row the operator sees. `skipImmediate` so saving a generator doesn't instantly fire a
 * conversation — the operator has "Run now" for that.
 */
export async function scheduleGenerator(gen: ConversationGeneratorDoc): Promise<void> {
  const a = getAgenda();
  const generatorId = String(gen._id);
  await a.cancel({ name: CONVERSATION_GEN_JOB, 'data.generatorId': generatorId });
  if (!gen.enabled) return;

  const job = a.create<ConversationGenJobData>(CONVERSATION_GEN_JOB, { generatorId });
  job.repeatEvery(`${Math.max(1, gen.interval_minutes)} minutes`, { skipImmediate: true });
  await job.save();
  log.info({ generatorId, agent: gen.target_agent_name, every: gen.interval_minutes }, 'generator scheduled');
}

/** Drop a generator's repeating job (deleted row). */
export async function unscheduleGenerator(generatorId: string): Promise<void> {
  await getAgenda().cancel({ name: CONVERSATION_GEN_JOB, 'data.generatorId': generatorId });
}

/**
 * Rebuild every generator tick from the collection at boot. Agenda persists jobs in Mongo, so a
 * restart would otherwise keep running ticks for generators that have since been disabled or deleted:
 * clear the lot and re-register only what's currently enabled.
 */
export async function syncConversationGenerators(): Promise<void> {
  const a = getAgenda();
  await a.cancel({ name: CONVERSATION_GEN_JOB });
  const enabled = await generatorRepository.listEnabled();
  for (const gen of enabled) await scheduleGenerator(gen);
  log.info({ count: enabled.length }, 'conversation generators synced');
}
