import { useCallback, useEffect, useState } from 'react';
import { Activity, GitBranch, GitCommitHorizontal, PackagePlus, Tag, Trash2 } from 'lucide-react';
import { Button, Callout, EmptyState, Select, Spinner } from '../../components/ui';
import { gitApi, type GitActivity, type GitIdentity, type GitRepo } from '../../lib/api';
import { Author, describeOp, errText, relativeTime, shortSha, subject } from './gitBits';

const OP_ICON: Record<string, typeof Activity> = {
  commit_repo: GitCommitHorizontal,
  create_repo: PackagePlus,
  delete_branch: Trash2,
  push_tag: Tag,
  delete_tag: Trash2,
};

/**
 * What happened on the server, newest first: pushes (with their commits), repo creations, branch and
 * tag events — filterable by agent and, on the global feed, by repo. A commit links to its diff.
 */
export function ActivityFeed({
  repo,
  repos,
  onOpenCommit,
  onOpenRepo,
}: {
  /** Fixed repo (the repo page's tab); absent on the global feed, which then offers a repo filter. */
  repo?: string;
  repos?: GitRepo[];
  onOpenCommit: (repo: string, sha: string) => void;
  onOpenRepo: (repo: string) => void;
}) {
  const [agents, setAgents] = useState<GitIdentity[]>([]);
  const [agentId, setAgentId] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [items, setItems] = useState<GitActivity[] | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void gitApi.identities().then((ids) => setAgents(ids.filter((i) => i.username))).catch(() => undefined);
  }, []);

  const effectiveRepo = repo ?? (repoFilter || undefined);

  const load = useCallback(
    async (nextPage: number) => {
      try {
        const res = await gitApi.activity({ agentId: agentId || undefined, repo: effectiveRepo, page: nextPage });
        setItems((prev) => (nextPage === 1 ? res.items : [...(prev ?? []), ...res.items]));
        setHasMore(res.hasMore);
        setPage(nextPage);
        setError(null);
      } catch (e) {
        setError(errText(e));
        if (nextPage === 1) setItems([]);
      }
    },
    [agentId, effectiveRepo],
  );

  useEffect(() => {
    setItems(null);
    void load(1);
  }, [load]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="!w-48 !py-1 text-xs" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Every account</option>
          {agents.map((a) => (
            <option key={a.agent_id} value={a.agent_id}>
              {a.agent_name}
            </option>
          ))}
        </Select>
        {!repo && repos && (
          <Select className="!w-48 !py-1 text-xs" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)}>
            <option value="">Every repo</option>
            {repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {error && <Callout tone="error">{error}</Callout>}
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        !error && <EmptyState icon={<Activity size={20} />}>Nothing has happened here yet.</EmptyState>
      ) : (
        <div className="divide-y divide-hairline overflow-hidden rounded-xl border hairline well">
          {items.map((a) => {
            const Icon = OP_ICON[a.op] ?? GitBranch;
            return (
              <div key={a.id} className="flex gap-3 px-3 py-2.5">
                <Icon size={14} className="mt-0.5 shrink-0 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                    <Author agent={a.actor.agent_name ? a.actor : null} fallback={a.actor.username} />
                    <span className="text-slate-500">{describeOp(a.op, a.commit_count)}</span>
                    {a.op !== 'create_repo' && a.ref && <span className="font-mono text-slate-300">{a.ref}</span>}
                    {a.repo && (
                      <>
                        {a.op !== 'create_repo' && a.ref && <span className="text-slate-500">in</span>}
                        <button onClick={() => onOpenRepo(a.repo!)} className="font-mono text-accent hover:underline">
                          {a.repo}
                        </button>
                      </>
                    )}
                    <span className="ml-auto text-[11px] text-slate-600" title={new Date(a.created).toLocaleString()}>
                      {relativeTime(a.created)}
                    </span>
                  </div>
                  {a.commits.length > 0 && a.repo && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {a.commits.map((c) => (
                        <button
                          key={c.sha}
                          onClick={() => onOpenCommit(a.repo!, c.sha)}
                          className="flex min-w-0 items-center gap-2 rounded px-1 text-left text-[11px] hover:raise-2"
                        >
                          <span className="shrink-0 font-mono text-slate-500">{shortSha(c.sha)}</span>
                          <span className="truncate text-slate-300">{subject(c.message)}</span>
                        </button>
                      ))}
                      {a.commit_count > a.commits.length && (
                        <span className="px-1 text-[11px] text-slate-600">+{a.commit_count - a.commits.length} more</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {hasMore && (
        <div className="flex justify-center">
          <Button onClick={() => void load(page + 1)}>Older activity</Button>
        </div>
      )}
    </div>
  );
}
