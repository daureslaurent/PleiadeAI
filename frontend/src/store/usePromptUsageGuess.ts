import { useMemo } from 'react';
import { tailChars, useStream } from './stream';
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
 * A live, best-effort re-estimate of `baseline` (the last *exact* breakdown) while a turn is
 * streaming — so the Usage tab's bar moves every render instead of stepping once per inference pass.
 *
 * **What `baseline` is decides what has to be added to it**, and the store says which it is:
 *
 * - A **mid-turn** baseline (`promptUsagePhase === 'live'`) is the prompt a pass of *this* turn
 *   actually sent. It already contains the user message and every tool result fed back so far, so
 *   the only thing missing is what has streamed since — which is exactly what `mark`, the tail's
 *   size when that breakdown arrived, lets us isolate. Adding the whole tail here would bill this
 *   turn's tool output twice.
 * - A **pre-turn** baseline (a settled `final` reading, or a fetched capture; `mark` is null) knows
 *   nothing about this turn: both the new user message and the entire tail are added.
 *
 * Either way the *sent* portion is then snapped to the run's own exact `context_usage` reading, so
 * only the still-growing tail is ever a chars/4 heuristic — nothing tokenizes a completion until the
 * turn ends.
 *
 * Returns `null` outside an active turn, or before any baseline exists — the caller falls back to
 * the real `baseline` in both cases.
 */
export function useLiveUsageGuess(
  baseline: PromptUsageBreakdown | null,
  streaming: boolean,
): PromptUsageBreakdown | null {
  const liveItems = useStream((s) => s.liveItems);
  const turns = useStream((s) => s.turns);
  const liveContext = useStream((s) => s.liveContext);
  const mark = useStream((s) => s.promptUsageMark);

  return useMemo(() => {
    if (!streaming || !baseline) return null;

    const segments = baseline.segments.map((s) => ({ ...s }));
    const moduleOrder = baseline.moduleGroups.map((g) => g.moduleId);

    // The turn's new user message — present already in a mid-turn baseline, missing from a pre-turn one.
    if (!mark) {
      const lastTurn = turns.at(-1);
      const newUserChars = lastTurn?.role === 'user' ? (lastTurn.blocks[0]?.text.length ?? 0) : 0;
      bumpSegment(segments, 'user', 'User', 'conversation', 'history', estTokens(newUserChars));
    }

    // Snap the "sent so far" portion to the exact live reading, once one exists.
    const sentSoFar = segments.reduce((a, s) => a + (s.tokens ?? 0), 0);
    if (liveContext && sentSoFar > 0) {
      const scale = liveContext.promptTokens / sentSoFar;
      for (const s of segments) if (s.tokens !== null) s.tokens = Math.round(s.tokens * scale);
    }

    // The still-streaming tail — whatever has arrived since the baseline was taken. Clamped at zero:
    // a frame the store dropped could otherwise make a delta negative and eat a real row.
    const tail = tailChars(liveItems);
    const assistantChars = Math.max(0, tail.assistant - (mark?.assistant ?? 0));
    const toolChars = Math.max(0, tail.tool - (mark?.tool ?? 0));
    const reasoningChars = Math.max(0, tail.reasoning - (mark?.reasoning ?? 0));
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
  }, [streaming, baseline, liveItems, turns, liveContext, mark]);
}
