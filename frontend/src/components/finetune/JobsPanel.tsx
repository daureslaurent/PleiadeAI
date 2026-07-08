import { useState } from 'react';
import { Download, Loader2, Terminal, Trash2 } from 'lucide-react';
import { finetuneJobsApi, type FinetuneJob } from '../../lib/api';
import { FinetuneStatusBadge } from './FinetuneStatusBadge';
import { LossChart } from './LossChart';

const LIVE: FinetuneJob['status'][] = ['queued', 'preparing', 'training', 'exporting'];

/** Trigger a browser download for an authenticated blob (same helper shape as SettingsView). */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Tracked training runs: live status + loss curve, the produced GGUF, and the tail of remote logs. */
export function JobsPanel({ jobs, onChanged }: { jobs: FinetuneJob[]; onChanged: () => void }) {
  if (jobs.length === 0) {
    return (
      <section className="glass-card animate-fade-up rounded-2xl border border-white/[0.06] p-5 text-sm text-slate-500">
        No training runs yet.
      </section>
    );
  }
  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <JobRow key={job._id} job={job} onChanged={onChanged} />
      ))}
    </div>
  );
}

function JobRow({ job, onChanged }: { job: FinetuneJob; onChanged: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const live = LIVE.includes(job.status);

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await finetuneJobsApi.downloadModelBlob(job._id);
      downloadBlob(blob, job.gguf_filename || `${job.run_name}.gguf`);
    } catch {
      // The backend surfaces the reason; a failed download shouldn't wedge the row.
    } finally {
      setDownloading(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove the record for "${job.run_name}"? The remote job is not cancelled.`)) return;
    await finetuneJobsApi.remove(job._id);
    onChanged();
  };

  return (
    <section className="glass-card animate-fade-up rounded-2xl border border-white/[0.06] p-4">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <FinetuneStatusBadge status={job.status} />
        <span className="text-sm font-semibold text-slate-100">{job.run_name}</span>
        <span className="truncate font-mono text-[11px] text-slate-500">{job.base_model}</span>
        {job.size_b != null && (
          <span className="font-mono text-[11px] text-slate-500">{job.size_b}B</span>
        )}
        {job.strategy && (
          <span className="text-[11px] text-slate-600">
            {job.strategy === 'fsdp_qlora' ? 'FSDP' : 'ZeRO-2'}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {job.log_tail?.length > 0 && (
            <button
              onClick={() => setShowLogs((v) => !v)}
              title="Toggle logs"
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            >
              <Terminal size={13} />
            </button>
          )}
          {job.status === 'done' && (
            <button
              onClick={() => void download()}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/30 transition hover:bg-emerald-500/25 active:scale-95 disabled:opacity-50"
            >
              {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              GGUF
            </button>
          )}
          <button
            onClick={() => void remove()}
            title="Remove record"
            className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-300"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </header>

      {/* Progress: the always-available signal, even when no loss metrics arrive. */}
      {live && (
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wider text-slate-500">
            <span className="text-shimmer">{job.status}</span>
            <span className="font-mono">{Math.round(job.progress * 100)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-black/40">
            <div
              className="h-full rounded-full bg-accent transition-all duration-700"
              style={{ width: `${Math.min(100, job.progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      <LossChart metrics={job.metrics} live={live} />

      {job.error && (
        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3 py-2 font-mono text-[11px] text-red-300">
          {job.error}
        </div>
      )}

      {job.status === 'done' && job.gguf_filename && (
        <div className="mt-2 font-mono text-[11px] text-slate-500">{job.gguf_filename}</div>
      )}

      {showLogs && job.log_tail?.length > 0 && (
        <pre className="mt-3 max-h-56 overflow-auto rounded-xl border border-white/[0.06] bg-black/40 p-3 font-mono text-[10px] leading-relaxed text-slate-400">
          {job.log_tail.join('\n')}
        </pre>
      )}
    </section>
  );
}
