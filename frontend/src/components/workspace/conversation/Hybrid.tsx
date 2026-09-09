import {
  AgentAvatar,
  AgentMeta,
  HistoryFold,
  InterviewerTag,
  LiveBody,
  TurnBody,
  isCollapsible,
  type ConversationProps,
} from './shared';

/**
 * **Hybrid** — the default (DIRECT_ART §4).
 *
 * The operator speaks in a compact right-aligned gradient bubble; the agent answers full-width,
 * document-style — identity header, then an open content column. The asymmetry is the point: user
 * turns are short and scannable, agent turns are dense with tool cards, code and sub-agent bubbles
 * and need the whole line.
 */
export function HybridConversation(p: ConversationProps) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <HistoryFold {...p} />

      {p.shownTurns.map((t, i) =>
        t.role === 'user' ? (
          <div key={p.hiddenTurns + i} className="flex animate-fade-up flex-col items-end pl-10">
            {p.generatedSession && <InterviewerTag />}
            <div
              className={`min-w-0 max-w-[78%] overflow-hidden break-words rounded-2xl rounded-br-md px-4 py-2.5 text-sm text-oncolor ${
                p.generatedSession
                  ? 'bg-gradient-to-br from-fuchsia-500/80 via-fuchsia-500/65 to-purple-500/70 shadow-[0_4px_20px_rgb(var(--c-reasoning)/0.22)]'
                  : 'bg-gradient-to-br from-accent/90 via-accent/75 to-indigo-500/80 shadow-[0_4px_20px_rgb(var(--c-accent)/0.25)]'
              }`}
            >
              <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={200} tone="bubble" />
            </div>
          </div>
        ) : (
          <div key={p.hiddenTurns + i} className="animate-fade-up">
            <div className="mb-1.5 flex items-center gap-2">
              <AgentAvatar name={p.agentName} />
              <AgentMeta name={p.agentName} score={t.score} memories={t.memories} />
            </div>
            <div className="min-w-0 overflow-hidden break-words pl-9 text-sm text-slate-100">
              <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={380} />
            </div>
          </div>
        ),
      )}

      {p.streaming && (
        <div className="animate-fade-up">
          <div className="mb-1.5 flex items-center gap-2">
            <AgentAvatar name={p.agentName} />
            <AgentMeta name={p.agentName} memories={p.liveMemories} />
          </div>
          <div className="min-w-0 overflow-hidden break-words pl-9 text-sm text-slate-100">
            <LiveBody blocks={p.liveBlocks} agentName={p.agentName} />
          </div>
        </div>
      )}
    </div>
  );
}
