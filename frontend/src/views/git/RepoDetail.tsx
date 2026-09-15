import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Copy, GitBranch, Pencil, Trash2 } from 'lucide-react';
import { Button, Callout, Chip, Input, Select, Spinner, useConfirm } from '../../components/ui';
import { gitApi, type GitBranch as Branch, type GitRepo, type GitStatus } from '../../lib/api';
import { AccessTab } from './AccessTab';
import { ActivityFeed } from './ActivityFeed';
import { CommitsTab } from './CommitsTab';
import { FilesTab } from './FilesTab';
import { Author, errText, relativeTime, shortSha, subject } from './gitBits';

const TABS = ['files', 'commits', 'branches', 'access', 'activity'] as const;
type Tab = (typeof TABS)[number];

function CloneLine({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  const cmd = `git clone ${url}`;
  return (
    <button
      onClick={() =>
        void navigator.clipboard.writeText(cmd).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
      className="flex min-w-0 items-center gap-2 rounded-lg border hairline well px-2.5 py-1 text-left font-mono text-[11px] text-slate-300 hover:hairline-strong"
      title="Copy"
    >
      <span className="truncate">{cmd}</span>
      {done ? <Check size={11} className="shrink-0 text-emerald-400" /> : <Copy size={11} className="shrink-0 text-slate-500" />}
    </button>
  );
}

function BranchesTab({ branches, defaultBranch, onPick }: { branches: Branch[]; defaultBranch: string; onPick: (name: string) => void }) {
  return (
    <div className="divide-y divide-hairline overflow-hidden rounded-xl border hairline well">
      {branches.map((b) => (
        <button key={b.name} onClick={() => onPick(b.name)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:raise-1">
          <GitBranch size={14} className="shrink-0 text-slate-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-xs text-slate-100">{b.name}</span>
              {b.name === defaultBranch && <Chip>default</Chip>}
              {b.protected && <Chip>protected</Chip>}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-slate-500">
              <span className="font-mono">{shortSha(b.sha)}</span>
              <span className="truncate text-slate-400">{subject(b.message)}</span>
            </div>
          </div>
          <div className="shrink-0 text-right text-[11px]">
            <Author agent={null} fallback={b.author_name} />
            <div className="text-slate-600">{relativeTime(b.date)}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * One repo: its clone line, a ref picker, and the tabs. The tab, ref, path, open file and open commit
 * all live in the query string, so any view of a repo is a link — which is how the activity feed
 * opens a commit's diff.
 */
export function RepoDetail({
  name,
  status,
  onChanged,
  onDeleted,
}: {
  name: string;
  status: GitStatus | null;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const [repo, setRepo] = useState<GitRepo | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'files';
  const gitRef = params.get('ref') ?? '';
  const path = params.get('path') ?? '';
  const file = params.get('file') ?? '';
  const sha = params.get('sha') ?? '';

  /** Replace some query keys; `null` removes one. */
  const patch = useCallback(
    (next: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === '') p.delete(k);
            else p.set(k, v);
          }
          return p;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  useEffect(() => {
    let cancelled = false;
    setRepo(null);
    setError(null);
    Promise.all([gitApi.repo(name), gitApi.branches(name).catch(() => [])])
      .then(([r, b]) => {
        if (cancelled) return;
        setRepo(r);
        setBranches(b);
      })
      .catch((e) => !cancelled && setError(errText(e)));
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (error) return <div className="p-4"><Callout tone="error">{error}</Callout></div>;
  if (!repo) return <Spinner />;

  const ref = gitRef || repo.default_branch;
  const cloneBase = status?.agent_urls?.bridge ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-lg text-slate-100">
              <span className="text-slate-500">{status?.org ?? 'pleiades'}/</span>
              {repo.name}
            </h2>
            {repo.fleet_readable ? <Chip>fleet-readable</Chip> : <Chip>private</Chip>}
            <span className="text-[11px] text-slate-500">updated {relativeTime(repo.updated_at)}</span>
            <Button
              variant="danger"
              className="ml-auto"
              icon={<Trash2 size={12} />}
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete ${repo.name}?`,
                  body: 'The repository and its whole history are removed from the git server. Agents with a clone keep their local copy.',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await gitApi.deleteRepo(repo.name);
                  onDeleted();
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              Delete
            </Button>
          </div>

          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  setRepo(await gitApi.updateRepo(repo.name, { description: draft }));
                  setEditing(false);
                  onChanged();
                } catch (err) {
                  setError(errText(err));
                }
              }}
            >
              <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What this repo holds" />
              <Button variant="primary" type="submit">Save</Button>
              <Button type="button" onClick={() => setEditing(false)}>Cancel</Button>
            </form>
          ) : (
            <button
              onClick={() => {
                setDraft(repo.description);
                setEditing(true);
              }}
              className="group flex items-center gap-1.5 self-start text-left text-sm text-slate-400 hover:text-slate-200"
            >
              {repo.description || <span className="italic text-slate-600">No description</span>}
              <Pencil size={11} className="opacity-0 group-hover:opacity-100" />
            </button>
          )}

          {cloneBase && (
            <div className="flex flex-wrap items-center gap-2">
              <CloneLine url={`${cloneBase}/${status?.org}/${repo.name}.git`} />
              <span className="text-[11px] text-slate-600">
                from a bridge container · host: {status?.agent_urls?.host} · vpn: {status?.agent_urls?.vpn}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1 border-b hairline">
          {TABS.map((t) => (
            <button
              key={t}
              // `path` means a folder on Files and a history filter on Commits, so a tab switch starts clean.
              onClick={() => patch({ tab: t === 'files' ? null : t, sha: null, file: null, path: null })}
              className={`-mb-px border-b-2 px-3 py-1.5 text-xs capitalize transition-colors ${
                tab === t ? 'border-accent text-accent' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t}
              {t === 'branches' && branches.length > 0 && <span className="ml-1 text-slate-600">{branches.length}</span>}
            </button>
          ))}
          {(tab === 'files' || tab === 'commits') && branches.length > 0 && (
            <Select
              className="!mb-1 ml-auto !w-44 !py-1 font-mono text-xs"
              value={ref}
              onChange={(e) => patch({ ref: e.target.value === repo.default_branch ? null : e.target.value, sha: null })}
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
              {!branches.some((b) => b.name === ref) && <option value={ref}>{ref}</option>}
            </Select>
          )}
        </div>

        {tab === 'files' && (
          <FilesTab
            repo={repo.name}
            gitRef={ref}
            path={path}
            file={file}
            onOpenDir={(p) => patch({ path: p || null, file: null })}
            onOpenFile={(f) => patch({ file: f })}
            onHistory={(p) => patch({ tab: 'commits', path: p, file: null, sha: null })}
          />
        )}
        {tab === 'commits' && (
          <CommitsTab
            repo={repo.name}
            gitRef={ref}
            path={path}
            sha={sha}
            onOpenCommit={(s) => patch({ sha: s })}
            onClearPath={() => patch({ path: null })}
          />
        )}
        {tab === 'branches' && (
          <BranchesTab
            branches={branches}
            defaultBranch={repo.default_branch}
            onPick={(b) => patch({ tab: null, ref: b === repo.default_branch ? null : b, path: null, file: null })}
          />
        )}
        {tab === 'access' && <AccessTab repo={repo.name} />}
        {tab === 'activity' && (
          <ActivityFeed
            repo={repo.name}
            onOpenRepo={() => patch({ tab: null })}
            onOpenCommit={(_r, s) => patch({ tab: 'commits', sha: s, path: null })}
          />
        )}
      </div>
    </div>
  );
}
