import { DatabaseBackup, KeyRound, ShieldAlert } from 'lucide-react';
import { GlassCard, Section } from '../../../components/ui';
import { ApiKeysManager } from '../managers/ApiKeysManager';
import { BackupTransfer } from '../managers/BackupTransfer';
import { ClearDataPanel } from '../managers/ClearDataPanel';

/** `/settings/access` — who may call this instance, plus the export/import and reset paths. */
export function AccessPanel() {
  return (
    <div className="animate-fade-up space-y-5">
      <Section title="API keys" icon={<KeyRound size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Credentials for scripts and external agents (MCP, CLI). A key is read-only by default; grant
          it scopes (like <span className="font-mono">agents:write</span>) to unlock mutating methods on
          matching route families. Keys can't open a socket or manage keys.
        </p>
        <ApiKeysManager />
      </Section>

      <Section title="Backup & transfer" icon={<DatabaseBackup size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Export agents + isolations (and Qdrant memory) to a file, or import a config onto this
          instance.
        </p>
        <BackupTransfer />
      </Section>

      {/* Danger zone — irreversible. Red is spent on meaning here, not decoration (DIRECT_ART §2). */}
      <GlassCard className="border-red-500/20 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="shrink-0 text-red-400">
            <ShieldAlert size={13} />
          </span>
          <h2 className="text-[10px] font-medium uppercase tracking-wider text-red-400/80">Danger zone</h2>
        </div>
        <ClearDataPanel />
      </GlassCard>
    </div>
  );
}
