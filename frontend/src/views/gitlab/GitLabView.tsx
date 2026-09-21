import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  ListOrdered,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  ScanSearch,
  X,
} from 'lucide-react';
import {
  agentsApi,
  gitlabApi,
  runQueueApi,
  type Agent,
  type GitLabActivity,
  type GitLabConnectionInfo,
  type GitLabIssue,
  type GitLabJob,
  type GitLabMergeRequest,
  type GitLabPipeline,
  type GitLabProject,
  type RunQueueEntry,
  type RunQueueSnapshot,
} from '../../lib/api';
import { Button, Callout, Dot, EmptyState, Row, Section, Spinner, type Tone } from '../../components/ui';

/**
 * `/gitlab` — what the fleet is doing on GitLab (`GITLAB_PLAN.md` §6).
 *
 * Five tabs, and the ordering is the operator's question order: *what exists* (Projects), *what have
 * my agents actually done* (Activity), *what is in flight* (Work), *is it green* (Pipelines), *what
 * is about to run* (Queue).
 *
 * Activity is the one that does not exist in GitLab. GitLab knows a commit was authored by the bot
 * account; only we know which agent made it, in which conversation, so each row links both out to
 * GitLab and back into the Workspace session that produced it.
 */
type Tab = 'projects' | 'activity' | 'work' | 'pipelines' | 'queue';

const TABS: { id: Tab; label: string; icon: typeof GitBranch }[] = [
  { id: 'projects', label: 'Projects', icon: GitBranch },
  { id: 'activity', label: 'Agent activity', icon: Activity },
  { id: 'work', label: 'Work', icon: CircleDot },
  { id: 'pipelines', label: 'Pipelines', icon: Rocket },
  { id: 'queue', label: 'Queue', icon: ListOrdered },
];

/** GitLab's statuses mapped onto the shared tone vocabulary. */
function pipelineTone(status?: string | null): Tone {
  switch (status) {
    case 'success':
      return 'ok';
    case 'failed':
      return 'error';
    case 'running':
    case 'pending':
    case 'created':
      return 'busy';
    default:
      return 'idle';
  }
}

