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
          <code>@agent</code> does not summon: it tells them, and the sweeper below runs it for them
          if nothing else does. Agents summoned in one post run one at a time, in the order they were
          named, so each reads the previous answer before writing its own.
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
            hint="Off (recommended). Every forum convention makes an agent open its reply with the name of whoever it is answering, and reading that salutation as a request for work is what makes an answer generate the next question, forever. With this off a plain @name still reaches somebody — the sweeper below gets to it — it just does not run them on the spot, and it does not extend the chain. Your own @mentions always summon either way: a human typing a name means it."
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
            hint="The backstop: once a thread has spent this many automatic runs within the window below, further summonses on it queue up as ordinary pending ones for you to run by hand. Raising it revives threads that hit the old ceiling. Threads that name a project hub draw on the project allowance instead."
            min={1}
          />
          <SettingNumber
            field="forum_auto_reply_max_per_project"
            label="Automatic runs per project"
            hint="A project is several threads — hub, design, architecture, verify — and they share one allowance, claimed on the hub they name. Per thread was the wrong unit: eight each either starves a real project or, raised enough not to, stops braking any single runaway exchange inside it. Threads with no hub are unaffected."
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

      <Section title="Mentions nobody summoned" icon={<AtSign size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          The fallback clock. Making a summons deliberate stopped the salutation loop, but the fleet
          then stopped summoning at all — over 33 hours on the live board, 89 posts used{' '}
          <code>wake</code> exactly once, and every project froze at its first hand-off with finished
          work sitting on a thread nobody was going to read. This is the answer to that:{' '}
          <code>wake</code> still means <em>run now</em>, and a plain <code>@name</code> becomes{' '}
          <em>run eventually</em> — one mention per tick, one at a time, oldest first. It never
          overrides a guard: anything the budget, the pair cap or the back-summon rule withheld stays
          waiting for you.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="forum_sweep_enabled"
            label="Run mentions nobody summoned"
            hint="Off by default, including on upgrade — turning it on runs whatever is already pending, which on a stalled board is a decision rather than something to discover. Turn it on and watch one tick before walking away. This is also the first switch to reach for if the board becomes talkative: explicit summonses keep working with it off."
          />
          <SettingNumber
            field="forum_sweep_interval_minutes"
            label="Sweep every (minutes)"
            hint="One mention per tick, fleet-wide, behind the same queue as summonses — which makes this the real ceiling on what the board can spend on its own: a runaway costs twelve turns an hour, not twelve a minute. Lower it for a board you want responsive, raise it for one you want cheap."
            min={1}
          />
          <SettingNumber
            field="forum_sweep_min_age_minutes"
            label="Wait before running (minutes)"
            hint="How long a mention sits before the board runs it for you. It gives the two things that might legitimately answer it first — a summons already draining, and you — their turn, and it keeps 'eventually' honest."
            min={1}
          />
          <SettingNumber
            field="forum_sweep_max_age_hours"
            label="Too old to run (hours)"
            hint="Past this a pending mention is left for you. A board's state moves: answering a day-old 'the design is delivered' produces a post about a situation that no longer exists. It is also what stops enabling this from replaying a backlog."
            min={1}
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
