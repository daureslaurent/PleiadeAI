import { useEffect, useState } from 'react';
import { SlidersHorizontal, Type } from 'lucide-react';
import { endpointsApi, sessionsApi, type EndpointMode } from '../../lib/api';
import { modeTone } from '../../lib/modeTone';

/**
 * The conversation's inference modes (`MODES_PLAN.md`), rendered as toggleable chips above the
 * composer's input row. Any number can be on at once: a `sampling` preset and a `prompt` snippet
 * compose, and two of the same kind resolve last-wins server-side.
 *
 * Renders **nothing** when the agent's model has no modes configured — which is every install that
 * hasn't opted in, so the composer is untouched by default. Which modes apply is answered by the
 * backend (`GET /endpoints/modes`), not recomputed here: the endpoint/model precedence that decides
 * it lives in the resolver, and a second implementation would eventually disagree with the turn.
 *
 * The selection is persisted on the session rather than held here, so a reload, a `continue` nudge
 * and an auto-loop tick all keep running the conversation the way the operator set it up.
 */
export function ModeBar({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const [modes, setModes] = useState<EndpointMode[]>([]);
  const [active, setActive] = useState<string[]>([]);

  // Reload on either change: switching agent can change the model (and so the offered modes), and
  // switching conversation changes which of them are on.
  useEffect(() => {
    let live = true;
    void endpointsApi
      .modesForAgent(agentId)
      .then((r) => live && setModes(r.modes))
      .catch(() => live && setModes([]));
    void sessionsApi
      .get(sessionId)
      .then((s) => live && setActive(s.mode_ids ?? []))
      .catch(() => live && setActive([]));
    return () => {
      live = false;
    };
  }, [agentId, sessionId]);

  function toggle(id: string) {
    const next = active.includes(id) ? active.filter((m) => m !== id) : [...active, id];
    setActive(next); // optimistic: a chip must feel like a switch, not a request
    void sessionsApi.setModes(sessionId, next).catch(() => setActive(active));
  }

  if (!modes.length) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {modes.map((mode) => {
        const tone = modeTone(mode.type);
        const on = active.includes(mode.id);
        return (
          <button
            key={mode.id}
            onClick={() => toggle(mode.id)}
            aria-pressed={on}
            title={
              mode.type === 'sampling'
                ? `Sampling: ${describeSampling(mode)}`
                : `Prompt, appended to the ${mode.placement === 'user_suffix' ? 'user turn' : 'system prompt'}: ${mode.text}`
            }
            className={[
              'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
              on
                ? `${tone.bg} ${tone.text} ${tone.border} ${tone.hover}`
                : 'border-transparent text-slate-500 hover:bg-white/[0.06] hover:text-slate-300',
            ].join(' ')}
          >
            {mode.type === 'sampling' ? <SlidersHorizontal size={11} /> : <Type size={11} />}
            {mode.name}
          </button>
        );
      })}
    </div>
  );
}

/** The samplers a mode actually overrides, for its tooltip — an unset field is not sent at all. */
function describeSampling(mode: EndpointMode): string {
  const set = Object.entries(mode.params).filter(([, v]) => typeof v === 'number');
  return set.length ? set.map(([k, v]) => `${k}=${v}`).join(', ') : 'nothing set';
}
