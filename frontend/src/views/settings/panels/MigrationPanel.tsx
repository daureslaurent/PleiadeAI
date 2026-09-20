import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, PackageOpen, ServerCog } from 'lucide-react';
import { Button, Callout, GlassCard, Section, Spinner } from '../../../components/ui';
import { migrationApi, type MigrationOverview } from '../../../lib/api';
import { InstanceExport } from '../managers/InstanceExport';
import { InstanceImport } from '../managers/InstanceImport';

/**
 * `/settings/migration` — move this whole instance to another server (spec `INSTANCE_MIGRATION_PLAN.md`).
 *
 * Both halves live on one page on purpose: the same operator does the export on the old box and the
 * import on the new one, usually with both tabs open, and the two are only comprehensible next to
 * each other. Not to be confused with Access & Data → Backup & transfer, which merges *some agents*
 * into a foreign fleet and strips every credential on the way out.
 */
export function MigrationPanel() {
  const [overview, setOverview] = useState<MigrationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      migrationApi
        .overview()
        .then((data) => {
          setOverview(data);
          setError(null);
        })
        .catch(() => setError('Could not read this instance. Is the backup volume mounted?')),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <div className="animate-fade-up">
        <Callout tone="error" icon={<AlertTriangle size={13} />}>
          {error}
        </Callout>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="flex items-center gap-2 py-10 text-xs text-slate-500">
        <Spinner /> Taking stock of this instance…
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-5">
      {overview.maintenance.active && (
        <Callout tone="warn" icon={<AlertTriangle size={13} />}>
          <div className="mb-2">
            This instance is in maintenance mode ({overview.maintenance.reason}). Background work is
            stopped and every other page will refuse to load.
          </div>
          <Button
            variant="ghost"
            onClick={() => void migrationApi.leaveMaintenance().then(reload)}
            icon={<ServerCog size={13} />}
          >
            Resume normal operation
          </Button>
        </Callout>
      )}

      <Section title="Export this instance" icon={<ArrowLeftRight size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          One encrypted file holding everything: every collection, the stored files, vector memory and
          — re-wrapped under your passphrase — every credential. Build it here, download it, drop it on
          the new server.
        </p>
        <InstanceExport overview={overview} onChanged={() => void reload()} />
      </Section>

      <GlassCard className="border-red-500/20 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="shrink-0 text-red-400">
            <PackageOpen size={13} />
          </span>
          <h2 className="text-[10px] font-medium uppercase tracking-wider text-red-400/80">
            Import — replaces this instance
          </h2>
        </div>
        <InstanceImport overview={overview} onChanged={() => void reload()} />
      </GlassCard>
    </div>
  );
}
