import { useEffect, useState } from 'react';
import { AlertTriangle, Ban, Check, Copy, Plus, Trash2 } from 'lucide-react';
import { Button, Callout, Checkbox, Input, Row, useConfirm } from '../../../components/ui';
import { API_KEY_SCOPES, apiKeysApi, type ApiKey, type ApiKeyScope } from '../../../lib/api';

/** "never" / "3m ago" / "2d ago" — coarse enough that we never need to re-render on a timer. */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const scales: [number, string][] = [
    [60, 's'],
    [3600, 'm'],
    [86_400, 'h'],
  ];
  for (const [limit, unit] of scales) {
    if (seconds < limit) {
      const value = unit === 's' ? Math.floor(seconds) : Math.floor(seconds / (limit / 60));
      return `${value}${unit} ago`;
    }
  }
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * Mint / revoke / delete API keys.
 *
 * The backend hashes the secret and returns the plaintext exactly once, in the create response — so
 * `issued` holds it in component state until the operator dismisses the callout, and it can never be
 * shown again. Revoking keeps the row (a dead key with an audit trail); deleting drops it entirely.
 */
export function ApiKeysManager() {
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => apiKeysApi.list().then(setKeys);

  useEffect(() => {
    void reload().catch(() => setError('Failed to load API keys.'));
  }, []);

  async function create() {
    if (!name.trim()) return;
    setError(null);
    try {
      const key = await apiKeysApi.create(name.trim(), scopes);
      setIssued({ name: key.name, key: key.key });
      setCopied(false);
      setName('');
      setScopes([]);
      setAdding(false);
      await reload();
    } catch {
      setError('Could not create the key.');
    }
  }

  async function revoke(k: ApiKey) {
    const ok = await confirm({
      title: `Revoke “${k.name}”?`,
      body: 'Anything using it stops working immediately. The audit row stays.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    await apiKeysApi.revoke(k._id);
    await reload();
  }

  async function remove(k: ApiKey) {
    const ok = await confirm({
      title: `Delete “${k.name}” permanently?`,
      body: 'This also drops its audit row.',
      danger: true,
    });
    if (!ok) return;
    await apiKeysApi.remove(k._id);
    await reload();
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <div className="space-y-3">
      {/* Shown once, right after creation. The plaintext is unrecoverable once this is dismissed. */}
      {issued && (
        <Callout tone="warn" icon={<AlertTriangle size={13} />}>
          <div className="space-y-2">
            <p>
              Copy <span className="font-medium">{issued.name}</span> now — this key is hashed at rest and
              will never be shown again.
            </p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={issued.key}
                onFocus={(e) => e.target.select()}
                className="flex-1 py-1.5 font-mono text-xs"
              />
              <Button
                onClick={() => void copy(issued.key)}
                icon={copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <button onClick={() => setIssued(null)} className="text-[11px] text-amber-300/70 hover:text-amber-200">
              I've saved it — dismiss
            </button>
          </div>
        </Callout>
      )}

      {keys.map((k) => (
        <Row key={k._id} className="flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={`truncate text-sm font-medium ${
                  k.revoked_at ? 'text-slate-500 line-through' : 'text-slate-200'
                }`}
              >
                {k.name}
              </span>
              {k.revoked_at && (
                <span className="shrink-0 rounded-md border border-red-500/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-400">
                  revoked
                </span>
              )}
              {API_KEY_SCOPES.filter((s) => k.scopes?.includes(s.scope)).map((s) => (
                <span
                  key={s.scope}
                  title={`This key can ${s.label}`}
                  className="shrink-0 rounded-md border border-amber-500/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400"
                >
                  {s.scope}
                </span>
              ))}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
              <span className="font-mono">plk_{k.prefix}…</span>
              <span>last used {relativeTime(k.last_used_at)}</span>
              <span>created {relativeTime(k.created_at)}</span>
            </div>
          </div>
          {!k.revoked_at && (
            <button
              onClick={() => void revoke(k)}
              title="Revoke — the key stops working, the audit row stays"
              className="shrink-0 rounded p-1.5 text-slate-500 transition-colors hover:text-amber-400"
            >
              <Ban size={14} />
            </button>
          )}
          <button
            onClick={() => void remove(k)}
            title="Delete permanently"
            className="shrink-0 rounded p-1.5 text-slate-500 transition-colors hover:text-red-400"
          >
            <Trash2 size={14} />
          </button>
        </Row>
      ))}

      {keys.length === 0 && !adding && (
        <p className="text-[11px] text-slate-500">
          No API keys yet. Create one to let a script or agent read this instance.
        </p>
      )}

      {error && <Callout tone="error">{error}</Callout>}

      {adding ? (
        <div className="space-y-2 rounded-xl border border-dashed border-white/[0.12] bg-black/25 p-3">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="Name (e.g. claude-code)"
          />
          {API_KEY_SCOPES.map((s) => (
            <Checkbox
              key={s.scope}
              checked={scopes.includes(s.scope)}
              onChange={(on) =>
                setScopes((prev) => (on ? [...prev, s.scope] : prev.filter((x) => x !== s.scope)))
              }
            >
              <span>
                Allow this key to <span className="text-slate-200">{s.label}</span> (
                <span className="font-mono">{s.scope}</span>).
              </span>
            </Checkbox>
          ))}
          <p className="text-[11px] text-slate-500">Grant nothing for a read-only key.</p>
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setAdding(false);
                setName('');
                setScopes([]);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={!name.trim()}>
              Create key
            </Button>
          </div>
        </div>
      ) : (
        <Button icon={<Plus size={13} />} onClick={() => setAdding(true)}>
          Create API key
        </Button>
      )}
    </div>
  );
}
