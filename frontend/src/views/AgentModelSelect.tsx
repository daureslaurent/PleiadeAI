import { useEffect, useState } from 'react';
import { AlertTriangle, Cpu, GitFork } from 'lucide-react';
import { Link } from 'react-router-dom';
import { agentsApi, endpointsApi, endpointVision, settingsApi, type Endpoint, type InferenceSettings } from '../lib/api';

/**
 * Assigns an agent's inference target: which endpoint + model it runs on (or the fleet default
 * when left unset). Changes apply immediately (like the isolation selector). Endpoints and their
 * discovered models are managed on the Settings page.
 *
 * With `role="subagent"` it edits where the agent's `task` subagents run instead
 * (`subagent_endpoint_id` / `subagent_model`, `SUBAGENT_PLAN.md`). Unset there inherits the fleet's
 * subagent default, and failing that the agent's own endpoint + model — which is what the empty
 * options then say, along with how many children that endpoint runs at once.
 */
export function AgentModelSelect({
  agentId,
  endpointId,
  model,
  visual = false,
  role = 'agent',
  agentEndpointId = null,
  agentModel = '',
}: {
  agentId: string;
  endpointId: string | null;
  model: string;
  /** Whether this agent is visual (isolation image has the visual layer) — drives the vision warning. */
  visual?: boolean;
  /** Which of the agent's two targets this edits: its own turns, or its `task` subagents. */
  role?: 'agent' | 'subagent';
  /** `role="subagent"` only: the agent's own target, which an unset subagent target falls back to. */
  agentEndpointId?: string | null;
  agentModel?: string;
}) {
  const isSub = role === 'subagent';
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [settings, setSettings] = useState<InferenceSettings | null>(null);
  const [selectedEp, setSelectedEp] = useState<string>(endpointId ?? '');
  const [selectedModel, setSelectedModel] = useState<string>(model ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void endpointsApi.list().then(setEndpoints);
    // For visual agents we warn on the *global* Vision endpoint (approach A), not this agent's model.
    void settingsApi.get().then(setSettings);
  }, []);

  useEffect(() => {
    setSelectedEp(endpointId ?? '');
    setSelectedModel(model ?? '');
  }, [agentId, endpointId, model]);

  async function apply(next: { endpoint_id?: string | null; model?: string }) {
    setBusy(true);
    try {
      await agentsApi.update(
        agentId,
        isSub
          ? {
              ...('endpoint_id' in next ? { subagent_endpoint_id: next.endpoint_id } : {}),
              ...('model' in next ? { subagent_model: next.model } : {}),
            }
          : next,
      );
    } finally {
      setBusy(false);
    }
  }

  function onEndpoint(id: string) {
    setSelectedEp(id);
    // Switching endpoints invalidates the previously-picked model; reset to the endpoint default.
    setSelectedModel('');
    void apply({ endpoint_id: id || null, model: '' });
  }
  function onModel(m: string) {
    setSelectedModel(m);
    void apply({ model: m });
  }

  const active = endpoints.find((e) => e._id === selectedEp);
  const fleetDefaultEp = endpoints.find((e) => e.is_default);
  // What an unset target falls back to. For the agent's own turns that is the fleet default endpoint.
  // For its subagents it is the fleet's subagent default when one is set, else the agent's own target
  // — the same order the runner resolves in.
  const fleetSubEp = settings?.subagent_endpoint_id
    ? endpoints.find((e) => e._id === settings.subagent_endpoint_id)
    : undefined;
  const agentEp = agentEndpointId ? endpoints.find((e) => e._id === agentEndpointId) : fleetDefaultEp;
  const inheritsFleetSub = Boolean(settings?.subagent_endpoint_id || settings?.subagent_model);
  const defaultEp = isSub ? (inheritsFleetSub ? (fleetSubEp ?? agentEp) : agentEp) : fleetDefaultEp;
  // The endpoint whose models/default apply: the chosen one, or the fallback when unset.
  const effectiveEp = active ?? defaultEp;
  const models = effectiveEp?.models ?? [];
  // What "Default model" resolves to on the effective endpoint (its default, else first model).
  const inheritedModel = isSub && !active ? (inheritsFleetSub ? settings?.subagent_model : agentModel) : '';
  const resolvedDefault = inheritedModel || effectiveEp?.default_model || models[0] || '';
  const defaultLabel = isSub ? (inheritsFleetSub ? 'Fleet subagent default' : "Agent's own") : 'Default';

  // A visual agent interprets screenshots via the *global* Vision endpoint (Settings), not its own
  // model — so warn only when that global endpoint is unset or not marked vision-capable. The agent's
  // own endpoint above can stay text-only.
  const visionEp = settings?.vision_endpoint_id
    ? endpoints.find((e) => e._id === settings.vision_endpoint_id)
    : undefined;
  const visionWarning =
    visual && Boolean(settings) && !endpointVision(visionEp, settings?.vision_model);

  return (
    <div className="space-y-3 rounded-md border border-border bg-panel p-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="flex-1">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-400">
            {isSub ? <GitFork size={13} /> : <Cpu size={13} />} {isSub ? 'Subagent endpoint' : 'Endpoint'}
          </div>
          <select
            value={selectedEp}
            disabled={busy}
            onChange={(e) => onEndpoint(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          >
            <option value="">
              {defaultLabel}
              {defaultEp ? ` — ${defaultEp.name}` : ''}
            </option>
            {endpoints.map((e) => (
              <option key={e._id} value={e._id}>
                {e.name}
                {e.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="flex-1">
          <div className="mb-1 text-xs text-slate-400">{isSub ? 'Subagent model' : 'Model'}</div>
          <select
            value={selectedModel}
            disabled={busy}
            onChange={(e) => onModel(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          >
            <option value="">
              {defaultLabel}
              {resolvedDefault ? ` — ${resolvedDefault}` : ' model'}
            </option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
                {effectiveEp?.model_vision?.[m] === true ? ' — vision' : ''}
              </option>
            ))}
            {/* Preserve a model that isn't in the (possibly stale) discovered list. */}
            {selectedModel && !models.includes(selectedModel) && (
              <option value={selectedModel}>{selectedModel} (custom)</option>
            )}
          </select>
        </label>
      </div>

      {visionWarning && (
        <div className="flex items-start gap-1.5 rounded border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            This is a <span className="font-medium">visual</span> agent, but{' '}
            {settings?.vision_endpoint_id
              ? "the configured Vision endpoint isn't marked multimodal"
              : 'no Vision endpoint is configured'}
            . <span className="font-mono">visual_screenshot</span> can't interpret the screen. Set a
            vision-capable <span className="font-medium">Vision endpoint</span> in{' '}
            <Link to="/settings" className="text-accent hover:underline">
              Settings
            </Link>
            . (This agent's own model can stay text-only.)
          </span>
        </div>
      )}

      {isSub && effectiveEp && (
        <p className="text-xs text-slate-400">
          {(effectiveEp.parallel_slots ?? 1) > 1
            ? `Up to ${effectiveEp.parallel_slots} explore subagents run at once on ${effectiveEp.name}`
            : `Subagents run one after another on ${effectiveEp.name}`}{' '}
          — its Parallel streams, set on the Connections page.
        </p>
      )}

      <p className="text-xs text-slate-500">
        {isSub ? (
          <>
            Where this agent's <code>task</code> subagents run. Leave both unset to inherit the fleet
            subagent model (Settings → Fleet), or this agent's own model when there is none. Add
          </>
        ) : (
          <>
            Leave both on <span className="text-slate-400">Default</span> to use the fleet default. Add
          </>
        )}
        endpoints and refresh their models on the{' '}
        <Link to="/settings" className="text-accent hover:underline">
          Settings
        </Link>{' '}
        page.
      </p>
    </div>
  );
}
