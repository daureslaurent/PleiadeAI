import axios from 'axios';
import { useAuth } from '../store/auth';

/**
 * Base for API/asset URLs. Empty VITE_API_URL → same-origin relative (e.g. `/api`), which is how the
 * app runs behind the Caddy edge. The `|| ''` guards against an unset var becoming the string
 * "undefined" in a template literal.
 */
export const API_BASE = import.meta.env.VITE_API_URL || '';

/** REST client. The JWT is injected on every request from localStorage. */
export const api = axios.create({
  baseURL: `${API_BASE}/api`,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('pleiades_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * Any 401 means the current token is no longer accepted (expired, or the backend secret rotated).
 * Drop it and reset auth so the AuthGuard login window is shown instead of a stranded workspace.
 * The `/auth/login` call itself is exempt — a wrong password there is a form error, not a session
 * expiry, and must surface to the login form.
 */
api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status;
    const url: string = error?.config?.url ?? '';
    if (status === 401 && !url.includes('/auth/login')) {
      useAuth.getState().logout();
    }
    return Promise.reject(error);
  },
);

export async function login(username: string, password: string): Promise<string> {
  const { data } = await api.post<{ token: string }>('/auth/login', { username, password });
  return data.token;
}

/** Build lifecycle of a Docker image (mirrors backend `image.model` / `buildManager`). */
export type ImageStatus = 'none' | 'queued' | 'building' | 'built' | 'error';

/** One build-arg pair forwarded to `docker build --build-arg`. */
export interface BuildArg {
  key: string;
  value: string;
}

/** A live build-job snapshot from the in-process build queue (GET /images/builds). */
export interface BuildJob {
  image_id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  queued_at: number;
  started_at?: number;
  ended_at?: number;
  error?: string;
}

/** A first-class Docker image entity (mirrors backend `image.model`). */
export interface Image {
  _id: string;
  name: string;
  description: string;
  dockerfile: string;
  build_args: BuildArg[];
  no_cache: boolean;
  pull: boolean;
  /** `docker build` timeout override in ms; null → server default (AGENT_BUILD_TIMEOUT_MS). */
  build_timeout_ms: number | null;
  /**
   * Visual-desktop image: its Dockerfile carries the visual layer (Xvfb + x11vnc + xdotool/scrot/
   * pyautogui). Agents on a profile that references it are auto-granted the visual_* tools.
   */
  visual: boolean;
  /** Visual desktop resolution (Xvfb/VNC screen); null → the boot default (1280×800). */
  visual_width: number | null;
  visual_height: number | null;
  /** Stored click calibration for this visual image's desktop (null until measured). */
  visual_calibration: VisualCalibration | null;
  image_status: ImageStatus;
  image_built_at: string | null;
  last_build_error: string | null;
  image_size: number | null;
  /** Live build-job state annotated on the list endpoint (null if none this process). */
  build_job?: BuildJob | null;
}

/** Per-axis affine click calibration measured for a (visual image + vision model) pair. */
export interface VisualCalibration {
  vision_model: string;
  width: number;
  height: number;
  ax: number;
  bx: number;
  ay: number;
  by: number;
  samples: number;
  /** Mean absolute pixel error before / after the correction — how much it helped. */
  error_before: number;
  error_after: number;
  measured_at: string;
}

export type NewImage = Pick<Image, 'name' | 'description' | 'dockerfile'> &
  Partial<
    Pick<Image, 'build_args' | 'no_cache' | 'pull' | 'build_timeout_ms' | 'visual' | 'visual_width' | 'visual_height'>
  >;
export type ImagePatch = Partial<NewImage>;

/** Live status for an image (GET /images/:id/status). */
export interface ImageStatusDetail {
  image_status: ImageStatus;
  image_exists: boolean;
  image_size: number | null;
  image_built_at: string | null;
  last_build_error: string | null;
  build_active: boolean;
  warnings: string[];
  referenced_by: Array<{ _id: string; name: string }>;
}

/** A shared Docker isolation profile (mirrors backend `isolation.model`). */
/** Outbound SSH client key algorithm the profile's generator can produce. */
export type SshKeyType = 'ed25519' | 'rsa';

export interface Isolation {
  _id: string;
  name: string;
  description: string;
  /** The image entity this profile runs (see `images`); null until one is picked. */
  image_id: string | null;
  cpus: string;
  memory: string;
  network: 'host' | 'bridge' | 'none' | 'vpn' | 'ssh';
  idle_timeout_ms: number;
  /** Public key + known_hosts are returned as-is (not secret); the private key never is. */
  ssh_public_key: string;
  ssh_known_hosts: string;
  /** Algorithm of the stored key ('' = legacy/unknown → treated as ed25519). */
  ssh_key_type: SshKeyType | '';
  // Remote execution target, used when `network === 'ssh'`: the agent's bash, file tools and skills
  // all run on this host over SSH (the agent never sees the hop). Not secret — the credential is the
  // SSH key above.
  ssh_remote_host: string;
  ssh_remote_port: number;
  ssh_remote_user: string;
  // VPN (gluetun / WireGuard) config, used when `network === 'vpn'`, is supplied as an uploaded
  // WireGuard `.conf` (write-only, see IsolationPatch). It is secret and never returned.
}

/** One host key returned by a `ssh-keyscan` of the remote, for the operator to review and pin. */
export interface ScannedHostKey {
  line: string;
  type: string;
  fingerprint: string;
}

export type NewIsolation = Pick<
  Isolation,
  | 'name'
  | 'description'
  | 'image_id'
  | 'cpus'
  | 'memory'
  | 'network'
  | 'idle_timeout_ms'
  | 'ssh_public_key'
  | 'ssh_known_hosts'
  | 'ssh_remote_host'
  | 'ssh_remote_port'
  | 'ssh_remote_user'
> & {
  /** WireGuard `.conf` contents to upload at create time (write-only). */
  vpn_conf?: string;
  /** Remote sudo password to set at create time (write-only). */
  sudo_password?: string;
};

/** Update payload: profile fields plus the write-only secrets (omit to keep, '' to clear). */
export type IsolationPatch = Partial<NewIsolation> & {
  ssh_private_key?: string;
  /** WireGuard `.conf` contents (write-only): non-empty replaces, '' clears, omit keeps. */
  vpn_conf?: string;
  /** Remote sudo password (write-only): non-empty replaces, '' clears, omit keeps. */
  sudo_password?: string;
};

/** One running instance (container) of an isolation profile — one per assigned agent. */
export interface IsolationInstance {
  agent_id: string;
  agent_name: string;
  container: string;
  /** docker state: running / exited / created / … or 'absent' when no container exists yet. */
  state: string;
  volume_mode: 'individual' | 'shared';
  volume: string;
}

/** A workspace volume owned by an isolation profile (its shared volume or an agent's individual one). */
export interface IsolationVolume {
  name: string;
  scope: 'shared' | 'individual';
  agent_id?: string;
  agent_name?: string;
  exists: boolean;
  created_at: string | null;
  mountpoint: string | null;
  in_use: boolean;
  used_by: Array<{ container: string; state: string; running: boolean }>;
}

/** Live status for an isolation profile (GET /isolations/:id/status). */
export interface IsolationStatus {
  /** The referenced image (null if none picked) and its build status. */
  image_id: string | null;
  image_name: string | null;
  image_status: ImageStatus | null;
  shared_volume_exists: boolean;
  assigned_agents: Array<{ _id: string; name: string }>;
  instances: IsolationInstance[];
  volumes: IsolationVolume[];
  ssh_key_set: boolean;
  /** Whether a WireGuard `.conf` is stored, and the gluetun container's docker state. */
  vpn_conf_set: boolean;
  vpn_state: string;
  /** Whether a remote sudo password is stored for this profile. */
  sudo_password_set: boolean;
}

/**
 * One pleiades-managed docker container across all profiles (GET /isolations/containers).
 * `orphan` means it no longer maps to live config (agent/profile deleted or unassigned).
 */
export interface ManagedContainer {
  kind: 'agent' | 'gluetun';
  container: string;
  /** docker state: running / exited / created / … */
  state: string;
  agent_id?: string;
  agent_name?: string;
  isolation_id?: string;
  isolation_name?: string;
  orphan: boolean;
  reason?: string;
}

/** One entry in a container directory listing (GET /agents/:id/container/files). */
export interface ContainerFile {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  /** Modification time, epoch seconds. */
  mtime: number;
}

/** Live resource usage (GET /agents/:id/container/stats). Strings mirror `docker stats` output. */
export interface ContainerStats {
  cpu_perc: string | null;
  mem_usage: string | null;
  mem_perc: string | null;
  net_io: string | null;
  block_io: string | null;
  pids: string | null;
  /** `/workspace` footprint in bytes (`du -sb`). */
  workspace_bytes: number;
}

/** Inline file preview (GET /agents/:id/container/file). */
export interface ContainerFilePreview {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
}

/** Per-agent container status (GET /agents/:id/container). */
export interface AgentContainerStatus {
  isolation_id: string | null;
  isolation_name: string | null;
  image_status: ImageStatus | null;
  volume_mode: 'individual' | 'shared';
  container_state: string;
  individual_volume_exists: boolean;
}

export interface Agent {
  _id: string;
  name: string;
  /** Short summary shown in the agent directory (`annuaire` tool) to guide delegation. */
  description: string;
  /**
   * Role flag. `true` — a subagent: listed in the `annuaire` and delegatable via `ask_agent`.
   * `false` — a top-level orchestrator: hidden from the `annuaire`, auto-granted the delegation
   * tools, and prompted to consult the directory and delegate to subagents.
   */
  subagent: boolean;
  system_prompt: string;
  tools_allowed: string[];
  qdrant_namespace: string;
  parameters: Record<string, string>;
  /** The agent's AGENTS.md charter: operator-authored standing instructions. Agents cannot edit it. */
  agents_md: string;
  /** The agent's own Markdown notebook — it writes this via `update_notebook`; the operator may correct it. */
  notebook: string;
  /** Assigned isolation profile (null = runs on the backend). */
  isolation_id: string | null;
  /**
   * Computed by the list endpoint: true when the assigned isolation profile references a `visual`
   * image, so the workspace can gate the Desktop panel button. Absent on other agent responses.
   */
  visual?: boolean;
  /** Workspace volume scope under the assigned isolation. */
  isolation_volume_mode: 'individual' | 'shared';
  /** Assigned inference endpoint (null = the fleet default endpoint). */
  endpoint_id: string | null;
  /** Chosen model on that endpoint ('' = endpoint's first model, then the global default). */
  model: string;
  /** Max tool round-trips per turn before the run is cut off (`null` = global default). */
  max_tool_iterations: number | null;
  /** Operator-chosen identity hue (HSL, 0–360). `null` = unset → deterministic name-hash color. */
  color: number | null;
  /** Operator-chosen lucide icon key (see `agentIcons`). `''` = unset → initial letter. */
  icon: string;
  /** Linked mailbox ids this agent may read via `list_mail`/`read_mail` (Settings → Connections). */
  mail_accounts: string[];
}

export interface Skill {
  _id: string;
  name: string;
  description: string;
  language: 'ts' | 'py';
  source: string;
  enabled: boolean;
  disabled_reason: string | null;
  parameters_schema?: unknown;
}

export interface Notification {
  _id: string;
  /** Owning agent, or null for system-level notifications (e.g. a fine-tune finishing). */
  agent_id: string | null;
  title: string;
  content: string;
  status: 'unread' | 'read';
  created_at: string;
}

/** A new agent's notebook always starts empty — the agent writes it itself via `update_notebook`. */
export type NewAgent = Omit<Agent, '_id' | 'notebook'>;

export const agentsApi = {
  list: () => api.get<Agent[]>('/agents').then((r) => r.data),
  create: (body: NewAgent) => api.post<Agent>('/agents', body).then((r) => r.data),
  update: (
    id: string,
    patch: Partial<
      Pick<
        Agent,
        | 'name'
        | 'description'
        | 'subagent'
        | 'system_prompt'
        | 'tools_allowed'
        | 'isolation_id'
        | 'isolation_volume_mode'
        | 'endpoint_id'
        | 'model'
        | 'max_tool_iterations'
        | 'color'
        | 'icon'
        | 'mail_accounts'
      >
    >,
  ) =>
    api.patch<Agent>(`/agents/${id}`, patch).then((r) => r.data),
  suggestIdentity: (name: string, description: string) =>
    api
      .post<{ color: number; icon: string }>('/agents/suggest-identity', { name, description })
      .then((r) => r.data),
  container: (id: string) =>
    api.get<AgentContainerStatus>(`/agents/${id}/container`).then((r) => r.data),
  startContainer: (id: string) => api.post(`/agents/${id}/container/start`).then((r) => r.data),
  stopContainer: (id: string) => api.post(`/agents/${id}/container/stop`).then((r) => r.data),
  deleteVolume: (id: string) => api.delete(`/agents/${id}/container/volume`).then((r) => r.data),
  containerStats: (id: string) =>
    api.get<ContainerStats>(`/agents/${id}/container/stats`).then((r) => r.data),
  listFiles: (id: string, path: string) =>
    api
      .get<{ path: string; entries: ContainerFile[] }>(`/agents/${id}/container/files`, { params: { path } })
      .then((r) => r.data),
  readFile: (id: string, path: string) =>
    api
      .get<ContainerFilePreview>(`/agents/${id}/container/file`, { params: { path } })
      .then((r) => r.data),
  deleteFile: (id: string, path: string) =>
    api.delete(`/agents/${id}/container/files`, { params: { path } }).then((r) => r.data),
  uploadFile: (id: string, path: string, file: File) => {
    const token = localStorage.getItem('pleiades_token');
    return fetch(
      `${API_BASE}/api/agents/${id}/container/files?path=${encodeURIComponent(path)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: file,
      },
    ).then((res) => {
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
    });
  },
  /** Fetch a file as a blob and trigger a browser download. */
  async downloadFile(id: string, path: string): Promise<void> {
    const token = localStorage.getItem('pleiades_token');
    const res = await fetch(
      `${API_BASE}/api/agents/${id}/container/download?path=${encodeURIComponent(path)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
    );
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  setAgentsMd: (id: string, content: string) =>
    api.put<Agent>(`/agents/${id}/agents-md`, { content }).then((r) => r.data),
  setNotebook: (id: string, content: string) =>
    api.put<Agent>(`/agents/${id}/notebook`, { content }).then((r) => r.data),
  remove: (id: string) => api.delete(`/agents/${id}`).then((r) => r.data),
  setParam: (id: string, key: string, value: string) =>
    api.put<Agent>(`/agents/${id}/parameters/${encodeURIComponent(key)}`, { value }).then((r) => r.data),
  removeParam: (id: string, key: string) =>
    api.delete<Agent>(`/agents/${id}/parameters/${encodeURIComponent(key)}`).then((r) => r.data),
};

/** Handshake for the live visual desktop: boots the VNC stack and returns the noVNC credentials. */
export interface VisualSession {
  /** VNC password to hand the noVNC client. */
  password: string;
  /** Backend path to open the raw-binary WebSocket relay at (append `?token=`). */
  ws_path: string;
}

export const visualApi = {
  /** POST the visual-session handshake for an agent; `409 not_ready` if the image lacks the layer. */
  session: (id: string) =>
    api.post<VisualSession>(`/agents/${id}/container/visual/session`).then((r) => r.data),
  /** Signal that a human has taken (`true`) or released (`false`) manual control, pausing `visual_act`. */
  control: (id: string, human: boolean) =>
    api.post(`/agents/${id}/container/visual/control`, { human }).then((r) => r.data),
  /** Measure + store click calibration for this agent's desktop (long-running; several vision calls). */
  calibrate: (id: string) =>
    api
      .post<{ calibration: VisualCalibration }>(`/agents/${id}/container/visual/calibrate`)
      .then((r) => r.data.calibration),
  /** Build the `ws(s)://…` relay URL (with JWT) the noVNC RFB client connects to. */
  wsUrl: (wsPath: string): string => {
    const token = localStorage.getItem('pleiades_token') ?? '';
    const base = API_BASE
      ? API_BASE.replace(/^http/, 'ws')
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    return `${base}${wsPath}?token=${encodeURIComponent(token)}`;
  },
};

/** Callbacks for the streamed image build (Server-Sent Events over fetch). */
export interface BuildHandlers {
  onLog?: (chunk: string) => void;
  onDone?: (size: number | null) => void;
  onError?: (message: string) => void;
}

/**
 * Consume a server SSE stream (`fetch`, so we can read the body incrementally), dispatching
 * `log`/`done`/`error` frames to the handlers. Resolves when the stream closes. Shared by the
 * image build-log reattach flow.
 */
async function consumeBuildStream(url: string, handlers: BuildHandlers): Promise<void> {
  const token = localStorage.getItem('pleiades_token');
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.body) throw new Error('no response stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; parse complete frames, keep the remainder.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === 'log') handlers.onLog?.(parsed);
      else if (event === 'done') handlers.onDone?.(parsed.size ?? null);
      else if (event === 'error') handlers.onError?.(parsed.message);
    }
  }
}

export const imagesApi = {
  list: () => api.get<Image[]>('/images').then((r) => r.data),
  get: (id: string) => api.get<Image>(`/images/${id}`).then((r) => r.data),
  status: (id: string) => api.get<ImageStatusDetail>(`/images/${id}/status`).then((r) => r.data),
  builds: () => api.get<BuildJob[]>('/images/builds').then((r) => r.data),
  create: (body: NewImage) => api.post<Image>('/images', body).then((r) => r.data),
  update: (id: string, patch: ImagePatch) =>
    api.patch<Image>(`/images/${id}`, patch).then((r) => r.data),
  remove: (id: string) => api.delete(`/images/${id}`).then((r) => r.data),

  /** Enqueue a background build (returns immediately; attach to `streamLogs` to watch). */
  enqueueBuild: (id: string) => api.post(`/images/${id}/build`).then((r) => r.data),

  /** Clear this image's stored visual click calibration. */
  clearCalibration: (id: string) => api.delete(`/images/${id}/calibration`).then((r) => r.data),

  /**
   * Attach to an image's build-log SSE stream. Reattaches to an in-flight or just-finished build
   * (the server replays the buffered log first). Resolves when the stream closes.
   */
  streamLogs: (id: string, handlers: BuildHandlers) =>
    consumeBuildStream(`${API_BASE}/api/images/${id}/build/logs`, handlers),
};

export const isolationsApi = {
  list: () => api.get<Isolation[]>('/isolations').then((r) => r.data),
  get: (id: string) => api.get<Isolation>(`/isolations/${id}`).then((r) => r.data),
  status: (id: string) => api.get<IsolationStatus>(`/isolations/${id}/status`).then((r) => r.data),
  create: (body: NewIsolation) => api.post<Isolation>('/isolations', body).then((r) => r.data),
  update: (id: string, patch: IsolationPatch) =>
    api.patch<Isolation>(`/isolations/${id}`, patch).then((r) => r.data),
  /**
   * Generate a fresh outbound SSH keypair server-side. The private key is stored encrypted and
   * injected into containers — only the public key (an `authorized_keys` line) is returned.
   */
  generateSsh: (id: string, type: SshKeyType) =>
    api
      .post<{ ssh_public_key: string; ssh_key_type: SshKeyType }>(`/isolations/${id}/ssh/generate`, {
        type,
      })
      .then((r) => r.data),
  /**
   * Fetch the remote's SSH host keys + fingerprints (`ssh` network mode). Nothing is pinned here —
   * the operator reviews the fingerprint and saves it via `update({ ssh_known_hosts })`.
   */
  scanHostKey: (id: string, host?: string, port?: number) =>
    api
      .post<{ keys: ScannedHostKey[] }>(`/isolations/${id}/ssh/scan-host`, { host, port })
      .then((r) => r.data.keys),
  /** End-to-end check of the `ssh`-mode hop: connect with this profile's key and run a command. */
  testSsh: (id: string) =>
    api
      .post<{ ok: boolean; detail: string }>(`/isolations/${id}/ssh/test`, {})
      .then((r) => r.data),
  remove: (id: string) => api.delete(`/isolations/${id}`).then((r) => r.data),

  /** Every pleiades-managed container across all profiles, with orphan classification. */
  listContainers: () =>
    api.get<ManagedContainer[]>('/isolations/containers').then((r) => r.data),
  /** Remove one managed container by name (agent containers clear their idle timer too). */
  removeContainer: (name: string) =>
    api.delete(`/isolations/containers/${encodeURIComponent(name)}`).then((r) => r.data),

  /**
   * Delete one of a profile's workspace volumes. `force` first tears down any container mounting it
   * (recreated on the agent's next run); without force an in-use volume rejects with 409.
   */
  deleteVolume: (id: string, name: string, force = false) =>
    api
      .delete(`/isolations/${id}/volumes/${encodeURIComponent(name)}`, {
        params: force ? { force: 1 } : undefined,
      })
      .then((r) => r.data),
};

export interface Session {
  _id: string;
  agent_id: string;
  agent_name: string;
  title: string;
  /** `synthetic` → produced by the Conversation Generator, not a chat the operator had. */
  origin?: 'user' | 'synthetic';
  created_at: string;
  updated_at: string;
}

/** Persisted turn as stored by the backend (mirror of message.model). */
export interface StoredMessage {
  _id: string;
  session_id: string;
  role: 'user' | 'assistant';
  text: string;
  /** User only: data-URL images attached to the message. */
  images?: string[];
  blocks?: unknown[];
  reasoning?: string;
  trace?: unknown[];
  /** Assistant only: memories auto-recalled into the top-level run's prompt for this turn. */
  memories?: unknown[];
  /** Assistant only: session context size (prompt tokens) recorded for this turn. */
  context_tokens?: number;
  /** Assistant only: model context window at the time of this turn. */
  context_window?: number;
  /** Assistant only: the turn id grouping this turn's llama calls (parent + sub-agent runs). */
  turn_id?: string;
  /** Assistant only: the depth-0 agent-run id, so the top-level turn's quality score links. */
  run_id?: string;
  created_at: string;
}

export interface NewMessage {
  role: 'user' | 'assistant';
  text?: string;
  images?: string[];
  blocks?: unknown[];
  reasoning?: string;
  trace?: unknown[];
  memories?: unknown[];
  context_tokens?: number;
  context_window?: number;
  turn_id?: string;
  run_id?: string;
}

export const sessionsApi = {
  /**
   * Sessions for one agent. `origin` defaults to `all` — the Workspace shows generated conversations
   * alongside the operator's own, marked as such (the Conversation Generator is meant to be read).
   */
  listByAgent: (agentId: string, origin: 'user' | 'synthetic' | 'all' = 'all') =>
    api.get<Session[]>('/sessions', { params: { agentId, origin } }).then((r) => r.data),
  create: (agentId: string) => api.post<Session>('/sessions', { agentId }).then((r) => r.data),
  rename: (id: string, title: string) =>
    api.patch<Session>(`/sessions/${id}`, { title }).then((r) => r.data),
  remove: (id: string) => api.delete(`/sessions/${id}`).then((r) => r.data),
  messages: (id: string) => api.get<StoredMessage[]>(`/sessions/${id}/messages`).then((r) => r.data),
  addMessage: (id: string, body: NewMessage) =>
    api.post<StoredMessage>(`/sessions/${id}/messages`, body).then((r) => r.data),
};

/** A persisted session resource (image or binary blob) shown in the workspace Data tab. */
export interface SessionResource {
  handle: string;
  kind: 'image' | 'blob';
  mime: string;
  size: number;
  filename?: string;
  source: 'attachment' | 'tool' | 'fetch';
  agentId: string;
  createdAt: string;
}

async function fetchResourceBlob(sessionId: string, handle: string): Promise<Blob> {
  const token = localStorage.getItem('pleiades_token');
  const res = await fetch(
    `${API_BASE}/api/resources/${encodeURIComponent(sessionId)}/${encodeURIComponent(handle)}/content`,
    { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
  );
  if (!res.ok) throw new Error(`resource fetch failed (${res.status})`);
  return res.blob();
}

export const resourcesApi = {
  list: (sessionId: string) =>
    api.get<SessionResource[]>('/resources', { params: { sessionId } }).then((r) => r.data),
  /** Fetch a resource's bytes as an object URL (for image thumbnails). Caller revokes it. */
  async objectUrl(sessionId: string, handle: string): Promise<string> {
    return URL.createObjectURL(await fetchResourceBlob(sessionId, handle));
  },
  /** Fetch + trigger a browser download of a resource (blobs). */
  async download(sessionId: string, handle: string, filename?: string): Promise<void> {
    const blob = await fetchResourceBlob(sessionId, handle);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || handle;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

export type NewSkill = Omit<Skill, '_id' | 'disabled_reason'> & {
  parameters_schema?: unknown;
};

export const skillsApi = {
  list: () => api.get<Skill[]>('/skills').then((r) => r.data),
  create: (body: NewSkill) => api.post<Skill>('/skills', body).then((r) => r.data),
  save: (id: string, patch: Partial<Skill> & { parameters_schema?: unknown }) =>
    api.patch<Skill>(`/skills/${id}`, patch).then((r) => r.data),
  enable: (id: string) => api.post(`/skills/${id}/enable`).then((r) => r.data),
  remove: (id: string) => api.delete(`/skills/${id}`).then((r) => r.data),
};

/** Core tools always available to every agent (mirrors backend tools/registry.ts). */
export interface ToolConfigField {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'select';
  options?: string[];
  hint?: string;
  default: string | number | boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  configSchema: ToolConfigField[];
  config: Record<string, string | number | boolean>;
  enabled: boolean;
}

export const toolsApi = {
  list: () => api.get<ToolInfo[]>('/tools').then((r) => r.data),
  update: (name: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) =>
    api.put<ToolInfo>(`/tools/${encodeURIComponent(name)}`, patch).then((r) => r.data),
};

export const memoryApi = {
  list: (agentId: string) =>
    api.get<Array<{ id: string | number; payload: Record<string, unknown> }>>(`/memory/${agentId}`).then((r) => r.data),
  remove: (agentId: string, ids: Array<string | number>) =>
    api.delete(`/memory/${agentId}/points`, { data: { ids } }).then((r) => r.data),
  /** Wipe the agent's entire namespace server-side (the listing is paged — see the route). */
  clear: (agentId: string) =>
    api.delete<{ ok: boolean; deleted: number }>(`/memory/${agentId}/all`).then((r) => r.data),
};

export const inboxApi = {
  list: (unreadOnly = false) =>
    api
      .get<Notification[]>('/inbox', { params: unreadOnly ? { unread: 'true' } : {} })
      .then((r) => r.data),
  unreadCount: () =>
    api.get<{ count: number }>('/inbox/unread-count').then((r) => r.data.count),
  markRead: (id: string) => api.post(`/inbox/${id}/read`).then((r) => r.data),
  readAll: () => api.post<{ updated: number }>('/inbox/read-all').then((r) => r.data),
  remove: (id: string) => api.delete(`/inbox/${id}`).then((r) => r.data),
  /** Bulk-delete every already-read notification. */
  clearRead: () => api.post<{ deleted: number }>('/inbox/clear-read').then((r) => r.data),
};

/**
 * One Conversation Generator row: an interviewer agent that periodically chats up `target_agent` to
 * harvest multi-turn conversations for training (see `docs/conversation-generator.md`).
 */
export interface ConversationGenerator {
  _id: string;
  target_agent_id: string;
  target_agent_name: string;
  interviewer_agent_id: string;
  enabled: boolean;
  interval_minutes: number;
  /** Question→answer exchanges per generated conversation. */
  turns: number;
  /** Subjects to steer the interviewer; one is drawn per conversation. Empty → it picks its own. */
  topics: string[];
  last_run_at: string | null;
  last_error: string;
  conversations_count: number;
  created_at: string;
  updated_at: string;
}

export type ConversationGeneratorInput = Partial<{
  target_agent_id: string;
  interviewer_agent_id: string;
  enabled: boolean;
  interval_minutes: number;
  turns: number;
  topics: string[];
}>;

export const conversationGenApi = {
  list: () => api.get<ConversationGenerator[]>('/conversation-gen').then((r) => r.data),
  create: (input: ConversationGeneratorInput) =>
    api.post<ConversationGenerator>('/conversation-gen', input).then((r) => r.data),
  update: (id: string, patch: ConversationGeneratorInput) =>
    api.patch<ConversationGenerator>(`/conversation-gen/${id}`, patch).then((r) => r.data),
  remove: (id: string) => api.delete(`/conversation-gen/${id}`).then((r) => r.data),
  /** Kick one conversation off-schedule. Returns as soon as it starts — poll `list` for the outcome. */
  runNow: (id: string) =>
    api.post<{ started: boolean }>(`/conversation-gen/${id}/run-now`).then((r) => r.data),
  /** The generated sessions, newest first (all generators when `generatorId` is omitted). */
  sessions: (generatorId?: string, limit = 50) =>
    api
      .get<{ sessions: Session[]; total: number }>('/conversation-gen/sessions', {
        params: { generatorId, limit },
      })
      .then((r) => r.data),
};

export interface AutonomyJob {
  id: string;
  data: {
    agentName: string;
    prompt: string;
    alert?: boolean;
    /** Set when an agent created the schedule itself via the `schedule_task` tool. */
    ownerAgent?: string;
  };
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** The 5-field cron expression (recurring: live schedule; one-shot: informational). */
  cron: string | null;
  once: boolean;
  /** IANA timezone the cron is evaluated in (server SCHEDULE_TZ). */
  timezone: string;
  /** True while an Agenda worker is executing this job right now (liveness signal). */
  running: boolean;
}

/** Cron helper reply: validity + the next occurrences in the server's SCHEDULE_TZ. */
export interface CronPreview {
  valid: boolean;
  error: string | null;
  next: string[];
  timezone: string;
}

/** Fields the create/edit form submits. Cron-only: `once` runs a single time at the next match. */
export interface AutonomyJobInput {
  agentName: string;
  prompt: string;
  cron: string;
  once: boolean;
  alert?: boolean;
}

/** One historical execution of a schedule. `output` is full markdown (or the error message). */
export interface AutonomyRunResult {
  id: string;
  status: 'success' | 'error';
  output: string;
  prompt: string;
  startedAt: string;
  finishedAt: string;
}

export const autonomyApi = {
  jobs: () => api.get<AutonomyJob[]>('/autonomy/jobs').then((r) => r.data),
  create: (input: AutonomyJobInput) =>
    api.post<{ id: string }>('/autonomy/jobs', input).then((r) => r.data),
  update: (id: string, input: AutonomyJobInput) =>
    api.put<{ id: string }>(`/autonomy/jobs/${id}`, input).then((r) => r.data),
  remove: (id: string) => api.delete(`/autonomy/jobs/${id}`).then((r) => r.data),
  run: (id: string) => api.post(`/autonomy/jobs/${id}/run`).then((r) => r.data),
  results: (id: string) =>
    api.get<AutonomyRunResult[]>(`/autonomy/jobs/${id}/results`).then((r) => r.data),
  kill: () => api.post('/autonomy/kill').then((r) => r.data),
  cronPreview: (expr: string) =>
    api.get<CronPreview>('/autonomy/cron/preview', { params: { expr } }).then((r) => r.data),
};

/** Effective Telegram state for the Autonomy page (config itself lives in settings). */
export interface TelegramStatus {
  configured: boolean;
  /** Live bot identity (getMe). null with `configured` ⇒ invalid token / Telegram outage. */
  bot: { id: number; username: string | null } | null;
  targets: string[];
  /** Whether the interactive long-poll bot is enabled (TELEGRAM_POLLING env). */
  polling: boolean;
  running: boolean;
}

export const telegramApi = {
  status: () => api.get<TelegramStatus>('/telegram/status').then((r) => r.data),
  test: (message?: string) =>
    api.post<{ ok: boolean; targets: string[] }>('/telegram/test', { message }).then((r) => r.data),
};

export interface InferenceSettings {
  llama_url: string;
  llama_model: string;
  llama_api_key: string;
  max_tokens: number;
  context_window: number;
  /** Fleet default: auto-detect the context-meter max from each server's real n_ctx (else manual). */
  context_window_auto: boolean;
  temperature: number;
  top_p: number;
  embedding_url: string;
  embedding_model: string;
  embedding_api_key: string;
  /** '' → generate session titles with the responding agent's own model; else a specific endpoint id. */
  title_endpoint_id: string;
  /** Model on `title_endpoint_id` for titles ('' → that endpoint's default). Ignored when the id is ''. */
  title_model: string;
  /** Token budget for the title call — big enough to fit a reasoning model's `<think>` block + title. */
  title_max_tokens: number;
  /** Vision analysis endpoint for the visual tools ('' → vision analysis unavailable). */
  vision_endpoint_id: string;
  /** Model on `vision_endpoint_id` for screenshot analysis ('' → that endpoint's default). */
  vision_model: string;
  /** Vision sampling params. `null` = disabled (not sent to the model → server default). */
  vision_temperature: number | null;
  vision_top_p: number | null;
  vision_max_tokens: number | null;
  vision_frequency_penalty: number | null;
  vision_presence_penalty: number | null;
  /** Image generation endpoint for `generate_image` ('' → the tool reports it's unconfigured). */
  image_endpoint_id: string;
  /** Model on `image_endpoint_id` for generation ('' → that endpoint's default). */
  image_model: string;
  /** Host self-update master switch — gates the "Update app" action + the periodic check. */
  update_enabled: boolean;
  /** How often the backend triggers a read-only host update check (git fetch + compare). */
  update_check_interval_hours: number;
  /** Conversation Quality Scorer: auto-score each turn on completion. */
  scoring_enabled: boolean;
  /** Judge endpoint ('' → reuse the responding agent's own endpoint). */
  scoring_endpoint_id: string;
  /** Model on `scoring_endpoint_id` for judging ('' → that endpoint's default). */
  scoring_model: string;
  /** Token budget for the judge reply. */
  scoring_max_tokens: number;
  /** Fleet default per-turn tool-round ceiling; an agent's own `max_tool_iterations` overrides it. */
  max_tool_iterations: number;
  /** Ceiling on `ask_agent` delegation depth (depth 0 = the directly-addressed agent). Clamped 1–10. */
  max_agent_hops: number;
  /** Fleet-wide AGENTS.md house rules, injected read-only into every agent's prompt ('' → omitted). */
  agents_md: string;
  /**
   * Post-turn memory distillation: the agent's own model rewrites a finished turn into 0..N
   * standalone memories, instead of the raw transcript being embedded verbatim. Off → an agent only
   * remembers what it deliberately saves with `remember`.
   */
  memory_distill_enabled: boolean;
  /** Token budget for the distillation reply (a small JSON object). */
  memory_max_tokens: number;
  /** How this instance is reached from a browser — the base of the Gmail OAuth redirect URI. */
  public_base_url: string;
  /** Google Cloud OAuth client for linking Gmail mailboxes ('' → mail linking unconfigured). */
  google_client_id: string;
  google_client_secret: string;
  /** Telegram bot token for alerts + the interactive bot ('' → TELEGRAM_BOT_TOKEN env fallback). */
  telegram_bot_token: string;
  /** Comma list of chat ids that receive alerts / may talk to the bot ('' → env fallback). */
  telegram_chat_ids: string;
  /** How often the backend polls every monitored machine, seconds (floor 5). */
  monitor_poll_seconds: number;
  /** History samples kept per machine in RAM (clamped 60…100000 by the poller). 720 ≈ 2h at a 10s poll. */
  monitor_history_samples: number;
  /** Whether breached monitor thresholds fan out to the inbox + Telegram (the dashboard tints regardless). */
  monitor_alerts_enabled: boolean;
  /** Fleet-wide monitor thresholds: °C for temps, percent for the rest. warn = amber, critical = red. */
  monitor_cpu_temp_warn: number;
  monitor_cpu_temp_critical: number;
  monitor_gpu_temp_warn: number;
  monitor_gpu_temp_critical: number;
  monitor_memory_warn: number;
  monitor_memory_critical: number;
  monitor_vram_warn: number;
  monitor_vram_critical: number;
  monitor_disk_warn: number;
  monitor_disk_critical: number;
  /** Minutes before the same breach on the same machine may alert again. */
  monitor_alert_cooldown_minutes: number;
}

export const settingsApi = {
  get: () => api.get<InferenceSettings>('/settings').then((r) => r.data),
  update: (patch: Partial<InferenceSettings>) =>
    api.put<InferenceSettings>('/settings', patch).then((r) => r.data),
};

/** One commit that the tracked branch is ahead of the deployed checkout. */
export interface UpdateCommit {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  subject: string;
  body: string;
}

/** Host-side `git fetch` comparison, written by check_run.sh and read back by the backend. */
export interface UpdateStatus {
  checkedAt: string;
  currentSha: string;
  currentShortSha: string;
  remoteSha: string;
  remoteShortSha: string;
  branch: string;
  behindBy: number;
  currentVersion: string;
  remoteVersion: string;
  commits: UpdateCommit[];
  error?: string;
}

/** GET /host/update — feature toggle + host-bridge readiness + last known comparison. */
export interface UpdateInfo {
  enabled: boolean;
  ready: boolean;
  reason?: string;
  status: UpdateStatus | null;
  updateAvailable: boolean;
}

/** A slice of the host update log (byte-offset tailing for the "Updating…" overlay). */
export interface UpdateLogChunk {
  text: string;
  offset: number;
  size: number;
}

/** Backend build version — bumped independently of the frontend when `backend/` changes. */
export interface BackendVersion {
  version: string;
  build: number;
  date: string;
}

export const hostApi = {
  getUpdate: () => api.get<UpdateInfo>('/host/update').then((r) => r.data),
  checkUpdate: () => api.post<UpdateInfo>('/host/update/check').then((r) => r.data),
  runUpdate: () => api.post<{ ok: boolean; logOffset: number }>('/host/update').then((r) => r.data),
  updateLog: (since: number) =>
    api.get<UpdateLogChunk>('/host/update/log', { params: { since } }).then((r) => r.data),
  getVersion: () => api.get<BackendVersion>('/host/version').then((r) => r.data),
};

/** One linked Gmail mailbox (Settings → Connections). Tokens never leave the backend. */
export interface MailAccount {
  _id: string;
  email: string;
  provider: 'google';
  /** OAuth scopes granted at consent (space-separated). */
  scopes: string;
  /** `error` = the last Gmail call failed to authenticate (revoked consent…) — re-link to fix. */
  status: 'linked' | 'error';
  last_error: string;
  created_at: string;
  updated_at: string;
}

export const mailApi = {
  list: () => api.get<MailAccount[]>('/mail/accounts').then((r) => r.data),
  remove: (id: string) => api.delete(`/mail/accounts/${id}`).then((r) => r.data),
  /** Start an OAuth link flow; navigate the browser to the returned Google consent URL. */
  oauthStart: () => api.post<{ url: string }>('/mail/oauth/start').then((r) => r.data),
};

/** One OpenAI-compatible inference endpoint with its autodiscovered model list. */
export interface Endpoint {
  _id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
  models_updated_at: string | null;
  /** Model used by agents on this endpoint that don't pick one ('' → first discovered model). */
  default_model: string;
  context_window: number;
  /** How the context-meter max is chosen: follow the global default, auto-detect n_ctx, or manual. */
  context_window_mode: 'inherit' | 'auto' | 'manual';
  /** Probed real n_ctx per model id (from /props at discovery). Drives the auto-mode resolved value. */
  model_contexts?: Record<string, number>;
  is_default: boolean;
  /** Failover position: 0 = not in the fallback chain; >0 = ascending order tried when the primary fails. */
  fallback_order: number;
  /** System-managed built-in local docker fallback: read-only name/URL, cannot be deleted. */
  managed: boolean;
  /**
   * Manual vision (multimodal) marker — the fallback when nothing was auto-detected. A probed
   * `model_vision` reading always wins; resolve via `endpointVision()`, don't read this directly.
   */
  supports_vision: boolean;
  /**
   * Auto-detected vision capability per model id, probed at "Refresh models" (`--mmproj` in the
   * server's launch args / `/props` modalities). `true`/`false` are confident readings; a model
   * absent from the map is undetectable and falls back to `supports_vision`.
   */
  model_vision?: Record<string, boolean>;
}

/**
 * Whether `model` on this endpoint is vision-capable: the auto-detected reading when the probe
 * produced one, else the manual `supports_vision` flag. Omit `model` to check the endpoint's
 * effective default model. Mirrors the backend's `effectiveVision()`.
 */
export function endpointVision(e: Endpoint | undefined | null, model?: string): boolean {
  if (!e) return false;
  const m = model || e.default_model || e.models[0] || '';
  const detected = m ? e.model_vision?.[m] : undefined;
  return typeof detected === 'boolean' ? detected : Boolean(e.supports_vision);
}

/** One LLM call at an endpoint's gate: streaming now (`running`) or parked behind it (`queue`). */
export interface EndpointCall {
  /** Agent making the call (null for agent-less side tasks like the interviewer). */
  agent: string | null;
  /** Kind of call: chat-turn, title-gen, vision, judge, … */
  source: string;
  model: string;
  /** How long it has been streaming (running) / waiting (queued), in ms — computed server-side. */
  elapsed_ms: number;
}

/** Live reachability snapshot of one endpoint (from `GET /endpoints/health`), for the header badge. */
export interface EndpointHealth {
  _id: string;
  name: string;
  up: boolean;
  /** Probe round-trip in ms (null when down). */
  latency_ms: number | null;
  /** Model the server is serving right now ('' when down or none discovered). */
  model: string;
  /** The reported `model` is vision-capable (auto-detected `--mmproj`, else the manual flag). */
  vision: boolean;
  is_default: boolean;
  fallback_order: number;
  managed: boolean;
  /** Agents targeting this endpoint; agents with no explicit endpoint count on the default. */
  agents: Array<{ name: string; color: number | null }>;
  /** LLM call streaming on this endpoint right now (backend's endpoint gate), if any. */
  running: EndpointCall | null;
  /** Calls parked behind `running`, FIFO. Empty when nothing is queued. */
  queue: EndpointCall[];
}

export type NewEndpoint = Pick<Endpoint, 'name' | 'base_url' | 'api_key' | 'context_window'>;
export type EndpointPatch = Partial<
  Pick<
    Endpoint,
    | 'name'
    | 'base_url'
    | 'api_key'
    | 'context_window'
    | 'context_window_mode'
    | 'default_model'
    | 'fallback_order'
    | 'supports_vision'
  >
>;

/** Result of importing a config bundle (agents + isolations, overwrite-by-name policy). */
export interface ImportSummary {
  ok: boolean;
  isolations: { created: number; overwritten: number };
  agents: { created: number; overwritten: number };
  warnings: string[];
}

/**
 * Backup & transfer. Exports download as files (config = importable agents+isolations,
 * memory = archival Qdrant dump); import consumes a previously exported config bundle.
 */
export const transferApi = {
  exportConfig: (agentIds: string[], all: boolean) =>
    api
      .post('/transfer/export/config', { agentIds, all }, { responseType: 'blob' })
      .then((r) => r.data as Blob),
  exportMemory: (agentIds: string[], all: boolean) =>
    api
      .post('/transfer/export/memory', { agentIds, all }, { responseType: 'blob' })
      .then((r) => r.data as Blob),
  importConfig: (bundle: unknown) =>
    api.post<ImportSummary>('/transfer/import/config', bundle).then((r) => r.data),
};

/** Per-model call tally for one endpoint (from the backend's in-process gate). */
export interface LlmModelMetrics {
  model: string;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  avgDurationMs: number;
  lastCallAt: number | null;
}

/** Live call metrics for one endpoint. `active`/`queued` reflect the serial-per-endpoint gate. */
export interface LlmMetrics {
  active: number;
  queued: number;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  avgDurationMs: number;
  lastCallAt: number | null;
  lastModel: string | null;
  byModel: LlmModelMetrics[];
}

/** One endpoint joined with its live LLM metrics, as returned by `GET /llm/stats`. */
export interface LlmEndpointStats {
  _id: string;
  name: string;
  base_url: string;
  models: string[];
  default_model: string;
  is_default: boolean;
  fallback_order: number;
  managed: boolean;
  /** True for traffic to a URL with no matching endpoint doc (e.g. legacy side-task connection). */
  unregistered: boolean;
  metrics: LlmMetrics;
}

export const llmApi = {
  stats: () => api.get<LlmEndpointStats[]>('/llm/stats').then((r) => r.data),
};

/** A captured llama request/response as sent by the outgoing OpenAI-compatible body. */
export interface LlamaRequestCapture {
  model: string;
  messages: unknown[];
  tools?: unknown[] | null;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface LlamaResponseCapture {
  text: string;
  toolCalls: { id: string; name: string; argsJson: string }[];
  finishReason: string | null;
}

/** One persisted llama call, as listed on the LLM Debug page. */
export interface LlamaCallRecord {
  id: string;
  /** Turn grouping id (null for side-task calls) — groups a turn's parent + sub-agent runs. */
  turnId: string | null;
  /** Agent-run id (null for side-task calls) — links a record to its Conversation Quality score. */
  runId: string | null;
  source: 'chat-turn' | 'title-gen' | 'identity' | 'vision' | 'judge' | 'memory' | 'interview';
  endpoint: string;
  model: string;
  sessionId: string | null;
  agentId: string | null;
  agentName: string | null;
  depth: number | null;
  status: 'success' | 'error';
  request: LlamaRequestCapture;
  response: LlamaResponseCapture;
  /** Present only on the per-call detail fetch (archive). */
  rawChunks?: string[];
  tools: unknown[] | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  durationMs: number;
  firstTokenMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface LlamaLogStats {
  archive: { bytes: number; count: number };
  debug: { bytes: number; count: number };
  dbBytes: number;
}

export const llmDebugApi = {
  list: (limit: number) =>
    api.get<LlamaCallRecord[]>('/llama-logs', { params: { limit } }).then((r) => r.data),
  get: (id: string) => api.get<LlamaCallRecord>(`/llama-logs/${id}`).then((r) => r.data),
  stats: () => api.get<LlamaLogStats>('/llama-logs/stats').then((r) => r.data),
  purgeArchive: () =>
    api.delete<{ deleted: number; scoresDeleted: number }>('/llama-logs/archive').then((r) => r.data),
};

// ── Conversation Quality Scorer ────────────────────────────────────────────

export type ScoreTag = 'Perfect' | 'Patched' | 'Recovered' | 'Rejected';

export interface ConversationScore {
  /** The scored agent-run (the score's key). */
  runId: string;
  /** The user turn this run belongs to (groups parent + sub-agent runs). */
  turnId: string | null;
  /** The agent that produced this run. */
  agentName: string | null;
  /** Hop depth: 0 = user-facing agent, >0 = delegated sub-agent. */
  depth: number | null;
  sessionId: string | null;
  score: number;
  tag: ScoreTag;
  explanation: string;
  judgeModel: string;
  origin: 'auto' | 'batch' | 'manual';
  createdAt: string;
}

export interface ScoringSummary {
  total: number;
  avgScore: number;
  byTag: Record<string, number>;
}

export interface BatchScoreResult {
  total: number;
  scored: number;
  skipped: number;
  failed: number;
}

export const scoringApi = {
  summary: () => api.get<ScoringSummary>('/scoring/summary').then((r) => r.data),
  list: (opts: { sessionId?: string; tag?: string; minScore?: number; limit?: number } = {}) =>
    api.get<ConversationScore[]>('/scoring/scores', { params: opts }).then((r) => r.data),
  scoreRun: (runId: string) =>
    api.post<ConversationScore>(`/scoring/run/${runId}`).then((r) => r.data),
  scoreAll: (body: { mode: 'unscored' | 'rescore'; concurrency: number; limit?: number }) =>
    api.post<BatchScoreResult>('/scoring/score-all', body).then((r) => r.data),
  export: () => api.post<{ path: string; turns: number; bytes: number }>('/scoring/export').then((r) => r.data),
  /** Fetch the JSONL export as an authenticated blob (also writes the server-side file). */
  downloadBlob: () =>
    api.get('/scoring/export/download', { responseType: 'blob' }).then((r) => r.data as Blob),
  /**
   * Training-dataset composition for the Fine-Tuning page: total exportable examples, the quality
   * distribution of the judged subset, and how many pass the supplied filter.
   */
  datasetStats: (opts: { minScore?: number; tags?: string[] } = {}) =>
    api
      .get<DatasetStats>('/scoring/dataset-stats', {
        params: { minScore: opts.minScore, tags: opts.tags?.join(',') || undefined },
      })
      .then((r) => r.data),
};

export const endpointsApi = {
  list: () => api.get<Endpoint[]>('/endpoints').then((r) => r.data),
  health: () => api.get<EndpointHealth[]>('/endpoints/health').then((r) => r.data),
  create: (body: NewEndpoint) => api.post<Endpoint>('/endpoints', body).then((r) => r.data),
  update: (id: string, patch: EndpointPatch) =>
    api.patch<Endpoint>(`/endpoints/${id}`, patch).then((r) => r.data),
  discover: (id: string) => api.post<Endpoint>(`/endpoints/${id}/discover`).then((r) => r.data),
  setDefault: (id: string) => api.post<Endpoint>(`/endpoints/${id}/default`).then((r) => r.data),
  remove: (id: string) => api.delete(`/endpoints/${id}`).then((r) => r.data),
};

// ---------------------------------------------------------------------------
// Fine-tuning: remote training servers + tracked jobs
// ---------------------------------------------------------------------------

/** A remote fine-tune server. The bearer token never leaves the backend (`has_api_key` only). */
export interface FinetuneServer {
  _id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  has_api_key: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface NewFinetuneServer {
  name: string;
  base_url: string;
  api_key?: string;
  enabled?: boolean;
}
export type FinetuneServerPatch = Partial<NewFinetuneServer>;

export type Feasibility = 'ok' | 'tight' | 'no';
export type TrainStrategy = 'deepspeed_zero2' | 'fsdp_qlora';

/** One row of a server's per-model-size feasibility table (`GET /hardware`). */
export interface FeasibilityEntry {
  size_b: number;
  feasibility: Feasibility;
  strategy: TrainStrategy | null;
  max_sequence_len: number | null;
  note: string;
}

export interface HardwareReport {
  hardware: {
    gpus: { index: number; name: string; vram_total_mb: number; vram_free_mb: number }[];
    gpu_count: number;
    min_gpu_vram_mb: number | null;
    total_gpu_vram_mb: number;
    cpu: { model: string; cores: number };
    ram: { total_mb: number; free_mb: number };
    detected_at: string;
    note?: string;
  };
  sizes: FeasibilityEntry[];
}

/** Live utilization sample (`GET /usage`). `gpus: []` + `note` when nvidia-smi is unavailable. */
export interface UsageReport {
  gpus: {
    index: number;
    name: string;
    util_pct: number;
    vram_used_mb: number;
    vram_total_mb: number;
    temp_c: number | null;
    power_w: number | null;
  }[];
  cpu: { cores: number; load_avg: [number, number, number]; load_pct: number };
  ram: { used_mb: number; total_mb: number };
  at: string;
  note?: string;
}

/** The server's hardware-fitted plan for a run — its *recommendation*, shown before/after start. */
export interface TrainingPlan {
  size_b: number;
  size_source: string;
  strategy: TrainStrategy;
  sequence_len: number;
  micro_batch_size: number;
  gradient_accumulation_steps: number;
  feasibility: Feasibility;
  est_per_gpu_vram_gb: number;
  usable_per_gpu_vram_gb: number;
  adjustments: string[];
  warnings: string[];
}

export interface TrainMetric {
  step: number;
  loss: number;
  epoch?: number | null;
  lr?: number | null;
  at: string;
}

export type FinetuneJobStatus =
  | 'queued'
  | 'preparing'
  | 'training'
  | 'exporting'
  | 'done'
  | 'failed';

export interface FinetuneJob {
  _id: string;
  server_id: string;
  remote_job_id: string;
  run_name: string;
  base_model: string;
  size_b: number | null;
  strategy: string;
  plan: TrainingPlan | null;
  dataset_source: 'scored' | 'manual';
  dataset_stats: Record<string, unknown> | null;
  status: FinetuneJobStatus;
  progress: number;
  metrics: TrainMetric[];
  log_tail: string[];
  gguf_filename: string;
  error: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Training-data composition for the Fine-Tuning chart. */
export interface DatasetStats {
  total_examples: number;
  scored: ScoringSummary;
  filtered_count: number;
  filter: { minScore: number | null; tags: string[] | null };
}

export interface StartTrainBody {
  run_name: string;
  base_model: string;
  target_size_b?: number;
  on_infeasible?: 'auto_adjust' | 'warn_proceed';
  hyperparams?: Record<string, number | string>;
  dataset:
    | { source: 'scored'; filter?: { minScore?: number; tags?: string[] } }
    | { source: 'manual'; dataset_id: string };
}

/** `GET /health` on a remote fine-tune server. version/build absent on older servers. */
export interface FinetuneHealth {
  ok: boolean;
  version?: string;
  build?: number;
}

export const finetuneServersApi = {
  list: () => api.get<FinetuneServer[]>('/finetune-servers').then((r) => r.data),
  create: (body: NewFinetuneServer) =>
    api.post<FinetuneServer>('/finetune-servers', body).then((r) => r.data),
  update: (id: string, patch: FinetuneServerPatch) =>
    api.patch<FinetuneServer>(`/finetune-servers/${id}`, patch).then((r) => r.data),
  remove: (id: string) => api.delete(`/finetune-servers/${id}`).then((r) => r.data),

  health: (id: string) =>
    api.get<FinetuneHealth>(`/finetune-servers/${id}/health`).then((r) => r.data),
  hardware: (id: string) =>
    api.get<HardwareReport>(`/finetune-servers/${id}/hardware`).then((r) => r.data),
  usage: (id: string) => api.get<UsageReport>(`/finetune-servers/${id}/usage`).then((r) => r.data),

  /** Forward a manually-picked .jsonl to the server; returns its `dataset_id`. */
  upload: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api
      .post<{ dataset_id: string; line_count: number }>(`/finetune-servers/${id}/upload`, form)
      .then((r) => r.data);
  },

  train: (id: string, body: StartTrainBody) =>
    api
      .post<{ job_id: string; remote_job_id: string; plan: TrainingPlan }>(
        `/finetune-servers/${id}/train`,
        body,
      )
      .then((r) => r.data),
};

export const finetuneJobsApi = {
  list: (limit?: number) =>
    api.get<FinetuneJob[]>('/finetune-jobs', { params: { limit } }).then((r) => r.data),
  get: (id: string) => api.get<FinetuneJob>(`/finetune-jobs/${id}`).then((r) => r.data),
  remove: (id: string) => api.delete(`/finetune-jobs/${id}`).then((r) => r.data),
  /** Stream the produced GGUF through the backend as an authenticated blob. */
  downloadModelBlob: (id: string) =>
    api.get(`/finetune-jobs/${id}/model`, { responseType: 'blob' }).then((r) => r.data as Blob),
};

/**
 * A read-only API key (Settings → API Keys). The secret itself is never returned by the backend —
 * only `prefix`, the public handle printed in the UI. See `IssuedApiKey` for the one exception.
 */
/**
 * Write capabilities a key can be granted. A key with no scopes is read-only. Mirrors
 * `API_KEY_SCOPES` in the backend's `api-key.model.ts` — keep the two lists in step.
 */
export const API_KEY_SCOPES = [
  { scope: 'agents:write', label: 'create, edit and delete agents' },
  { scope: 'isolations:write', label: 'create and edit isolation profiles' },
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]['scope'];

export interface ApiKey {
  _id: string;
  name: string;
  prefix: string;
  /** Granted write scopes. Empty = read-only. */
  scopes: ApiKeyScope[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at?: string;
}

/** The create response, and the only time the plaintext `key` ever exists outside the client. */
export interface IssuedApiKey extends ApiKey {
  key: string;
}

export const apiKeysApi = {
  list: () => api.get<ApiKey[]>('/api-keys').then((r) => r.data),
  /** Returns the plaintext key exactly once — show it before the component unmounts. */
  create: (name: string, scopes: ApiKeyScope[] = []) =>
    api.post<IssuedApiKey>('/api-keys', { name, scopes }).then((r) => r.data),
  revoke: (id: string) => api.post<ApiKey>(`/api-keys/${id}/revoke`).then((r) => r.data),
  remove: (id: string) => api.delete(`/api-keys/${id}`).then((r) => r.data),
};

/**
 * Operator data reset (Settings → danger zone). Counts are grouped by category so the confirm
 * dialog can spell out exactly what will be deleted; `clear` empties the selected categories.
 * Agents, isolations, images and Qdrant memory are never in scope here.
 */
export type ResetCategory = 'conversations' | 'scores' | 'logs' | 'activity';

export type DataCounts = Record<ResetCategory, Record<string, number>>;

export interface ClearSummary {
  ok: boolean;
  deleted: Record<string, number>;
  total: number;
}

export const maintenanceApi = {
  counts: () => api.get<DataCounts>('/maintenance/data-counts').then((r) => r.data),
  /** A restorable dump of the selected categories, for the "download a backup first" option. */
  exportBlob: (categories: ResetCategory[]) =>
    api
      .get('/maintenance/export', { params: { categories: categories.join(',') }, responseType: 'blob' })
      .then((r) => r.data as Blob),
  clear: (categories: ResetCategory[]) =>
    api.post<ClearSummary>('/maintenance/clear', { categories, confirm: 'CLEAR' }).then((r) => r.data),
};

// --- Monitor (fleet machine telemetry; backend `domain/monitor/`) ---

/**
 * Wire shape of one `monitor-client` snapshot, mirroring `backend/src/domain/monitor/monitor.types.ts`.
 * Every field is nullable and every array may be empty: the client degrades one section at a time
 * (no fan chip, no GPU, no `nvidia-smi`), so the UI must render around gaps rather than assume them away.
 */
export interface MonitorSnapshot {
  collected_at: string;
  host: { hostname: string | null; os: string | null; kernel: string | null; uptime_sec: number | null };
  cpu: {
    model: string | null;
    sockets: number | null;
    cores: number | null;
    threads: number | null;
    usage_percent: number | null;
    per_core_percent: (number | null)[];
    frequencies_mhz: (number | null)[];
    temperature_celsius: number | null;
    load_average: { '1m': number | null; '5m': number | null; '15m': number | null };
  };
  memory: {
    total_bytes: number | null;
    available_bytes: number | null;
    used_bytes: number | null;
    used_percent: number | null;
    cached_bytes: number | null;
    swap_total_bytes: number | null;
    swap_used_bytes: number | null;
  } | null;
  gpus: MonitorGpu[];
  temperatures: MonitorTemperature[];
  fans: MonitorFan[];
  disks: MonitorDisk[];
  network: Record<string, MonitorNic>;
  warnings: string[];
}

export interface MonitorGpu {
  index: number | null;
  name: string | null;
  uuid: string | null;
  temperature_celsius: number | null;
  utilization_percent: number | null;
  memory_utilization_percent: number | null;
  memory_total_bytes: number | null;
  memory_used_bytes: number | null;
  memory_used_percent: number | null;
  /** Null on passively cooled cards — no fan, rather than a failed reading. */
  fan_percent: number | null;
  power_draw_watts: number | null;
  power_limit_watts: number | null;
  clock_sm_mhz: number | null;
  clock_mem_mhz: number | null;
  pstate: string | null;
}

export interface MonitorTemperature {
  chip: string;
  label: string;
  celsius: number | null;
  high_celsius: number | null;
  critical_celsius: number | null;
}

export interface MonitorFan {
  chip: string;
  label: string;
  rpm: number | null;
  duty_percent: number | null;
}

export interface MonitorDisk {
  label: string;
  total_bytes?: number | null;
  used_bytes?: number | null;
  available_bytes?: number | null;
  used_percent?: number | null;
  error?: string;
}

export interface MonitorNic {
  rx_bytes: number | null;
  tx_bytes: number | null;
  rx_bytes_per_sec: number | null;
  tx_bytes_per_sec: number | null;
  rx_errors: number | null;
  tx_errors: number | null;
}

/** A threshold rule currently exceeded. `severity` maps straight to the DIRECT_ART amber/red scale. */
export interface MonitorBreach {
  key: string;
  rule: 'cpu_temp' | 'gpu_temp' | 'memory' | 'vram' | 'disk' | 'offline';
  label: string;
  value: number | null;
  limit: number | null;
  severity: 'warn' | 'critical';
}

/** One target's newest state, as held by the backend poller. */
export interface MonitorLive {
  target_id: string;
  name: string;
  base_url: string;
  endpoint_id: string | null;
  note: string;
  online: boolean;
  error: string | null;
  last_ok_at: string | null;
  latency_ms: number | null;
  /** Last known snapshot — kept while offline, so a dark card still shows what it looked like. */
  snapshot: MonitorSnapshot | null;
  breaches: MonitorBreach[];
}

/** One point of reduced history (`t` = epoch ms). GPU arrays are index-aligned with the snapshot. */
export interface MonitorSample {
  t: number;
  cpu: number | null;
  cpu_temp: number | null;
  mem: number | null;
  gpu_util: (number | null)[];
  gpu_vram: (number | null)[];
  gpu_temp: (number | null)[];
  rx: number | null;
  tx: number | null;
}

/** A configured machine (Settings → Monitor). The API key is write-only — reads report only `has_api_key`. */
export interface MonitorTarget {
  _id: string;
  name: string;
  base_url: string;
  endpoint_id: string | null;
  enabled: boolean;
  note: string;
  has_api_key: boolean;
}

export interface MonitorTargetPatch {
  name?: string;
  base_url?: string;
  /** Omit to keep the stored key; `''` clears it. */
  api_key?: string;
  endpoint_id?: string | null;
  enabled?: boolean;
  note?: string;
}

/** Result of the settings form's "Test" button — a live probe, with the target's own error verbatim. */
export interface MonitorTestResult {
  ok: boolean;
  latency_ms?: number;
  hostname?: string | null;
  os?: string | null;
  cpu?: string | null;
  gpus?: (string | null)[];
  warnings?: string[];
  error?: string;
}

/**
 * What the backend's in-RAM history buffer holds and costs. `bytes` figures are *estimates* — V8
 * exposes no per-object retained size — intended as an order-of-magnitude guide for picking a depth.
 */
export interface MonitorStats {
  /** The effective cap after clamping, which may differ from the number typed in settings. */
  cap: number;
  total_samples: number;
  total_bytes: number;
  targets: {
    target_id: string;
    name: string;
    samples: number;
    bytes: number;
    /** Epoch ms of the oldest/newest retained sample — how far back the graphs actually reach. */
    oldest: number | null;
    newest: number | null;
  }[];
}

export const monitorApi = {
  listTargets: () => api.get<MonitorTarget[]>('/monitor/targets').then((r) => r.data),
  createTarget: (body: MonitorTargetPatch & { name: string; base_url: string }) =>
    api.post<MonitorTarget>('/monitor/targets', body).then((r) => r.data),
  updateTarget: (id: string, patch: MonitorTargetPatch) =>
    api.patch<MonitorTarget>(`/monitor/targets/${id}`, patch).then((r) => r.data),
  removeTarget: (id: string) => api.delete(`/monitor/targets/${id}`).then((r) => r.data),
  test: (id: string) => api.post<MonitorTestResult>(`/monitor/targets/${id}/test`).then((r) => r.data),

  /** Newest snapshot per target, served from the backend poller's memory (no upstream call). */
  live: () => api.get<MonitorLive[]>('/monitor/live').then((r) => r.data),
  /** `since` (epoch ms) fetches only newer samples, so a polling page doesn't re-download the buffer. */
  history: (id: string, since?: number) =>
    api.get<MonitorSample[]>(`/monitor/targets/${id}/history`, { params: { since } }).then((r) => r.data),
  /** Live size of the history buffer, for the Settings → Monitor readout. */
  stats: () => api.get<MonitorStats>('/monitor/stats').then((r) => r.data),
};
