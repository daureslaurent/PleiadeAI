import {
  AgentMeta,
  HistoryFold,
  LiveBody,
  TurnBody,
  isCollapsible,
  type ConversationProps,
} from './shared';
import { agentColor } from '../../../lib/agentColor';

/**
 * **Transcript** — the Codex/ChatGPT reading.
 *
 * One left-aligned column, no bubbles: each turn opens with a small role label and runs full-width
 * underneath. Tool calls collapse to a single line and thinking to a single toggle (both come from
 * the layout descriptor, so the renderers themselves are the shared ones), which is what lets a
 * long agentic turn read as a paragraph with footnotes rather than a stack of cards.
 */
function RoleLabel({ children, color }: { children: string; color?: string }) {
  return (
    <div
      className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
      style={color ? { color } : undefined}
    >
      <span className={color ? '' : 'text-slate-500'}>{children}</span>
    </div>
  );
}

export function TranscriptConversation(p: ConversationProps) {
  const accent = agentColor(p.agentName).accent;
  return (
    <div className="mx-auto max-w-3xl space-y-7">
      <HistoryFold {...p} />

      {p.shownTurns.map((t, i) => (
        <div key={p.hiddenTurns + i} className="animate-fade-up">
          {t.role === 'user' ? (
            <>
              <RoleLabel>{p.generatedSession ? 'Interviewer' : 'You'}</RoleLabel>
              <div className="min-w-0 break-words border-l-2 border-accent/40 pl-3 text-sm text-slate-200">
                <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={200} />
              </div>
            </>
          ) : (
            <>
              <div className="mb-1 flex items-center gap-2">
                <AgentMeta name={p.agentName} score={t.score} memories={t.memories} />
              </div>
              <div className="min-w-0 break-words text-sm text-slate-100">
                <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={420} />
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
          <div className="min-w-0 break-words text-sm text-slate-100" style={{ ['--rail' as string]: accent }}>
            <LiveBody blocks={p.liveBlocks} agentName={p.agentName} />
          </div>
        </div>
      )}
    </div>
  );
}
