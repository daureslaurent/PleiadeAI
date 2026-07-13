import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePrefs } from '../../store/prefs';
import { APP_VERSION } from '../../version';
import { CATEGORIES, type SettingsCategory } from './categories';
import { useSettings } from './context';

/**
 * `/settings` — the category index (DIRECT_ART §3/§4): a grid of glass cards, one per category,
 * each routing to its own page. Every card carries a live status line so the operator can read the
 * fleet's configuration off this page without opening anything.
 */
export function SettingsHome() {
  const { form, endpoints, finetuneServers } = useSettings();
  const showSubagentThinking = usePrefs((s) => s.showSubagentThinking);

  const defaultEndpoint = endpoints.find((e) => e.is_default);
  const defaultModel = defaultEndpoint?.default_model || defaultEndpoint?.models[0];
  const enabledServers = finetuneServers.filter((s) => s.enabled).length;

  /** The one fact per category that is worth reading at a glance. */
  const status: Record<string, string> = {
    inference: defaultEndpoint
      ? `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} · default ${defaultEndpoint.name}${
          defaultModel ? ` / ${defaultModel}` : ''
        }`
      : 'no default endpoint set',
    memory: form.memory_distill_enabled ? 'distilling memories from turns' : 'distillation off — `remember` only',
    fleet: [
      form.agents_md.trim() ? 'house rules set' : 'no house rules',
      `scoring ${form.scoring_enabled ? 'on' : 'off'}`,
      `${enabledServers} FT server${enabledServers === 1 ? '' : 's'}`,
    ].join(' · '),
    interface: `sub-agent thinking ${showSubagentThinking ? 'shown' : 'hidden'}`,
    system: `v${APP_VERSION} · updates ${form.update_enabled ? 'enabled' : 'disabled'}`,
    access: 'keys, export/import, clear data',
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
          <p className="mt-1 text-sm text-slate-500">
            Fleet-wide configuration. Changes save as you make them and take effect on each agent's
            next turn — no restart.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((category, i) => (
            <CategoryCard
              key={category.slug}
              category={category}
              status={status[category.slug] ?? ''}
              index={i}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function CategoryCard({
  category,
  status,
  index,
}: {
  category: SettingsCategory;
  status: string;
  index: number;
}) {
  const { icon: Icon, tone = 'accent' } = category;
  const tile =
    tone === 'danger'
      ? 'bg-red-500/10 text-red-400 ring-red-500/20'
      : 'bg-accent/10 text-accent ring-accent/20';

  return (
    <Link
      to={category.slug}
      // Staggered entrance so the grid resolves as one gesture rather than six (DIRECT_ART §6).
      style={{ animationDelay: `${index * 40}ms` }}
      className="glass-card group flex animate-fade-up flex-col rounded-2xl border border-white/[0.06] p-4 transition-colors hover:border-white/[0.12]"
    >
      <div className="flex items-start gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${tile}`}>
          <Icon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <h3 className="truncate text-sm font-semibold text-slate-100">{category.title}</h3>
            <ChevronRight
              size={15}
              className="ml-auto shrink-0 text-slate-600 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-400"
            />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{category.blurb}</p>
        </div>
      </div>

      <div className="mb-3 mt-3 flex flex-wrap gap-1">
        {category.contains.map((section) => (
          <span
            key={section}
            className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-slate-400"
          >
            {section}
          </span>
        ))}
      </div>

      {/* `mt-auto` pins the status line to the card's bottom edge, so the row reads as one baseline
          however many lines the blurb and chips above it happen to take. */}
      <div className="mt-auto truncate border-t border-white/[0.06] pt-2 font-mono text-[10px] text-slate-500">
        {status}
      </div>
    </Link>
  );
}
