import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Box, Globe, HardDrive, KeyRound, Layers, Lock, Package, RefreshCw, Save, Server, Trash2, Users } from 'lucide-react';
import {
  isolationsApi,
  imagesApi,
  type Image,
  type Isolation,
  type IsolationStatus,
  type IsolationInstance,
  type IsolationVolume,
  type ManagedContainer,
} from '../lib/api';
import { MasterDetail, ListRow } from '../components/MasterDetail';

interface Draft {
  _id?: string;
  name: string;
  description: string;
  /** The Docker image this profile runs (managed on the Images page); '' = none picked. */
  image_id: string;
  cpus: string;
  memory: string;
  network: Isolation['network'];
  idle_timeout_ms: number;
  ssh_public_key: string;
  ssh_known_hosts: string;
  /** Write-only: typed here to set/replace the key; never loaded back from the server. */
  ssh_private_key: string;
  /** Write-only WireGuard `.conf` contents (uploaded file); never loaded back from the server. */
  vpn_conf: string;
  /** Write-only remote sudo password; never loaded back from the server. */
  sudo_password: string;
}

const blank = (): Draft => ({
  name: '',
  description: '',
  image_id: '',
  cpus: '1',
  memory: '1g',
  network: 'host',
  idle_timeout_ms: 1_800_000,
  ssh_public_key: '',
  ssh_known_hosts: '',
  ssh_private_key: '',
  vpn_conf: '',
  sudo_password: '',
});

const toDraft = (i: Isolation): Draft => ({
  _id: i._id,
  name: i.name,
  description: i.description,
  image_id: i.image_id ?? '',
  cpus: i.cpus,
  memory: i.memory,
  network: i.network,
  idle_timeout_ms: i.idle_timeout_ms,
  ssh_public_key: i.ssh_public_key ?? '',
  ssh_known_hosts: i.ssh_known_hosts ?? '',
  ssh_private_key: '',
  vpn_conf: '',
  sudo_password: '',
});

/**
 * Isolation profiles page (master-detail): create/edit/delete reusable Docker environments that
 * agents get assigned to on the Agents page. Each profile references a Docker image (built on the
 * Images page) and layers the resource/network/VPN/SSH runtime policy on top.
 */
