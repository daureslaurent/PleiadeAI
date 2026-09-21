import { AgentAvatar, HistoryFold, LiveBody, TurnBody, isCollapsible, type ConversationProps } from './shared';
import { User } from 'lucide-react';
import { agentColor } from '../../../lib/agentColor';

/**
 * **Timeline** — the conversation as an audit trail.
 *
 * One vertical spine, every turn a node on it. Tool calls stay in the flow but as single lines
 * (`toolStyle: 'row'`) and thinking as a node marker, so a hundred-step autonomous run reads as a
 * scannable sequence rather than as a wall of cards — which is exactly the case where "what did it
 * actually do, in what order" is the question being asked.
 *
 * The spine is one absolutely-positioned rule behind the nodes rather than a border per row, so it
 * stays unbroken across turns of wildly different heights.
 */
export function TimelineConversation(p: ConversationProps) {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="space-y-4">
        <HistoryFold {...p} />
      </div>

      <div className="relative mt-4 pl-7">
        {/* The spine. Inset to sit under the node markers' centres. */}
        <div className="absolute bottom-2 left-[11px] top-2 w-px raise-3" aria-hidden />

        {p.shownTurns.map((t, i) => (
          <Node
            key={p.hiddenTurns + i}
            marker={
              t.role === 'user' ? (
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border hairline-strong well text-slate-400">
                  <User size={11} />
                </span>
              ) : (
                <AgentAvatar name={p.agentName} size="md" />
              )
            }
            label={t.role === 'user' ? (p.generatedSession ? 'Interviewer' : 'You') : p.agentName}
            labelColor={t.role === 'user' ? undefined : agentColor(p.agentName).accent}
          >
            <TurnBody turn={t} collapsible={isCollapsible(p, i)} maxHeight={320} />
          </Node>
        ))}

        {p.streaming && (
          <Node
            marker={<AgentAvatar name={p.agentName} size="md" />}
            label={p.agentName}
            labelColor={agentColor(p.agentName).accent}
          >
            <LiveBody blocks={p.liveBlocks} agentName={p.agentName} />
          </Node>
        )}
      </div>
    </div>
  );
}

function Node({
  marker,
  label,
  labelColor,
  children,
}: {
  marker: React.ReactNode;
  label: string;
  labelColor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative animate-fade-up pb-5">
      <div className="absolute -left-7 top-0">{marker}</div>
      <div
        className="mb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider"
        style={labelColor ? { color: labelColor } : undefined}
      >
        <span className={labelColor ? '' : 'text-slate-500'}>{label}</span>
      </div>
      <div className="min-w-0 break-words text-[13px] text-slate-100">{children}</div>
    </div>
  );
}
