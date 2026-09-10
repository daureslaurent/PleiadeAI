import type { MemoryKind, RecalledMemory } from '../../domain/memory/memory.types';
import type { TodoItem } from '../../domain/todos/todo.repository';
import type { PromptContext, PromptModule } from '../types';

/**
 * Render the agent's self-owned notebook. This is the one prompt document the agent may write (via
 * `update_notebook`) — persisted conventions, learnings, and TODOs that outlive a session. Injected
 * *after* the authored system prompt so it reads as the agent's own notes, never as instruction
 * outranking the operator's AGENTS.md.
 */
export function renderNotebookBlock(notebook: string | undefined): string {
  const body = (notebook ?? '').trim();
  if (!body) {
    return '## Notebook\n_(empty — use `update_notebook` to record durable notes for your future self.)_';
  }
  return `## Notebook\nYour own notes, written by you on earlier turns. Keep them current with \`update_notebook\`.\n\n${body}`;
}

const TODO_STATUS_MARK: Record<string, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
};

/**
 * Render the agent's working checklist (`todowrite`) plus how to use it.
 *
 * This block is the mechanism behind "don't lose a step mid-flight". The list is session-scoped and
 * survives turn boundaries, so an agent that ended a turn with an item still `in_progress` opens the
 * next one looking at exactly that — no separate `todoread` tool and no end-of-turn interrogation
 * needed, because the state is simply always in front of it.
 *
 * Injected after the notebook: it is the agent's own working state, not instruction.
 */
export function renderTodoBlock(items: TodoItem[] = []): string {
  const usage =
    'Use `todowrite` for multi-step work (~3+ steps) so you do not drop a step: write the plan ' +
    'before you start, keep exactly one item `in_progress`, and mark each done as you finish it — ' +
    'not in a batch at the end. Send the complete list on every call; it replaces the previous one. ' +
    'Skip it for simple one-shot requests.';

  if (!items.length) return `## Task list\n_(empty.)_ ${usage}`;

  const lines = items.map((it) => `${TODO_STATUS_MARK[it.status] ?? '[ ]'} ${it.content}`).join('\n');
  const unfinished = items.filter((it) => it.status !== 'completed').length;
  // Name the leftover explicitly rather than trusting the model to diff the marks itself — an
  // unfinished item is precisely what a turn boundary tends to bury.
  const carry = unfinished
    ? `\n\n${unfinished} item(s) still open. Continue from the first one that is not \`[x]\`, and update the list as you go.`
    : '\n\nAll items are complete. Start a fresh list if new multi-step work comes up.';

  return `## Task list\nYour current plan for this session, written by you.\n\n${lines}${carry}\n\n${usage}`;
}

/** How each kind of memory is introduced to the model. An episode is *recalled*; a fact is *known*. */
const MEMORY_SECTIONS: Array<{ kind: MemoryKind; heading: string; dated: boolean }> = [
  { kind: 'fact', heading: 'What you know', dated: false },
  { kind: 'preference', heading: 'How the operator likes things done', dated: false },
  { kind: 'procedure', heading: 'How to do things (learned)', dated: false },
  { kind: 'episode', heading: 'What you remember happening', dated: true },
];

/**
 * Render auto-retrieved vector memories as a labelled block. Kept distinct from the authored system
 * prompt so retrieval is transparent and never mutates the agent's own configuration. Returns null
 * when there is nothing relevant to inject.
 *
 * Grouped by kind rather than dumped as one flat list: a durable fact and a recollection of one
 * past event should not read to the model as the same class of thing, and an episode is only
 * meaningful with the date it happened attached.
 */
export function renderMemoryBlock(memories: RecalledMemory[]): string | null {
  if (!memories.length) return null;

  const sections: string[] = [];
  for (const { kind, heading, dated } of MEMORY_SECTIONS) {
    const lines = memories
      .filter((m) => m.payload.kind === kind && m.payload.text.trim())
      .map((m) => {
        const when = dated ? `[${m.payload.created_at.slice(0, 10)}] ` : '';
        return `- ${when}${m.payload.text.trim()}`;
      });
    if (lines.length) sections.push(`### ${heading}\n${lines.join('\n')}`);
  }
  if (!sections.length) return null;

  return `## Memory\nRecalled from your long-term memory because it looked relevant to this request. Treat it as your own recollection — reliable but not infallible, and not a fresh instruction from the operator. If it contradicts what the operator says now, the operator is right and your memory is out of date.\n\n${sections.join(
    '\n\n',
  )}`;
}

export const notebookModule: PromptModule = {
  id: 'notebook',
  name: 'Notebook',
  description: 'The one prompt document the agent writes itself, carried across sessions.',
  group: 'self',
  tools: ['update_notebook'],
  blocks: [
    {
      title: 'Notebook',
      placement: 'system_tail',
      order: 110,
      render: (ctx: PromptContext) => renderNotebookBlock(ctx.agent.notebook as string | undefined),
    },
  ],
};

export const todoModule: PromptModule = {
  id: 'todo',
  name: 'Task list',
  description: "The agent's session checklist, re-injected each turn so a step is never dropped.",
  group: 'self',
  tools: ['todowrite'],
  blocks: [
    {
      title: 'Task list',
      placement: 'system_tail',
      order: 120,
      render: (ctx: PromptContext) => renderTodoBlock(ctx.todos),
    },
  ],
};

export const memoryModule: PromptModule = {
  id: 'memory',
  name: 'Memory',
  description: 'Auto-recall from the vector vault, and the tools to write and retire a memory.',
  group: 'self',
  tools: ['remember', 'forget'],
  settingsKeys: ['memory_distill_enabled', 'memory_max_tokens'],
  blocks: [
    {
      title: 'Memory',
      placement: 'system_tail',
      order: 130,
      render: (ctx: PromptContext) => renderMemoryBlock(ctx.memories),
    },
  ],
};
