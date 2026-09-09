/**
 * The chat layout registry (THEME_SYSTEM_PLAN.md §3.1).
 *
 * A *theme* decides what the app looks like; a *layout* decides how a turn is **structured** —
 * whether the operator speaks in a bubble or under a label, whether a tool call is a card, a
 * one-line row or a chip, and whether the agent's machinery (tools, thoughts, delegation) stays
 * in the reading flow or moves into a column of its own.
 *
 * The two are independent: any theme × any layout.
 *
 * A layout is a **descriptor plus one `ConversationView`** — not a fork of the chat page. The
 * shell (header, banners, todo panel, ask-user prompt, composer) is shared, and `Blocks.tsx` /
 * `ToolCall.tsx` read the descriptor from `ChatLayoutContext`, so every tool renderer and every
 * sub-agent bubble works in all five without being copied.
 */

export type ChatLayoutId = 'hybrid' | 'transcript' | 'workbench' | 'timeline' | 'bubbles';

export interface ChatLayoutDef {
  id: ChatLayoutId;
  label: string;
  blurb: string;
  /** How the operator's turn is framed. */
  userStyle: 'bubble-right' | 'label-block' | 'bubble-left';
  /** How the agent's turn is framed. */
  agentStyle: 'document' | 'label-block' | 'bubble' | 'rail';
  /**
   * How a `kind:'tool'` block presents in the flow.
   * `card` full treatment · `row` one collapsed line · `chip` an inline pill · `none` it has
   * moved to the trace column.
   */
  toolStyle: 'card' | 'row' | 'chip' | 'none';
  /** How a `kind:'reasoning'` block presents: a panel, a one-line toggle, a rail node, or not. */
  thinkingStyle: 'block' | 'line' | 'node' | 'none';
  /** A permanently docked column beside the conversation. `trace` = the live tool/thought/hop log. */
  rightColumn: 'trace' | null;
  density: 'comfortable' | 'compact';
  /** Tailwind max-width for the reading column. */
  readingWidth: string;
  /** Vertical rhythm between turns. */
  turnGap: string;
}

export const DEFAULT_CHAT_LAYOUT: ChatLayoutId = 'hybrid';

export const CHAT_LAYOUTS: ChatLayoutDef[] = [
  {
    id: 'hybrid',
    label: 'Hybrid',
    blurb:
      'You speak in a compact bubble; the agent answers full-width, document-style, with its tool cards inline.',
    userStyle: 'bubble-right',
    agentStyle: 'document',
    toolStyle: 'card',
    thinkingStyle: 'block',
    rightColumn: null,
    density: 'comfortable',
    readingWidth: 'max-w-3xl',
    turnGap: 'space-y-6',
  },
  {
    id: 'transcript',
    label: 'Transcript',
    blurb:
      'One left-aligned column under role labels. Tool calls collapse to a single line you can open.',
    userStyle: 'label-block',
    agentStyle: 'label-block',
    toolStyle: 'row',
    thinkingStyle: 'line',
    rightColumn: null,
    density: 'comfortable',
    readingWidth: 'max-w-3xl',
    turnGap: 'space-y-7',
  },
  {
    id: 'workbench',
    label: 'Workbench',
    blurb:
      'Prose on the left, every tool call, thought and delegation in a live trace column on the right.',
    userStyle: 'label-block',
    agentStyle: 'label-block',
    toolStyle: 'none',
    thinkingStyle: 'none',
    rightColumn: 'trace',
    density: 'comfortable',
    readingWidth: 'max-w-2xl',
    turnGap: 'space-y-6',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    blurb:
      'One vertical spine. Every message, tool call, thought and hop is a stamped node on it — built for auditing a long run.',
    userStyle: 'label-block',
    agentStyle: 'rail',
    toolStyle: 'row',
    thinkingStyle: 'node',
    rightColumn: null,
    density: 'compact',
    readingWidth: 'max-w-4xl',
    turnGap: 'space-y-0',
  },
  {
    id: 'bubbles',
    label: 'Bubbles',
    blurb: 'Both sides bubbled and tight, tools reduced to chips. The most messages per screen.',
    userStyle: 'bubble-right',
    agentStyle: 'bubble',
    toolStyle: 'chip',
    thinkingStyle: 'line',
    rightColumn: null,
    density: 'compact',
    readingWidth: 'max-w-2xl',
    turnGap: 'space-y-3',
  },
];

export const CHAT_LAYOUT_IDS = CHAT_LAYOUTS.map((l) => l.id);

export function chatLayoutById(id: string | undefined): ChatLayoutDef {
  return CHAT_LAYOUTS.find((l) => l.id === id) ?? CHAT_LAYOUTS.find((l) => l.id === DEFAULT_CHAT_LAYOUT)!;
}

export const isChatLayoutId = (v: unknown): v is ChatLayoutId =>
  typeof v === 'string' && (CHAT_LAYOUT_IDS as string[]).includes(v);
