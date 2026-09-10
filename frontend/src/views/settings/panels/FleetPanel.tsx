import { AtSign, FileLock2, Gauge, ListChecks, Sparkles } from 'lucide-react';
import { Section } from '../../../components/ui';
import { FinetuneServersManager } from '../managers/FinetuneServersManager';
import {
  EndpointModelPicker,
  SettingNumber,
  SettingText,
  SettingTextarea,
  SettingToggle,
} from '../controls';

/** `/settings/fleet` — the rules and services every agent in the fleet inherits. */
export function FleetPanel() {
  return (
    <div className="animate-fade-up space-y-5">
      <Section title="House rules (AGENTS.md)" icon={<FileLock2 size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Standing instructions injected into every agent's prompt, subagents included. Agents cannot
          edit this — no tool writes it. Per-agent instructions live on each agent's page; the agent's
          own writable notes are its Notebook.
        </p>
        <SettingTextarea
          field="agents_md"
          label="AGENTS.md"
          rows={12}
          placeholder={'# House rules\n- Rules every agent in this fleet must follow.'}
          hint="Markdown. Leave empty to inject nothing. Takes effect on each agent's next turn — no restart."
        />
      </Section>

      <Section title="The work board" icon={<ListChecks size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Projects run themselves here: a task is dispatched to its owner the moment everything it
          depends on has been <em>accepted by somebody else</em>, and no agent has to remember to
          hand work on. Nothing is dispatched while this is off, and a project stays a draft until
          you start it — so turning this on with nothing planned does nothing at all.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="forum_board_enabled"
            label="Dispatch tasks automatically"
            hint="Off → the board is a plan you run by hand, task by task, with the Run button on each one. On → the scheduler dispatches ready tasks and their reviews on its own clock. Every other limit here still applies either way."
          />
          <SettingNumber
            field="forum_tick_interval_minutes"
            label="Tick every (minutes)"
            hint="How often the board reaps finished runs, works out what is ready and dispatches. Short is cheap here in a way the old mention sweep never was: a tick with nothing ready runs no inference at all — it is one indexed find per running project."
            min={1}
          />
          <SettingNumber
            field="forum_max_parallel"
            label="Tasks running at once"
            hint="1 unless your inference endpoint genuinely serves concurrent streams. Raise it and the scheduler will happily dispatch four turns into a queue of one, and every one of them spends its project's allowance while it waits."
            min={1}
          />
          <SettingNumber
            field="forum_plan_max_turns"
            label="Agent turns per project"
            hint="The leash, counted across a project's whole life — work turns, review turns and planning turns alike. Copied onto each project when it is opened and raisable there, so lifting this does not quietly restart a project you let run out on purpose."
            min={1}
          />
          <SettingNumber
            field="forum_task_max_dispatches"
            label="Empty runs before a task is blocked"
            hint="A task dispatched this many times that comes back without a submission is parked for the manager. Without it, a task no agent can actually do is re-dispatched every tick until the project's whole allowance is gone."
            min={1}
          />
          <SettingNumber
            field="forum_task_max_review_rounds"
            label="Review bounces before escalating"
            hint="How many times a reviewer may send a task back before the manager decides instead. Two agents disagreeing about what 'done' means do not converge by repeating themselves at each other."
            min={1}
          />
          <SettingNumber
            field="forum_plan_max_revisions"
            label="Replans before the project stops"
            hint="How many times the manager may rewrite one plan before it stops and asks you. A manager that keeps being called and keeps changing nothing is the shape this catches."
            min={1}
          />
          <SettingText
            field="forum_project_manager_agent"
            label="Project manager agent"
            hint="The agent that plans a project and is called when one hits a problem — it never dispatches anything itself. Empty falls back to an agent named project_manager."
          />
        </div>
      </Section>

      <Section title="What agents may post" icon={<AtSign size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Every agent post declares a kind — <code>status</code>, <code>finding</code>,{' '}
          <code>question</code>, <code>handoff</code>, <code>decision</code>, <code>review</code>,{' '}
          <code>note</code> — and each kind has a required field and a length ceiling. A post that
          misses either is refused <em>before</em> it lands, with the defect named, so the agent
          fixes it in the same turn. This is the guard that runs before a turn is spent; the
          repetition check below only catches a restatement after one already has been.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="forum_post_contract_enabled"
            label="Hold agent posts to their kind"
            hint="On. Switching it off restores the world this replaced, where a status update could be three thousand characters of restatement. Your own posts are never held to it — a human writing on the board is not the failure mode it exists for."
          />
        </div>
      </Section>

      <Section title="Forum mentions" icon={<AtSign size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Naming somebody on the board tells them: it notifies, and it shows on their next turn. It
          no longer starts a turn for them, and it no longer needs to — work moves because the board
          dispatches a task, not because an agent remembered to wake somebody. You can still run any
          mention by hand from the thread or the triage list. These budgets govern that older path on
          threads outside a project.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="forum_auto_reply"
            label="Run mentions automatically"
            hint="Off → a mention raises a notification and waits for you. This is the pre-board mechanism and it is kept for threads that are conversations rather than work."
          />
          <SettingNumber
            field="forum_auto_reply_max_per_thread"
            label="Automatic runs per thread"
            hint="Once a thread has spent this many automatic runs within the window below, further mentions on it wait for you."
            min={1}
          />
          <SettingNumber
            field="forum_auto_reply_max_per_project"
            label="Automatic runs per hub"
            hint="Threads that name the same hub thread share one allowance, claimed on the hub. Projects on the board have their own turn budget instead, above."
            min={1}
          />
          <SettingNumber
            field="forum_auto_reply_window_hours"
            label="Budget window (hours)"
            hint="The allowance above is spent over this rolling window and then refills. 0 counts over the thread's whole life."
            min={0}
          />
        </div>
      </Section>

      <Section title="Conversation quality scorer" icon={<Gauge size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Scores each completed turn 0–100 + a tag (Perfect/Patched/Recovered/Rejected) for the
          fine-tuning dataset. Manage scores on the Scoring page.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="scoring_enabled"
            label="Auto-score turns"
            hint="When on, every completed turn is scored automatically by the judge. Off → score only from the Scoring page (manual / batch)."
          />
          <EndpointModelPicker
            endpointField="scoring_endpoint_id"
            modelField="scoring_model"
            label="Judge model"
            noneLabel="Agent's own model"
            hint="The LLM-as-judge that rates turns. “Agent's own model” reuses the default endpoint; for reliable scores prefer a specific, capable endpoint (judged at temperature 0)."
          />
          <SettingNumber
            field="scoring_max_tokens"
            label="Judge max tokens"
            hint="Token budget for the judge's reply. Reasoning judges spend tokens on a <think> block before the JSON verdict, so keep this ≥512."
            min={64}
          />
        </div>
      </Section>

      <Section title="Fine-tune servers" icon={<Sparkles size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Remote GPU training servers driven from the Fine-Tuning page.
        </p>
        <FinetuneServersManager />
      </Section>
    </div>
  );
}
