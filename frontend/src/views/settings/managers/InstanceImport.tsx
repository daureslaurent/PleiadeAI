import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Eye, EyeOff, FileUp, RotateCw, ShieldCheck, Upload } from 'lucide-react';
import { Button, Callout, Input, Field } from '../../../components/ui';
import {
  migrationApi,
  type EnvDiffRow,
  type InstanceArchive,
  type MigrationOverview,
  type PreflightReport,
  type RestoreReport,
} from '../../../lib/api';
import { CensusTable, JobProgress, formatBytes, formatCount, useMigrationJob } from './migration-shared';
import { messageOf } from './InstanceExport';

type Stage = 'choose' | 'uploading' | 'passphrase' | 'preflighting' | 'report' | 'restoring' | 'done';

/**
 * The target half of a server move: drop the archive, read what it would do, then replace this
 * instance with it.
 *
 * The preflight is not a formality and is not skippable. It streams the entire archive once,
 * decrypting and parsing every entry, so that a wrong passphrase or a truncated upload is a refusal
 * rather than a half-restored database — the restore itself drops collections as it goes, and there
 * is no undo for that.
 */
export function InstanceImport({
  overview,
  onChanged,
}: {
  overview: MigrationOverview;
  onChanged: () => void;
}) {
  const [stage, setStage] = useState<Stage>('choose');
  const [dragging, setDragging] = useState(false);
  const [uploaded, setUploaded] = useState<InstanceArchive | null>(null);
  const [sent, setSent] = useState(0);
  const [size, setSize] = useState(0);
  const [passphrase, setPassphrase] = useState('');
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [restore, setRestore] = useState<RestoreReport | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onSettled = useCallback(
    (job: { kind: string; status: string; result?: unknown; error?: string }) => {
      if (job.status === 'error') {
        setError(job.error ?? 'Failed.');
        setStage(job.kind === 'preflight' ? 'passphrase' : 'report');
        return;
      }
      if (job.kind === 'preflight') {
        setReport(job.result as PreflightReport);
        setStage('report');
      } else if (job.kind === 'restore') {
        setRestore(job.result as RestoreReport);
        setStage('done');
      }
      onChanged();
    },
    [onChanged],
  );
  const [job, setJob] = useMigrationJob(
    overview.job && overview.job.kind !== 'export' ? overview.job : null,
    onSettled,
  );

  async function takeFile(file: File) {
    setError(null);
    if (!file.name.endsWith('.plmig')) {
      setError('That is not an instance archive (expected a .plmig file).');
      return;
    }
    setStage('uploading');
    setSize(file.size);
    setSent(0);
    try {
      const archive = await migrationApi.upload(file, (s) => setSent(s));
      setUploaded(archive);
      setStage('passphrase');
    } catch (err) {
      setError(messageOf(err, 'Upload failed.'));
      setStage('choose');
    }
  }

  async function runPreflight() {
    if (!uploaded) return;
    setError(null);
    try {
      setJob(await migrationApi.startPreflight(uploaded.id, passphrase));
      setStage('preflighting');
    } catch (err) {
      setError(messageOf(err, 'Preflight could not be started.'));
    }
  }

  async function runRestore() {
    if (!uploaded || confirmText !== 'REPLACE') return;
    setError(null);
    try {
      setJob(await migrationApi.startRestore(uploaded.id, passphrase));
      setStage('restoring');
    } catch (err) {
      setError(messageOf(err, 'Restore could not be started.'));
    }
  }

  function reset() {
    setStage('choose');
    setUploaded(null);
    setReport(null);
    setRestore(null);
    setPassphrase('');
    setConfirmText('');
    setError(null);
    setJob(null);
    void migrationApi.clearJob().then(onChanged);
  }

  // --- choose / upload ------------------------------------------------------------------------
  if (stage === 'choose' || stage === 'uploading') {
    const pct = size > 0 ? Math.round((sent / size) * 100) : 0;
    return (
      <div className="space-y-3">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void takeFile(file);
          }}
          onClick={() => stage === 'choose' && fileRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors ${
            dragging ? 'border-accent bg-accent/[0.07]' : 'hairline well hover:border-accent/40'
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".plmig"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void takeFile(file);
            }}
          />
          {stage === 'uploading' ? (
            <>
              <Upload size={20} className="text-accent" />
              <div className="text-xs text-slate-300">
                Uploading — {formatBytes(sent)} of {formatBytes(size)} ({pct}%)
              </div>
              <div className="h-1 w-56 overflow-hidden rounded-full raise-2">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-[10px] text-slate-500">
                Sent in chunks — a dropped connection resumes rather than restarting.
              </p>
            </>
          ) : (
            <>
              <FileUp size={20} className="text-slate-500" />
              <div className="text-xs text-slate-300">
                Drop a <span className="font-mono">.plmig</span> archive here, or click to choose one
              </div>
              <p className="max-w-md text-[10px] leading-relaxed text-slate-500">
                Exported from the server you are moving away from. Nothing is changed until you have
                read the preflight report and typed the confirmation.
              </p>
            </>
          )}
        </div>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  // --- passphrase / preflight -----------------------------------------------------------------
  if (stage === 'passphrase' || stage === 'preflighting') {
    return (
      <div className="space-y-3">
        <ArchiveHeadline archive={uploaded} />
        <Field
          label="Archive passphrase"
          hint="The one typed on the source server when the archive was built."
        >
          <Input
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && passphrase.length >= 8 && void runPreflight()}
            placeholder="••••••••••••"
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void runPreflight()}
            disabled={passphrase.length < 8 || stage === 'preflighting'}
            loading={stage === 'preflighting'}
            icon={<ShieldCheck size={13} />}
          >
            Check this archive
          </Button>
          <Button variant="ghost" onClick={reset} disabled={stage === 'preflighting'}>
            Choose a different file
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-500">
          The whole archive is read and decrypted before anything here is touched, so a wrong
          passphrase or an incomplete upload is refused rather than discovered halfway through a
          restore. On a multi-gigabyte file this takes a while.
        </p>
        {job && stage === 'preflighting' && <JobProgress job={job} />}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    );
  }

  // --- restoring ------------------------------------------------------------------------------
  if (stage === 'restoring') {
    return (
      <div className="space-y-3">
        <Callout tone="warn" icon={<AlertTriangle size={13} />}>
          Restoring. The instance is in maintenance mode and will restart on its own when it finishes —
          this page will need a reload. Do not stop the stack.
        </Callout>
        {job && <JobProgress job={job} />}
      </div>
    );
  }

  // --- done -----------------------------------------------------------------------------------
  if (stage === 'done' && restore) {
    return <RestoreOutcome report={restore} onReset={reset} />;
  }

  // --- preflight report -----------------------------------------------------------------------
  if (!report) return null;
  return (
    <ReportView
      report={report}
      archive={uploaded}
      confirmText={confirmText}
      setConfirmText={setConfirmText}
      onRestore={() => void runRestore()}
      onReset={reset}
      error={error}
    />
  );
}