export function IsolationsView() {
  const [items, setItems] = useState<Isolation[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<IsolationStatus | null>(null);
  const [saving, setSaving] = useState(false);

  // Global managed-container overview (all profiles): shown in the detail pane instead of an editor.
  const [containers, setContainers] = useState<ManagedContainer[] | null>(null);
  const [showContainers, setShowContainers] = useState(false);
  const [containersBusy, setContainersBusy] = useState(false);

  const isNew = draft && !draft._id;
  const orphanCount = (containers ?? []).filter((c) => c.orphan).length;

  async function refresh() {
    const list = await isolationsApi.list();
    setItems(list);
    return list;
  }
  async function loadContainers() {
    setContainers(await isolationsApi.listContainers().catch(() => []));
  }
  useEffect(() => {
    void refresh();
    void loadContainers();
    void imagesApi.list().then(setImages).catch(() => undefined);
  }, []);

  async function loadStatus(id: string) {
    setStatus(await isolationsApi.status(id).catch(() => null));
  }

  function select(i: Isolation) {
    setShowContainers(false);
    setDraft(toDraft(i));
    setStatus(null);
    void loadStatus(i._id);
  }

  function newProfile() {
    setShowContainers(false);
    setDraft(blank());
    setStatus(null);
  }

  function openContainers() {
    setShowContainers(true);
    setDraft(null);
    void loadContainers();
  }

  async function removeContainer(name: string) {
    if (!confirm(`Remove container "${name}"? An assigned agent recreates its own on next run.`)) return;
    setContainersBusy(true);
    try {
      await isolationsApi.removeContainer(name);
      await loadContainers();
      if (draft?._id) await loadStatus(draft._id);
    } catch (e) {
      alert(`Remove failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setContainersBusy(false);
    }
  }

  async function removeOrphans() {
    const orphans = (containers ?? []).filter((c) => c.orphan);
    if (!orphans.length) return;
    if (!confirm(`Remove ${orphans.length} orphaned container(s)? This cannot be undone.`)) return;
    setContainersBusy(true);
    try {
      for (const c of orphans) await isolationsApi.removeContainer(c.container).catch(() => undefined);
      await loadContainers();
    } finally {
      setContainersBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const fields = {
        name: draft.name,
        description: draft.description,
        image_id: draft.image_id || null,
        cpus: draft.cpus,
        memory: draft.memory,
        network: draft.network,
        idle_timeout_ms: draft.idle_timeout_ms,
        ssh_public_key: draft.ssh_public_key,
        ssh_known_hosts: draft.ssh_known_hosts,
      };
      // Only send write-only secrets when the operator actually supplied one. The uploaded `.conf`
      // and the SSH private key are both accepted directly on create and on update.
      const secrets = {
        ...(draft.ssh_private_key.trim() ? { ssh_private_key: draft.ssh_private_key } : {}),
        ...(draft.vpn_conf.trim() ? { vpn_conf: draft.vpn_conf } : {}),
        ...(draft.sudo_password.trim() ? { sudo_password: draft.sudo_password } : {}),
      };

      if (isNew) {
        const created = await isolationsApi.create({ ...fields, ...secrets });
        await refresh();
        select(created);
      } else {
        await isolationsApi.update(draft._id!, { ...fields, ...secrets });
        setDraft({ ...draft, ssh_private_key: '', vpn_conf: '', sudo_password: '' });
        await refresh();
        await loadStatus(draft._id!);
      }
    } finally {
      setSaving(false);
    }
  }

  async function clearSshKey() {
    if (!draft?._id) return;
    if (!confirm('Remove the SSH private key from this profile?')) return;
    await isolationsApi.update(draft._id, { ssh_private_key: '' });
    setDraft({ ...draft, ssh_private_key: '' });
    await loadStatus(draft._id);
  }

  async function clearVpnConf() {
    if (!draft?._id) return;
    if (!confirm('Remove the WireGuard .conf from this profile?')) return;
    await isolationsApi.update(draft._id, { vpn_conf: '' });
    setDraft({ ...draft, vpn_conf: '' });
    await loadStatus(draft._id);
  }

  async function clearSudoPassword() {
    if (!draft?._id) return;
    if (!confirm('Remove the remote sudo password from this profile?')) return;
    await isolationsApi.update(draft._id, { sudo_password: '' });
    setDraft({ ...draft, sudo_password: '' });
    await loadStatus(draft._id);
  }

  async function deleteVolume(v: IsolationVolume) {
    if (!draft?._id) return;
    const msg = v.in_use
      ? `Volume "${v.name}" is in use by ${v.used_by.map((u) => u.container).join(', ')}.\n\n` +
        `This removes that container (recreated on the agent's next run) and permanently deletes ` +
        `the volume and all its files. Continue?`
      : `Permanently delete volume "${v.name}" and all its files? This cannot be undone.`;
    if (!confirm(msg)) return;
    try {
      await isolationsApi.deleteVolume(draft._id, v.name, v.in_use);
      await loadStatus(draft._id);
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function remove() {
    if (!draft?._id) return;
    const count = status?.assigned_agents.length ?? 0;
    const warn = count
      ? `This profile is assigned to ${count} agent(s). Deleting it removes the shared volume and unassigns those agents (the image is kept). Continue?`
      : 'Delete this isolation profile (removes its shared volume; the image is kept)?';
    if (!confirm(warn)) return;
    await isolationsApi.remove(draft._id);
    setDraft(null);
    setStatus(null);
    await refresh();
  }

  return (
    <MasterDetail
      newLabel="New isolation"
      onNew={newProfile}
      list={
        <>
          <ListRow active={showContainers} onClick={openContainers}>
            <Layers size={15} /> Containers
            {orphanCount > 0 && (
              <span className="ml-auto rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-400">
                {orphanCount} orphan
              </span>
            )}
          </ListRow>
          <div className="my-1 border-t border-border" />
          {items.map((i) => (
            <ListRow key={i._id} active={!showContainers && draft?._id === i._id} onClick={() => select(i)}>
              <Box size={15} /> {i.name}
              {!i.image_id && (
                <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-600" title="no image assigned">
                  no image
                </span>
              )}
            </ListRow>
          ))}
        </>
      }
    >
      {showContainers ? (
        <ContainersPanel
          containers={containers}
          busy={containersBusy}
          onRefresh={loadContainers}
          onRemove={removeContainer}
          onRemoveOrphans={removeOrphans}
        />
      ) : !draft ? (
        <Empty />
      ) : (
        <div className="mx-auto max-w-3xl space-y-5 p-6">
          <div className="flex items-center gap-3">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="isolation_name (e.g. python-dev)"
              className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
            />
            {!isNew && (
              <button
                onClick={remove}
                className="flex items-center gap-1 rounded-md border border-red-900 px-3 py-2 text-xs text-red-400 hover:bg-red-950"
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              <Save size={15} /> Save
            </button>
          </div>

          <Label>Description</Label>
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="What this environment provides"
            className="w-full rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />

          {/* Docker image — built + managed on the Images page; the profile just references one. */}
          <div className="space-y-2 rounded-md border border-border bg-surface/40 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
                <Package size={13} /> Docker image
              </span>
              {status && status.image_id && <StatusBadge status={status.image_status ?? 'none'} />}
            </div>
            <div className="flex items-center gap-2">
              <select
                value={draft.image_id}
                onChange={(e) => setDraft({ ...draft, image_id: e.target.value })}
                className="flex-1 rounded border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
              >
                <option value="">— no image (agents can't launch) —</option>
                {images.map((img) => (
                  <option key={img._id} value={img._id}>
                    {img.name}
                    {img.image_status !== 'built' ? ` (${img.image_status})` : ''}
                  </option>
                ))}
              </select>
              <Link
                to="/images"
                className="shrink-0 rounded border border-border px-2.5 py-1.5 text-xs text-slate-300 hover:border-accent"
              >
                Manage images
              </Link>
            </div>
            {draft.image_id && status?.image_status && status.image_status !== 'built' && (
              <p className="flex items-center gap-1.5 text-[11px] text-amber-400">
                <AlertTriangle size={12} /> This image is not built yet — build it on the{' '}
                <Link to="/images" className="underline">
                  Images
                </Link>{' '}
                page, or agents on this profile will error.
              </p>
            )}
            <p className="text-[11px] text-slate-500">
              Save any image change first — assigned agents pick up the new image on their next run.
            </p>
          </div>

          <div className="grid grid-cols-4 gap-2 text-xs">
            <Field label="CPUs">
              <input
                value={draft.cpus}
                onChange={(e) => setDraft({ ...draft, cpus: e.target.value })}
                className="w-full rounded border border-border bg-surface px-2 py-1"
              />
            </Field>
            <Field label="Memory">
              <input
                value={draft.memory}
                onChange={(e) => setDraft({ ...draft, memory: e.target.value })}
                className="w-full rounded border border-border bg-surface px-2 py-1"
              />
            </Field>
            <Field label="Network">
              <select
                value={draft.network}
                onChange={(e) => setDraft({ ...draft, network: e.target.value as Isolation['network'] })}
                className="w-full rounded border border-border bg-surface px-2 py-1"
              >
                <option value="host">host (LAN + host)</option>
                <option value="bridge">bridge (NAT)</option>
                <option value="none">none (offline)</option>
                <option value="vpn">vpn (gluetun)</option>
              </select>
            </Field>
            <Field label="Idle stop (min)">
              <input
                type="number"
                value={Math.round(draft.idle_timeout_ms / 60000)}
                onChange={(e) =>
                  setDraft({ ...draft, idle_timeout_ms: Math.max(1, Number(e.target.value) || 30) * 60000 })
                }
                className="w-full rounded border border-border bg-surface px-2 py-1"
              />
            </Field>
          </div>

          {/* VPN (gluetun / WireGuard) — only relevant in `vpn` network mode */}
          {draft.network === 'vpn' && (
            <div className="space-y-2 rounded-md border border-border bg-surface/40 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
                  <Globe size={13} /> VPN (gluetun / WireGuard)
                </span>
                <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide">
                  {status?.vpn_conf_set ? (
                    <>
                      <span className="text-emerald-400">config set</span>
                      <button onClick={clearVpnConf} className="text-red-400 hover:underline">
                        remove
                      </button>
                    </>
                  ) : (
                    <span className="text-slate-600">no config</span>
                  )}
                  {status?.vpn_state && status.vpn_state !== 'absent' && (
                    <span className="text-slate-500">tunnel: {status.vpn_state}</span>
                  )}
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                Agent containers on this profile route all traffic through a dedicated gluetun
                container. Tools are held until the tunnel is healthy (kill-switch), so the real IP
                never leaks. Upload a standard WireGuard <code>.conf</code> — the backend parses it
                into gluetun's config. It contains the private key, so it is encrypted at rest and
                never shown again after saving.
              </p>
              <div className="flex items-center gap-2">
                <label className="cursor-pointer rounded border border-border bg-surface px-2 py-1 text-[11px] hover:border-accent">
                  Upload .conf
                  <input
                    type="file"
                    accept=".conf,text/plain"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) setDraft({ ...draft, vpn_conf: await file.text() });
                      e.target.value = '';
                    }}
                  />
                </label>
                {draft.vpn_conf.trim() && (
                  <span className="text-[10px] uppercase tracking-wide text-amber-400">
                    new config staged — save to apply
                  </span>
                )}
              </div>
              <textarea
                value={draft.vpn_conf}
                onChange={(e) => setDraft({ ...draft, vpn_conf: e.target.value })}
                rows={6}
                spellCheck={false}
                placeholder={
                  status?.vpn_conf_set
                    ? '•••••••• config set — upload or paste a new .conf to replace it'
                    : '[Interface]\nPrivateKey = …\nAddress = 10.64.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0'
                }
                className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
              />
            </div>
          )}

          {/* Outbound SSH client key */}
          <div className="space-y-2 rounded-md border border-border bg-surface/40 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
                <KeyRound size={13} /> Outbound SSH key
              </span>
              {status?.ssh_key_set ? (
                <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-emerald-400">
                  key set
                  <button onClick={clearSshKey} className="text-red-400 hover:underline">
                    remove
                  </button>
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wide text-slate-600">no key</span>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              Injected into each agent container at <code>~/.ssh/id_ed25519</code> (chmod 600) so the
              agent can <code>git clone</code> / <code>ssh</code> out. Encrypted at rest; never shown
              again after saving.
            </p>
            <textarea
              value={draft.ssh_private_key}
              onChange={(e) => setDraft({ ...draft, ssh_private_key: e.target.value })}
              rows={4}
              spellCheck={false}
              placeholder={
                status?.ssh_key_set
                  ? '•••••••• key set — paste a new private key to replace it'
                  : '-----BEGIN OPENSSH PRIVATE KEY-----\n…'
              }
              className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Public key (optional)</div>
                <textarea
                  value={draft.ssh_public_key}
                  onChange={(e) => setDraft({ ...draft, ssh_public_key: e.target.value })}
                  rows={3}
                  spellCheck={false}
                  placeholder="ssh-ed25519 AAAA… (→ id_ed25519.pub)"
                  className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
                />
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">known_hosts (optional)</div>
                <textarea
                  value={draft.ssh_known_hosts}
                  onChange={(e) => setDraft({ ...draft, ssh_known_hosts: e.target.value })}
                  rows={3}
                  spellCheck={false}
                  placeholder="github.com ssh-ed25519 AAAA…"
                  className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              SSH changes apply after <span className="text-slate-400">Save</span> and take effect on
              each agent’s next container start.
            </p>
          </div>

          {/* Remote sudo password */}
          <div className="space-y-2 rounded-md border border-border bg-surface/40 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
                <Lock size={13} /> Remote sudo password
              </span>
              {status?.sudo_password_set ? (
                <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-emerald-400">
                  password set
                  <button onClick={clearSudoPassword} className="text-red-400 hover:underline">
                    remove
                  </button>
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wide text-slate-600">no password</span>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              Planted in each agent container at <code>/opt/pleiade/sudo_pass</code> (chmod 600) with a{' '}
              <code>SUDO_ASKPASS</code> helper, so the agent can escalate on a remote host it SSHes into —
              e.g. <code>ssh host 'sudo -S -p "" cmd' &lt; /opt/pleiade/sudo_pass</code>. Encrypted at
              rest; never shown again after saving.
            </p>
            <input
              type="password"
              value={draft.sudo_password}
              onChange={(e) => setDraft({ ...draft, sudo_password: e.target.value })}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                status?.sudo_password_set
                  ? '•••••••• password set — type a new one to replace it'
                  : 'remote sudo password'
              }
              className="w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
            />
          </div>

          {isNew ? (
            <p className="text-xs text-slate-500">Save the profile, then assign a built image and agents.</p>
          ) : (
            <>
              {status && (
                <div className="flex items-center gap-1 text-xs text-slate-500">
                  <Users size={13} /> {status.assigned_agents.length} agent(s) assigned · network{' '}
                  <code>{draft.network}</code> — pick <code>host</code> for LAN access.
                </div>
              )}

              {status && <InstancesSection instances={status.instances} />}
              {status && <VolumesSection volumes={status.volumes} onDelete={deleteVolume} />}
            </>
          )}
        </div>
      )}
    </MasterDetail>
  );
}

/** Human-friendly volume creation time; falls back to the raw string docker returned. */
function fmtDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

/** Colour for a container's docker state. */
function stateTone(state: string): string {
  if (state === 'running') return 'text-emerald-400 border-emerald-900 bg-emerald-950/40';
  if (state === 'absent') return 'text-slate-500 border-border bg-surface';
  if (state === 'exited' || state === 'created') return 'text-slate-400 border-slate-700 bg-surface';
  return 'text-amber-400 border-amber-900 bg-amber-950/40';
}

/** The per-agent containers ("instances") running under this profile's image. */
function InstancesSection({ instances }: { instances: IsolationInstance[] }) {
  return (
    <div className="space-y-2">
      <Label>
        <span className="flex items-center gap-1.5">
          <Server size={13} /> Instances ({instances.length})
        </span>
      </Label>
      {instances.length === 0 ? (
        <p className="text-[11px] text-slate-600">No agents are assigned to this profile.</p>
      ) : (
        <div className="divide-y divide-border rounded border border-border">
          {instances.map((i) => (
            <div key={i.agent_id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className="font-medium text-slate-200">{i.agent_name}</span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${stateTone(i.state)}`}
              >
                {i.state}
              </span>
              <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] text-slate-500">
                <span className="rounded bg-surface px-1.5 py-0.5 uppercase tracking-wide text-slate-400">
                  {i.volume_mode}
                </span>
                {i.container}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Volumes owned by this profile (shared + per-agent individual), with a delete control. */
function VolumesSection({
  volumes,
  onDelete,
}: {
  volumes: IsolationVolume[];
  onDelete: (v: IsolationVolume) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>
        <span className="flex items-center gap-1.5">
          <HardDrive size={13} /> Volumes ({volumes.filter((v) => v.exists).length})
        </span>
      </Label>
      <div className="divide-y divide-border rounded border border-border">
        {volumes.map((v) => (
          <div key={v.name} className="flex items-start gap-3 px-3 py-2 text-xs">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                  {v.scope}
                </span>
                {v.agent_name && <span className="text-slate-300">{v.agent_name}</span>}
                {v.exists ? (
                  v.in_use ? (
                    <span className="rounded border border-amber-900 bg-amber-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                      in use
                    </span>
                  ) : (
                    <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                      idle
                    </span>
                  )
                ) : (
                  <span className="text-[10px] uppercase tracking-wide text-slate-600">not created</span>
                )}
              </div>
              <div className="truncate font-mono text-[10px] text-slate-500">{v.name}</div>
              {v.exists && (
                <div className="text-[10px] text-slate-600">
                  created {fmtDate(v.created_at)}
                  {v.in_use && ` · mounted by ${v.used_by.map((u) => u.container).join(', ')}`}
                </div>
              )}
            </div>
            <button
              onClick={() => onDelete(v)}
              disabled={!v.exists}
              title={v.exists ? 'Delete volume' : 'Nothing to delete'}
              className="flex shrink-0 items-center gap-1 rounded border border-red-900 px-2 py-1 text-[11px] text-red-400 hover:bg-red-950 disabled:cursor-not-allowed disabled:border-border disabled:text-slate-700 disabled:hover:bg-transparent"
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        Deleting a volume permanently removes its <code>/workspace</code> files. An in-use volume also
        stops its container (recreated on the agent's next run).
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'built'
      ? 'text-emerald-400 border-emerald-900'
      : status === 'building' || status === 'queued'
        ? 'text-amber-400 border-amber-900'
        : status === 'error'
          ? 'text-red-400 border-red-900'
          : 'text-slate-500 border-border';
  return (
    <span className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${color}`}>
      image: {status}
    </span>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-slate-600">
      Select an isolation profile or create a new one.
    </div>
  );
}

/**
 * Global overview of every pleiade-managed docker container (agent + gluetun) across all profiles,
 * with orphans flagged for cleanup and a per-row / bulk remove.
 */
function ContainersPanel({
  containers,
  busy,
  onRefresh,
  onRemove,
  onRemoveOrphans,
}: {
  containers: ManagedContainer[] | null;
  busy: boolean;
  onRefresh: () => void;
  onRemove: (name: string) => void;
  onRemoveOrphans: () => void;
}) {
  const rows = containers ?? [];
  const orphans = rows.filter((c) => c.orphan);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Layers size={16} /> Managed containers
        </h2>
        <span className="text-xs text-slate-500">
          {rows.length} total{orphans.length > 0 && ` · ${orphans.length} orphaned`}
        </span>
        <button
          onClick={onRefresh}
          disabled={busy}
          className="ml-auto flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-50"
        >
          <RefreshCw size={13} /> Refresh
        </button>
        {orphans.length > 0 && (
          <button
            onClick={onRemoveOrphans}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-red-900 px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950 disabled:opacity-50"
          >
            <Trash2 size={13} /> Remove {orphans.length} orphan{orphans.length > 1 ? 's' : ''}
          </button>
        )}
      </div>
      <p className="text-[11px] text-slate-500">
        Every docker container pleiade manages, across all profiles. <b>Orphaned</b> containers no
        longer map to live config (their agent or profile was deleted / unassigned) and are safe to
        remove. Removing an active agent's container is fine too — it is recreated on the agent's
        next run.
      </p>

      {rows.length === 0 ? (
        <p className="text-xs text-slate-600">No managed containers exist right now.</p>
      ) : (
        <div className="divide-y divide-border rounded border border-border">
          {rows.map((c) => (
            <div key={c.container} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                {c.kind}
              </span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${stateTone(c.state)}`}
              >
                {c.state}
              </span>
              <div className="min-w-0">
                <div className="truncate text-slate-200">
                  {c.agent_name ?? c.isolation_name ?? <span className="text-slate-500">unknown</span>}
                  {c.isolation_name && c.agent_name && (
                    <span className="text-slate-500"> · {c.isolation_name}</span>
                  )}
                </div>
                <div className="truncate font-mono text-[10px] text-slate-500">{c.container}</div>
                {c.orphan && c.reason && (
                  <div className="flex items-center gap-1 text-[10px] text-amber-400">
                    <AlertTriangle size={11} /> {c.reason}
                  </div>
                )}
              </div>
              <button
                onClick={() => onRemove(c.container)}
                disabled={busy}
                className="ml-auto flex shrink-0 items-center gap-1 rounded border border-red-900 px-2 py-1 text-[11px] text-red-400 hover:bg-red-950 disabled:opacity-50"
              >
                <Trash2 size={12} /> Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
