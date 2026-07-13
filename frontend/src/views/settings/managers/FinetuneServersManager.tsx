import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Callout, Input, Row, useConfirm } from '../../../components/ui';
import { finetuneServersApi, type FinetuneServer, type FinetuneServerPatch } from '../../../lib/api';
import { useSettings } from '../context';

/**
 * CRUD for remote fine-tune servers (the GPU boxes the Fine-Tuning page drives). Mirrors
 * `EndpointsManager` — edit-on-blur, confirm-to-delete — with one difference: the API key is
 * write-only. The backend stores it encrypted and never returns it, so the password box stays blank
 * and only patches when the operator types a new value.
 */
export function FinetuneServersManager() {
  const { finetuneServers: servers, reloadFinetuneServers: reload } = useSettings();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || !url.trim()) return;
    setError(null);
    try {
      await finetuneServersApi.create({ name: name.trim(), base_url: url.trim(), api_key: apiKey || undefined });
      setName('');
      setUrl('');
      setApiKey('');
      setAdding(false);
      await reload();
    } catch {
      setError('Could not add the server — is the name already taken?');
    }
  }

  async function patch(id: string, p: FinetuneServerPatch) {
    await finetuneServersApi.update(id, p);
    await reload();
  }

  async function remove(s: FinetuneServer) {
    const ok = await confirm({
      title: `Delete fine-tune server “${s.name}”?`,
      body: 'Tracked jobs keep their history.',
      danger: true,
    });
    if (!ok) return;
    await finetuneServersApi.remove(s._id);
    await reload();
  }

  return (
    <div className="space-y-3">
      {servers.map((s) => (
        <Row key={s._id} className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <Input
              defaultValue={s.name}
              onBlur={(ev) => ev.target.value !== s.name && void patch(s._id, { name: ev.target.value })}
              className="flex-1 py-1.5 font-medium"
            />
            <button
              onClick={() => void patch(s._id, { enabled: !s.enabled })}
              title={s.enabled ? 'Disable (hide from the Fine-Tuning page)' : 'Enable'}
              className={[
                'shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors',
                s.enabled
                  ? 'border-emerald-500/30 text-emerald-400'
                  : 'border-white/[0.12] text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {s.enabled ? 'enabled' : 'disabled'}
            </button>
            <Button variant="danger" onClick={() => void remove(s)} title="Delete server" className="px-2">
              <Trash2 size={13} />
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              defaultValue={s.base_url}
              onBlur={(ev) => ev.target.value !== s.base_url && void patch(s._id, { base_url: ev.target.value })}
              placeholder="http://192.168.1.30:8088"
              className="py-1.5 font-mono text-xs"
            />
            <Input
              type="password"
              defaultValue=""
              placeholder={s.has_api_key ? '•••••••• (set — type to replace)' : 'API key (optional)'}
              onBlur={(ev) => {
                if (ev.target.value) {
                  void patch(s._id, { api_key: ev.target.value });
                  ev.target.value = '';
                }
              }}
              className="py-1.5 text-xs"
            />
          </div>
        </Row>
      ))}

      {servers.length === 0 && !adding && (
        <p className="text-[11px] text-slate-500">
          No fine-tune servers yet. Add the base URL of a running fine-tune service.
        </p>
      )}

      {error && <Callout tone="error">{error}</Callout>}

      {adding ? (
        <div className="space-y-2 rounded-xl border border-dashed border-white/[0.12] bg-black/25 p-3">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. rig-01)" />
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://192.168.1.30:8088"
            className="font-mono text-xs"
          />
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key (optional)"
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void create()} disabled={!name.trim() || !url.trim()}>
              Add server
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/[0.12] py-2 text-xs text-slate-400 transition-colors hover:border-white/25 hover:text-slate-200"
        >
          <Plus size={14} /> Add fine-tune server
        </button>
      )}
    </div>
  );
}
