import { ChevronDown, ChevronUp, Mic } from 'lucide-react';
import { Blocks, ThinkingRow, activityLabel } from '../Blocks';
import { Collapsible } from '../Collapsible';
import { agentColor, agentGlow, agentIcon, agentInitial } from '../../../lib/agentColor';
import { iconFor } from '../../../lib/agentIcons';
import { ScoreBadge } from '../../ScoreBadge';
import { MemoriesBadge } from '../../MemoriesBadge';
import type { Block, RecalledMemory, Turn, TurnScore } from '../../../store/stream';

/**
 * The pieces every chat layout is built from (THEME_SYSTEM_PLAN.md §3.2).
 *
 * A layout decides *structure* — who sits where, what a tool call looks like, whether the
 * machinery stays in the flow. Everything below is the part that is the same whatever it decides:
 * what a user turn contains, what an agent's identity looks like, how a long history folds. Five
 * layouts share these rather than each carrying a copy.
 */

/** What every `ConversationView` receives. The shell (`ChatPanel`) owns all of this state. */
export interface ConversationProps {
  /** The whole conversation — needed to decide what is the *last* turn, not just the last shown. */
  turns: Turn[];
  /** The tail actually rendered; the rest is behind the fold. */
  shownTurns: Turn[];
  hiddenTurns: number;
  showAllTurns: boolean;
  onShowAll: () => void;
  onFoldBack: () => void;
  /** How many turns stay unfolded — the fold only offers itself past this. */
  recentTurns: number;
  agentName: string;
  /** A Conversation Generator session: the "user" turns are the interviewer, not the operator. */
  generatedSession?: boolean;
  streaming: boolean;
  liveBlocks: Block[];
  liveMemories?: RecalledMemory[];
}

/** Whether a turn should clamp behind "Show more": everything but the settled last one. */
export function isCollapsible(p: ConversationProps, index: number): boolean {
  return p.streaming || p.hiddenTurns + index < p.turns.length - 1;
}

/** The "Show N earlier messages" divider, and the control that folds them back. */
export function HistoryFold(p: ConversationProps) {
  return (
    <>
      {p.hiddenTurns > 0 && (
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 raise-2" />
          <button
            onClick={p.onShowAll}
            className="glass flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:text-slate-100"
          >
            <ChevronUp size={12} />
            Show {p.hiddenTurns} earlier {p.hiddenTurns === 1 ? 'message' : 'messages'}
          </button>
          <div className="h-px flex-1 raise-2" />
        </div>
      )}
      {p.showAllTurns && p.turns.length > p.recentTurns && (
        <div className="flex justify-center">
          <button
            onClick={p.onFoldBack}
            className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
          >
            <ChevronDown size={12} /> Fold history back
          </button>
        </div>
      )}
    </>
  );
}

/** A user turn's contents: its attachments, then its text. */
export function UserContent({ turn }: { turn: Extract<Turn, { role: 'user' }> }) {
  return (
    <div className="space-y-1.5">
      {turn.images && turn.images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {turn.images.map((src, j) => (
            <a key={j} href={src} target="_blank" rel="noreferrer">
              <img
                src={src}
                alt={`attachment ${j + 1}`}
                className="max-h-40 rounded-md border border-border object-contain"
              />
            </a>
          ))}
        </div>
      )}
      {turn.blocks[0].text && (
        <span className="whitespace-pre-wrap break-words leading-relaxed">{turn.blocks[0].text}</span>
      )}
    </div>
  );
}

/** Either half of a turn's body, wrapped in the clamp when the layout asks for one. */
export function TurnBody({
  turn,
  collapsible,
  maxHeight,
  tone,
}: {
  turn: Turn;
  collapsible: boolean;
  maxHeight: number;
  tone?: 'bubble';
}) {
  const body = turn.role === 'user' ? <UserContent turn={turn} /> : <Blocks blocks={turn.blocks} />;
  return collapsible ? (
    <Collapsible maxHeight={maxHeight} tone={tone}>
      {body}
    </Collapsible>
  ) : (
    body
  );
}

/* Written out rather than interpolated: Tailwind scans source text, so `h-${n}` generates nothing. */
const AVATAR_SIZE = {
  sm: { box: 'h-5 w-5 rounded-md text-[11px]', icon: 12 },
  md: { box: 'h-6 w-6 rounded-md text-[11px]', icon: 13 },
  lg: { box: 'h-7 w-7 rounded-lg text-xs', icon: 15 },
} as const;

/** The agent's avatar in its identity hue — the same mark wherever an agent speaks. */
export function AgentAvatar({
  name,
  size = 'lg',
}: {
  name: string;
  size?: keyof typeof AVATAR_SIZE;
}) {
  const color = agentColor(name);
  const Icon = iconFor(agentIcon(name));
  const { box, icon } = AVATAR_SIZE[size];
  return (
    <span
      className={`flex shrink-0 items-center justify-center font-bold text-slate-950 shadow-[0_0_12px_var(--glow)] ${box}`}
      style={{ background: color.accent, ['--glow' as string]: agentGlow(name, 0.33) }}
    >
      {Icon ? <Icon size={icon} /> : agentInitial(name)}
    </span>
  );
}

/** Name + quality score + recalled-memories pill: the metadata row of an agent turn. */
export function AgentMeta({
  name,
  score,
  memories,
}: {
  name: string;
  score?: TurnScore;
  memories?: RecalledMemory[];
}) {
  return (
    <>
      <span
        className="text-xs font-semibold tracking-wide"
        style={{ color: agentColor(name).accent }}
      >
        {name}
      </span>
      {score && <ScoreBadge score={score} size="xs" />}
      {memories && memories.length > 0 && <MemoriesBadge memories={memories} />}
    </>
  );
}

/** The "Interviewer" flag on a generated session's user turns. */
export function InterviewerTag({ align = 'right' }: { align?: 'right' | 'left' }) {
  return (
    <div
      className={`mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-300/80 ${
        align === 'right' ? 'pr-1' : ''
      }`}
    >
      <Mic size={11} /> Interviewer
    </div>
  );
}

/**
 * The in-flight turn's blocks plus its spinner row. The spinner stays silent while a delegated
 * sub-agent owns the floor — that bubble spins instead, so only the deepest active frame shows one.
 */
export function LiveBody({ blocks, agentName }: { blocks: Block[]; agentName: string }) {
  const label = activityLabel(blocks);
  return (
    <>
      <Blocks blocks={blocks} live />
      {label && <ThinkingRow label={label} color={agentColor(agentName).accent} />}
    </>
  );
}
