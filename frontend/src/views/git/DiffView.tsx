import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffFile {
  path: string;
  oldPath: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  binary: boolean;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/**
 * Parse `git diff` unified output into files and numbered lines. Only what a reader needs: the
 * header lines that say *what kind* of change it is are folded into `status`, the hunks are kept.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (header) {
      file = {
        path: header[2]!,
        oldPath: header[1]!,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;

    if (!inHunk) {
      if (raw.startsWith('new file mode')) file.status = 'added';
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
      else if (raw.startsWith('rename from')) file.status = 'renamed';
      else if (raw.startsWith('Binary files')) file.binary = true;
    }

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith('+')) {
      file.lines.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
      file.additions++;
    } else if (raw.startsWith('-')) {
      file.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
      file.deletions++;
    } else if (raw.startsWith('\\')) {
      file.lines.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith(' ') || raw === '') {
      // A trailing empty line after the last hunk is the split artefact, not context.
      if (raw === '' && file.lines.length && file.lines[file.lines.length - 1]!.kind !== 'ctx') continue;
      file.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

const LINE_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-red-500/10 text-red-300',
  ctx: 'text-slate-300',
  hunk: 'raise-1 text-accent/80',
  meta: 'text-slate-500 italic',
};

const MARK: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ', hunk: '', meta: '' };

const STATUS_TONE: Record<DiffFile['status'], string> = {
  added: 'text-emerald-400',
  deleted: 'text-red-400',
  renamed: 'text-amber-400',
  modified: 'text-slate-400',
};

/** Large diffs start folded past this many lines, so one generated file can't bury the rest. */
const AUTO_COLLAPSE_LINES = 400;

function FileDiff({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(file.lines.length <= AUTO_COLLAPSE_LINES);
  return (
    <div className="overflow-hidden rounded-xl border hairline well">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 border-b hairline px-3 py-2 text-left text-xs hover:raise-1"
      >
        {open ? <ChevronDown size={13} className="text-slate-500" /> : <ChevronRight size={13} className="text-slate-500" />}
        <span className="min-w-0 flex-1 truncate font-mono text-slate-200">
          {file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className={`text-[10px] uppercase tracking-wider ${STATUS_TONE[file.status]}`}>{file.status}</span>
        <span className="font-mono text-[11px] text-emerald-400">+{file.additions}</span>
        <span className="font-mono text-[11px] text-red-400">−{file.deletions}</span>
      </button>
      {open &&
        (file.binary ? (
          <div className="px-3 py-2 text-xs text-slate-500">Binary file — no text diff.</div>
        ) : file.lines.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-500">No content change (mode or empty file).</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.55]">
              <tbody>
                {file.lines.map((l, i) => (
                  <tr key={i} className={LINE_TONE[l.kind]}>
                    <td className="w-10 select-none border-r hairline px-2 text-right text-slate-600">{l.oldNo ?? ''}</td>
                    <td className="w-10 select-none border-r hairline px-2 text-right text-slate-600">{l.newNo ?? ''}</td>
                    <td className="w-4 select-none pl-2 text-slate-500">{MARK[l.kind]}</td>
                    <td className="whitespace-pre pr-4">{l.text || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

/** A commit's whole diff: one foldable card per file. */
export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (files.length === 0) return <div className="text-xs text-slate-500">This commit changes no files.</div>;
  return (
    <div className="flex flex-col gap-3">
      {files.map((f) => (
        <FileDiff key={`${f.oldPath}->${f.path}`} file={f} />
      ))}
      {truncated && (
        <div className="text-xs text-amber-400">The diff was cut at 1 MB — the file list above is complete.</div>
      )}
    </div>
  );
}
