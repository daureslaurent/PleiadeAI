import { AtSign, ChevronsRight, FileLock2, Gauge, GitFork, Sparkles } from 'lucide-react';
import { Section } from '../../../components/ui';
import { FinetuneServersManager } from '../managers/FinetuneServersManager';
import {
  EndpointModelPicker,
  SettingNumber,
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

      <Section title="Tool calls in parallel" icon={<ChevronsRight size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          A model that asks for three things in one message has already decided they are independent
          — it cannot see any result until all of them come back. Running them at once costs the
          longest of the three instead of the sum of all three. Only calls a tool declares safe ever
          overlap (reads: <code>read</code>, <code>grep</code>, a forum <em>search</em>) — a write,
          a <code>bash</code>, a delegation or a skill always runs alone, and results are still fed
          back in the order the model asked for them.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="tool_parallel_enabled"
            label="Overlap independent calls"
            hint="Off → every call runs strictly one after another, as before. On → the parallel-safe run of a batch executes together; the chat draws those calls as one group with a bar each, so you can see which one held the batch up."
          />
          <SettingNumber
            field="tool_parallel_max"
            label="Calls in flight at once"
            hint="0 means unlimited — the whole safe run starts together. A small number is the throttle for an isolated container that does not enjoy several simultaneous commands; it never changes what runs, only how much of it runs at the same moment."
            min={0}
          />
        </div>
      </Section>

      <Section title="Subagents" icon={<GitFork size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          An agent can hand a self-contained piece of its own work to a <code>task</code> subagent —
          a fresh copy of itself with an empty context — and gets back only a short report. The
          reading stays out of the parent's context, so a big model with a small window can direct
          a smaller, long-context one. Independent <em>explore</em> tasks run together: as many as the
          subagent endpoint's <strong>Parallel streams</strong> (Connections page) allow, and one
          after another when that is 1. A <em>work</em> task, which may change things, always runs
          alone. The prompt side is the Subagents module; which other modules a child also gets is
          its "In subagent runs" switch on the Modules page.
        </p>
        <div className="space-y-4">
          <EndpointModelPicker
            endpointField="subagent_endpoint_id"
            modelField="subagent_model"
            label="Subagent model"
            noneLabel="Each agent's own model"
            hint="Where task subagents run, unless an agent picks its own on the Agents page. A smaller model with a long context suits them: children read and report, the parent judges. Its endpoint's Parallel streams is how many children run at once."
          />
          <SettingNumber
            field="subagent_report_max_chars"
            label="Longest report (characters)"
            hint="The most one subagent report may be. Each report is also shrunk to what the parent's remaining context can hold across every task in the same reply, so a small-window parent never overflows when several reports land together."
            min={500}
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
            hint="On. Switching it off restores the world this replaced, where a status update could be three thousand characters of restatement. Your own posts are never held to it — a human writing on the forum is not the failure mode it exists for."
          />
        </div>
      </Section>

      <Section title="Forum mentions" icon={<AtSign size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Naming somebody on the forum tells them: it notifies, and it shows on their next turn. It
          does not start a turn for them — the <code>wake</code> argument of the same post is what
          does, and every post that names somebody has to pass it. You can still run any mention by
          hand from the thread or the triage list. These budgets govern that older automatic path.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="forum_auto_reply"
            label="Run mentions automatically"
            hint="Off → a mention raises a notification and waits for you. Kept for threads that are conversations rather than work."
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
            hint="Threads that name the same hub thread share one allowance, claimed on the hub, so a project spanning five threads is not five separate budgets."
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
