import type { ChatMessage } from '../domain/agents/jit-builder';
import { blocksAt } from './registry';
import type { ModuleState } from './state.service';
import type { BlockPlacement, ModuleScope, PromptContext } from './types';

/**
 * Assemble a turn's prompt out of the enabled modules (`MODULES_PLAN.md` §7).
 *
 * The ordering the old `buildSystemMessage` hard-coded is now the ordering the placements encode,
 * and it means the same thing it always did:
 *
 *   system_head · --- authored system_prompt --- · system_tail · system_suffix
 *
 * Everything in `system_head` is operator-owned and read-only to the agent; the notebook — the one
 * document the agent can write — is in `system_tail`, so the agent's own notes can never be read as
 * outranking the instructions it was given; `system_suffix` is the conversation's modes, which
 * outrank both and therefore come last.
 */
function renderPlacement(
  state: ModuleState,
  ctx: PromptContext,
  placement: BlockPlacement,
  scope: ModuleScope,
): string[] {
  const out: { order: number; text: string }[] = [];

  for (const { module, block } of blocksAt(placement)) {
    if (!state.enabled(module.id, scope)) continue;
    const override = block.overridable ? state.override(module.id, block.title) : undefined;
    const text = override ?? block.render(ctx);
    if (text && text.trim()) out.push({ order: block.order, text: text.trim() });
  }

  // Operator-authored modules are ordinary blocks at the same placement — they interleave by
  // `order` rather than being bolted on at the end, which is what makes "put this before the
  // notebook" expressible at all.
  for (const custom of state.customAt(placement, scope)) {
    const body = custom.text.trim();
    const needsHeading = placement !== 'user_suffix' && !body.startsWith('## ');
    out.push({ order: custom.order, text: needsHeading ? `## ${custom.name}\n${body}` : body });
  }

  return out.sort((a, b) => a.order - b.order).map((b) => b.text);
}

/**
 * The single leading system message. A *second* `system` turn is not an option: many chat templates
 * (including the GGUFs we serve) enforce "System message must be at the beginning" and hard-fail on
 * one, which is why memory recall and the forum block are blocks here rather than messages.
 */
export function assembleSystemMessage(
  state: ModuleState,
  ctx: PromptContext,
  scope: ModuleScope = 'turn',
): ChatMessage {
  const head = renderPlacement(state, ctx, 'system_head', scope);
  const tail = [
    ...renderPlacement(state, ctx, 'system_tail', scope),
    ...renderPlacement(state, ctx, 'system_suffix', scope),
  ];
  const authored = (ctx.agent.system_prompt ?? '').trim();

  const parts = [head.join('\n\n'), authored, tail.join('\n\n')];
  return { role: 'system', content: parts.join('\n\n---\n\n') };
}

/**
 * Whatever the enabled modules want appended to the operator's own words on the user turn — the
 * image note, and the modes whose placement is `user_suffix` (the only position llama.cpp chat
 * templates honour a control token like `/no_think` in).
 */
export function assembleUserSuffix(state: ModuleState, ctx: PromptContext, scope: ModuleScope = 'turn'): string {
  return renderPlacement(state, ctx, 'user_suffix', scope).join('\n\n');
}

/** The operator's text with that suffix attached, or unchanged when nothing was appended. */
export function assembleUserText(
  state: ModuleState,
  ctx: PromptContext,
  baseText: string,
  scope: ModuleScope = 'turn',
): string {
  const suffix = assembleUserSuffix(state, ctx, scope);
  return suffix ? [baseText, suffix].filter(Boolean).join('\n\n') : baseText;
}
