import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Box,
  Check,
  Copy,
  Cpu,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  Lock,
  Package,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Users,
} from 'lucide-react';
import {
  isolationsApi,
  imagesApi,
  type Image,
  type Isolation,
  type IsolationStatus,
  type IsolationInstance,
  type IsolationVolume,
  type ManagedContainer,
  type SshKeyType,
} from '../lib/api';
import { MasterDetail, ListRow, ListDivider } from '../components/MasterDetail';
import {
  Button,
  Callout,
  Chip,
  EmptyState,
  Field,
  GlassCard,
  Hint,
  Input,
  RowGroup,
  Section,
  Select,
  StatusBadge,
  Textarea,
  toneOf,
  useConfirm,
  type Tone,
} from '../components/ui';

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
  /** Algorithm of the stored key ('' = legacy/unknown → ed25519). Drives the injected filename hint. */
  ssh_key_type: SshKeyType | '';
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
  ssh_key_type: '',
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
  ssh_key_type: i.ssh_key_type ?? '',
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
  // Server-side SSH keypair generation: chosen algorithm, in-flight flag, and copy-to-clipboard feedback.
  const [genType, setGenType] = useState<SshKeyType>('ed25519');
  const [generatingKey, setGeneratingKey] = useState(false);
  const [pubKeyCopied, setPubKeyCopied] = useState(false);
  const confirm = useConfirm();

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
    const ok = await confirm({
      title: `Remove container “${name}”?`,
      body: 'An assigned agent recreates its own on next run.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
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
    const ok = await confirm({
      title: `Remove ${orphans.length} orphaned container(s)?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
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
    if (!(await confirm({ title: 'Remove the SSH private key from this profile?', danger: true, confirmLabel: 'Remove' }))) return;
    await isolationsApi.update(draft._id, { ssh_private_key: '', ssh_public_key: '' });
    setDraft({ ...draft, ssh_private_key: '', ssh_public_key: '', ssh_key_type: '' });
    await loadStatus(draft._id);
  }

  /**
   * Generate a fresh keypair server-side. The private key is stored encrypted + injected into
   * containers and never leaves the backend; only the public key comes back to display. Replacing an
   * existing key invalidates the old public key on remote hosts, so confirm first.
   */
  async function generateSshKey() {
    if (!draft?._id) return;
    if (
      status?.ssh_key_set &&
      !(await confirm({
        title: 'Replace the existing SSH key?',
        body: 'The current public key stops working — you must add the NEW public key to your remote servers’ authorized_keys.',
        danger: true,
        confirmLabel: 'Generate new key',
      }))
    )
      return;
    setGeneratingKey(true);
    try {
      const r = await isolationsApi.generateSsh(draft._id, genType);
      // Clear any half-typed manual key so Save doesn't overwrite the freshly generated one.
      setDraft({ ...draft, ssh_public_key: r.ssh_public_key, ssh_key_type: r.ssh_key_type, ssh_private_key: '' });
      await loadStatus(draft._id);
    } catch (e) {
      alert(`Key generation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGeneratingKey(false);
    }
  }

  async function copyPublicKey() {
    if (!draft?.ssh_public_key) return;
    await navigator.clipboard.writeText(draft.ssh_public_key);
    setPubKeyCopied(true);
    setTimeout(() => setPubKeyCopied(false), 1500);
  }

  async function clearVpnConf() {
    if (!draft?._id) return;
    if (!(await confirm({ title: 'Remove the WireGuard .conf from this profile?', danger: true, confirmLabel: 'Remove' }))) return;
    await isolationsApi.update(draft._id, { vpn_conf: '' });
    setDraft({ ...draft, vpn_conf: '' });
    await loadStatus(draft._id);
  }

  async function clearSudoPassword() {
    if (!draft?._id) return;
    if (!(await confirm({ title: 'Remove the remote sudo password from this profile?', danger: true, confirmLabel: 'Remove' }))) return;
    await isolationsApi.update(draft._id, { sudo_password: '' });
    setDraft({ ...draft, sudo_password: '' });
    await loadStatus(draft._id);
  }

  async function deleteVolume(v: IsolationVolume) {
    if (!draft?._id) return;
    const body = v.in_use
      ? `Volume "${v.name}" is in use by ${v.used_by.map((u) => u.container).join(', ')}.\n\n` +
        `This removes that container (recreated on the agent's next run) and permanently deletes ` +
        `the volume and all its files.`
      : `Permanently delete volume "${v.name}" and all its files? This cannot be undone.`;
    if (!(await confirm({ title: 'Delete volume?', body, danger: true }))) return;
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
    const body = count
      ? `This profile is assigned to ${count} agent(s). Deleting it removes the shared volume and unassigns those agents (the image is kept).`
      : 'Deleting it removes its shared volume; the image is kept.';
    if (!(await confirm({ title: `Delete isolation profile “${draft.name}”?`, body, danger: true }))) return;
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
            <Layers size={15} className="shrink-0" />
            <span className="flex-1 truncate">Containers</span>
            {orphanCount > 0 && (
              <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-400">
                {orphanCount} orphan
              </span>
            )}
          </ListRow>
          <ListDivider />
          {items.map((i) => (
            <ListRow key={i._id} active={!showContainers && draft?._id === i._id} onClick={() => select(i)}>
              <Box size={15} className="shrink-0" />
              <span className="flex-1 truncate">{i.name}</span>
              {!i.image_id && (
                <span
                  className="shrink-0 text-[10px] uppercase tracking-wider text-slate-600"
                  title="no image assigned"
                >
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
        <EmptyState icon={<Box size={28} />}>Select an isolation profile or create a new one.</EmptyState>
      ) : (
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          <div className="flex items-center gap-2">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="isolation_name (e.g. python-dev)"
              className="flex-1 font-mono"
            />
            {!isNew && (
              <Button variant="danger" icon={<Trash2 size={13} />} onClick={remove}>
                Delete
              </Button>
            )}
            <Button variant="primary" icon={<Save size={13} />} onClick={save} loading={saving}>
              Save
            </Button>
          </div>

          <Section title="Profile" icon={<Box size={13} />}>
            <Field label="Description">
              <Input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="What this environment provides"
              />
            </Field>
          </Section>

          {/* Docker image — built + managed on the Images page; the profile just references one. */}
          <Section
            title="Docker image"
            icon={<Package size={13} />}
            right={
              status &&
              status.image_id && (
                <StatusBadge tone={toneOf(status.image_status ?? 'none')}>
                  image: {status.image_status ?? 'none'}
                </StatusBadge>
              )
            }
          >
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <Select
                  value={draft.image_id}
                  onChange={(e) => setDraft({ ...draft, image_id: e.target.value })}
                  className="flex-1"
                >
                  <option value="">— no image (agents can&apos;t launch) —</option>
                  {images.map((img) => (
                    <option key={img._id} value={img._id}>
                      {img.name}
                      {img.image_status !== 'built' ? ` (${img.image_status})` : ''}
                    </option>
                  ))}
                </Select>
                <Link
                  to="/images"
                  className="shrink-0 rounded-lg px-3 py-2 text-xs text-slate-300 ring-1 ring-white/[0.1] transition hover:bg-white/[0.06]"
                >
                  Manage images
                </Link>
              </div>
              {draft.image_id && status?.image_status && status.image_status !== 'built' && (
                <Callout tone="warn" icon={<AlertTriangle size={13} />}>
                  This image is not built yet — build it on the{' '}
                  <Link to="/images" className="underline">
                    Images
                  </Link>{' '}
                  page, or agents on this profile will error.
                </Callout>
              )}
              <Hint>
                Save any image change first — assigned agents pick up the new image on their next run.
              </Hint>
            </div>
          </Section>

          <Section title="Resources" icon={<Cpu size={13} />}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="CPUs">
                <Input
                  value={draft.cpus}
                  onChange={(e) => setDraft({ ...draft, cpus: e.target.value })}
                  className="py-1.5 text-xs"
                />
              </Field>
              <Field label="Memory">
                <Input
                  value={draft.memory}
                  onChange={(e) => setDraft({ ...draft, memory: e.target.value })}
                  className="py-1.5 text-xs"
                />
              </Field>
              <Field label="Network">
                <Select
                  value={draft.network}
                  onChange={(e) => setDraft({ ...draft, network: e.target.value as Isolation['network'] })}
                  className="py-1.5 text-xs"
                >
                  <option value="host">host (LAN + host)</option>
                  <option value="bridge">bridge (NAT)</option>
                  <option value="none">none (offline)</option>
                  <option value="vpn">vpn (gluetun)</option>
                </Select>
              </Field>
              <Field label="Idle stop (min)">
                <Input
                  type="number"
                  value={Math.round(draft.idle_timeout_ms / 60000)}
                  onChange={(e) =>
                    setDraft({ ...draft, idle_timeout_ms: Math.max(1, Number(e.target.value) || 30) * 60000 })
                  }
                  className="py-1.5 text-xs"
                />
              </Field>
            </div>
          </Section>

          {/* VPN (gluetun / WireGuard) — only relevant in `vpn` network mode */}
          {draft.network === 'vpn' && (
            <Section
              title="VPN (gluetun / WireGuard)"
              icon={<Globe size={13} />}
              right={
                <span className="flex items-center gap-2 text-[10px] uppercase tracking-wider">
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
              }
            >
              <div className="space-y-2.5">
                <Hint>
                  Agent containers on this profile route all traffic through a dedicated gluetun
                  container. Tools are held until the tunnel is healthy (kill-switch), so the real IP
                  never leaks. Upload a standard WireGuard <code>.conf</code> — the backend parses it
                  into gluetun&apos;s config. It contains the private key, so it is encrypted at rest
                  and never shown again after saving.
                </Hint>
                <div className="flex items-center gap-2">
                  <label className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[11px] text-slate-300 ring-1 ring-white/[0.1] transition hover:bg-white/[0.06]">
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
                    <span className="text-[10px] uppercase tracking-wider text-amber-400">
                      new config staged — save to apply
                    </span>
                  )}
                </div>
                <Textarea
                  value={draft.vpn_conf}
                  onChange={(e) => setDraft({ ...draft, vpn_conf: e.target.value })}
                  rows={6}
                  placeholder={
                    status?.vpn_conf_set
                      ? '•••••••• config set — upload or paste a new .conf to replace it'
                      : '[Interface]\nPrivateKey = …\nAddress = 10.64.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0'
                  }
                />
              </div>
            </Section>
          )}

          {/* Outbound SSH client key */}
          <Section
            title="Outbound SSH key"
            icon={<KeyRound size={13} />}
            right={
              status?.ssh_key_set ? (
                <span className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-emerald-400">
                  key set
                  <button onClick={clearSshKey} className="text-red-400 hover:underline">
                    remove
                  </button>
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider text-slate-600">no key</span>
              )
            }
          >
            <div className="space-y-2.5">
              <Hint>
                Injected into each agent container at{' '}
                <code>~/.ssh/{draft.ssh_key_type === 'rsa' ? 'id_rsa' : 'id_ed25519'}</code> (chmod
                600) so the container can <code>ssh</code> / <code>git clone</code> out to a remote
                server. The private key is encrypted at rest and never leaves the backend.
              </Hint>

              {/* Generate a keypair server-side (private key stays hidden; public key is shown to copy). */}
              <div className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Generate a new keypair">
                    <Select
                      value={genType}
                      onChange={(e) => setGenType(e.target.value as SshKeyType)}
                      disabled={isNew || generatingKey}
                      className="w-40"
                    >
                      <option value="ed25519">ed25519 (recommended)</option>
                      <option value="rsa">RSA 4096</option>
                    </Select>
                  </Field>
                  <Button
                    variant="primary"
                    icon={<KeyRound size={13} />}
                    onClick={generateSshKey}
                    loading={generatingKey}
                    disabled={!!isNew}
                  >
                    {status?.ssh_key_set ? 'Regenerate' : 'Generate'}
                  </Button>
                </div>
                {isNew ? (
                  <Hint>Save the profile first, then generate its key.</Hint>
                ) : (
                  <Hint>
                    The private key is generated on the server and never shown. Copy the public key
                    below into your remote host&apos;s <code>~/.ssh/authorized_keys</code>.
                  </Hint>
                )}
                {draft.ssh_public_key ? (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-slate-400">
                        Public key ({draft.ssh_key_type || 'ed25519'})
                      </span>
                      <button
                        onClick={copyPublicKey}
                        className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-white"
                      >
                        {pubKeyCopied ? <Check size={12} /> : <Copy size={12} />}
                        {pubKeyCopied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <code className="block max-h-24 overflow-auto break-all rounded-md bg-black/30 p-2 text-[11px] text-slate-300">
                      {draft.ssh_public_key}
                    </code>
                  </div>
                ) : null}
              </div>

              {/* Manual entry: paste an existing private key instead of generating one. */}
              <details className="group">
                <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-slate-500 hover:text-slate-300">
                  or paste an existing key
                </summary>
                <div className="mt-2 space-y-2.5">
                  <Textarea
                    value={draft.ssh_private_key}
                    onChange={(e) => setDraft({ ...draft, ssh_private_key: e.target.value })}
                    rows={4}
                    placeholder={
                      status?.ssh_key_set
                        ? '•••••••• key set — paste a new private key to replace it'
                        : '-----BEGIN OPENSSH PRIVATE KEY-----\n…'
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Public key (optional)">
                      <Textarea
                        value={draft.ssh_public_key}
                        onChange={(e) => setDraft({ ...draft, ssh_public_key: e.target.value })}
                        rows={3}
                        placeholder="ssh-ed25519 AAAA… (→ id_ed25519.pub)"
                      />
                    </Field>
                    <Field label="known_hosts (optional)">
                      <Textarea
                        value={draft.ssh_known_hosts}
                        onChange={(e) => setDraft({ ...draft, ssh_known_hosts: e.target.value })}
                        rows={3}
                        placeholder="github.com ssh-ed25519 AAAA…"
                      />
                    </Field>
                  </div>
                  <Hint>
                    A pasted key is stored under <code>id_ed25519</code>. Changes here apply after{' '}
                    <span className="text-slate-400">Save</span>.
                  </Hint>
                </div>
              </details>

              <Hint>
                SSH changes take effect on each agent&apos;s next container start (assigned containers
                are recreated automatically).
              </Hint>
            </div>
          </Section>

          {/* Remote sudo password */}
          <Section
            title="Remote sudo password"
            icon={<Lock size={13} />}
            right={
              status?.sudo_password_set ? (
                <span className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-emerald-400">
                  password set
                  <button onClick={clearSudoPassword} className="text-red-400 hover:underline">
                    remove
                  </button>
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider text-slate-600">no password</span>
              )
            }
          >
            <div className="space-y-2.5">
              <Hint>
                Planted in each agent container at <code>/opt/pleiades/sudo_pass</code> (chmod 600) with
                a <code>SUDO_ASKPASS</code> helper, so the agent can escalate on a remote host it SSHes
                into — e.g. <code>ssh host &apos;sudo -S -p &quot;&quot; cmd&apos; &lt; /opt/pleiades/sudo_pass</code>.
                Encrypted at rest; never shown again after saving.
              </Hint>
              <Input
                type="password"
                value={draft.sudo_password}
                onChange={(e) => setDraft({ ...draft, sudo_password: e.target.value })}
                autoComplete="new-password"
                spellCheck={false}
                className="font-mono text-[11px]"
                placeholder={
                  status?.sudo_password_set
                    ? '•••••••• password set — type a new one to replace it'
                    : 'remote sudo password'
                }
              />
            </div>
          </Section>

          {isNew ? (
            <Hint>Save the profile, then assign a built image and agents.</Hint>
          ) : (
            <>
              {status && (
                <div className="flex items-center gap-1.5 px-1 text-[11px] text-slate-500">
                  <Users size={12} /> {status.assigned_agents.length} agent(s) assigned · network{' '}
                  <code className="text-slate-400">{draft.network}</code> — pick{' '}
                  <code className="text-slate-400">host</code> for LAN access.
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

/** Map a container's docker state onto the shared tone vocabulary. */
function stateTone(state: string): Tone {
  if (state === 'running') return 'ok';
  if (state === 'absent' || state === 'exited' || state === 'created') return 'idle';
  return 'busy';
}

/** The per-agent containers ("instances") running under this profile's image. */
function InstancesSection({ instances }: { instances: IsolationInstance[] }) {
  return (
    <Section title={`Instances (${instances.length})`} icon={<Server size={13} />}>
      {instances.length === 0 ? (
        <Hint>No agents are assigned to this profile.</Hint>
      ) : (
        <RowGroup>
          {instances.map((i) => (
            <div key={i.agent_id} className="flex items-center gap-3 px-3 py-2.5 text-xs">
              <span className="font-medium text-slate-200">{i.agent_name}</span>
              <StatusBadge tone={stateTone(i.state)}>{i.state}</StatusBadge>
              <span className="ml-auto flex min-w-0 items-center gap-1.5">
                <Chip>{i.volume_mode}</Chip>
                <span className="truncate font-mono text-[10px] text-slate-500">{i.container}</span>
              </span>
            </div>
          ))}
        </RowGroup>
      )}
    </Section>
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
    <Section title={`Volumes (${volumes.filter((v) => v.exists).length})`} icon={<HardDrive size={13} />}>
      <div className="space-y-2.5">
        <RowGroup>
          {volumes.map((v) => (
            <div key={v.name} className="flex items-start gap-3 px-3 py-2.5 text-xs">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip>{v.scope}</Chip>
                  {v.agent_name && <span className="text-slate-300">{v.agent_name}</span>}
                  {v.exists ? (
                    v.in_use ? (
                      <StatusBadge tone="busy">in use</StatusBadge>
                    ) : (
                      <StatusBadge tone="idle">idle</StatusBadge>
                    )
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider text-slate-600">
                      not created
                    </span>
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
              <Button
                variant="danger"
                icon={<Trash2 size={12} />}
                onClick={() => onDelete(v)}
                disabled={!v.exists}
                title={v.exists ? 'Delete volume' : 'Nothing to delete'}
                className="px-2 py-1"
              >
                Delete
              </Button>
            </div>
          ))}
        </RowGroup>
        <Hint>
          Deleting a volume permanently removes its <code>/workspace</code> files. An in-use volume
          also stops its container (recreated on the agent&apos;s next run).
        </Hint>
      </div>
    </Section>
  );
}

/**
 * Global overview of every pleiades-managed docker container (agent + gluetun) across all profiles,
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
      <Section
        title="Managed containers"
        icon={<Layers size={13} />}
        right={
          <>
            <span className="text-[11px] text-slate-500">
              {rows.length} total{orphans.length > 0 && ` · ${orphans.length} orphaned`}
            </span>
            <Button variant="ghost" icon={<RefreshCw size={13} />} onClick={onRefresh} disabled={busy}>
              Refresh
            </Button>
            {orphans.length > 0 && (
              <Button variant="danger" icon={<Trash2 size={13} />} onClick={onRemoveOrphans} disabled={busy}>
                Remove {orphans.length} orphan{orphans.length > 1 ? 's' : ''}
              </Button>
            )}
          </>
        }
      >
        <Hint>
          Every docker container pleiades manages, across all profiles. <b>Orphaned</b> containers no
          longer map to live config (their agent or profile was deleted / unassigned) and are safe to
          remove. Removing an active agent&apos;s container is fine too — it is recreated on the
          agent&apos;s next run.
        </Hint>
      </Section>

      {rows.length === 0 ? (
        <GlassCard>
          <EmptyState icon={<Layers size={28} />}>No managed containers exist right now.</EmptyState>
        </GlassCard>
      ) : (
        <RowGroup>
          {rows.map((c) => (
            <div key={c.container} className="flex items-center gap-3 px-3 py-2.5 text-xs">
              <Chip>{c.kind}</Chip>
              <StatusBadge tone={stateTone(c.state)}>{c.state}</StatusBadge>
              <div className="min-w-0 flex-1">
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
              <Button
                variant="danger"
                icon={<Trash2 size={12} />}
                onClick={() => onRemove(c.container)}
                disabled={busy}
                className="px-2 py-1"
              >
                Remove
              </Button>
            </div>
          ))}
        </RowGroup>
      )}
    </div>
  );
}
