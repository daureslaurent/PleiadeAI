import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Trash2, Webhook } from 'lucide-react';
import { Button, Callout, Checkbox, Field, Input, Row, Select, Textarea, Toggle, useConfirm } from '../../../components/ui';
import {
  API_AUTH_TYPES,
  API_HTTP_METHODS,
  apiSourcesApi,
  type ApiAuthType,
  type ApiHttpMethod,
  type ApiOperationSpec,
  type ApiPair,
  type ApiSource,
} from '../../../lib/api';
import { ApiOperationEditor } from './ApiOperationEditor';

/**
 * Configured HTTP APIs (Settings → APIs; `API_TOOL_PLAN.md`).
 *
 * Each row is one API the `api_man`/`api` tools expose to agents. Edits are local-first and flushed
 * on a trailing debounce — the same "no Save button" contract the rest of Settings has — because an
 * operation editor with a dozen text fields would otherwise PUT on every keystroke.
 *
 * The credential is write-only: the backend reports `has_secret` and never the value, so the field
 * shows a placeholder, and leaving it untouched keeps what is stored.
 */

const DEBOUNCE_MS = 500;

/** The fields a PUT may carry — everything the operator edits, and nothing the server owns. */
function editable(s: ApiSource) {
  return {
    name: s.name,
    description: s.description,
    base_url: s.base_url,
    enabled: s.enabled,
    auth_type: s.auth_type,
    auth_header: s.auth_header,
    auth_query: s.auth_query,
    auth_username: s.auth_username,
    headers: s.headers,
    methods_allowed: s.methods_allowed,
    timeout_ms: s.timeout_ms,
    operations: s.operations,
    notes: s.notes,
  };
}

