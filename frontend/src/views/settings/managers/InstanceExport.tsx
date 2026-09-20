import { useCallback, useState } from 'react';
import { Download, HardDriveDownload, Package, Trash2 } from 'lucide-react';
import { Button, Callout, Checkbox, Field, Input, useConfirm } from '../../../components/ui';
import {
  migrationApi,
  type InstanceArchive,
  type MigrationJob,
  type MigrationOverview,
} from '../../../lib/api';
import { CensusTable, JobProgress, formatBytes, formatCount, useMigrationJob } from './migration-shared';

/**
 * The source half of a server move: build one `.plmig` archive of this whole instance, then download it.
 *
 * Two deliberate shapes here. The passphrase is required rather than optional, because it is not
 * only what encrypts the file — it is the key every stored credential is re-wrapped under, which is
 * what frees the target from having to inherit this box's `ISOLATION_ENC_KEY`. And the archive is
 * *built first, downloaded second*: at several GB, generating into the response would mean no
 * progress, no retry, and a dropped connection costing the whole run.
 */
export function InstanceExport({
  overview,
  onChanged,
}: {
  overview: MigrationOverview;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [passphrase, setPassphrase] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [includeEnv, setIncludeEnv] = useState(true);
  const [excludeInferenceLogs, setExcludeLogs] = useState(false);
  const [excludeMedia, setExcludeMedia] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settled = useCallback(() => onChanged(), [onChanged]);
  const [job, setJob] = useMigrationJob(overview.job?.kind === 'export' ? overview.job : null, settled);

  const fp = overview.fingerprint;
  const logRows =
    (fp.mongo.collections['llama_calls_archive'] ?? 0) + (fp.mongo.collections['llama_calls_debug'] ?? 0);
  const mediaBytes = Object.values(fp.mongo.gridfs_bytes).reduce((a, b) => a + b, 0);
  const running = job?.status === 'running';
  const mismatch = confirmPass.length > 0 && passphrase !== confirmPass;
  const canStart = passphrase.length >= 8 && passphrase === confirmPass && !running;

  async function start() {
    setError(null);
    try {
      const started = await migrationApi.startExport({
        passphrase,
        includeEnv,
        excludeInferenceLogs,
        excludeMedia,
      });
      setJob(started);
    } catch (err) {
      setError(messageOf(err, 'Export could not be started.'));
    }
  }

  async function remove(archive: InstanceArchive) {
    const ok = await confirm({
      title: 'Delete this archive?',
      body: 'The file is removed from the backup volume. Anything already downloaded is unaffected.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await migrationApi.remove(archive.id);
    onChanged();
  }

  return (
    <div className="space-y-4">
      {/* What is actually here, so the operator can recognise a wrong instance before exporting it. */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
            This instance holds
          </div>
          <div className="text-[11px] text-slate-500">
            {formatCount(fp.mongo.total_documents)} documents · {formatBytes(mediaBytes)} of files ·{' '}
            {formatCount(fp.qdrant.total_points)} memory vectors
          </div>
        </div>
        <CensusTable collections={fp.mongo.collections} qdrant={fp.qdrant.collections} />
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
          Every collection is carried, enumerated from the live database rather than a fixed list — a
          release that adds one is still moved. Roughly {formatBytes(overview.estimate_bytes)} before
          compression;{' '}
          {overview.free_bytes === null
            ? 'free space on the backup volume is unknown'
            : `${formatBytes(overview.free_bytes)} free on the backup volume`}
          .
        </p>
      </div>

      {/* Passphrase */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Passphrase" hint="At least 8 characters. You will need it on the new server.">
          <Input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="••••••••••••"
          />
        </Field>
        <Field label="Repeat passphrase" hint={mismatch ? 'The two entries differ.' : undefined}>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPass}
            onChange={(e) => setConfirmPass(e.target.value)}
            placeholder="••••••••••••"
          />
        </Field>
      </div>

      <Callout tone="info">
        The passphrase encrypts the file <em>and</em> re-wraps every stored credential — SSH keys, VPN
        configs, API and mailbox secrets. That is what lets the new server run on a completely fresh{' '}
        <span className="font-mono">.env</span> instead of inheriting this one's encryption key
        (currently <span className="font-mono">{overview.enc_key_fingerprint}</span>). There is no
        recovery if it is lost.
      </Callout>

      {/* Contents */}
      <div className="space-y-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Contents</div>
        <Checkbox checked={includeEnv} onChange={setIncludeEnv}>
          Include the environment snapshot
          <span className="ml-1 text-slate-500">
            — shown on the new server for you to copy into its <span className="font-mono">.env</span>,
            never applied automatically
          </span>
        </Checkbox>
        <Checkbox checked={excludeInferenceLogs} onChange={setExcludeLogs}>
          Leave out inference logs
          <span className="ml-1 text-slate-500">({formatCount(logRows)} rows — history, not state)</span>
        </Checkbox>
        <Checkbox checked={excludeMedia} onChange={setExcludeMedia}>
          Leave out generated media and uploaded files
          <span className="ml-1 text-slate-500">({formatBytes(mediaBytes)})</span>
        </Checkbox>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void start()} disabled={!canStart} loading={running} icon={<Package size={13} />}>
          {running ? 'Building archive…' : 'Build archive'}
        </Button>
        {passphrase.length > 0 && passphrase.length < 8 && (
          <span className="text-[11px] text-amber-400/80">Passphrase is too short.</span>
        )}
      </div>

      {job && <JobProgress job={job} />}
      {error && <p className="text-[11px] text-red-400">{error}</p>}

      {/* Built archives */}
      <div className="border-t hairline pt-4">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Archives on this server
        </div>
        {overview.archives.length === 0 ? (
          <p className="text-[11px] text-slate-500">None yet. The three most recent are kept.</p>
        ) : (
          <ul className="space-y-1.5">
            {overview.archives.map((a) => (
              <ArchiveRow key={a.id} archive={a} onDelete={() => void remove(a)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ArchiveRow({ archive, onDelete }: { archive: InstanceArchive; onDelete: () => void }) {
  return (
    <li className="flex items-center gap-3 rounded-xl border hairline well px-3 py-2">
      <HardDriveDownload size={14} className="shrink-0 text-slate-500" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-slate-300">{archive.filename}</div>
        <div className="text-[10px] text-slate-500">
          {formatBytes(archive.bytes)} · {new Date(archive.created_at).toLocaleString()}
          {archive.origin === 'upload' && ' · uploaded'}
          {archive.sha256 && ` · sha256 ${archive.sha256.slice(0, 12)}`}
        </div>
      </div>
      <a
        href={migrationApi.downloadUrl(archive.id)}
        download={archive.filename}
        className="shrink-0 rounded-lg raise-2 px-2.5 py-1.5 text-[11px] text-slate-300 transition-colors hover:raise-3"
      >
        <span className="flex items-center gap-1.5">
          <Download size={12} /> Download
        </span>
      </a>
      <button
        onClick={onDelete}
        title="Delete archive"
        className="shrink-0 rounded-lg p-1.5 text-slate-500 transition-colors hover:text-red-400"
      >
        <Trash2 size={13} />
      </button>
    </li>
  );
}

export function messageOf(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error ?? (err instanceof Error ? err.message : fallback);
}

export type { MigrationJob };
