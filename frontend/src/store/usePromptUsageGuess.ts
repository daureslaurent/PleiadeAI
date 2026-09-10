import { useMemo } from 'react';
import { useStream } from './stream';
import type { PromptUsageBreakdown, PromptUsageModuleGroup, PromptUsageSegment } from '../lib/api';

/** Cheap, no-tokenizer estimate — good enough to move a bar smoothly, not to bill anyone. */
const CHARS_PER_TOKEN = 4;
const estTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

function bumpSegment(
  segments: PromptUsageSegment[],
  id: string,
  label: string,
  group: PromptUsageSegment['group'],
  kind: PromptUsageSegment['kind'],
  delta: number,
): void {
  if (delta <= 0) return;
  const row = segments.find((s) => s.id === id);
  if (row) {
    row.tokens = (row.tokens ?? 0) + delta;
    return;
  }
  segments.push({
    id,
    label,
    group,
    tokens: delta,
    count: 1,
    kind,
    moduleId: null,
    moduleName: null,
    moduleGroup: null,
  });
}

/** Re-fold `segments` into module totals, preserving `orderHint`'s (the baseline's) module order. */
function deriveModuleGroups(
  segments: PromptUsageSegment[],
  orderHint: string[],
): PromptUsageModuleGroup[] {
  const byId = new Map<string, PromptUsageModuleGroup>();
  for (const s of segments) {
    if (s.kind !== 'module' || !s.moduleId) continue;
    const g = byId.get(s.moduleId);
    if (!g) {
      byId.set(s.moduleId, {
        moduleId: s.moduleId,
        moduleName: s.moduleName ?? s.moduleId,
        moduleGroup: s.moduleGroup ?? 'core',
        tokens: s.tokens ?? 0,
        segments: [s],
      });
      continue;
    }
    g.tokens += s.tokens ?? 0;
    g.segments.push(s);
  }
  const order = orderHint.length ? orderHint : [...byId.keys()];
  return [...byId.values()].sort((a, b) => order.indexOf(a.moduleId) - order.indexOf(b.moduleId));
}

/**
 * A live, best-effort re-estimate of `baseline` (the last *exact*, fetched breakdown) while a turn
 * is streaming — so the Usage tab's bar can move every render instead of sitting frozen until the
 * turn settles and the real tokenizer pass lands.
 *
 * Everything already in `baseline` (the system/tools/prior-conversation cost) is treated as static
 * except for one correction: once the turn's first `context_usage` `live` reading arrives, it carries
 * the *exact* prompt-token count for "baseline + this turn's new user message" (not the still-
 * streaming completion), so that portion is scaled to match it exactly rather than trusted as a raw
 * guess. Only the actively-growing tail — assistant text, tool output, reasoning — stays a pure
 * chars/4 heuristic, since nothing tokenizes it until the turn ends.
 *
 * Returns `null` outside an active turn, or before any baseline has ever been fetched — the caller
 * falls back to the real `baseline` in both cases.
 */
export function useLiveUsageGuess(
  baseline: PromptUsageBreakdown | null,
  streaming: boolean,
): PromptUsageBreakdown | null {
  const liveItems = useStream((s) => s.liveItems);
  const turns = useStream((s) => s.turns);
  const liveContext = useStream((s) => s.liveContext);

  return useMemo(() => {
    if (!streaming || !baseline) return null;

    const segments = baseline.segments.map((s) => ({ ...s }));
    const moduleOrder = baseline.moduleGroups.map((g) => g.moduleId);

    // The turn's new user message — not yet in `baseline`, which was fetched before this turn began.
    const lastTurn = turns.at(-1);
    const newUserChars = lastTurn?.role === 'user' ? (lastTurn.blocks[0]?.text.length ?? 0) : 0;
    bumpSegment(segments, 'user', 'User', 'conversation', 'history', estTokens(newUserChars));

    // Snap the "sent so far" portion to the exact live reading, once one exists.
    const sentSoFar = segments.reduce((a, s) => a + (s.tokens ?? 0), 0);
    if (liveContext && sentSoFar > 0) {
      const scale = liveContext.promptTokens / sentSoFar;
      for (const s of segments) if (s.tokens !== null) s.tokens = Math.round(s.tokens * scale);
    }

    // The still-streaming completion tail — pure heuristic, nothing to anchor it to yet.
    let assistantChars = 0;
    let toolChars = 0;
    let reasoningChars = 0;
    for (const it of liveItems) {
      if (it.frameId !== 'root') continue;
      if (it.kind === 'text') assistantChars += it.text.length;
      else if (it.kind === 'reasoning') reasoningChars += it.text.length;
      else if (it.kind === 'tool') toolChars += it.output.length + (it.argsText?.length ?? 0);
    }
    bumpSegment(segments, 'assistant', 'Assistant', 'conversation', 'history', estTokens(assistantChars));
    bumpSegment(
      segments,
      'tool_results',
      'Tool results',
      'conversation',
      'history',
      estTokens(toolChars),
    );
    bumpSegment(segments, 'reasoning', 'Reasoning', 'conversation', 'reasoning', estTokens(reasoningChars));

    const sum = segments.reduce((a, s) => a + (s.tokens ?? 0), 0);
    return {
      segments,
      moduleGroups: deriveModuleGroups(segments, moduleOrder),
      sum,
      total: sum,
      contextWindow: liveContext?.contextWindow ?? baseline.contextWindow,
      modules: baseline.modules,
    };
  }, [streaming, baseline, liveItems, turns, liveContext]);
}
