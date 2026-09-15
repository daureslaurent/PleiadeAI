import { Bot, User } from 'lucide-react';
import type { GitAgentRef } from '../../lib/api';

export { relativeTime } from '../autonomy/time';

/** The backend's `{ error }` body when there is one, else the transport error. */
export function errText(e: unknown): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string };
  return err?.response?.data?.error ?? err?.message ?? String(e);
}

export const shortSha = (sha: string) => sha.slice(0, 8);

/** First line of a commit message. */
export const subject = (message: string) => message.split('\n')[0] ?? '';

/**
 * Who did it: an agent (the git account maps back to one) or a plain account — the backend's admin
 * when the operator created a repo from this page, or a human author name in an imported history.
 */
export function Author({ agent, fallback }: { agent: GitAgentRef | null; fallback: string }) {
  if (agent?.agent_name) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-accent" title={agent.username}>
        <Bot size={11} className="shrink-0" />
        <span className="truncate">{agent.agent_name}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-slate-400">
      <User size={11} className="shrink-0" />
      <span className="truncate">{fallback}</span>
    </span>
  );
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const LANGS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  dockerfile: 'docker',
  ini: 'ini',
  lua: 'lua',
};

/** Prism language for a path, by extension (or a bare `Dockerfile`/`Makefile`). */
export function languageFor(path: string): string {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  if (base === 'dockerfile') return 'docker';
  if (base === 'makefile') return 'makefile';
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return LANGS[ext] ?? 'text';
}

/** What an activity row says the actor did. */
export function describeOp(op: string, count: number): string {
  switch (op) {
    case 'commit_repo':
      return `pushed ${count} commit${count === 1 ? '' : 's'} to`;
    case 'create_repo':
      return 'created';
    case 'rename_repo':
      return 'renamed';
    case 'delete_branch':
      return 'deleted branch';
    case 'push_tag':
      return 'pushed tag';
    case 'delete_tag':
      return 'deleted tag';
    case 'transfer_repo':
      return 'transferred';
    default:
      return op.replace(/_/g, ' ');
  }
}
