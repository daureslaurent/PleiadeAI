import type { ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Check, Loader2 } from 'lucide-react';
import { Link, Navigate, Outlet, useParams } from 'react-router-dom';
import { Spinner } from '../../components/ui';
import { categoryBySlug } from './categories';
import { SettingsProvider, useSettings, type SaveState } from './context';
import { InferencePanel } from './panels/InferencePanel';
import { MemoryPanel } from './panels/MemoryPanel';
import { FleetPanel } from './panels/FleetPanel';
import { ConnectionsPanel } from './panels/ConnectionsPanel';
import { MonitorPanel } from './panels/MonitorPanel';
import { InterfacePanel } from './panels/InterfacePanel';
import { SystemPanel } from './panels/SystemPanel';
import { AccessPanel } from './panels/AccessPanel';

/**
 * `/settings` layout route. Owns the settings doc for the whole section (see `context.tsx`) and
 * renders the index or a category page into the `<Outlet />`, so switching category never refetches.
 */
export function SettingsView() {
  return (
    <SettingsProvider fallback={<Spinner />}>
      <Outlet />
    </SettingsProvider>
  );
}

const PANELS: Record<string, () => ReactNode> = {
  inference: InferencePanel,
  memory: MemoryPanel,
  fleet: FleetPanel,
  connections: ConnectionsPanel,
  monitor: MonitorPanel,
  interface: InterfacePanel,
  system: SystemPanel,
  access: AccessPanel,
};

/** `/settings/:category` — one page per card. An unknown slug falls back to the index. */
export function SettingsCategoryPage() {
  const { category: slug } = useParams();
  const category = categoryBySlug(slug);
  const Panel = slug ? PANELS[slug] : undefined;
  if (!category || !Panel) return <Navigate to="/settings" replace />;

  const { icon: Icon, tone = 'accent' } = category;
  const tile =
    tone === 'danger' ? 'bg-red-500/10 text-red-400 ring-red-500/20' : 'bg-accent/10 text-accent ring-accent/20';

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <div className="animate-fade-up">
          <Link
            to="/settings"
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300"
          >
            <ArrowLeft size={13} /> Settings
          </Link>
          <div className="mt-3 flex items-center gap-3">
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${tile}`}>
              <Icon size={17} />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-slate-100">{category.title}</h2>
              <p className="text-[11px] text-slate-500">{category.blurb}</p>
            </div>
            <div className="ml-auto">
              <SavePill />
            </div>
          </div>
        </div>

        <Panel />
      </div>
    </div>
  );
}

/**
 * Autosave feedback — the only trace of the old Save button. Motion marks liveness (DIRECT_ART §6):
 * it spins while a write is in flight, confirms, then fades back to nothing.
 */
function SavePill() {
  const { save } = useSettings();
  if (save === 'idle') return null;

  const styles: Record<Exclude<SaveState, 'idle'>, string> = {
    saving: 'border-white/[0.07] bg-black/25 text-slate-400',
    saved: 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-400',
    error: 'border-red-500/25 bg-red-500/[0.07] text-red-400',
  };

  return (
    <span
      className={`flex animate-fade-up items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] backdrop-blur-sm ${styles[save]}`}
    >
      {save === 'saving' && (
        <>
          <Loader2 size={12} className="animate-spin" /> Saving…
        </>
      )}
      {save === 'saved' && (
        <>
          <Check size={12} /> Saved
        </>
      )}
      {save === 'error' && (
        <>
          <AlertTriangle size={12} /> Save failed
        </>
      )}
    </span>
  );
}
