import { useEffect, useState } from 'react';
import { ChevronRight, FileCode2, FileText, Folder, GitCommitHorizontal, History, Link2 } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Button, Callout, EmptyState, Spinner } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { gitApi, type GitFile, type GitTreeEntry } from '../../lib/api';
import { usePrefs } from '../../store/prefs';
import { themeById } from '../../theme/themes';
import { errText, fmtBytes, languageFor } from './gitBits';

/** Breadcrumb over a repo path; the root crumb is the repo name. */
function Crumbs({ repo, path, onGo }: { repo: string; path: string; onGo: (path: string) => void }) {
  const parts = path ? path.split('/') : [];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-xs">
      <button onClick={() => onGo('')} className="rounded px-1 text-accent hover:raise-2">
        {repo}
      </button>
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-0.5">
          <ChevronRight size={11} className="text-slate-600" />
          <button
            onClick={() => onGo(parts.slice(0, i + 1).join('/'))}
            className={`rounded px-1 hover:raise-2 ${i === parts.length - 1 ? 'text-slate-100' : 'text-slate-400'}`}
          >
            {part}
          </button>
        </span>
      ))}
    </div>
  );
}

function FileBody({ file }: { file: GitFile }) {
  const [rendered, setRendered] = useState(true);
  const prismStyle = themeById(usePrefs((s) => s.theme)).mode === 'light' ? oneLight : oneDark;
  const language = languageFor(file.path);

  if (file.binary) {
    return <EmptyState icon={<FileCode2 size={20} />}>Binary file ({fmtBytes(file.size)}) — nothing to show as text.</EmptyState>;
  }
  return (
    <div className="flex flex-col gap-2">
      {file.truncated && (
        <Callout tone="warn">Only the first 512 KB of this {fmtBytes(file.size)} file is shown.</Callout>
      )}
      {language === 'markdown' && (
        <div className="flex gap-1">
          <Button variant={rendered ? 'accentSoft' : 'ghost'} onClick={() => setRendered(true)}>
            Rendered
          </Button>
          <Button variant={rendered ? 'ghost' : 'accentSoft'} onClick={() => setRendered(false)}>
            Source
          </Button>
        </div>
      )}
      {language === 'markdown' && rendered ? (
        <div className="rounded-xl border hairline well px-5 py-4 text-sm text-slate-200">
          <Markdown>{file.content}</Markdown>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border hairline well">
          <SyntaxHighlighter
            language={language}
            style={prismStyle}
            showLineNumbers
            lineNumberStyle={{ minWidth: '2.5em', opacity: 0.4 }}
            customStyle={{ margin: 0, background: 'transparent', padding: '0.75rem', fontSize: '0.78rem', lineHeight: '1.55' }}
            codeTagProps={{ style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }}
          >
            {file.content}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  );
}

/**
 * Browse a repo at a ref: a folder listing with breadcrumbs (a README under it renders like a forge
 * does), or one file, highlighted, with a jump to its history.
 */
export function FilesTab({
  repo,
  gitRef,
  path,
  file,
  onOpenDir,
  onOpenFile,
  onHistory,
}: {
  repo: string;
  gitRef: string;
  path: string;
  file: string;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onHistory: (path: string) => void;
}) {
  const [entries, setEntries] = useState<GitTreeEntry[] | null>(null);
  const [content, setContent] = useState<GitFile | null>(null);
  const [readme, setReadme] = useState<GitFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setReadme(null);
    if (file) {
      setContent(null);
      gitApi
        .file(repo, file, gitRef)
        .then((f) => !cancelled && setContent(f))
        .catch((e) => !cancelled && setError(errText(e)));
    } else {
      setEntries(null);
      gitApi
        .tree(repo, path, gitRef)
        .then((list) => {
          if (cancelled) return;
          setEntries(list);
          const md = list.find((e) => e.type === 'file' && /^readme(\.md|\.markdown)?$/i.test(e.name));
          if (md) void gitApi.file(repo, md.path, gitRef).then((f) => !cancelled && setReadme(f)).catch(() => undefined);
        })
        .catch((e) => !cancelled && setError(errText(e)));
    }
    return () => {
      cancelled = true;
    };
  }, [repo, gitRef, path, file]);

  const here = file || path;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Crumbs repo={repo} path={here} onGo={onOpenDir} />
        {here && (
          <Button className="ml-auto" icon={<History size={12} />} onClick={() => onHistory(here)}>
            History
          </Button>
        )}
        {file && content && (
          <Button
            icon={<Link2 size={12} />}
            onClick={() => void navigator.clipboard.writeText(content.content)}
            disabled={content.binary}
          >
            Copy
          </Button>
        )}
      </div>

      {error && <Callout tone="error">{error}</Callout>}

      {file ? (
        content ? <FileBody file={content} /> : !error && <Spinner />
      ) : entries === null ? (
        !error && <Spinner />
      ) : entries.length === 0 ? (
        <EmptyState icon={<GitCommitHorizontal size={20} />}>This repo has no commits yet — push one to see files.</EmptyState>
      ) : (
        <>
          <div className="divide-y divide-hairline overflow-hidden rounded-xl border hairline well">
            {path && (
              <button
                onClick={() => onOpenDir(path.split('/').slice(0, -1).join('/'))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-slate-500 hover:raise-1"
              >
                <Folder size={13} /> ..
              </button>
            )}
            {entries.map((e) => (
              <button
                key={e.path}
                onClick={() => (e.type === 'dir' ? onOpenDir(e.path) : onOpenFile(e.path))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:raise-1"
              >
                {e.type === 'dir' ? (
                  <Folder size={13} className="shrink-0 text-accent/80" />
                ) : (
                  <FileText size={13} className="shrink-0 text-slate-500" />
                )}
                <span className={`min-w-0 flex-1 truncate font-mono ${e.type === 'dir' ? 'text-slate-100' : 'text-slate-300'}`}>
                  {e.name}
                </span>
                {e.type === 'file' && <span className="shrink-0 text-[10px] text-slate-600">{fmtBytes(e.size)}</span>}
                {e.type !== 'file' && e.type !== 'dir' && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-slate-600">{e.type}</span>
                )}
              </button>
            ))}
          </div>
          {readme && !readme.binary && (
            <div className="rounded-xl border hairline well px-5 py-4 text-sm text-slate-200">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">{readme.path}</div>
              <Markdown>{readme.content}</Markdown>
            </div>
          )}
        </>
      )}
    </div>
  );
}
