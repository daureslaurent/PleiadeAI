import type { AgentDoc } from '../domain/agents/agent.model';
import type { ImageBlock } from '../core/event-bus/events.types';
import type { RecalledMemory } from '../domain/memory/memory.types';
import type { TodoItem } from '../domain/todos/todo.repository';
import type { ForumBlockInput, TaskPointer } from '../domain/forum/forum-recall.service';

/**
 * The module system (`MODULES_PLAN.md`).
 *
 * A **module** is one slice of what this instance is made of: the prompt text it contributes, the
 * core tools that text talks about, and the settings that tune it. The registry is the single
 * source of truth for all three, which is what lets `Settings → Modules` render itself and what
 * lets a switch there remove a block *and* the tools it describes in one move.
 */

/** Where a block lands relative to the operator-authored `agent.system_prompt`. */
export type BlockPlacement = 'system_head' | 'system_tail' | 'system_suffix' | 'user_suffix';

/** How the settings page clusters rows. Ordering of the groups is the order of this tuple. */
export const MODULE_GROUPS = ['core', 'operator', 'self', 'work', 'capabilities'] as const;
export type ModuleGroup = (typeof MODULE_GROUPS)[number];

/**
 * Everything a block may render from. Prepared once per turn by `AgentRunner`: modules render, they
 * never fetch. The runner is also the only place that knows a module is *off* early enough to skip
 * the query behind it — which is the real saving, not the tokens.
 */
export interface PromptContext {
  agent: AgentDoc;
  /** Fleet-wide AGENTS.md (`settings.agents_md`). */
  houseRules?: string;
  todos: TodoItem[];
  autoLoop: AutoLoopPromptState | null;
  memories: RecalledMemory[];
  /** Forum pointers for this turn, or null when the module is off / the agent lacks the tool. */
  forum: ForumBlockInput | null;
  /** Work items owned by or awaiting this agent, or null when the board module is off. */
  board: { tasks: TaskPointer[]; reviews: TaskPointer[] } | null;
  images: ImagePromptState;
  /** Active `prompt` modes, already split by the placement each one declared. */
  modes: { system: string[]; user: string[] };
  /** Injected so the environment block is deterministic under test. */
  now?: Date;
}

/** What the image note needs to know: what the agent can see, and what is reachable by handle. */
export interface ImagePromptState {
  supportsVision: boolean;
  /** Images attached to *this* turn. */
  current: ImageBlock[];
  /** Images from earlier in the session, carried over. */
  session: ImageBlock[];
  /** Whichever of the two the note should name handles from. */
  pooled: ImageBlock[];
}

/** What the auto-loop block needs to know about the running loop (`AUTO_AGENT_PLAN.md`). */
export interface AutoLoopPromptState {
  goal: string;
  /** The iteration about to run (1-based). */
  iteration: number;
  intervalSec: number;
  progress: { n: number; summary: string }[];
}

export interface PromptBlock {
  /**
   * The `## Title` this block renders with. Also how `domain/llama-logs/prompt-usage.ts` recognises
   * it when it takes an assembled message back apart, so it must match the rendered heading exactly.
   * A `user_suffix` block carries no heading and the title is a label for the settings page only.
   */
  title: string;
  placement: BlockPlacement;
  /** Within the placement. Gaps of 10 so a future block can be slotted without renumbering. */
  order: number;
  /**
   * Whether the operator may replace this block's wording (`settings.module_overrides`). True only
   * for blocks that are pure static text — a block that renders live data has nothing to override.
   */
  overridable?: boolean;
  /**
   * `user_suffix` only: how `domain/llama-logs/prompt-usage.ts` recognises this block's rendered
   * text again at the tail of a captured user message. A `system_*` block announces itself with its
   * `## Title` and needs nothing here; a `user_suffix` block is glued headingless onto the
   * operator's own words (a chat template honours a control token nowhere else), so without a
   * signature its cost is billed to the user's message instead of to the module that wrote it.
   * Matched against one trailing paragraph at a time, so anchor it (`/^\[Active modes —/`).
   */
  detect?: RegExp;
  render(ctx: PromptContext): string | null;
}

export interface PromptModule {
  /** Stable — it is the storage key in `modules_disabled` and `module_overrides`. */
  id: string;
  name: string;
  /** One line, shown on the settings row. */
  description: string;
  group: ModuleGroup;
  /** Cannot be switched off: the clock and the tool-calling contract are load-bearing. */
  mandatory?: boolean;
  /** Ships off, the operator opts in. Defaults to true. */
  defaultEnabled?: boolean;
  /** Core tools this module owns. Disabling the module drops them from every agent's toolset. */
  tools?: string[];
  /** Existing settings keys the module's detail view surfaces. No data migration — see §6. */
  settingsKeys?: string[];
  /** The prompt this module contributes. Absent for a tools-only module. */
  blocks?: PromptBlock[];
}

/** An operator-authored module: static text, no code. Stored in `settings.modules_custom`. */
export interface CustomModule {
  id: string;
  name: string;
  description: string;
  text: string;
  placement: BlockPlacement;
  order: number;
  enabled: boolean;
}

/** Custom module ids carry this prefix; the settings route refuses anything else in the list. */
export const CUSTOM_MODULE_PREFIX = 'custom:';

export function isCustomModuleId(id: string): boolean {
  return id.startsWith(CUSTOM_MODULE_PREFIX);
}
