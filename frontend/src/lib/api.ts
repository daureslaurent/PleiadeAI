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
  const token = localStorage.getItem('pleiade_token');
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
export interface Isolation {
  _id: string;
  name: string;
  description: string;
  /** The image entity this profile runs (see `images`); null until one is picked. */
  image_id: string | null;
  cpus: string;
  memory: string;
  network: 'host' | 'bridge' | 'none' | 'vpn';
  idle_timeout_ms: number;
  /** Public key + known_hosts are returned as-is (not secret); the private key never is. */
  ssh_public_key: string;
  ssh_known_hosts: string;
  // VPN (gluetun / WireGuard) config, used when `network === 'vpn'`, is supplied as an uploaded
  // WireGuard `.conf` (write-only, see IsolationPatch). It is secret and never returned.
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
 * One pleiade-managed docker container across all profiles (GET /isolations/containers).
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
  /** Agent-owned Markdown notebook, editable here or by the agent via `update_agents_md`. */
  agents_md: string;
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
  agent_id: string;
  title: string;
  content: string;
  status: 'unread' | 'read';
  created_at: string;
}

export type NewAgent = Omit<Agent, '_id'>;

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
    const token = localStorage.getItem('pleiade_token');
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
    const token = localStorage.getItem('pleiade_token');
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
    const token = localStorage.getItem('pleiade_token') ?? '';
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
  const token = localStorage.getItem('pleiade_token');
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
  remove: (id: string) => api.delete(`/isolations/${id}`).then((r) => r.data),

  /** Every pleiade-managed container across all profiles, with orphan classification. */
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
  context_tokens?: number;
  context_window?: number;
  turn_id?: string;
  run_id?: string;
}

export const sessionsApi = {
  listByAgent: (agentId: string) =>
    api.get<Session[]>('/sessions', { params: { agentId } }).then((r) => r.data),
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
  const token = localStorage.getItem('pleiade_token');
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
};

export const inboxApi = {
  list: () => api.get<Notification[]>('/inbox').then((r) => r.data),
  markRead: (id: string) => api.post(`/inbox/${id}/read`).then((r) => r.data),
};

export interface AutonomyJob {
  id: string;
  data: { agentName: string; prompt: string; alert?: boolean };
  nextRunAt: string | null;
  lastRunAt: string | null;
  repeatInterval: string | null;
}

/** Fields the create/edit form submits; `interval` (recurring) or `when` (one-off), not both. */
export interface AutonomyJobInput {
  agentName: string;
  prompt: string;
  interval?: string;
  when?: string;
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

export const hostApi = {
  getUpdate: () => api.get<UpdateInfo>('/host/update').then((r) => r.data),
  checkUpdate: () => api.post<UpdateInfo>('/host/update/check').then((r) => r.data),
  runUpdate: () => api.post<{ ok: boolean; logOffset: number }>('/host/update').then((r) => r.data),
  updateLog: (since: number) =>
    api.get<UpdateLogChunk>('/host/update/log', { params: { since } }).then((r) => r.data),
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
   * Operator marker: this endpoint's model is multimodal (vision). Advisory — used to warn when a
   * visual agent is paired with a text-only endpoint (its screenshots would be silently ignored).
   */
  supports_vision: boolean;
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
  source: 'chat-turn' | 'title-gen' | 'identity' | 'vision' | 'judge';
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

export const finetuneServersApi = {
  list: () => api.get<FinetuneServer[]>('/finetune-servers').then((r) => r.data),
  create: (body: NewFinetuneServer) =>
    api.post<FinetuneServer>('/finetune-servers', body).then((r) => r.data),
  update: (id: string, patch: FinetuneServerPatch) =>
    api.patch<FinetuneServer>(`/finetune-servers/${id}`, patch).then((r) => r.data),
  remove: (id: string) => api.delete(`/finetune-servers/${id}`).then((r) => r.data),

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
export interface ApiKey {
  _id: string;
  name: string;
  prefix: string;
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
  create: (name: string) => api.post<IssuedApiKey>('/api-keys', { name }).then((r) => r.data),
  revoke: (id: string) => api.post<ApiKey>(`/api-keys/${id}/revoke`).then((r) => r.data),
  remove: (id: string) => api.delete(`/api-keys/${id}`).then((r) => r.data),
};