function ArchiveHeadline({ archive }: { archive: InstanceArchive | null }) {
  if (!archive) return null;
  return (
    <div className="flex items-center gap-2 rounded-xl border hairline well px-3 py-2 text-[11px] text-slate-400">
      <Check size={13} className="shrink-0 text-emerald-400" />
      <span className="truncate">
        {archive.note ?? archive.filename} · {formatBytes(archive.bytes)} uploaded
      </span>
    </div>
  );
}

function ReportView({
  report,
  archive,
  confirmText,
  setConfirmText,
  onRestore,
  onReset,
  error,
}: {
  report: PreflightReport;
  archive: InstanceArchive | null;
  confirmText: string;
  setConfirmText: (v: string) => void;
  onRestore: () => void;
  onReset: () => void;
  error: string | null;
}) {
  const src = report.source_fingerprint;
  const tgt = report.target_fingerprint;
  const changedEnv = report.env.rows.filter((r) => r.status !== 'same');

  return (
    <div className="space-y-4">
      <ArchiveHeadline archive={archive} />

      <Callout tone="info" icon={<ShieldCheck size={13} />}>
        Archive read end to end and verified. Exported{' '}
        {new Date(report.manifest.exported_at).toLocaleString()}
        {report.manifest.source.app_version && ` from version ${report.manifest.source.app_version}`}.
        Credentials will be re-wrapped from the source key{' '}
        <span className="font-mono">{report.enc_keys.source}</span> to this server's{' '}
        <span className="font-mono">{report.enc_keys.target}</span>.
      </Callout>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-emerald-400/80">
            Will arrive · {formatCount(src.mongo.total_documents)} documents
          </div>
          <CensusTable collections={src.mongo.collections} qdrant={src.qdrant.collections} />
        </div>
        <div>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-red-400/80">
            Will be destroyed · {formatCount(tgt.mongo.total_documents)} documents
          </div>
          <CensusTable
            collections={tgt.mongo.collections}
            qdrant={tgt.qdrant.collections}
            emptyLabel="This instance is empty — nothing to lose."
          />
        </div>
      </div>

      {report.warnings.length > 0 && (
        <ul className="space-y-1 text-[11px] leading-relaxed text-amber-400/80">
          {report.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {report.secret_warnings.length > 0 && (
        <Callout tone="warn" icon={<AlertTriangle size={13} />}>
          <div className="mb-1">
            Some credentials could not be read on the source server and will arrive unusable:
          </div>
          <ul className="list-inside list-disc text-[10px]">
            {report.secret_warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}

      {report.env.present && changedEnv.length > 0 && <EnvDiff rows={changedEnv} />}

      {/* Confirmation */}
      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.05] p-3">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-red-400/80">
          <AlertTriangle size={13} /> This replaces everything on this server
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
          Every collection is dropped and rebuilt from the archive, vector memory is recreated, and the
          backend restarts. Log in afterwards with this server's own password — the login is set by{' '}
          <span className="font-mono">.env</span> and does not travel.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
            placeholder="Type REPLACE"
            className="w-44 font-mono"
          />
          <Button variant="danger" disabled={confirmText !== 'REPLACE'} onClick={onRestore} icon={<RotateCw size={13} />}>
            Replace this instance
          </Button>
          <Button variant="ghost" onClick={onReset}>
            Cancel
          </Button>
        </div>
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

/**
 * The `.env` values that differ, for the operator to copy across.
 *
 * Shown rather than applied: the backend does not mount the host's `.env`, and a value that only
 * takes effect on restart cannot be written by the process that would have to restart to see it.
 */
function EnvDiff({ rows }: { rows: EnvDiffRow[] }) {
  const [revealed, setRevealed] = useState(false);
  const text = rows
    .filter((r) => r.source_value !== '')
    .map((r) => `${r.name}=${r.source_value}`)
    .join('\n');

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Environment differences ({rows.length})
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRevealed((v) => !v)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-slate-400 transition-colors hover:raise-2"
          >
            {revealed ? <EyeOff size={12} /> : <Eye size={12} />} {revealed ? 'Hide' : 'Reveal'}
          </button>
          <button
            onClick={() => void navigator.clipboard.writeText(text)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-slate-400 transition-colors hover:raise-2"
          >
            <Copy size={12} /> Copy
          </button>
        </div>
      </div>
      <div className="max-h-44 overflow-auto rounded-xl border hairline well">
        <table className="w-full text-[11px]">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b hairline last:border-0">
                <td className="px-2.5 py-1 font-mono text-slate-400">{r.name}</td>
                <td className="px-2.5 py-1 font-mono text-slate-300">
                  {r.secret && !revealed ? '••••••••' : r.source_value || <em className="text-slate-600">unset</em>}
                </td>
                <td className="px-2.5 py-1 text-right text-[10px] text-slate-500">
                  {r.status === 'only_source' ? 'not set here' : r.status === 'only_target' ? 'only here' : 'differs'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
        Copy what you want into this server's <span className="font-mono">.env</span> and restart the
        stack. Stored credentials are re-wrapped automatically and need none of this — only host-level
        settings do.
      </p>
    </div>
  );
}

function RestoreOutcome({ report, onReset }: { report: RestoreReport; onReset: () => void }) {
  return (
    <div className="space-y-3">
      <Callout tone={report.verification.matches ? 'info' : 'warn'} icon={<Check size={13} />}>
        Restored {formatCount(report.documents_restored)} documents across {report.collections_restored}{' '}
        collections and {formatCount(report.qdrant_points_restored)} memory vectors.{' '}
        {report.verification.matches
          ? 'The census matches the source exactly.'
          : 'The census does NOT match the source — see below.'}
      </Callout>

      {!report.verification.matches && (
        <ul className="max-h-40 space-y-0.5 overflow-auto rounded-xl border hairline well p-3 text-[11px] text-amber-400/80">
          {report.verification.differences.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}

      {report.warnings.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-auto text-[11px] text-slate-500">
          {report.warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      )}

      <Callout tone="warn" icon={<RotateCw size={13} />}>
        {report.restart_requested
          ? 'The backend is restarting. Reload this page in a moment and log in with this server’s password.'
          : 'Automatic restart failed — run "docker compose restart backend" on the host, then reload.'}
      </Callout>

      <div className="flex gap-2">
        <Button onClick={() => window.location.reload()} icon={<RotateCw size={13} />}>
          Reload
        </Button>
        <Button variant="ghost" onClick={onReset}>
          Done
        </Button>
      </div>
    </div>
  );
}
