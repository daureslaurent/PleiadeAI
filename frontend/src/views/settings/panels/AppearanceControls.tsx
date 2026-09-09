import { Check } from 'lucide-react';
import { usePrefs } from '../../../store/prefs';
import { THEMES, type ThemeDef } from '../../../theme/themes';
import { CHAT_LAYOUTS, type ChatLayoutId } from '../../../theme/layouts';

/**
 * The theme and chat-layout pickers (THEME_SYSTEM_PLAN.md §2.4).
 *
 * Both are grids of cards rather than selects, because neither choice can be judged from its name:
 * a theme has to be *seen* and a layout has to be *diagrammed*. The theme card paints its own
 * palette literally (the swatch triplet, not the active theme's tokens, so all five read correctly
 * whichever one is on); the layout card draws a wireframe from the descriptor.
 *
 * Both apply on click — no Save button, same as every other settings control.
 */

function Card({
  active,
  onClick,
  title,
  blurb,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group overflow-hidden rounded-xl border text-left transition-colors ${
        active ? 'border-accent/60 raise-2' : 'hairline hover:border-white/[0.16]'
      }`}
    >
      {children}
      <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-2">
        <span className={`text-xs font-medium ${active ? 'text-accent' : 'text-slate-200'}`}>
          {title}
        </span>
        {active && <Check size={12} className="text-accent" />}
      </div>
      <p className="px-3 pb-3 text-[11px] leading-relaxed text-slate-500">{blurb}</p>
    </button>
  );
}

/** A miniature of the theme, painted in its own colours: chrome bar, a turn, a reply. */
function ThemeSketch({ theme }: { theme: ThemeDef }) {
  const [ground, surface, accent] = theme.swatch;
  const ink = theme.mermaid.primaryTextColor;
  return (
    <div className="h-[68px] w-full p-2" style={{ background: ground }}>
      <div className="flex h-full gap-1.5">
        <div className="w-6 shrink-0 rounded" style={{ background: surface }} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="ml-auto h-3 w-2/5 rounded" style={{ background: accent }} />
          <div className="h-1.5 w-full rounded" style={{ background: ink, opacity: 0.45 }} />
          <div className="h-1.5 w-4/5 rounded" style={{ background: ink, opacity: 0.28 }} />
          <div className="h-1.5 w-1/2 rounded" style={{ background: ink, opacity: 0.18 }} />
        </div>
      </div>
    </div>
  );
}

/* The wireframe vocabulary: `Line` is prose, `Bar` is a tool row, `Bub` is a bubble. */
const Line = ({ w, dim = 0.5 }: { w: string; dim?: number }) => (
  <div className="h-1.5 rounded bg-slate-300" style={{ width: w, opacity: dim }} />
);
const Bar = ({ w = '70%' }: { w?: string }) => (
  <div className="h-2 rounded-sm bg-accent" style={{ width: w, opacity: 0.55 }} />
);

/** A wireframe of the layout's structure — what actually distinguishes the five. */
function LayoutSketch({ id }: { id: ChatLayoutId }) {
  const shell = 'flex h-[68px] w-full flex-col gap-1.5 p-2.5';
  switch (id) {
    case 'hybrid':
      return (
        <div className={shell}>
          <div className="ml-auto h-3.5 w-2/5 rounded-md rounded-br-sm bg-accent/70" />
          <Line w="100%" />
          <Bar w="85%" />
          <Line w="70%" dim={0.32} />
        </div>
      );
    case 'transcript':
      return (
        <div className={shell}>
          <Line w="18%" dim={0.85} />
          <Line w="100%" />
          <div className="flex items-center gap-1">
            <div className="h-2 w-1 rounded-sm bg-accent/70" />
            <Bar w="60%" />
          </div>
          <Line w="80%" dim={0.32} />
        </div>
      );
    case 'workbench':
      return (
        <div className="flex h-[68px] w-full gap-1.5 p-2.5">
          <div className="flex flex-1 flex-col gap-1.5">
            <Line w="100%" />
            <Line w="85%" dim={0.32} />
            <Line w="60%" dim={0.32} />
          </div>
          <div className="w-px self-stretch bg-slate-300/30" />
          <div className="flex w-[38%] flex-col gap-1">
            <Bar w="100%" />
            <Bar w="80%" />
            <Bar w="90%" />
            <Bar w="65%" />
          </div>
        </div>
      );
    case 'timeline':
      return (
        <div className="relative flex h-[68px] w-full flex-col justify-center gap-2 p-2.5 pl-4">
          <div className="absolute bottom-3 left-[13px] top-3 w-px bg-slate-300/30" />
          {[0.85, 0.5, 0.5, 0.32].map((dim, i) => (
            <div key={i} className="flex items-center gap-2">
              <div
                className="-ml-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                style={{ opacity: dim + 0.15 }}
              />
              <Line w={`${80 - i * 12}%`} dim={dim} />
            </div>
          ))}
        </div>
      );
    case 'bubbles':
      return (
        <div className={shell}>
          <div className="ml-auto h-3 w-[45%] rounded-md bg-accent/70" />
          <div className="h-3 w-[55%] rounded-md bg-slate-300/25" />
          <div className="ml-auto h-3 w-[35%] rounded-md bg-accent/70" />
          <div className="h-2 w-[28%] rounded-full bg-slate-300/40" />
        </div>
      );
  }
}

export function ThemePicker() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {THEMES.map((t) => (
        <Card
          key={t.id}
          active={theme === t.id}
          onClick={() => setTheme(t.id)}
          title={t.label}
          blurb={t.blurb}
        >
          <ThemeSketch theme={t} />
        </Card>
      ))}
    </div>
  );
}

export function ChatLayoutPicker() {
  const layout = usePrefs((s) => s.chatLayout);
  const setChatLayout = usePrefs((s) => s.setChatLayout);
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {CHAT_LAYOUTS.map((l) => (
        <Card
          key={l.id}
          active={layout === l.id}
          onClick={() => setChatLayout(l.id)}
          title={l.label}
          blurb={l.blurb}
        >
          <div className="well">
            <LayoutSketch id={l.id} />
          </div>
        </Card>
      ))}
    </div>
  );
}