export function ApiSourcesManager() {
  const confirm = useConfirm();
  const [sources, setSources] = useState<ApiSource[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', base_url: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** Mirrors `sources` so a burst of edits composes instead of each one racing the last render. */
  const latest = useRef<ApiSource[]>([]);

  const reload = useCallback(async () => {
    try {
      const list = await apiSourcesApi.list();
      latest.current = list;
      setSources(list);
    } catch {
      setError('Could not load the configured APIs.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A pending edit must not be lost by navigating away mid-debounce.
  useEffect(() => {
    const pending = timers.current;
    return () => Object.values(pending).forEach(clearTimeout);
  }, []);

  /**
   * Apply an edit locally, then flush that source once the operator stops typing. The next value is
   * computed from a ref rather than inside the state updater — an updater that also schedules a
   * request would fire twice under StrictMode's double-invocation.
   */
  function edit(id: string, patch: Partial<ApiSource>) {
    const next = latest.current.map((s) => (s._id === id ? { ...s, ...patch } : s));
    latest.current = next;
    setSources(next);

    const target = next.find((s) => s._id === id);
    if (!target) return;
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => {
      apiSourcesApi
        .update(id, editable(target))
        .then((saved) => {
          // Only adopt the server's copy for fields the operator isn't still editing: overwriting
          // the whole row here would yank the cursor out of a field typed into during the flight.
          latest.current = latest.current.map((s) =>
            s._id === id ? { ...s, last_error: saved.last_error, has_secret: saved.has_secret } : s,
          );
          setSources(latest.current);
        })
        .catch((err) => {
          const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
          setError(detail ?? 'Could not save that change.');
        });
    }, DEBOUNCE_MS);
  }

  /** The credential never round-trips, so it is sent on its own rather than through `edit`. */
  async function saveSecret(id: string, secret: string) {
    try {
      const saved = await apiSourcesApi.update(id, { secret });
      latest.current = latest.current.map((s) => (s._id === id ? { ...s, has_secret: saved.has_secret } : s));
      setSources(latest.current);
    } catch {
      setError('Could not save the credential.');
    }
  }

  async function create() {
    if (!draft.name.trim() || !draft.base_url.trim()) return;
    try {
      await apiSourcesApi.create({
        name: draft.name.trim().toLowerCase(),
        base_url: draft.base_url.trim(),
        description: draft.description.trim(),
      });
      setDraft({ name: '', base_url: '', description: '' });
      setAdding(false);
      setError(null);
      await reload();
    } catch (err) {
      const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(detail ?? 'Could not add the API.');
    }
  }

  async function remove(s: ApiSource) {
    const ok = await confirm({
      title: `Delete the “${s.name}” API?`,
      body: 'Its operations and stored credential are removed. Agents calling them get an error on the next turn.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await apiSourcesApi.remove(s._id);
    await reload();
  }

  return (
    <div className="space-y-3">
      {sources.map((s) => (
        <Row key={s._id} className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOpenId((cur) => (cur === s._id ? null : s._id))}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              {openId === s._id ? (
                <ChevronDown size={14} className="shrink-0 text-slate-500" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-slate-500" />
              )}
              <span className="shrink-0 font-mono text-sm font-medium text-slate-200">{s.name}</span>
              <span className="truncate text-[11px] text-slate-500">{s.description || s.base_url}</span>
              <span className="shrink-0 text-[10px] text-slate-500">
                {s.operations.filter((o) => o.enabled).length} op
                {s.operations.filter((o) => o.enabled).length === 1 ? '' : 's'}
              </span>
            </button>
            <Toggle checked={s.enabled} onChange={(v) => edit(s._id, { enabled: v })} />
            <Button variant="danger" onClick={() => void remove(s)} title="Delete API" className="px-2">
              <Trash2 size={13} />
            </Button>
          </div>

          {s.last_error && (
            <p className="flex items-start gap-1.5 text-[10px] text-amber-400">
              <AlertTriangle size={11} className="mt-px shrink-0" />
              <span className="break-words">Last call failed: {s.last_error}</span>
            </p>
          )}

          {openId === s._id && (
            <div className="space-y-3 border-t hairline pt-3">
              <Field label="Description" hint="The single line api_man returns — what this API is for.">
                <Input
                  value={s.description}
                  onChange={(e) => edit(s._id, { description: e.target.value })}
                  placeholder="Open-Meteo forecast + geocoding, no key needed."
                  className="py-1.5 text-xs"
                />
              </Field>

              <div className="grid grid-cols-[1fr_7rem] gap-2">
                <Field label="Base URL">
                  <Input
                    value={s.base_url}
                    onChange={(e) => edit(s._id, { base_url: e.target.value })}
                    placeholder="https://api.open-meteo.com"
                    className="py-1.5 font-mono text-xs"
                  />
                </Field>
                <Field label="Timeout (ms)">
                  <Input
                    type="number"
                    value={s.timeout_ms}
                    onChange={(e) => edit(s._id, { timeout_ms: Number(e.target.value) })}
                    className="py-1.5 text-xs"
                  />
                </Field>
              </div>

              <div>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Methods allowed
                </div>
                <div className="flex flex-wrap gap-3">
                  {API_HTTP_METHODS.map((m) => (
                    <Checkbox
                      key={m}
                      checked={s.methods_allowed.includes(m)}
                      onChange={(v) =>
                        edit(s._id, {
                          methods_allowed: (v
                            ? [...s.methods_allowed, m]
                            : s.methods_allowed.filter((x) => x !== m)) as ApiHttpMethod[],
                        })
                      }
                    >
                      <span className="font-mono text-[11px]">{m}</span>
                    </Checkbox>
                  ))}
                </div>
                <p className="mt-1 text-[10px] text-slate-500">
                  An operation whose verb is unticked is hidden from <code className="font-mono">api_man</code> and
                  refused by <code className="font-mono">api</code>. New APIs are read-only until you widen this.
                </p>
              </div>

              <AuthEditor source={s} onEdit={(patch) => edit(s._id, patch)} onSecret={(v) => void saveSecret(s._id, v)} />

              <PairsEditor
                label="Static headers"
                hint="Sent on every request (User-Agent, Accept, a tenant id…). Never put a credential here."
                pairs={s.headers}
                onChange={(headers) => edit(s._id, { headers })}
              />

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Operations</span>
                  <Button
                    onClick={() =>
                      edit(s._id, {
                        operations: [
                          ...s.operations,
                          {
                            id: '',
                            description: '',
                            method: 'GET',
                            path: '/',
                            query: [],
                            body_template: '',
                            params: [],
                            enabled: true,
                          } as ApiOperationSpec,
                        ],
                      })
                    }
                    icon={<Plus size={12} />}
                    className="px-2 py-0.5 text-[11px]"
                  >
                    Add operation
                  </Button>
                </div>

                {s.operations.length === 0 ? (
                  <p className="text-[11px] text-slate-500">
                    No operations yet — an API with none is invisible to <code className="font-mono">api_man</code>.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {s.operations.map((op, i) => (
                      <ApiOperationEditor
                        key={i}
                        op={op}
                        methodsAllowed={s.methods_allowed}
                        onChange={(next) =>
                          edit(s._id, { operations: s.operations.map((o, idx) => (idx === i ? next : o)) })
                        }
                        onRemove={() => edit(s._id, { operations: s.operations.filter((_, idx) => idx !== i) })}
                        onTest={(params) => apiSourcesApi.test(s._id, op.id, params)}
                      />
                    ))}
                  </div>
                )}
              </div>

              <Field label="Notes" hint="Appended to api_man({api}) — quirks, rate limits, which operation to prefer.">
                <Textarea
                  value={s.notes}
                  onChange={(e) => edit(s._id, { notes: e.target.value })}
                  rows={2}
                  placeholder="Rate limit: 60 req/min. Prefer `search` over `list` when you know the name."
                />
              </Field>
            </div>
          )}
        </Row>
      ))}

      {error && <Callout tone="error">{error}</Callout>}

      {adding ? (
        <div className="space-y-2 rounded-xl border border-dashed hairline-strong well p-3">
          <Input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Name — lowercase, the namespace in `name.operation` (e.g. weather)"
            autoFocus
            className="font-mono text-xs"
          />
          <Input
            value={draft.base_url}
            onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
            placeholder="https://api.open-meteo.com"
            className="font-mono text-xs"
          />
          <Input
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            placeholder="What this API is for — the line api_man returns."
            className="text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void create()}
              disabled={!draft.name.trim() || !draft.base_url.trim()}
            >
              Add API
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed hairline-strong py-2 text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          <Plus size={14} /> Add API
        </button>
      )}

      {!sources.length && !adding && (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <Webhook size={12} /> Nothing configured — <code className="font-mono">api_man</code> reports an empty
          catalogue until you add one.
        </p>
      )}
    </div>
  );
}

/** Auth type + its one relevant field + the write-only credential. */
function AuthEditor({
  source,
  onEdit,
  onSecret,
}: {
  source: ApiSource;
  onEdit: (patch: Partial<ApiSource>) => void;
  onSecret: (secret: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg hairline p-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Authentication">
          <Select
            value={source.auth_type}
            onChange={(e) => onEdit({ auth_type: e.target.value as ApiAuthType })}
            className="py-1.5 text-xs"
          >
            {API_AUTH_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'none'
                  ? 'None — public API'
                  : t === 'header'
                    ? 'Key in a header'
                    : t === 'query'
                      ? 'Key in the query string'
                      : t === 'bearer'
                        ? 'Bearer token'
                        : 'Basic auth'}
              </option>
            ))}
          </Select>
        </Field>

        {source.auth_type === 'header' && (
          <Field label="Header name">
            <Input
              value={source.auth_header}
              onChange={(e) => onEdit({ auth_header: e.target.value })}
              placeholder="X-API-Key"
              className="py-1.5 font-mono text-xs"
            />
          </Field>
        )}
        {source.auth_type === 'query' && (
          <Field label="Query parameter">
            <Input
              value={source.auth_query}
              onChange={(e) => onEdit({ auth_query: e.target.value })}
              placeholder="api_key"
              className="py-1.5 font-mono text-xs"
            />
          </Field>
        )}
        {source.auth_type === 'basic' && (
          <Field label="Username">
            <Input
              value={source.auth_username}
              onChange={(e) => onEdit({ auth_username: e.target.value })}
              className="py-1.5 font-mono text-xs"
            />
          </Field>
        )}
      </div>

      {source.auth_type !== 'none' && (
        <Field
          label={source.auth_type === 'basic' ? 'Password' : 'Credential'}
          hint="Encrypted at rest and never sent back to this page. Agents cannot read it."
        >
          <Input
            type="password"
            placeholder={source.has_secret ? '•••••••• (stored — type to replace)' : 'paste the key or token'}
            onBlur={(e) => {
              if (e.target.value) {
                onSecret(e.target.value);
                e.target.value = '';
              }
            }}
            className="py-1.5"
          />
        </Field>
      )}
    </div>
  );
}

/** A small key/value list — static headers today, reusable for anything pinned per request. */
function PairsEditor({
  label,
  hint,
  pairs,
  onChange,
}: {
  label: string;
  hint?: string;
  pairs: ApiPair[];
  onChange: (next: ApiPair[]) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</span>
        <Button
          onClick={() => onChange([...pairs, { key: '', value: '' }])}
          icon={<Plus size={11} />}
          className="px-1.5 py-0.5 text-[10px]"
        >
          Add
        </Button>
      </div>
      {hint && <p className="mb-1.5 text-[10px] text-slate-500">{hint}</p>}
      <div className="space-y-1.5">
        {pairs.map((pair, i) => (
          <div key={i} className="flex gap-1.5">
            <Input
              value={pair.key}
              onChange={(e) => onChange(pairs.map((p, idx) => (idx === i ? { ...p, key: e.target.value } : p)))}
              placeholder="Header"
              className="w-40 py-1 font-mono text-[11px]"
            />
            <Input
              value={pair.value}
              onChange={(e) => onChange(pairs.map((p, idx) => (idx === i ? { ...p, value: e.target.value } : p)))}
              placeholder="value"
              className="flex-1 py-1 font-mono text-[11px]"
            />
            <Button variant="danger" onClick={() => onChange(pairs.filter((_, idx) => idx !== i))} className="px-1.5">
              <Trash2 size={11} />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
