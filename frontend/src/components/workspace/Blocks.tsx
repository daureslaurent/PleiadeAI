import { useState } from 'react';
import { ChevronRight, CornerDownRight, Loader2, Check, X, Brain, Gauge } from 'lucide-react';
import { ToolCall } from '../ToolCall';
import { Markdown } from '../Markdown';
import { agentColor, agentIcon, agentInitial } from '../../lib/agentColor';
import { iconFor } from '../../lib/agentIcons';
import { usePrefs } from '../../store/prefs';
import { ScoreBadge } from '../ScoreBadge';
import { MemoriesBadge } from '../MemoriesBadge';
import type { Block } from '../../store/stream';

type AgentBlock = Extract<Block, { kind: 'agent' }>;

/**
 * Render an ordered list of assistant blocks: prose spans, thinking blocks, inline tool blocks, and
 * nested sub-agent bubbles. Mutually recursive with `SubAgentBubble` so an agent→agent→agent chain
 * nests visually with progressive indentation.
 *
 * `live` — this frame is currently running, so its trailing thinking block streams open.
 * `isSub` — these are a sub-agent's blocks; their thinking blocks obey the `showSubagentThinking`
 *   preference (the top-level agent's thinking always shows).
 */
export function Blocks({
  blocks,
  live = false,
  isSub = false,
}: {
  blocks: Block[];
  live?: boolean;
  isSub?: boolean;
}) {
  const showSubThinking = usePrefs((s) => s.showSubagentThinking);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'text') {
          // Streaming caret on the trailing live prose block, so the reader sees where text lands.
          const isTail = live && i === blocks.length - 1;
          return (
            <div key={i} className={isTail ? 'stream-caret' : undefined}>
              <Markdown>{b.text}</Markdown>
            </div>
          );
        }
        if (b.kind === 'reasoning') {
          if (!b.text.trim() || (isSub && !showSubThinking)) return null;
          // Auto-expanded only while it's the frame's live trailing block (i.e. actively thinking);
          // collapses as soon as output follows it or the turn ends.
          return (
            <ThinkingBlock key={i} text={b.text} active={live && i === blocks.length - 1} />
          );
        }
        if (b.kind === 'tool') return <ToolCall key={b.callId} block={b} />;
        return <SubAgentBubble key={i} block={b} />;
      })}
    </>
  );
}

/**
 * A collapsible `<think>` reasoning panel. Expanded and spinning while the agent is actively
 * thinking (`active`), then collapses to a one-line "Thought process" chip the user can reopen.
 */
function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;
  return (
    <div
      className={[
        'my-1.5 overflow-hidden rounded-xl border border-reasoning/20 bg-reasoning/[0.06] backdrop-blur-sm transition-shadow',
        active ? 'shadow-[0_0_16px_rgba(168,85,247,0.15)]' : '',
      ].join(' ')}
    >
      <button
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-reasoning/10"
      >
        <ChevronRight
          size={12}
          className="shrink-0 text-reasoning/60 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : undefined }}
        />
        <Brain size={12} className="shrink-0 text-reasoning" />
        <span className={`text-[11px] font-medium text-reasoning ${active ? 'text-shimmer' : ''}`}>
          {active ? 'Thinking…' : 'Thought process'}
        </span>
        {active && <Loader2 size={11} className="ml-auto shrink-0 animate-spin text-reasoning/70" />}
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap px-3 pb-2 pt-0.5 font-mono text-[11px] leading-relaxed text-slate-400">
          {text}
        </div>
      )}
    </div>
  );
}

function fmtDuration(ms?: number): string | null {
  if (ms === undefined) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Compact tokens value: 1234 → "1.2K", 512 → "512". */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n);
}

/**
 * Contextual label for a frame's live spinner, derived from what it's doing *right now* (its last
 * block). Returns `null` when the frame has delegated to a still-running sub-agent — that deeper
 * frame owns the spinner instead, so only the single deepest active frame shows a "working" row.
 */
export function activityLabel(blocks: Block[]): string | null {
  const last = blocks[blocks.length - 1];
  if (last?.kind === 'agent' && last.status === 'running') return null;
  // The thinking block shows its own live spinner/header, so no separate activity row is needed.
  if (last?.kind === 'reasoning') return null;
  if (last?.kind === 'tool' && last.status === 'running') return `running ${last.tool}…`;
  return 'thinking…';
}

/**
 * The live "spinner + what it's doing" row shown at the end of an in-flight agent's output. Colored
 * to the owning agent so a nested sub-agent's spinner reads as that sub-agent's. Rendered by both
 * the top-level bubble (`ChatPanel`) and each running `SubAgentBubble`.
 */
export function ThinkingRow({ label, color }: { label: string; color?: string }) {
  return (
    <div
      className="mt-1 flex items-center gap-1.5 py-0.5 text-[11px]"
      style={color ? { color } : undefined}
    >
      <Loader2 size={12} className="shrink-0 animate-spin" />
      <span className={`text-shimmer ${color ? 'opacity-90' : 'text-slate-400'}`}>{label}</span>
    </div>
  );
}

