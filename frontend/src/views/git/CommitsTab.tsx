import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy, GitCommitHorizontal, X } from 'lucide-react';
import { Button, Callout, EmptyState, Spinner } from '../../components/ui';
import { gitApi, type GitCommitDetail, type GitCommitSummary } from '../../lib/api';
import { DiffView } from './DiffView';
import { Author, errText, relativeTime, shortSha, subject } from './gitBits';

function CopySha({ sha }: { sha: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() =>
        void navigator.clipboard.writeText(sha).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
      title="Copy the full sha"
      className="inline-flex items-center gap-1 rounded px-1 font-mono text-[11px] text-slate-400 hover:raise-2 hover:text-slate-200"
    >
      {shortSha(sha)} {done ? <Check size={10} /> : <Copy size={10} />}
    </button>
  );
}

function CommitDetail({ repo, sha, onBack, onOpenCommit }: { repo: string; sha: string; onBack: () => void; onOpenCommit: (sha: string) => void }) {
  const [commit, setCommit] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCommit(null);
    setError(null);
    gitApi
      .commit(repo, sha)
      .then((c) => !cancelled && setCommit(c))
      .catch((e) => !cancelled && setError(errText(e)));
    return () => {
      cancelled = true;
    };
  }, [repo, sha]);

  const body = commit ? commit.message.split('\n').slice(1).join('\n').trim() : '';

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button icon={<ArrowLeft size={12} />} onClick={onBack}>
          History
        </Button>
      </div>
      {error && <Callout tone="error">{error}</Callout>}
      {!commit ? (
        !error && <Spinner />
      ) : (
        <>
          <div className="rounded-xl border hairline well px-4 py-3">
            <div className="text-sm font-medium text-slate-100">{subject(commit.message)}</div>
            {body && <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-slate-400">{body}</pre>}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <Author agent={commit.agent} fallback={commit.author_name} />
              <span className="text-slate-500" title={new Date(commit.date).toLocaleString()}>
                {relativeTime(commit.date)}
              </span>
              <CopySha sha={commit.sha} />
              {commit.parents.map((p) => (
                <button key={p} onClick={() => onOpenCommit(p)} className="font-mono text-slate-500 hover:text-accent">
                  parent {shortSha(p)}
                </button>
              ))}
              {commit.stats && (
                <span className="ml-auto font-mono">
                  <span className="text-slate-500">{commit.files.length} file{commit.files.length === 1 ? '' : 's'} · </span>
                  <span className="text-emerald-400">+{commit.stats.additions}</span>{' '}
                  <span className="text-red-400">−{commit.stats.deletions}</span>
                </span>
              )}
            </div>
          </div>
          <DiffView diff={commit.diff} truncated={commit.diff_truncated} />
        </>
      )}
    </div>
  );
}

/**
 * The log at a ref (optionally narrowed to one path), newest first, a page at a time. A commit opens
 * in place with its full diff; the sha lives in the URL so an activity row can link straight to it.
 */
export function CommitsTab({
  repo,
  gitRef,
  path,
  sha,
  onOpenCommit,
  onClearPath,
}: {
  repo: string;
  gitRef: string;
  path: string;
  sha: string;
  onOpenCommit: (sha: string | null) => void;
  onClearPath: () => void;
}) {
  const [items, setItems] = useState<GitCommitSummary[] | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextPage: number) => {
      try {
        const res = await gitApi.commits(repo, { ref: gitRef || undefined, path: path || undefined, page: nextPage });
        setItems((prev) => (nextPage === 1 ? res.items : [...(prev ?? []), ...res.items]));
        setHasMore(res.hasMore);
        setPage(nextPage);
        setError(null);
      } catch (e) {
        setError(errText(e));
        if (nextPage === 1) setItems([]);
      }
    },
    [repo, gitRef, path],
  );

  useEffect(() => {
    setItems(null);
    void load(1);
  }, [load]);

  if (sha) return <CommitDetail repo={repo} sha={sha} onBack={() => onOpenCommit(null)} onOpenCommit={onOpenCommit} />;

  return (
    <div className="flex flex-col gap-3">
      {path && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          History of <span className="font-mono text-slate-200">{path}</span>
          <button onClick={onClearPath} className="rounded p-0.5 hover:raise-2" title="Whole repo">
            <X size={12} />
          </button>
        </div>
      )}
      {error && <Callout tone="error">{error}</Callout>}
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        !error && <EmptyState icon={<GitCommitHorizontal size={20} />}>No commits here yet.</EmptyState>
      ) : (
        <div className="divide-y divide-hairline overflow-hidden rounded-xl border hairline well">
          {items.map((c) => (
            <button
              key={c.sha}
              onClick={() => onOpenCommit(c.sha)}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:raise-1"
            >
              <GitCommitHorizontal size={14} className="shrink-0 text-slate-600" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-slate-100">{subject(c.message)}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                  <Author agent={c.agent} fallback={c.author_name} />
                  <span className="text-slate-600" title={new Date(c.date).toLocaleString()}>
                    {relativeTime(c.date)}
                  </span>
                </div>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-slate-500">{shortSha(c.sha)}</span>
            </button>
          ))}
        </div>
      )}
      {hasMore && (
        <div className="flex justify-center">
          <Button
            loading={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              await load(page + 1);
              setLoadingMore(false);
            }}
          >
            Older commits
          </Button>
        </div>
      )}
    </div>
  );
}
