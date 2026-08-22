import { Agenda, type Job } from 'agenda';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { sessionLock } from '../core/session/SessionLock';
import { agentRunner } from '../orchestrator/AgentRunner';
import { agentRepository } from '../domain/agents/agent.repository';
import { flowRepository } from '../domain/flows/flow.repository';
import { flowRunner } from '../flows/FlowRunner';
import { runResultRepository } from '../domain/autonomy/run-result.repository';
import { alertEngine } from '../alerts/AlertEngine';
import { conversationGenService } from '../domain/conversation-gen/conversation-gen.service';
import { generatorRepository } from '../domain/conversation-gen/generator.repository';
import type { ConversationGeneratorDoc } from '../domain/conversation-gen/generator.model';
import { forumSweeper } from '../domain/forum/forum-sweeper';
import { settingsService } from '../domain/settings/settings.service';

const log = createLogger('agenda');

export const AUTONOMOUS_RUN_JOB = 'agent:autonomous_run';

/**
 * The forum's fallback clock (`FORUM_AUTORUN_PLAN.md`).
 *
 * Through Agenda rather than an in-process interval, which is the house rule for anything
 * cron-shaped: the schedule survives a restart with no bespoke `restore()`, the job is locked in
 * Mongo so nothing can double-sweep, and the operator can see it in `agenda_jobs` beside every other
 * scheduled thing. `TimerScheduler`'s in-process timers are the exception, and only because a stream
 * ticks in seconds — a five-minute sweep has no such excuse.
 */
export const FORUM_SWEEP_JOB = 'forum:mention_sweep';

/** Scheduled execution of a saved flow (FLOWS_PLAN.md §7). */
export const FLOW_RUN_JOB = 'flow:scheduled_run';

/** Payload of a scheduled flow run. */
export interface FlowJobData {
  flowId: string;
  flowName: string;
  /** Values for the flow's `input` nodes, keyed by input name. */
  inputs?: Record<string, unknown>;
  /** Alert on completion (default true). */
  alert?: boolean;
  scheduleId?: string;
  cron?: string;
  once?: boolean;
}

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

  // Scheduled flows (FLOWS_PLAN.md §7). Deliberately the same tail as an autonomous task: the result
  // is recorded in the run history and fanned out to the inbox and Telegram, so "my pipeline ran
  // overnight" reaches the operator through the channel they already watch. No session yielding —
  // a flow's agent nodes each yield on their own agent, which is the lock that actually matters.
  agenda.define(FLOW_RUN_JOB, async (job: Job<FlowJobData>) => {
    const { flowId, flowName, inputs = {}, alert = true } = job.attrs.data;
    const scheduleId = job.attrs.data.scheduleId ?? String(job.attrs._id);
    const flow = await flowRepository.findById(flowId);
    if (!flow) {
      log.warn({ flowId, flowName }, 'scheduled flow skipped: flow not found');
      return;
    }
    if (!flow.enabled) {
      log.info({ flow: flow.name }, 'scheduled flow skipped: disabled');
      return;
    }

    log.info({ flow: flow.name }, 'running scheduled flow');
    const startedAt = new Date();
    const outcome = await flowRunner.start({ flow, trigger: 'cron', inputs });
    const ok = outcome.status === 'success';

    await runResultRepository
      .record({
        schedule_id: scheduleId,
        agent_name: `flow:${flow.name}`,
        prompt: Object.keys(inputs).length ? JSON.stringify(inputs) : '(no inputs)',
        status: ok ? 'success' : 'error',
        output: ok ? outcome.output : (outcome.error ?? 'the flow failed'),
        started_at: startedAt,
      })
      .catch((e) => log.error({ err: e }, 'failed to persist flow run result'));

    if (alert) {
      await alertEngine
        .dispatch({
          agentId: flowId,
          title: `${ok ? 'Flow complete' : 'Flow FAILED'}: ${flow.name}`,
          content: (ok ? outcome.output : (outcome.error ?? '')).slice(0, 2000),
        })
        .catch((e) => log.error({ err: e }, 'failed to dispatch flow alert'));
    }
  });

  // Conversation Generator (docs/conversation-generator.md): an interviewer agent chats up a target
  // agent to harvest training data. The service owns the yielding, persistence and error recording —
  // the job is just the clock.
  agenda.define(CONVERSATION_GEN_JOB, async (job: Job<ConversationGenJobData>) => {
    const { generatorId } = job.attrs.data;
    await conversationGenService.runOnce(generatorId);
  });

  // The handler is only the clock: it hands the queue one mention and returns in milliseconds. It
  // must never await the turn — an inference run can outlast the job's lock, and a scheduler that
  // re-fires a job it believes died would start a second turn on the same mention.
  agenda.define(FORUM_SWEEP_JOB, async () => {
    await forumSweeper.tick();
  });

  agenda.on('fail', (err: Error, job: Job) => {
    log.error({ err, job: job.attrs.name }, 'agenda job failed');
  });

  await agenda.start();
  await syncConversationGenerators();
  await syncForumSweep();
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

/**
 * (Re)register the forum sweep tick. Cancel-then-create, like the generators, so a changed interval
 * takes effect without a restart and a restart cannot leave two ticks racing.
 *
 * Registered whether or not sweeping is enabled: the switch is re-read inside `tick()`, so toggling
 * it in Settings takes effect on the next tick rather than needing the schedule rebuilt. `skipImmediate`
 * so saving an unrelated setting never fires a sweep on the spot.
 */
export async function syncForumSweep(): Promise<void> {
  const a = getAgenda();
  await a.cancel({ name: FORUM_SWEEP_JOB });
  const settings = await settingsService.get();
  const minutes = Math.max(1, settings.forum_sweep_interval_minutes ?? 5);
  const job = a.create(FORUM_SWEEP_JOB, {});
  job.repeatEvery(`${minutes} minutes`, { skipImmediate: true });
  await job.save();
  log.info({ every: minutes, enabled: settings.forum_sweep_enabled === true }, 'forum sweep scheduled');
}
