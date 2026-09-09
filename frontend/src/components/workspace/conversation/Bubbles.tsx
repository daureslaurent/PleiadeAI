import {
  AgentAvatar,
  HistoryFold,
  InterviewerTag,
  LiveBody,
  TurnBody,
  isCollapsible,
  type ConversationProps,
} from './shared';
import { ScoreBadge } from '../../ScoreBadge';

/**
 * **Bubbles** — the densest reading.
 *
 * Both sides bubbled and tight, the way a messenger renders. Tool calls become inline chips (via
 * the descriptor) so an agentic turn stays one paragraph tall, and the reading column narrows —
 * this layout optimises for how many exchanges fit on a screen, not for inspecting any one of them.
 */
export function BubblesConversation(p: ConversationProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <HistoryFold {...p} />

      {p.shownTurns.map((t, i) =>
        t.role === 'user' ? (
          <div key={p.hiddenTurns + i} className="flex animate-fade-up flex-col items-end pl-12">
            {p.generatedSession && <InterviewerTag />}
            <div
              className={`min-w-0 max-w-[85%] overflow-hidden break-words rounded-2xl rounded-br-md px-3 py-1.5 text-[13px] text-oncolor ${
                p.generatedSession ? 'bg-fuchsia-500/75' : 'bg-accent/85'
              }`}
            >
              <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={160} tone="bubble" />
            </div>
          </div>
        ) : (
          <div key={p.hiddenTurns + i} className="flex animate-fade-up items-start gap-2 pr-8">
            <AgentAvatar name={p.agentName} size="sm" />
            <div className="min-w-0 flex-1 overflow-hidden break-words rounded-2xl rounded-bl-md border hairline raise-1 px-3 py-1.5 text-[13px] text-slate-100">
              <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={280} />
              {t.score && (
                <div className="mt-1">
                  <ScoreBadge score={t.score} size="xs" />
                </div>
              )}
            </div>
          </div>
        ),
      )}

      {p.streaming && (
        <div className="flex animate-fade-up items-start gap-2 pr-8">
          <AgentAvatar name={p.agentName} size="sm" />
          <div className="min-w-0 flex-1 overflow-hidden break-words rounded-2xl rounded-bl-md border hairline raise-1 px-3 py-1.5 text-[13px] text-slate-100">
            <LiveBody blocks={p.liveBlocks} agentName={p.agentName} />
          </div>
        </div>
      )}
    </div>
  );
}
