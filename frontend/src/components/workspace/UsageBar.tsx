import type { ModuleGroup, PromptUsageBreakdown, PromptUsageModuleGroup } from '../../lib/api';

/**
 * One hue family per module group (`ModulesSettings.tsx`'s `GROUP_LABELS` grouping, mirrored here so
 * the Usage tab's legend reads the same way the Settings page's module list is organized), cycling
 * through its shades for however many of that group's modules actually rendered a block this turn.
 * Written out in full — Tailwind scans source for literal class names, so a computed `bg-${x}-400`
 * would never make it into the stylesheet — and limited to this theme's configured ramps
 * (`tailwind.config.ts`: slate/amber/indigo/rose/sky/emerald, plus the `accent`/`reasoning` tokens).
 */
const GROUP_PALETTE: Record<ModuleGroup, string[]> = {
  core: ['bg-slate-400', 'bg-slate-300', 'bg-slate-500'],
  operator: ['bg-amber-400', 'bg-amber-300', 'bg-amber-500', 'bg-amber-200'],
  self: ['bg-indigo-400', 'bg-indigo-300', 'bg-indigo-500'],
  work: ['bg-rose-400', 'bg-rose-300', 'bg-rose-500', 'bg-rose-200'],
  capabilities: ['bg-sky-400', 'bg-sky-300', 'bg-sky-500', 'bg-sky-200'],
};

/** The fixed non-module consumers of the window — same handful every turn, so fixed colors suit. */
const CATEGORY_COLOR: Record<string, string> = {
  system_prompt: 'bg-accent',
  injected_system: 'bg-accent/60',
  tool_schemas: 'bg-reasoning',
  user: 'bg-emerald-400',
  assistant: 'bg-emerald-300',
  tool_results: 'bg-emerald-200',
  reasoning: 'bg-emerald-500',
};

/** Stable within one breakdown: shade index = position among same-group modules that rendered. */
export function moduleColor(
  group: PromptUsageModuleGroup,
  moduleGroups: PromptUsageModuleGroup[],
): string {
  const palette = GROUP_PALETTE[group.moduleGroup];
  const siblings = moduleGroups.filter((g) => g.moduleGroup === group.moduleGroup);
  const index = Math.max(
    siblings.findIndex((g) => g.moduleId === group.moduleId),
    0,
  );
  return palette[index % palette.length]!;
}

export function categoryColor(id: string): string {
  return CATEGORY_COLOR[id] ?? 'bg-slate-400';
}

export interface BarItem {
  key: string;
  label: string;
  tokens: number;
  color: string;
}

/** One item per rendered module, one per non-empty non-module category — what `UsageDetailList` also builds rows from. */
export function usageBarItems(breakdown: PromptUsageBreakdown): BarItem[] {
  const items: BarItem[] = breakdown.moduleGroups
    .filter((g) => g.tokens > 0)
    .map((g) => ({
      key: `module:${g.moduleId}`,
      label: g.moduleName,
      tokens: g.tokens,
      color: moduleColor(g, breakdown.moduleGroups),
    }));
  for (const s of breakdown.segments) {
    if (s.kind === 'module' || !(s.tokens ?? 0)) continue;
    items.push({ key: `cat:${s.id}`, label: s.label, tokens: s.tokens ?? 0, color: categoryColor(s.id) });
  }
  return items;
}

interface Props {
  breakdown: PromptUsageBreakdown;
  isGuess: boolean;
}

/** The stacked bar: every module + category in proportion to the window, trailing into free space. */
export function UsageBar({ breakdown, isGuess }: Props) {
  const items = usageBarItems(breakdown);
  const windowSize = breakdown.contextWindow;
  const total = breakdown.total ?? breakdown.sum;
  const free = windowSize > 0 ? Math.max(0, windowSize - total) : 0;

  return (
    <div
      className={`flex h-6 w-full overflow-hidden rounded-md well ${isGuess ? 'animate-pulse' : ''}`}
    >
      {items.map((it) => {
        const width =
          windowSize > 0
            ? (it.tokens / windowSize) * 100
            : breakdown.sum > 0
              ? (it.tokens / breakdown.sum) * 100
              : 0;
        if (width <= 0) return null;
        return (
          <div
            key={it.key}
            title={`${it.label} — ${it.tokens.toLocaleString()} tok`}
            className={it.color}
            style={{ width: `${width}%` }}
          />
        );
      })}
      {free > 0 && <div title={`Free — ${free.toLocaleString()} tok`} className="flex-1" />}
    </div>
  );
}