/**
 * A delegated `ask_agent` run, shown as a color-coded, collapsible panel nested at the point of
 * the hop. Live while running (auto-expanded, full trace); auto-collapses to a summary chip when
 * done. The agent's identity color threads through the avatar, name, and the left rail wrapping
 * its work, so the viewer can always separate "who did what".
 */
function SubAgentBubble({ block }: { block: AgentBlock }) {
  const running = block.status === 'running';
  // null → follow the live default (open while running, collapsed once done); a boolean is the
  // user's explicit override once they click.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? running;
  const color = agentColor(block.agent);
  const duration = fmtDuration(block.durationMs);
  const showSubThinking = usePrefs((s) => s.showSubagentThinking);
  // Contextual "working" row for this sub-agent — null while it's delegating deeper (that frame
  // shows its own) or once it's finished. When its thinking block is hidden by preference, still
  // surface a plain "thinking…" so the sub-agent doesn't look idle while it reasons.
  const lastChild = block.children[block.children.length - 1];
  const thinkingHidden = running && !showSubThinking && lastChild?.kind === 'reasoning';
  const childLabel = running
    ? thinkingHidden
      ? 'thinking…'
      : activityLabel(block.children)
    : null;

  return (
    <div
      className={[
        'my-2 animate-fade-up overflow-hidden rounded-xl border backdrop-blur-sm transition-shadow',
        running ? 'animate-glow-pulse' : '',
      ].join(' ')}
      style={{
        borderColor: color.border,
        background: color.soft,
        ['--glow' as string]: `${color.accent}2e`,
      }}
    >
      <button
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
      >
        <ChevronRight
          size={13}
          className="shrink-0 text-slate-500 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : undefined }}
        />
        {/* Identity avatar in the agent's hue, showing its chosen icon (else its initial). */}
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-slate-950"
          style={{ background: color.accent }}
        >
          {(() => {
            const Icon = iconFor(agentIcon(block.agent));
            return Icon ? <Icon size={12} /> : agentInitial(block.agent);
          })()}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[10px] font-medium text-slate-500">{block.from}</span>
          <CornerDownRight size={11} className="shrink-0 text-slate-600" />
          <span className="truncate text-xs font-semibold" style={{ color: color.accent }}>
            {block.agent}
          </span>
        </span>
        {/* Delegated task preview — keeps the collapsed chip informative. */}
        <span className="min-w-0 flex-1 truncate text-[11px] italic text-slate-500">
          {block.query}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px]">
          {/* This sub-agent run's own Conversation Quality score, once the scorer has judged it. */}
          {block.score && <ScoreBadge score={block.score} size="xs" />}
          {block.promptTokens !== undefined && (
            <span
              className="flex items-center gap-1 text-slate-500"
              title={`Sub-agent context: ${block.promptTokens.toLocaleString()}${
                block.contextWindow
                  ? ` of ${block.contextWindow.toLocaleString()} tokens (${Math.round(
                      (block.promptTokens / block.contextWindow) * 100,
                    )}%)`
                  : ' tokens'
              }`}
            >
              <Gauge size={11} className="shrink-0 text-slate-600" />
              <span className="font-mono">
                {fmtTokens(block.promptTokens)}
                {block.contextWindow ? ` / ${fmtTokens(block.contextWindow)}` : ''}
              </span>
            </span>
          )}
          {duration && <span className="text-slate-500">{duration}</span>}
          {running ? (
            <span className="flex items-center gap-1 text-slate-400">
              <Loader2 size={12} className="animate-spin" />
            </span>
          ) : block.status === 'error' ? (
            <X size={13} className="text-red-400" />
          ) : (
            <Check size={13} className="text-emerald-400" />
          )}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-2.5">
          {/* What this sub-agent recalled into its *own* prompt (it has its own memory silo). Lives in
              the body, not the header row — that row is one big collapse button. */}
          {block.memories && block.memories.length > 0 && (
            <div className="mb-2 flex">
              <MemoriesBadge memories={block.memories} />
            </div>
          )}
          {/* The delegated question, spelled out above the sub-agent's work. */}
          <div className="mb-2 rounded-md bg-black/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-400">
            <span className="mr-1 select-none text-slate-600">Q:</span>
            {block.query}
          </div>
          {/* The sub-agent's own block tree, rail-marked in its color. */}
          <div className="border-l-2 pl-3" style={{ borderColor: color.accent }}>
            {block.children.length > 0 && (
              <Blocks blocks={block.children} live={running} isSub />
            )}
            {childLabel ? (
              <ThinkingRow label={childLabel} color={color.accent} />
            ) : block.children.length === 0 && !running ? (
              <div className="py-1 text-[11px] italic text-slate-600">no output</div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
