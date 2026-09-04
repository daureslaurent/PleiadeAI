import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, SlidersHorizontal, Type, X } from 'lucide-react';
import { endpointsApi, sessionsApi, type EndpointMode } from '../../lib/api';
import { modeTone } from '../../lib/modeTone';

/**
 * The conversation's inference modes (`MODES_PLAN.md`). Any number can be on at once: a `sampling`
 * preset and a `prompt` snippet compose, and two of the same kind resolve last-wins server-side.
 *
 * Renders **nothing** when the agent's model has no modes configured — which is every install that
 * hasn't opted in, so the composer is untouched by default. Which modes apply is answered by the
 * backend (`GET /endpoints/modes`), not recomputed here: the endpoint/model precedence that decides
 * it lives in the resolver, and a second implementation would eventually disagree with the turn.
 *
 * The selection is persisted on the session rather than held here, so a reload, a `continue` nudge
 * and an auto-loop tick all keep running the conversation the way the operator set it up.
 *
 * UI: a single collapsed trigger (avoids a full always-visible row eating composer space) that opens
 * a checklist popover; the current selection shows as small removable chips next to the trigger so
 * it's never invisible, just not the whole row.
 */
export function ModeBar({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const [modes, setModes] = useState<EndpointMode[]>([]);
  const [active, setActive] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  // Close the popover on an outside click, same as any other dropdown.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function toggle(id: string) {
    const next = active.includes(id) ? active.filter((m) => m !== id) : [...active, id];
    setActive(next); // optimistic: a chip must feel like a switch, not a request
    void sessionsApi.setModes(sessionId, next).catch(() => setActive(active));
  }

  if (!modes.length) return null;

  const activeModes = modes.filter((m) => active.includes(m.id));

  return (
    <div ref={rootRef} className="relative mb-2 flex flex-wrap items-center gap-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-pressed={open}
        title="Inference modes for this conversation"
        className={[
          'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
          activeModes.length > 0 || open
            ? 'border-accent/40 bg-accent/10 text-accent'
            : 'border-transparent text-slate-500 hover:bg-white/[0.06] hover:text-slate-300',
        ].join(' ')}
      >
        <SlidersHorizontal size={11} />
        Modes
        {activeModes.length > 0 && (
          <span className="rounded-full bg-accent/20 px-1.5 text-[10px] leading-4 text-accent">
            {activeModes.length}
          </span>
        )}
        <ChevronDown size={11} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>

      {/* Current selection, always visible as compact removable chips — the popover itself stays closed by default. */}
      {activeModes.map((mode) => {
        const tone = modeTone(mode.type);
        return (
          <span
            key={mode.id}
            title={
              mode.type === 'sampling'
                ? `Sampling: ${describeSampling(mode)}`
                : `Prompt, appended to the ${mode.placement === 'user_suffix' ? 'user turn' : 'system prompt'}: ${mode.text}`
            }
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone.bg} ${tone.text} ${tone.border}`}
          >
            {mode.name}
            <button
              onClick={() => toggle(mode.id)}
              title={`Turn off ${mode.name}`}
              className="rounded-full opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={10} />
            </button>
          </span>
        );
      })}

      {open && (
        <div className="glass-card absolute bottom-full left-0 z-20 mb-1.5 w-64 rounded-xl border p-1.5 shadow-xl">
          <div className="max-h-72 overflow-y-auto">
            {modes.map((mode) => {
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
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
                    on ? 'text-slate-100' : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      on ? 'border-accent bg-accent/20 text-accent' : 'border-white/15 text-transparent',
                    ].join(' ')}
                  >
                    <Check size={11} />
                  </span>
                  {mode.type === 'sampling' ? <SlidersHorizontal size={12} className="shrink-0" /> : <Type size={12} className="shrink-0" />}
                  <span className="truncate">{mode.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The samplers a mode actually overrides, for its tooltip — an unset field is not sent at all. */
function describeSampling(mode: EndpointMode): string {
  const set = Object.entries(mode.params ?? {}).filter(([, v]) => typeof v === 'number');
  return set.length ? set.map(([k, v]) => `${k}=${v}`).join(', ') : 'nothing set';
}
