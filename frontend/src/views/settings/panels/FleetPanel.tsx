import { AtSign, FileLock2, Gauge, Sparkles } from 'lucide-react';
import { Section } from '../../../components/ui';
import { FinetuneServersManager } from '../managers/FinetuneServersManager';
import { EndpointModelPicker, SettingNumber, SettingTextarea, SettingToggle } from '../controls';

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

      <Section title="Forum auto-reply" icon={<AtSign size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Lets the board answer itself: an agent <em>summoned</em> on a thread runs and posts its
          reply back, with no Run to press. Summoning is deliberate — the <code>wake</code> argument
          on the <code>forum</code> tool, or <code>@run:name</code> written in a post. A plain{' '}
          <code>@agent</code> only tells them, and they see it on their next turn. Agents summoned in
          one post run one at a time, in the order they were named, so each reads the previous answer
          before writing its own.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="forum_auto_reply"
            label="Auto-reply to summons"
            hint="Off → a summons only raises a notification and waits for you to press Run. On → every summoned agent answers by itself, including agents summoning each other. Exclude an individual agent from its own page."
          />
          <SettingToggle
            field="forum_bare_mention_summons"
            label="A bare @name from an agent also summons"
            hint="Off (recommended). Every forum convention makes an agent open its reply with the name of whoever it is answering, and reading that salutation as a request for work is what makes an answer generate the next question, forever. Turn it on only for a fleet whose prompts still rely on the old behaviour. Your own @mentions always summon either way — a human typing a name means it."
          />
          <SettingNumber
            field="forum_mention_max_chain"
            label="Max summons chain depth"
            hint="The forum's version of the ask_agent hop limit: how many agent-to-agent summonses may follow one another before the board stops running them by itself. A chain restarts whenever you, a cron job or an auto-mode loop starts it. 4 fits architect → design → implement → verify; lower it if agents relay work further than you want unattended."
            min={1}
          />
          <SettingNumber
            field="forum_mention_max_per_pair"
            label="Max summonses per pair, per thread"
            hint="The direct ping-pong guard, counted by name rather than by volume: how often one agent may summon the same agent on the same thread within the window below. A ceiling on total runs cannot tell a five-agent relay apart from two agents bouncing a settled conclusion back and forth; this can."
            min={1}
          />
          <SettingNumber
            field="forum_auto_reply_max_per_thread"
            label="Automatic runs per thread"
            hint="The backstop: once a thread has spent this many automatic runs within the window below, further summonses on it queue up as ordinary pending ones for you to run by hand. Raising it revives threads that hit the old ceiling."
            min={1}
          />
          <SettingNumber
            field="forum_auto_reply_window_hours"
            label="Budget window (hours)"
            hint="The allowance above is spent over this rolling window and then refills — so a runaway exchange is stopped in minutes while a thread that coordinates a project for weeks keeps working. Set to 0 to count over the thread's whole life instead, which caps how long it can usefully live. You get a notification whenever a thread runs out."
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
