import { useState } from 'react';
import { ChevronDown, ChevronRight, Play, Plus, Trash2 } from 'lucide-react';
import { Button, Checkbox, Field, Input, Select, Textarea } from '../../../components/ui';
import {
  API_HTTP_METHODS,
  API_PARAM_LOCATIONS,
  API_PARAM_TYPES,
  type ApiHttpMethod,
  type ApiOperationSpec,
  type ApiParamSpec,
  type ApiTestResult,
} from '../../../lib/api';

/**
 * One operation of one API — what an agent actually calls as `<api>.<id>`.
 *
 * The parameter list is the part that matters: `description` is not documentation, it is the text
 * the model reads in `api_man` before deciding what to pass, so the form gives it as much room as
 * the name. Test runs the operation through the backend's own caller, so a green result means an
 * agent's call will work, not merely that the host answers.
 */
export function ApiOperationEditor({
  op,
  methodsAllowed,
  onChange,
  onRemove,
  onTest,
}: {
  op: ApiOperationSpec;
  methodsAllowed: ApiHttpMethod[];
  onChange: (next: ApiOperationSpec) => void;
  onRemove: () => void;
  onTest: (params: Record<string, unknown>) => Promise<ApiTestResult>;
}) {
  const [open, setOpen] = useState(false);
  const [testArgs, setTestArgs] = useState('{}');
  const [result, setResult] = useState<ApiTestResult | 'running' | null>(null);

  const set = (patch: Partial<ApiOperationSpec>) => onChange({ ...op, ...patch });
  const setParam = (i: number, patch: Partial<ApiParamSpec>) =>
    set({ params: op.params.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) });

  const methodBlocked = !methodsAllowed.includes(op.method);
  const takesBody = op.method !== 'GET' && op.method !== 'HEAD';

  async function runTest() {
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(testArgs || '{}') as Record<string, unknown>;
    } catch {
      setResult({ ok: false, error: 'the test arguments are not valid JSON' });
      return;
    }
    setResult('running');
    try {
      setResult(await onTest(params));
    } catch (err) {
      const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setResult({ ok: false, error: detail ?? (err instanceof Error ? err.message : 'test failed') });
    }
  }

  return (
    <div className="rounded-lg hairline well-soft">
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? <ChevronDown size={13} className="shrink-0 text-slate-500" /> : <ChevronRight size={13} className="shrink-0 text-slate-500" />}
          <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-400 hairline">
            {op.method}
          </span>
          <span className="truncate font-mono text-xs text-slate-200">
            {op.id || 'unnamed'}
            <span className="text-slate-500">
              ({op.params.map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ')})
            </span>
          </span>
          {op.description && <span className="truncate text-[11px] text-slate-500">— {op.description}</span>}
        </button>
        {methodBlocked && (
          <span className="shrink-0 text-[10px] text-amber-400" title="This verb is not in the API's allowed methods, so the call is refused.">
            {op.method} not allowed
          </span>
        )}
        <Checkbox checked={op.enabled} onChange={(v) => set({ enabled: v })}>
          <span className="text-[10px] text-slate-500">on</span>
        </Checkbox>
        <Button variant="danger" onClick={onRemove} title="Remove operation" className="px-1.5">
          <Trash2 size={12} />
        </Button>
      </div>

      {open && (
        <div className="space-y-3 border-t hairline p-3">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Field label="Operation id" hint="The agent calls this as <api>.<id>.">
              <Input
                value={op.id}
                onChange={(e) => set({ id: e.target.value.trim() })}
                placeholder="forecast"
                className="py-1.5 font-mono text-xs"
              />
            </Field>
            <Field label="Method">
              <Select
                value={op.method}
                onChange={(e) => set({ method: e.target.value as ApiHttpMethod })}
                className="py-1.5 text-xs"
              >
                {API_HTTP_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="What it does" hint="Shown to the agent in api_man — one line, concrete.">
            <Input
              value={op.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Hourly weather forecast for a coordinate."
              className="py-1.5 text-xs"
            />
          </Field>

          <Field label="Path" hint="Appended to the base URL. Use {name} for a path parameter.">
            <Input
              value={op.path}
              onChange={(e) => set({ path: e.target.value })}
              placeholder="/v1/forecast"
              className="py-1.5 font-mono text-xs"
            />
          </Field>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Parameters</span>
              <Button
                onClick={() =>
                  set({
                    params: [
                      ...op.params,
                      { name: '', in: 'query', type: 'string', required: false, description: '', default: '' },
                    ],
                  })
                }
                icon={<Plus size={11} />}
                className="px-1.5 py-0.5 text-[10px]"
              >
                Add
              </Button>
            </div>

            {op.params.length === 0 && (
              <p className="text-[11px] text-slate-500">No parameters — the agent calls it with nothing.</p>
            )}

            <div className="space-y-1.5">
              {op.params.map((p, i) => (
                <div key={i} className="space-y-1.5 rounded-lg hairline p-2">
                  <div className="flex gap-1.5">
                    <Input
                      value={p.name}
                      onChange={(e) => setParam(i, { name: e.target.value.trim() })}
                      placeholder="latitude"
                      className="flex-1 py-1 font-mono text-[11px]"
                    />
                    <Select
                      value={p.in}
                      onChange={(e) => setParam(i, { in: e.target.value as ApiParamSpec['in'] })}
                      title="Where the value is sent"
                      className="w-24 py-1 text-[11px]"
                    >
                      {API_PARAM_LOCATIONS.map((loc) => (
                        <option key={loc} value={loc}>
                          {loc}
                        </option>
                      ))}
                    </Select>
                    <Select
                      value={p.type}
                      onChange={(e) => setParam(i, { type: e.target.value as ApiParamSpec['type'] })}
                      className="w-24 py-1 text-[11px]"
                    >
                      {API_PARAM_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                    <Checkbox checked={p.required} onChange={(v) => setParam(i, { required: v })}>
                      <span className="text-[10px] text-slate-500">req</span>
                    </Checkbox>
                    <Button
                      variant="danger"
                      onClick={() => set({ params: op.params.filter((_, idx) => idx !== i) })}
                      className="px-1.5"
                    >
                      <Trash2 size={11} />
                    </Button>
                  </div>
                  <div className="flex gap-1.5">
                    <Input
                      value={p.description}
                      onChange={(e) => setParam(i, { description: e.target.value })}
                      placeholder="What the agent should put here — this is what it reads."
                      className="flex-1 py-1 text-[11px]"
                    />
                    <Input
                      value={p.default}
                      onChange={(e) => setParam(i, { default: e.target.value })}
                      placeholder="default"
                      className="w-28 py-1 font-mono text-[11px]"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {takesBody && (
            <Field
              label="Body template (optional)"
              hint="Leave empty to send body parameters as a flat JSON object. Use {name} tokens for a nested shape."
            >
              <Textarea
                value={op.body_template}
                onChange={(e) => set({ body_template: e.target.value })}
                rows={3}
                placeholder={'{"query": "{q}", "options": {"limit": {limit}}}'}
              />
            </Field>
          )}

          <div className="rounded-lg hairline p-2">
            <div className="flex items-end gap-2">
              <Field label="Test arguments (JSON)" className="flex-1">
                <Input
                  value={testArgs}
                  onChange={(e) => setTestArgs(e.target.value)}
                  className="py-1 font-mono text-[11px]"
                  placeholder='{"latitude": 48.85, "longitude": 2.35}'
                />
              </Field>
              <Button
                onClick={() => void runTest()}
                loading={result === 'running'}
                icon={<Play size={11} />}
                className="mb-px"
              >
                Test
              </Button>
            </div>

            {result && result !== 'running' && (
              <div
                className={`mt-2 max-h-48 overflow-auto rounded px-2 py-1.5 font-mono text-[10px] leading-relaxed ${
                  result.ok ? 'bg-emerald-500/[0.08] text-emerald-300' : 'bg-red-500/[0.08] text-red-300'
                }`}
              >
                {result.ok ? (
                  <>
                    <div className="mb-1 break-all text-slate-400">
                      {result.status} · {result.duration_ms}ms · {result.url}
                    </div>
                    {result.truncated && <div className="mb-1 text-amber-300/80">{result.truncated}</div>}
                    <pre className="whitespace-pre-wrap break-words">{JSON.stringify(result.data, null, 2)}</pre>
                  </>
                ) : (
                  <span className="break-words">{result.error}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
