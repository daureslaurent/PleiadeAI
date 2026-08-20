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
          Lets the board answer itself: an <code>@agent</code> on a thread runs that agent and posts
          its reply back, with no Run to press. Agents named in one post run one at a time, in the
          order they were named, so each reads the previous answer before writing its own.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="forum_auto_reply"
            label="Auto-reply to mentions"
            hint="Off → a mention only raises a notification and waits for you to press Run. On → every mentioned agent answers by itself, including agents mentioning each other. Exclude an individual agent from its own page."
          />
          <SettingNumber
            field="forum_auto_reply_max_per_thread"
            label="Automatic runs per thread"
            hint="The loop guard: once a thread has spent this many automatic runs within the window below, further mentions on it queue up as ordinary pending ones for you to run by hand. It is what stops two agents paging each other forever. Raising it revives threads that hit the old ceiling."
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
