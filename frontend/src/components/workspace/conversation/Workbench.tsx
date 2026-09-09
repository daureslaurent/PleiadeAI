import {
  AgentMeta,
  HistoryFold,
  LiveBody,
  TurnBody,
  isCollapsible,
  type ConversationProps,
} from './shared';

/**
 * **Workbench** — prose here, machinery next door.
 *
 * The conversation column carries only what was *said*; every tool call, thought and delegation
 * hop is rendered by the docked `TraceColumn` instead (`AgentWorkspace` mounts it whenever the
 * layout declares `rightColumn: 'trace'`). Nothing is hidden — the two halves are the same turn
 * read two ways, and the split is what lets a long agentic run stay readable while it runs.
 *
 * The suppression itself is not here: the descriptor's `toolStyle: 'none'` / `thinkingStyle: 'none'`
 * are read by the shared `Blocks` and `ToolCall`, so a sub-agent's own tools drop out at every
 * depth without this file knowing the block tree exists.
 */
export function WorkbenchConversation(p: ConversationProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <HistoryFold {...p} />

      {p.shownTurns.map((t, i) => (
        <div key={p.hiddenTurns + i} className="animate-fade-up">
          {t.role === 'user' ? (
            <>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {p.generatedSession ? 'Interviewer' : 'You'}
              </div>
              <div className="min-w-0 break-words border-l-2 border-accent/40 pl-3 text-sm text-slate-200">
                <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={200} />
              </div>
            </>
          ) : (
            <>
              <div className="mb-1 flex items-center gap-2">
                <AgentMeta name={p.agentName} score={t.score} memories={t.memories} />
              </div>
              <div className="min-w-0 break-words text-sm leading-relaxed text-slate-100">
                <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={480} />
              </div>
            </>
          )}
        </div>
      ))}

      {p.streaming && (
        <div className="animate-fade-up">
          <div className="mb-1 flex items-center gap-2">
            <AgentMeta name={p.agentName} memories={p.liveMemories} />
          </div>
          <div className="min-w-0 break-words text-sm leading-relaxed text-slate-100">
            <LiveBody blocks={p.liveBlocks} agentName={p.agentName} />
          </div>
        </div>
      )}
    </div>
  );
}
