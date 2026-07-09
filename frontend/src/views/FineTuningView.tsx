import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  finetuneServersApi,
  scoringApi,
  type DatasetStats,
  type FinetuneServer,
  type ScoreTag,
} from '../lib/api';
import { useFinetune } from '../store/finetune';
import { DatasetPanel } from '../components/finetune/DatasetPanel';
import { ServerCard } from '../components/finetune/ServerCard';
import { StartTrainingForm } from '../components/finetune/StartTrainingForm';
import { JobsPanel } from '../components/finetune/JobsPanel';

/**
 * Fine-Tuning command center.
 *
 * Four strata, all glass over the starfield: what we can train on (dataset composition + quality
 * filter), where we can train it (per-server live utilization + capability), how to launch it (with
 * the server's feasibility recommendation), and what's running (live loss curves → downloadable GGUF).
 *
 * Job progress arrives over the `finetune` socket room via `store/finetune`; server utilization is
 * polled per-card only while this page is open.
 */
export function FineTuningView() {
  const [servers, setServers] = useState<FinetuneServer[]>([]);
  const [serversError, setServersError] = useState(false);
  const [stats, setStats] = useState<DatasetStats | null>(null);
  const [statsError, setStatsError] = useState(false);

  // The quality filter doubles as the training-set selector for the "scored" dataset source.
  const [minScore, setMinScore] = useState(0);
  const [tags, setTags] = useState<ScoreTag[]>([]);

  const jobs = useFinetune((s) => s.jobs);
  const wire = useFinetune((s) => s.wire);
  const hydrate = useFinetune((s) => s.hydrate);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    wire();
    void hydrate();
    return () => {
      mounted.current = false;
    };
  }, [wire, hydrate]);

  useEffect(() => {
    finetuneServersApi
      .list()
      .then((s) => mounted.current && setServers(s))
      .catch(() => mounted.current && setServersError(true));
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const next = await scoringApi.datasetStats({
        minScore: minScore || undefined,
        tags: tags.length ? tags : undefined,
      });
      if (mounted.current) {
        setStats(next);
        setStatsError(false);
      }
    } catch {
      if (mounted.current) setStatsError(true);
    }
  }, [minScore, tags]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const toggleTag = (tag: ScoreTag) =>
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));

  const enabled = servers.filter((s) => s.enabled);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-5">
        <DatasetPanel
          stats={stats}
          error={statsError}
          minScore={minScore}
          tags={tags}
          onMinScore={setMinScore}
          onToggleTag={toggleTag}
        />

        {/* Servers: live usage + capability */}
        <div>
          <h2 className="mb-2 px-1 text-[10px] uppercase tracking-wider text-slate-500">
            Fine-tune servers
          </h2>
          {serversError ? (
            <section className="glass-card rounded-2xl border border-white/[0.06] p-5">
              <div className="flex items-center gap-2 text-sm text-red-300">
                <AlertTriangle size={15} /> Failed to load fine-tune servers.
              </div>
            </section>
          ) : enabled.length === 0 ? (
            <section className="glass-card rounded-2xl border border-white/[0.06] p-5 text-sm text-slate-500">
              No enabled fine-tune servers. Add one in <span className="text-slate-300">Settings</span>.
            </section>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {enabled.map((s) => (
                <ServerCard key={s._id} server={s} />
              ))}
            </div>
          )}
        </div>

        <StartTrainingForm
          servers={enabled}
          minScore={minScore}
          tags={tags}
          filteredCount={stats?.filtered_count ?? 0}
          onStarted={() => void hydrate()}
        />

        <div>
          <h2 className="mb-2 px-1 text-[10px] uppercase tracking-wider text-slate-500">Runs</h2>
          <JobsPanel jobs={jobs} onChanged={() => void hydrate()} />
        </div>
      </div>
    </div>
  );
}
