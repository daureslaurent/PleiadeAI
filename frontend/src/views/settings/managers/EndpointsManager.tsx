import { useState } from 'react';
import { Plus, RefreshCw, Server, Star, Trash2 } from 'lucide-react';
import { Button, Callout, Checkbox, Input, Row, Select, useConfirm } from '../../../components/ui';
import { endpointsApi, type Endpoint, type EndpointPatch } from '../../../lib/api';
import { useSettings } from '../context';

/**
 * Manage inference endpoints: add/edit URL+key, autodiscover the model list (`/v1/models`), pick the
 * fleet default, delete. Field edits save on blur; discovery, default and delete apply immediately.
 *
 * The `managed` endpoint is the built-in docker llama.cpp fallback: its name and URL come from env,
 * so they're read-only here and it can't be deleted.
 */
export function EndpointsManager() {
  const { endpoints, reloadEndpoints: reload, form } = useSettings();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || !url.trim()) return;
    await endpointsApi.create({ name: name.trim(), base_url: url.trim(), api_key: apiKey, context_window: 0 });
    setName('');
    setUrl('');
    setApiKey('');
    setAdding(false);
    await reload();
  }

  async function discover(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await endpointsApi.discover(id);
      await reload();
    } catch {
      setError('Discovery failed — check the URL/key and that the server is reachable.');
    } finally {
      setBusyId(null);
    }
  }

  async function patch(id: string, p: EndpointPatch) {
    await endpointsApi.update(id, p);
    await reload();
  }

  async function remove(e: Endpoint) {
    const ok = await confirm({
      title: `Delete endpoint “${e.name}”?`,
      body: 'Agents using it fall back to the default endpoint.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await endpointsApi.remove(e._id);
    await reload();
  }

  return (
    <div className="space-y-3">
      {endpoints.map((e) => (
        <Row key={e._id} className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <Input
              defaultValue={e.name}
              readOnly={e.managed}
              onBlur={(ev) => !e.managed && ev.target.value !== e.name && void patch(e._id, { name: ev.target.value })}
              className="flex-1 py-1.5 font-medium"
            />
            {e.managed && (
              <span
                className="flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/30 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400"
                title="Built-in local llama.cpp fallback (docker). URL is fixed; model is auto-discovered."
              >
                <Server size={11} /> local
              </span>
            )}
            {e.is_default ? (
              <span className="flex shrink-0 items-center gap-1 rounded-md border border-amber-500/30 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                <Star size={11} /> default
              </span>
            ) : (
              <Button onClick={() => void endpointsApi.setDefault(e._id).then(reload)} className="py-0.5 text-[10px] uppercase tracking-wide">
                Make default
              </Button>
            )}
            {!e.managed && (
              <Button variant="danger" onClick={() => void remove(e)} title="Delete endpoint" className="px-2">
                <Trash2 size={13} />
              </Button>
            )}
          </div>

          <Input
            defaultValue={e.base_url}
            placeholder="http://192.168.1.20:8080"
            readOnly={e.managed}
            title={e.managed ? 'Fixed URL of the built-in docker fallback (set via LLAMA_FALLBACK_URL)' : undefined}
            onBlur={(ev) => !e.managed && ev.target.value !== e.base_url && void patch(e._id, { base_url: ev.target.value })}
            className="py-1.5 font-mono text-xs"
          />

          <div className="flex gap-2">
            <Input
              type="password"
              defaultValue={e.api_key}
              placeholder="API key (optional)"
              onBlur={(ev) => ev.target.value !== e.api_key && void patch(e._id, { api_key: ev.target.value })}
              className="flex-1 py-1.5"
            />
            <ContextWindowControl
              endpoint={e}
              globalAuto={form.context_window_auto}
              onPatch={(p) => void patch(e._id, p)}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-[11px] text-slate-500">
              {e.models.length ? (
                <span>
                  {e.models.length} model{e.models.length === 1 ? '' : 's'}:{' '}
                  <span className="text-slate-400">{e.models.slice(0, 4).join(', ')}</span>
                  {e.models.length > 4 ? '…' : ''}
                </span>
              ) : (
                <span className="text-slate-600">No models discovered yet.</span>
              )}
            </div>
            <Button
              onClick={() => void discover(e._id)}
              loading={busyId === e._id}
              icon={<RefreshCw size={12} />}
            >
              Refresh models
            </Button>
          </div>

          {/* Default model: what agents on this endpoint use when they don't pick one. The default
              endpoint's default model is the fleet-wide default. */}
          <label className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-slate-400">Default model</span>
            <Select
              value={e.default_model}
              onChange={(ev) => void patch(e._id, { default_model: ev.target.value })}
              className="flex-1 py-1.5"
            >
              <option value="">{e.models.length ? 'First available' : 'Refresh models to choose'}</option>
              {e.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {e.default_model && !e.models.includes(e.default_model) && (
                <option value={e.default_model}>{e.default_model} (custom)</option>
              )}
            </Select>
          </label>

          {/* Failover position: 0 = off; 1, 2, 3… = order this endpoint is tried when the primary is
              unreachable (a local CPU llama.cpp container makes a good last resort). */}
          <label className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-slate-400">Fallback priority</span>
            <Input
              type="number"
              min={0}
              defaultValue={e.fallback_order}
              title="0 = not a fallback. 1, 2, 3… = order this endpoint is tried when the primary is unreachable."
              onBlur={(ev) =>
                Number(ev.target.value) !== e.fallback_order &&
                void patch(e._id, { fallback_order: Number(ev.target.value) })
              }
              className="w-20 py-1.5"
            />
            <span className="text-[11px] text-slate-500">0 = off</span>
          </label>

          {/* Vision marker: multimodality can't be autodiscovered from /v1/models, so the operator
              declares it. Visual agents warn when paired with an endpoint that isn't ticked here. */}
          <Checkbox
            checked={Boolean(e.supports_vision)}
            onChange={(v) => void patch(e._id, { supports_vision: v })}
          >
            <span>Model supports vision (multimodal)</span>
            <span className="text-slate-500">
              — llama.cpp launched with <code>--mmproj</code>, or a vision model
            </span>
          </Checkbox>
        </Row>
      ))}

      {error && <Callout tone="error">{error}</Callout>}

      {adding ? (
        <div className="space-y-2 rounded-xl border border-dashed border-white/[0.12] bg-black/25 p-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. workstation)" autoFocus />
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:8080" />
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key (optional)"
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void create()} disabled={!name.trim() || !url.trim()}>
              Add endpoint
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/[0.12] py-2 text-xs text-slate-400 transition-colors hover:border-white/25 hover:text-slate-200"
        >
          <Plus size={14} /> Add endpoint
        </button>
      )}
    </div>
  );
}

/**
 * Per-endpoint context-window control: pick how the chat meter's max is chosen (inherit the global
 * default / auto-detect / manual). In effective-auto it shows the real n_ctx probed for the
 * endpoint's default model (read-only); in manual it's an editable number. "Inherit" resolves auto
 * vs manual from the global toggle, so the shown value always matches what the meter will use.
 */
function ContextWindowControl({
  endpoint: e,
  globalAuto,
  onPatch,
}: {
  endpoint: Endpoint;
  globalAuto: boolean;
  onPatch: (p: EndpointPatch) => void;
}) {
  const mode = e.context_window_mode ?? 'inherit';
  const effectiveAuto = mode === 'auto' || (mode !== 'manual' && globalAuto);
  const autoModel = e.default_model || e.models[0] || '';
  const probed = autoModel ? e.model_contexts?.[autoModel] : undefined;

  return (
    <div className="flex gap-2">
      <Select
        value={mode}
        title="How this endpoint's context-meter max is chosen"
        onChange={(ev) => onPatch({ context_window_mode: ev.target.value as Endpoint['context_window_mode'] })}
        className="w-auto py-1.5 text-xs"
      >
        <option value="inherit">Auto (global{globalAuto ? '' : ': manual'})</option>
        <option value="auto">Auto (this endpoint)</option>
        <option value="manual">Manual</option>
      </Select>
      {effectiveAuto ? (
        <Input
          readOnly
          value={probed ? `${probed.toLocaleString()} (auto)` : autoModel ? 'not probed — refresh models' : 'no model'}
          title={probed ? `Detected n_ctx for ${autoModel}` : 'Run "Refresh models" to probe this server\'s real n_ctx'}
          className="w-44 cursor-default py-1.5 text-slate-400"
        />
      ) : (
        <Input
          type="number"
          defaultValue={e.context_window}
          min={0}
          title="Manual context window (0 = use global)"
          onBlur={(ev) =>
            Number(ev.target.value) !== e.context_window && onPatch({ context_window: Number(ev.target.value) })
          }
          className="w-28 py-1.5"
        />
      )}
    </div>
  );
}