function ago(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function GitLabView() {
  const [tab, setTab] = useState<Tab>('projects');
  const [conn, setConn] = useState<GitLabConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void gitlabApi
      .connection()
      .then(setConn)
      .catch(() => setConn(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;

  // An unconfigured instance gets the setup path, not five empty tabs: every one of them would
  // otherwise render "failed to load" and say nothing about why.
  if (!conn?.url || !conn.token_set) {
    return (
      <div className="h-full overflow-auto p-6">
        <div className="mx-auto max-w-2xl">
          <Section title="GitLab" icon={<GitBranch size={13} />}>
            <Callout tone="info" icon={<AlertTriangle size={13} />}>
              {conn?.url
                ? 'A GitLab URL is set but no access token has been pasted yet, so nothing can be read.'
                : 'No GitLab instance is connected yet.'}{' '}
              Set it up in{' '}
              <Link to="/settings/connections" className="text-accent hover:underline">
                Settings → Connections
              </Link>
              . Once a token is in place, every agent in the fleet gets the GitLab tools.
            </Callout>
          </Section>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 border-b hairline px-6 py-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              tab === id ? 'bg-accent/20 text-accent ring-1 ring-accent/40' : 'text-slate-400 hover:raise-2'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
        <a
          href={conn.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-slate-500 hover:text-accent"
        >
          {conn.url.replace(/^https?:\/\//, '')}
          {conn.group && <span className="text-slate-600">/{conn.group}</span>}
          <ExternalLink size={11} />
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tab === 'projects' && <ProjectsTab onQueued={() => setTab('queue')} />}
        {tab === 'activity' && <ActivityTab />}
        {tab === 'work' && <WorkTab />}
        {tab === 'pipelines' && <PipelinesTab />}
        {tab === 'queue' && <QueueTab />}
      </div>
    </div>
  );
}

/** Shared load-with-refresh plumbing — four tabs, one pattern. */
function useLoad<T>(fn: () => Promise<T>): {
  data: T | null;
  error: string;
  busy: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  const reload = useCallback(() => {
    setBusy(true);
    void fn()
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => setError(err?.response?.data?.error ?? 'could not reach GitLab'))
      .finally(() => setBusy(false));
    // `fn` is rebuilt per render by the caller; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(reload, [reload]);
  return { data, error, busy, reload };
}

function TabHeader({ title, busy, onReload }: { title: string; busy: boolean; onReload: () => void }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{title}</h2>
      <Button variant="ghost" className="ml-auto" onClick={onReload} loading={busy} icon={<RefreshCw size={12} />}>
        Refresh
      </Button>
    </div>
  );
}

function ProjectsTab({ onQueued }: { onQueued: () => void }) {
  const { data, error, busy, reload } = useLoad(() => gitlabApi.projects());
  const [agents, setAgents] = useState<Agent[]>([]);
  const [who, setWho] = useState('');
  const [running, setRunning] = useState('');
  const [failed, setFailed] = useState('');

  useEffect(() => {
    void gitlabApi
      .connection()
      .then((c) => setWho(c.default_agent_id))
      .catch(() => undefined);
    void agentsApi
      .list()
      .then((rows) => setAgents(rows.filter((a) => !a.subagent)))
      .catch(() => setAgents([]));
  }, []);

  /**
   * Queue a review of one project and go and watch the line.
   *
   * It used to navigate straight into the session, because the run started here. It no longer does:
   * the check waits in the run lane like every other autonomous turn, so the honest thing to show
   * is the queue it was put in — with the row's link into the Workspace appearing the moment it
   * starts.
   */
  const check = async (path: string) => {
    setRunning(path);
    setFailed('');
    try {
      await gitlabApi.runCheck(path, who || undefined);
      onQueued();
    } catch (err: any) {
      setFailed(err?.response?.data?.error ?? 'could not queue the check');
    } finally {
      setRunning('');
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <TabHeader title="Projects" busy={busy} onReload={reload} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <ScanSearch size={12} />
        <span>“Check” asks an agent what needs attention on a project. It reports back; it changes nothing.</span>
        <select
          value={who}
          onChange={(e) => setWho(e.target.value)}
          className="ml-auto rounded-lg border hairline raise-1 px-2 py-1 text-[11px] text-slate-300"
        >
          <option value="">default agent</option>
          {agents.map((a) => (
            <option key={a._id} value={a._id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <Callout tone="error" icon={<AlertTriangle size={13} />}>
          {failed}
        </Callout>
      )}
      {error && <Callout tone="error" icon={<AlertTriangle size={13} />}>{error}</Callout>}
      {!error && data?.length === 0 && <EmptyState icon={<GitBranch size={20} />}>No projects in scope.</EmptyState>}
      <div className="grid gap-2 md:grid-cols-2">
        {(data ?? []).map((p: GitLabProject) => (
          <Row key={p.id} className="p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-mono text-xs text-slate-200 hover:text-accent"
                >
                  {p.path}
                </a>
                {p.description && (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{p.description}</p>
                )}
              </div>
              {p.pipeline && (
                <span className="flex shrink-0 items-center gap-1.5" title={`${p.default_branch}: ${p.pipeline.status}`}>
                  <Dot tone={pipelineTone(p.pipeline.status)} pulse={p.pipeline.status === 'running'} />
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-slate-600">
              <span className="font-mono">{p.default_branch}</span>
              <span>{p.open_issues} open</span>
              <span className="ml-auto">{ago(p.last_activity)}</span>
              <Button
                variant="ghost"
                loading={running === p.path}
                icon={<ScanSearch size={11} />}
                onClick={() => void check(p.path)}
              >
                Check
              </Button>
            </div>
          </Row>
        ))}
      </div>
    </div>
  );
}

/**
 * The feed of what the fleet did — the tab that justifies the whole page.
 *
 * Grouped by day, because the question is almost always "what happened today"; each row carries the
 * agent, and links to the conversation the call came out of, so a surprising commit is one click
 * from the reasoning that produced it.
 */
function ActivityTab() {
  const { data, error, busy, reload } = useLoad(() => gitlabApi.activity({ limit: 200 }));
  const byDay = new Map<string, GitLabActivity[]>();
  for (const row of data ?? []) {
    const day = new Date(row.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(row);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <TabHeader title="What the fleet did" busy={busy} onReload={reload} />
      {error && <Callout tone="error" icon={<AlertTriangle size={13} />}>{error}</Callout>}
      {!error && data?.length === 0 && (
        <EmptyState icon={<Activity size={20} />}>
          Nothing yet — this fills in as agents commit, open merge requests and work issues.
        </EmptyState>
      )}
      <div className="space-y-5">
        {[...byDay.entries()].map(([day, rows]) => (
          <div key={day}>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-600">{day}</div>
            <div className="space-y-1.5">
              {rows.map((row) => (
                <Row key={row._id} className="flex items-center gap-3 px-3 py-2">
                  <span className="shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    {row.agent_name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">
                    {row.action.replace('gitlab_', '').replace('.', ' ')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{row.title || row.target}</span>
                  <span className="hidden shrink-0 font-mono text-[10px] text-slate-600 sm:inline">{row.project}</span>
                  <span className="shrink-0 text-[10px] text-slate-600">
                    {new Date(row.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {row.session_id && (
                    <Link
                      to={`/workspace?session=${row.session_id}`}
                      title="Open the conversation this came from"
                      className="shrink-0 text-slate-600 hover:text-accent"
                    >
                      <Activity size={12} />
                    </Link>
                  )}
                  {row.url && (
                    <a href={row.url} target="_blank" rel="noreferrer" className="shrink-0 text-slate-600 hover:text-accent">
                      <ExternalLink size={12} />
                    </a>
                  )}
                </Row>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Issues grouped by assignee — "what is each agent working on" — with the open MRs beside them. */
function WorkTab() {
  const issues = useLoad(() => gitlabApi.issues('opened'));
  const mrs = useLoad(() => gitlabApi.mergeRequests('opened'));

  const byAssignee = new Map<string, GitLabIssue[]>();
  for (const issue of issues.data ?? []) {
    const key = issue.assignees[0] ?? '(unassigned)';
    if (!byAssignee.has(key)) byAssignee.set(key, []);
    byAssignee.get(key)!.push(issue);
  }
  // Unassigned last: it is the backlog, not somebody's plate.
  const groups = [...byAssignee.entries()].sort(([a], [b]) =>
    a === '(unassigned)' ? 1 : b === '(unassigned)' ? -1 : a.localeCompare(b),
  );

  return (
    <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div>
        <TabHeader title="Open issues" busy={issues.busy} onReload={issues.reload} />
        {issues.error && <Callout tone="error" icon={<AlertTriangle size={13} />}>{issues.error}</Callout>}
        {!issues.error && issues.data?.length === 0 && (
          <EmptyState icon={<CircleDot size={20} />}>Nothing open.</EmptyState>
        )}
        <div className="space-y-4">
          {groups.map(([assignee, rows]) => (
            <div key={assignee}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{assignee}</span>
                <span className="text-[10px] text-slate-600">{rows.length}</span>
              </div>
              <div className="space-y-1.5">
                {rows.map((i) => (
                  <Row key={`${i.project_id}-${i.iid}`} className="flex items-center gap-2 px-3 py-2">
                    <span className="shrink-0 font-mono text-[10px] text-slate-600">#{i.iid}</span>
                    <a
                      href={i.url}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate text-xs text-slate-300 hover:text-accent"
                    >
                      {i.title}
                    </a>
                    {i.labels.slice(0, 2).map((label) => (
                      <span key={label} className="shrink-0 rounded bg-slate-700/40 px-1.5 py-0.5 text-[10px] text-slate-400">
                        {label}
                      </span>
                    ))}
                    <span className="shrink-0 text-[10px] text-slate-600">{ago(i.updated_at)}</span>
                  </Row>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <TabHeader title="Open merge requests" busy={mrs.busy} onReload={mrs.reload} />
        {mrs.error && <Callout tone="error" icon={<AlertTriangle size={13} />}>{mrs.error}</Callout>}
        {!mrs.error && mrs.data?.length === 0 && (
          <EmptyState icon={<GitPullRequest size={20} />}>Nothing waiting.</EmptyState>
        )}
        <div className="space-y-1.5">
          {(mrs.data ?? []).map((m: GitLabMergeRequest) => (
            <Row key={`${m.project_id}-${m.iid}`} className="px-3 py-2">
              <div className="flex items-center gap-2">
                {m.pipeline && <Dot tone={pipelineTone(m.pipeline.status)} pulse={m.pipeline.status === 'running'} />}
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-xs text-slate-300 hover:text-accent"
                >
                  {m.title}
                </a>
                {m.draft && <span className="shrink-0 text-[10px] text-amber-400">draft</span>}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-600">
                <GitMerge size={10} />
                <span className="font-mono">
                  {m.source_branch} → {m.target_branch}
                </span>
                {m.has_conflicts && <span className="text-red-400">conflicts</span>}
                <span className="ml-auto">{m.author}</span>
              </div>
            </Row>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Recent pipelines, with one click into a failed job's log — the same text the agent reads. */
function PipelinesTab() {
  const { data, error, busy, reload } = useLoad(() => gitlabApi.pipelines());
  const [open, setOpen] = useState<GitLabPipeline | null>(null);
  const [jobs, setJobs] = useState<GitLabJob[] | null>(null);
  const [log, setLog] = useState<{ job: GitLabJob; text: string } | null>(null);

  const openPipeline = (p: GitLabPipeline) => {
    setOpen(p);
    setJobs(null);
    setLog(null);
  };

  useEffect(() => {
    if (!open?.project) return;
    void gitlabApi
      .jobs(open.project, open.id)
      .then(setJobs)
      .catch(() => setJobs([]));
  }, [open]);

  return (
    <div className="mx-auto max-w-5xl">
      <TabHeader title="Recent pipelines" busy={busy} onReload={reload} />
      {error && <Callout tone="error" icon={<AlertTriangle size={13} />}>{error}</Callout>}
      {!error && data?.length === 0 && <EmptyState icon={<Rocket size={20} />}>No pipelines yet.</EmptyState>}
      <div className="space-y-1.5">
        {(data ?? []).map((p) => (
          <Row key={`${p.project}-${p.id}`} className="px-3 py-2" onClick={() => openPipeline(p)}>
            <div className="flex items-center gap-3">
              <Dot tone={pipelineTone(p.status)} pulse={p.status === 'running'} />
              <span className="shrink-0 font-mono text-[10px] text-slate-500">{p.project}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">{p.ref}</span>
              <span className="shrink-0 font-mono text-[10px] text-slate-600">{p.sha}</span>
              <span className="shrink-0 text-[10px] text-slate-600">
                {p.duration ? `${Math.round(p.duration)}s` : ''}
              </span>
              <span className="shrink-0 text-[10px] text-slate-600">{ago(p.created_at)}</span>
            </div>
          </Row>
        ))}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setOpen(null)}>
          <div
            className="glass-card max-h-[80vh] w-full max-w-3xl overflow-auto rounded-2xl border hairline p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <Dot tone={pipelineTone(open.status)} />
              <span className="font-mono text-xs text-slate-300">
                {open.project} · {open.ref}
              </span>
              <a href={open.url} target="_blank" rel="noreferrer" className="ml-auto text-slate-500 hover:text-accent">
                <ExternalLink size={13} />
              </a>
            </div>
            {!jobs && <Loader2 size={14} className="animate-spin text-slate-500" />}
            <div className="space-y-1.5">
              {(jobs ?? []).map((job) => (
                <Row
                  key={job.id}
                  className="flex items-center gap-3 px-3 py-2"
                  onClick={() => {
                    void gitlabApi
                      .jobLog(open.project ?? '', job.id)
                      .then((r) => setLog({ job, text: r.log }))
                      .catch(() => setLog({ job, text: 'could not read this job’s log' }));
                  }}
                >
                  <Dot tone={pipelineTone(job.status)} />
                  <span className="shrink-0 text-[10px] text-slate-600">{job.stage}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{job.name}</span>
                  {job.failure_reason && <span className="shrink-0 text-[10px] text-red-400">{job.failure_reason}</span>}
                </Row>
              ))}
            </div>
            {log && (
              <pre className="mt-3 max-h-80 overflow-auto rounded-xl border hairline well p-3 font-mono text-[11px] leading-relaxed text-slate-400">
                {log.text}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** `queued_at` → how long it has been waiting, in the same register as `ago`. */
function waited(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}m` : `${Math.round(min / 60)}h`;
}

/** How long a finished run took. Blank when it never started (cancelled before its turn). */
function tookFor(row: RunQueueEntry): string {
  if (!row.started_at || !row.ended_at) return '';
  const sec = Math.round((new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
}

const QUEUE_TONES: Record<string, Tone> = {
  running: 'busy',
  queued: 'idle',
  done: 'ok',
  failed: 'error',
  cancelled: 'idle',
  interrupted: 'error',
};

/** The one line that says what a row *is*: where it came from and what about. */
function QueueRowBody({ row }: { row: RunQueueEntry }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xs font-medium text-slate-200">{row.agent_name}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-600">{row.origin || row.kind}</span>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-slate-500">
        {row.project && <span className="font-mono text-slate-600">{row.project} · </span>}
        {row.title || row.kind}
      </p>
    </div>
  );
}

/**
 * **Queue** — the LLM calls that have not happened yet (`RUN_QUEUE_PLAN.md` §5).
 *
 * The list is GitLab's own rows, but the *lane* is the whole fleet's: a forum wake or a cron task
 * holding it is why a GitLab row is not moving, so it is named in a banner rather than left to look
 * like a bug. Positions are counted within this list; `total_queued` says how many are really in
 * front, everything included.
 *
 * It polls rather than listening on the socket: three seconds is well inside the grain of a run that
 * takes an inference call, and the alternative is a new wire event for a page nobody keeps open.
 */
function QueueTab() {
  const [snap, setSnap] = useState<RunQueueSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [acting, setActing] = useState('');

  const load = useCallback(async () => {
    try {
      setSnap(await runQueueApi.list('gitlab'));
      setError('');
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'could not read the queue');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (id: string, what: 'cancel' | 'promote') => {
    setActing(id);
    try {
      await (what === 'cancel' ? runQueueApi.cancel(id) : runQueueApi.promote(id));
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? `could not ${what} that run`);
    } finally {
      setActing('');
    }
  };

  const togglePause = async () => {
    if (!snap) return;
    setActing('pause');
    try {
      await runQueueApi.pause(!snap.paused);
      await load();
    } finally {
      setActing('');
    }
  };

  if (!snap && busy) return <Spinner />;

  const holder = snap?.holder ?? null;
  const elsewhere = holder && holder.source !== 'gitlab' ? holder : null;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          What is about to run
        </h2>
        <Button
          variant="ghost"
          className="ml-auto"
          loading={acting === 'pause'}
          icon={snap?.paused ? <Play size={12} /> : <Pause size={12} />}
          onClick={() => void togglePause()}
        >
          {snap?.paused ? 'Resume' : 'Pause'}
        </Button>
        <Button variant="ghost" onClick={() => void load()} loading={busy} icon={<RefreshCw size={12} />}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-3">
          <Callout tone="error" icon={<AlertTriangle size={13} />}>{error}</Callout>
        </div>
      )}

      {snap?.paused && (
        <div className="mb-3">
          <Callout tone="warn" icon={<Pause size={13} />}>
            The run lane is held. Nothing new starts — a turn already running finishes on its own.
            Everything below keeps its place until you resume.
          </Callout>
        </div>
      )}

      {elsewhere && (
        <div className="mb-3">
          <Callout tone="info" icon={<Loader2 size={13} className="animate-spin" />}>
            The lane is busy with a <span className="font-medium">{elsewhere.source}</span> run —{' '}
            <span className="font-medium">{elsewhere.agent_name}</span>
            {elsewhere.title ? `, ${elsewhere.title}` : ''}. One turn runs at a time across the whole
            fleet, so the rows below start when it finishes.
          </Callout>
        </div>
      )}

      {snap?.running && (
        <Row className="mb-3 border-accent/30 p-3">
          <div className="flex items-center gap-2">
            <Dot tone="busy" pulse />
            <QueueRowBody row={snap.running} />
            <span className="shrink-0 text-[10px] text-slate-600">
              {snap.running.started_at ? `running ${waited(snap.running.started_at)}` : 'starting'}
            </span>
            {snap.running.session_id && (
              <Link
                to={`/workspace?session=${snap.running.session_id}`}
                className="shrink-0 text-[11px] text-accent hover:underline"
              >
                Watch
              </Link>
            )}
          </div>
        </Row>
      )}

      {snap && snap.queued.length === 0 && !snap.running && (
        <EmptyState icon={<ListOrdered size={20} />}>
          Nothing is waiting. A wake, a poll tick or a project check puts a turn in here.
        </EmptyState>
      )}

      {snap && snap.queued.length > 0 && (
        <div className="space-y-2">
          {snap.queued.map((row, i) => (
            <Row key={row.id} className="p-3">
              <div className="flex items-center gap-3">
                <span className="w-5 shrink-0 text-center font-mono text-[11px] text-slate-600">{i + 1}</span>
                <QueueRowBody row={row} />
                <span className="shrink-0 text-[10px] text-slate-600">waiting {waited(row.queued_at)}</span>
                <Button
                  variant="ghost"
                  disabled={i === 0}
                  loading={acting === row.id}
                  icon={<ArrowUp size={11} />}
                  onClick={() => void act(row.id, 'promote')}
                >
                  Run next
                </Button>
                <Button
                  variant="ghost"
                  loading={acting === row.id}
                  icon={<X size={11} />}
                  onClick={() => void act(row.id, 'cancel')}
                >
                  Cancel
                </Button>
              </div>
            </Row>
          ))}
        </div>
      )}

      {snap && snap.total_queued > snap.queued.length && (
        <p className="mt-2 text-[11px] text-slate-600">
          {snap.total_queued - snap.queued.length} other run
          {snap.total_queued - snap.queued.length === 1 ? '' : 's'} from elsewhere in the fleet share this
          lane.
        </p>
      )}

      {snap && snap.history.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Already run
          </h2>
          <div className="space-y-1.5">
            {snap.history.map((row) => (
              <Row key={row.id} className="px-3 py-2">
                <div className="flex items-center gap-3">
                  <Dot tone={QUEUE_TONES[row.status] ?? 'idle'} title={row.status} />
                  <QueueRowBody row={row} />
                  {row.error && (
                    <span className="max-w-[14rem] shrink-0 truncate text-[10px] text-red-400" title={row.error}>
                      {row.error}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-slate-600">
                    {row.status === 'done' ? tookFor(row) : row.status}
                    {row.ended_at ? ` · ${ago(row.ended_at)}` : ''}
                  </span>
                  {row.session_id && (
                    <Link
                      to={`/workspace?session=${row.session_id}`}
                      className="shrink-0 text-[11px] text-accent hover:underline"
                    >
                      Open
                    </Link>
                  )}
                </div>
              </Row>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
