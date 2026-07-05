import { useState } from 'react';
import { ChevronRight, Loader2, TerminalSquare, Wrench, Check, X } from 'lucide-react';
import type { Block } from '../store/stream';

type ToolBlock = Extract<Block, { kind: 'tool' }>;

/** Renders one tool invocation inline in the conversation. bash → terminal; others → card. */
export function ToolCall({ block }: { block: ToolBlock }) {
  return block.tool === 'bash' ? <BashBlock block={block} /> : <GenericToolBlock block={block} />;
}

function StatusIcon({ status }: { status: ToolBlock['status'] }) {
  if (status === 'running') return <Loader2 size={13} className="animate-spin text-slate-400" />;
  if (status === 'error') return <X size={13} className="text-red-400" />;
  return <Check size={13} className="text-emerald-400" />;
}

/** OpenCode-style terminal block for bash: `$ command`, collapsible live output, exit code. */
function BashBlock({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const command = String(block.args?.command ?? '');
  const exit =
    block.result && typeof block.result === 'object' && 'exit_code' in block.result
      ? (block.result as { exit_code: number }).exit_code
      : undefined;

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-[#0b0e13] font-mono text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <TerminalSquare size={13} className="shrink-0 text-slate-400" />
        <span className="truncate text-slate-200">
          <span className="text-emerald-400">$</span> {command}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {exit !== undefined && (
            <span className={exit === 0 ? 'text-slate-500' : 'text-red-400'}>exit {exit}</span>
          )}
          <StatusIcon status={block.status} />
        </span>
      </button>
      {(open || block.status === 'running') && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-slate-300">
          {block.output || (block.status === 'running' ? '…' : '(no output)')}
        </pre>
      )}
    </div>
  );
}

/** Compact card for non-terminal tools: name + status, expandable args/result. */
function GenericToolBlock({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-surface text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Wrench size={13} className="shrink-0 text-accent" />
        <span className="font-medium text-slate-200">{block.tool}</span>
        <span className="ml-auto">
          <StatusIcon status={block.status} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2 font-mono">
          <div>
            <div className="mb-0.5 text-[10px] uppercase text-slate-500">args</div>
            <pre className="whitespace-pre-wrap text-slate-300">
              {JSON.stringify(block.args, null, 2)}
            </pre>
          </div>
          {block.result !== undefined && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase text-slate-500">result</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-slate-300">
                {typeof block.result === 'string'
                  ? block.result
                  : JSON.stringify(block.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
