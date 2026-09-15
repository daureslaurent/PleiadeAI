import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Activity, AlertTriangle, FolderGit2, GitBranch, KeyRound, Plus, RefreshCw, Search } from 'lucide-react';
import { ListDivider, ListRow } from '../../components/MasterDetail';
import { Button, Callout, EmptyState, Field, Input, Section, Spinner, Toggle } from '../../components/ui';
import { gitApi, type GitRepo, type GitStatus } from '../../lib/api';
import { AccountsPanel } from './AccountsPanel';
import { ActivityFeed } from './ActivityFeed';
import { RepoDetail } from './RepoDetail';
import { errText, relativeTime } from './gitBits';

function NewRepoPanel({ onCreated, onCancel }: { onCreated: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fleet, setFleet] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <Section title="New repository" icon={<FolderGit2 size={12} />}>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const repo = await gitApi.createRepo({ name: name.trim(), description, fleet_readable: fleet });
              onCreated(repo.name);
            } catch (err) {
              setError(errText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Name" hint='Letters, digits, ".", "_" or "-". Starts with a README commit on main.'>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="shared-lib" />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this repo holds" />
          </Field>
          <label className="flex items-center gap-3 text-sm text-slate-300">
            <Toggle checked={fleet} onChange={setFleet} /> Every agent can read it
          </label>
          {error && <Callout tone="error">{error}</Callout>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </form>
      </Section>
    </div>
  );
}

/**
 * `/git` — the fleet's internal git server (GIT_SERVER_PLAN.md §5).
 *
 * The rail lists the repos (newest activity first) above two fleet-wide views: the activity feed —
 * who pushed what, where — and the agent accounts. Routes: `/git` (activity), `/git/accounts`,
 * `/git/new`, `/git/r/:repo` (with its tab/ref/path/commit in the query string).
 */
export function GitView() {
  const navigate = useNavigate();
  const { section, repo } = useParams<{ section?: string; repo?: string }>();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [repos, setRepos] = useState<GitRepo[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await gitApi.status();
      setStatus(s);
      setRepos(s.ok ? await gitApi.repos() : []);
      setError(null);
    } catch (e) {
      setError(errText(e));
      setRepos([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  }, [repos, query]);

  if (!repos) return <Spinner />;

  const view = repo ? 'repo' : section === 'accounts' ? 'accounts' : section === 'new' ? 'new' : 'activity';
  const openCommit = (r: string, sha: string) => navigate(`/git/r/${encodeURIComponent(r)}?tab=commits&sha=${sha}`);
  const openRepo = (r: string) => navigate(`/git/r/${encodeURIComponent(r)}`);

  return (
    <div className="flex h-full min-h-0">
      <aside className="glass flex w-64 shrink-0 flex-col border-r">
        <button
          onClick={() => navigate('/git/new')}
          disabled={!status?.ok}
          className="m-2 flex items-center justify-center gap-1.5 rounded-lg border border-dashed hairline-strong py-2 text-sm text-slate-400 transition-colors hover:border-accent/50 hover:bg-accent/[0.06] hover:text-accent active:scale-95 disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus size={15} /> New repository
        </button>
        <div className="px-2 pb-2">
          <ListRow active={view === 'activity'} onClick={() => navigate('/git')}>
            <Activity size={14} className="shrink-0" /> Activity
          </ListRow>
          <ListRow active={view === 'accounts'} onClick={() => navigate('/git/accounts')}>
            <KeyRound size={14} className="shrink-0" /> Agent accounts
          </ListRow>
          <ListDivider />
          <div className="relative mt-1">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
            <Input className="!py-1.5 pl-7 text-xs" placeholder="Filter repos" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {shown.map((r) => (
            <ListRow key={r.name} active={repo === r.name} onClick={() => openRepo(r.name)}>
              <GitBranch size={14} className="shrink-0 opacity-70" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs">{r.name}</div>
                <div className="truncate text-[10px] text-slate-500">
                  {r.description || (r.fleet_readable ? 'fleet-readable' : 'private')} · {relativeTime(r.updated_at)}
                </div>
              </div>
            </ListRow>
          ))}
          {status?.ok && repos.length === 0 && <div className="px-3 py-2 text-xs text-slate-600">No repositories yet.</div>}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="glass flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <h1 className="text-sm font-medium text-slate-100">Internal git</h1>
          {status?.ok ? (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400" title={status.server_url}>
              Forgejo {status.version?.split('+')[0]} · {status.org} · {repos.length} repo{repos.length === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
              {status?.enabled === false ? 'Not configured' : 'Unreachable'}
            </span>
          )}
          <Button className="ml-auto" icon={<RefreshCw size={12} />} onClick={() => void load()}>
            Refresh
          </Button>
        </div>

        {error && (
          <div className="p-3">
            <Callout tone="error" icon={<AlertTriangle size={13} />}>
              {error}
            </Callout>
          </div>
        )}

        {status && !status.ok ? (
          <div className="mx-auto w-full max-w-2xl p-4">
            <Callout tone="warn" icon={<AlertTriangle size={13} />}>
              {status.enabled === false ? (
                <>
                  The internal git server is off. Set <code className="font-mono">GIT_ADMIN_PASSWORD</code> in{' '}
                  <code className="font-mono">.env</code>, then <code className="font-mono">docker compose up -d forgejo backend</code>.
                  The backend creates the admin account, the <code className="font-mono">{status.org}</code> organisation and
                  one account per isolated agent by itself.
                </>
              ) : (
                <>
                  {status.error} {status.reachable === false && 'Is the forgejo container running?'}
                </>
              )}
            </Callout>
          </div>
        ) : view === 'repo' && repo ? (
          <RepoDetail
            key={repo}
            name={repo}
            status={status}
            onChanged={() => void load()}
            onDeleted={() => {
              void load();
              navigate('/git');
            }}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {view === 'new' ? (
              <NewRepoPanel
                onCancel={() => navigate('/git')}
                onCreated={(name) => {
                  void load();
                  openRepo(name);
                }}
              />
            ) : view === 'accounts' ? (
              <div className="mx-auto w-full max-w-5xl p-4">
                <AccountsPanel />
              </div>
            ) : (
              <div className="mx-auto w-full max-w-5xl p-4">
                {repos.length === 0 ? (
                  <EmptyState icon={<FolderGit2 size={20} />}>
                    No repositories yet. Create one here, or let an isolated agent make one with <code>git_repos create</code>.
                  </EmptyState>
                ) : (
                  <ActivityFeed repos={repos} onOpenCommit={openCommit} onOpenRepo={openRepo} />
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
