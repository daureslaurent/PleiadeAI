import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Plus, Server, TestTube2, Trash2, XCircle } from 'lucide-react';
import { Button, Callout, Input, Row, Select, Toggle, useConfirm } from '../../../components/ui';
import { monitorApi, type MonitorTarget, type MonitorTestResult } from '../../../lib/api';
import { useSettings } from '../context';

/**
 * Manage the machines shown on the Monitor page — each one running the `monitor-client/` service
 * (see its README for deployment).
 *
 * Field edits save on blur; the enable switch and the endpoint link apply immediately, matching
 * `EndpointsManager`. The API key is write-only: reads report only `has_api_key`, so the field shows
 * a placeholder rather than a value, and leaving it untouched keeps the stored key.
 */
export function MonitorTargetsManager() {
  const { endpoints } = useSettings();
  const confirm = useConfirm();
  const [targets, setTargets] = useState<MonitorTarget[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, MonitorTestResult | 'running'>>({});

  const reload = useCallback(async () => {
    try {
      setTargets(await monitorApi.listTargets());
    } catch {
      setError('Could not load monitored machines.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function create() {
    if (!name.trim() || !url.trim()) return;
    try {
      await monitorApi.createTarget({ name: name.trim(), base_url: url.trim(), api_key: apiKey });
      setName('');
      setUrl('');
      setApiKey('');
      setAdding(false);
      setError(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the machine.');
    }
  }

  async function patch(id: string, p: Parameters<typeof monitorApi.updateTarget>[1]) {
    await monitorApi.updateTarget(id, p);
    await reload();
  }

  async function test(id: string) {
    setTests((t) => ({ ...t, [id]: 'running' }));
    try {
      const result = await monitorApi.test(id);
      setTests((t) => ({ ...t, [id]: result }));
    } catch (err) {
      // The backend forwards the target's own error; surfacing it verbatim is the whole point of Test.
      const detail =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        (err instanceof Error ? err.message : 'probe failed');
      setTests((t) => ({ ...t, [id]: { ok: false, error: detail } }));
    }
  }

  async function remove(t: MonitorTarget) {
    const ok = await confirm({
      title: `Stop monitoring “${t.name}”?`,
      body: 'The machine is removed from the dashboard and its recorded history is dropped. The monitor-client on the box keeps running.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await monitorApi.removeTarget(t._id);
    await reload();
  }

  return (
    <div className="space-y-3">
      {targets.map((t) => {
        const result = tests[t._id];
        return (
          <Row key={t._id} className="space-y-2 p-3">
            <div className="flex items-center gap-2">
              <Input
                defaultValue={t.name}
                onBlur={(e) => e.target.value !== t.name && void patch(t._id, { name: e.target.value })}
                className="flex-1 py-1.5 font-medium"
              />
              <span
                className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500"
                title={t.enabled ? 'Polled every interval' : 'Configured but never polled'}
              >
                {t.enabled ? 'Polling' : 'Paused'}
              </span>
              <Toggle checked={t.enabled} onChange={(v) => void patch(t._id, { enabled: v })} />
              <Button variant="danger" onClick={() => void remove(t)} title="Stop monitoring" className="px-2">
                <Trash2 size={13} />
              </Button>
            </div>

            <Input
              defaultValue={t.base_url}
              placeholder="http://192.168.1.23:9101"
              onBlur={(e) => e.target.value !== t.base_url && void patch(t._id, { base_url: e.target.value })}
              className="py-1.5 font-mono text-xs"
            />

            <div className="flex gap-2">
              <Input
                type="password"
                placeholder={t.has_api_key ? '•••••••• (stored — type to replace)' : 'MONITOR_API_KEY (optional)'}
                onBlur={(e) => e.target.value && void patch(t._id, { api_key: e.target.value })}
                className="flex-1 py-1.5"
              />
              <Button onClick={() => void test(t._id)} loading={result === 'running'} icon={<TestTube2 size={12} />}>
                Test
              </Button>
            </div>

            {/* Which inference endpoint runs on this box — purely informational, shown as a badge
                on the dashboard card so "the 3060 is full" connects to "that's the vision endpoint". */}
            <label className="flex items-center gap-2">
              <span className="shrink-0 text-[11px] text-slate-400">Runs endpoint</span>
              <Select
                value={t.endpoint_id ?? ''}
                onChange={(e) => void patch(t._id, { endpoint_id: e.target.value || null })}
                className="flex-1 py-1.5"
              >
                <option value="">None — not an inference server</option>
                {endpoints.map((e) => (
                  <option key={e._id} value={e._id}>
                    {e.name} ({e.base_url})
                  </option>
                ))}
              </Select>
            </label>

            <Input
              defaultValue={t.note}
              placeholder="Note (e.g. “2×GPU rig, main inference box”)"
              onBlur={(e) => e.target.value !== t.note && void patch(t._id, { note: e.target.value })}
              className="py-1.5 text-xs"
            />

            {result && result !== 'running' && (
              <div
                className={`flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11px] ${
                  result.ok ? 'bg-emerald-500/[0.08] text-emerald-300' : 'bg-red-500/[0.08] text-red-300'
                }`}
              >
                {result.ok ? (
                  <CheckCircle2 size={12} className="mt-px shrink-0" />
                ) : (
                  <XCircle size={12} className="mt-px shrink-0" />
                )}
                {result.ok ? (
                  <span className="min-w-0">
                    <span className="font-mono">{result.hostname}</span> · {result.os} · {result.cpu}
                    {result.gpus?.length ? ` · ${result.gpus.join(', ')}` : ''} · {result.latency_ms}ms
                    {result.warnings?.length ? (
                      <span className="mt-0.5 block text-[10px] text-amber-300/80">
                        {result.warnings.join(' · ')}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="min-w-0 break-words font-mono">{result.error}</span>
                )}
              </div>
            )}
          </Row>
        );
      })}

      {error && <Callout tone="error">{error}</Callout>}

      {adding ? (
        <div className="space-y-2 rounded-xl border border-dashed border-white/[0.12] bg-black/25 p-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. ai-rig)" autoFocus />
          <div className="flex gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://192.168.1.23:9101"
              className="flex-1 font-mono text-xs"
            />
            {/* Prefill from an inference endpoint: same host, the monitor-client's default port. */}
            <Select
              value=""
              title="Prefill the host from an inference endpoint"
              onChange={(e) => {
                const ep = endpoints.find((x) => x._id === e.target.value);
                if (!ep) return;
                try {
                  const u = new URL(ep.base_url);
                  setUrl(`${u.protocol}//${u.hostname}:9101`);
                  if (!name.trim()) setName(ep.name);
                } catch {
                  /* a malformed endpoint URL just means no prefill */
                }
              }}
              className="w-40 text-xs"
            >
              <option value="">From endpoint…</option>
              {endpoints.map((ep) => (
                <option key={ep._id} value={ep._id}>
                  {ep.name}
                </option>
              ))}
            </Select>
          </div>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="MONITOR_API_KEY (optional)"
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void create()} disabled={!name.trim() || !url.trim()}>
              Add machine
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/[0.12] py-2 text-xs text-slate-400 transition-colors hover:border-white/25 hover:text-slate-200"
        >
          <Plus size={14} /> Add machine
        </button>
      )}

      {!targets.length && !adding && (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <Server size={12} /> Deploy <code className="font-mono">monitor-client/</code> on a server, then add it here.
        </p>
      )}
    </div>
  );
}
