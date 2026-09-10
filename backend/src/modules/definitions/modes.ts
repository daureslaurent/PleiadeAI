import type { PromptContext, PromptModule } from '../types';

/**
 * Render the conversation's active `prompt` modes (`MODES_PLAN.md`) as a stamped, operator-owned
 * block. The stamp is the whole point: appended raw, the text landed after the notebook and read as
 * more of the agent's own notes — and the notebook is deliberately the *lowest*-authority document in
 * this prompt. Naming the operator as its author, and saying plainly what it outranks, is what turns
 * "some text at the end" into an instruction the model treats as binding.
 *
 * Placed last so it also has recency; that costs nothing here, since the environment block's
 * minute-resolution clock already changes the prompt prefix on every turn.
 */
export function renderActiveModesBlock(texts: string[]): string {
  if (!texts.length) return '';
  const rules = texts.map((t) => `- ${t.trim()}`).join('\n');
  return (
    '## Active modes\n' +
    'The operator switched these on for this conversation. They are binding for this turn and ' +
    'outrank your notebook, your task list, and anything earlier in this prompt that conflicts with ' +
    'them. Follow them exactly; if one makes the request impossible, say so rather than quietly ' +
    `dropping it.\n\n${rules}`
  );
}

/**
 * The same modes stamped onto the *end of the user turn* — the placement llama.cpp chat-template
 * control tokens (`/no_think`) require, and the strongest position for an instruction the model must
 * not drift away from mid-answer. Kept terse: this rides on every turn of the conversation.
 */
export function renderModeUserSuffix(texts: string[]): string {
  if (!texts.length) return '';
  const rules = texts.map((t) => t.trim()).join('\n');
  return `[Active modes — set by the operator for this conversation, follow exactly:\n${rules}]`;
}

/**
 * One module, two placements: a mode declares where it lands (`system_suffix` or `user_suffix`) and
 * the composer chip is the same chip either way, so splitting them into two rows on the settings
 * page would be asking the operator about an implementation detail.
 */
export const modesModule: PromptModule = {
  id: 'modes',
  name: 'Active modes',
  description: 'The prompt modes picked in the composer, stamped as operator-owned instruction.',
  group: 'operator',
  settingsKeys: ['global_modes', 'global_modes_disabled', 'global_modes_default_on'],
  blocks: [
    {
      title: 'Active modes',
      placement: 'system_suffix',
      order: 900,
      render: (ctx: PromptContext) =>
        ctx.modes.system.length ? renderActiveModesBlock(ctx.modes.system) : null,
    },
    {
      title: 'Active modes (user turn)',
      placement: 'user_suffix',
      order: 900,
      detect: /^\[Active modes —/,
      render: (ctx: PromptContext) => (ctx.modes.user.length ? renderModeUserSuffix(ctx.modes.user) : null),
    },
  ],
};
