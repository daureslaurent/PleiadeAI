import axios from 'axios';
import { useAuth } from '../store/auth';
import type { TodoItem } from './ws-events.types';

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
  /**
   * Android-control image: its Dockerfile carries the Android layer (adb + socat + scrcpy-server).
   * This is where `adb` runs; *which* device an agent drives comes from its own device link.
   */
  android: boolean;
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
  /**
   * Auto agent mode (`AUTO_AGENT_PLAN.md`): unlocks the composer's Loop panel, where this agent can
   * be handed a standing goal and an interval and left to drive its own conversation. A capability
   * gate only — loops are armed per conversation.
   */
  auto_mode: boolean;
  /**
   * Starting values for this agent's Loop panel — not a running loop, just what the form opens with,
   * so an agent built for a standing job arms in one click.
   */
  loop_defaults?: { goal: string; continue_text: string; interval_sec: number };
  /**
   * Role slug when the app owns this agent (`''` for operator-made ones). A built-in cannot be
   * deleted or renamed — privileged tools authorise against the slug — but is otherwise editable.
   */
  builtin: string;
  /**
   * Whether an @-mention of this agent on the forum raises an alert (`FORUM_PLAN.md` §11.2). Off
   * only silences the alert: the mention is still recorded, still shown, and still reaches the agent
   * in its next turn's forum block. Whether a mention also *runs* it is `forum_auto_reply`.
   */
  forum_mentions?: boolean;
  /**
   * Whether an @-mention may run this agent on its own, when fleet-wide auto-reply is on
   * (`FORUM_PLAN.md` §11.6). Both must agree — this is the per-agent exclusion from it.
   */
  forum_auto_reply?: boolean;
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
  /**
   * Computed by the list endpoint: true when the agent is linked to a device *and* its isolation
   * image carries the Android layer — i.e. the phone mirror can actually open. Absent elsewhere.
   */
  android?: boolean;
  /**
   * Computed by the list endpoint: the assigned isolation image carries the Android layer. Reported
   * separately from `android` so the Agents form can tell "no device linked" from "image lacks adb".
   */
  android_image?: boolean;
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
  /** The Android device this agent drives (Settings → Connections), or null. Grants the android_* tools. */
  android_device_id: string | null;
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
  /** `forum_mention` → `ref_id` is a `forum_mentions` row and the row can offer Run. */
  kind?: string;
  ref_id?: string;
  created_at: string;
}

/** A new agent's notebook always starts empty — the agent writes it itself via `update_notebook`. */
export type NewAgent = Omit<Agent, '_id' | 'notebook' | 'builtin'>;

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
};

/** Guess a mime type from a filename's extension. Falls back to a generic binary type. */
function mimeFromExt(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

async function fetchContainerFileBlob(id: string, path: string): Promise<Blob> {
  const token = localStorage.getItem('pleiades_token');
  const res = await fetch(
    `${API_BASE}/api/agents/${id}/container/download?path=${encodeURIComponent(path)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
  );
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return res.blob();
}

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
        | 'auto_mode'
        | 'forum_mentions'
        | 'forum_auto_reply'
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
        | 'android_device_id'
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
    const blob = await fetchContainerFileBlob(id, path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  /**
   * Fetch a file's bytes as an object URL for inline media preview (images/video/audio). The
   * container download route always answers `application/octet-stream`, so the blob is re-tagged
   * with the mime guessed from the file's extension — otherwise `<img>`/`<video>` won't render it.
   * Caller revokes the URL.
   */
  async fileObjectUrl(id: string, path: string): Promise<string> {
    const blob = await fetchContainerFileBlob(id, path);
    const typed = blob.type ? blob : new Blob([blob], { type: mimeFromExt(path) });
    return URL.createObjectURL(typed);
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

/**
 * A registered Android device (`android_devices`): an emulator or phone reachable over adb TCP/IP.
 * Agents link to one and drive it with the `android_*` tools; the Workspace mirrors it live.
 */
export interface AndroidDevice {
  _id: string;
  name: string;
  description: string;
  /** Address the *agent's container* reaches adb on — not necessarily what the browser can see. */
  adb_host: string;
  adb_port: number;
  /** Live-mirror encoding, handed to scrcpy when the panel opens. `mirror_max_size` 0 = native. */
  mirror_max_size: number;
  mirror_bit_rate: number;
  mirror_max_fps: number;
  /** Forward device audio to the mirror panel. Off by default — see the model for why. */
  mirror_audio: boolean;
  /** Encoder to request. `aac` is the safe default; a codec the device lacks costs all audio. */
  mirror_audio_codec: AndroidAudioCodec;
  enabled: boolean;
  /** Result of the last "Test connection" — advisory, measured from the backend container. */
  last_status: 'unknown' | 'ok' | 'error';
  last_error: string;
  last_checked_at: string | null;
  last_seen_model: string;
}

export const ANDROID_AUDIO_CODECS = ['aac', 'opus', 'flac'] as const;
export type AndroidAudioCodec = (typeof ANDROID_AUDIO_CODECS)[number];

export type NewAndroidDevice = Pick<AndroidDevice, 'name' | 'adb_host'> &
  Partial<Pick<AndroidDevice, 'description' | 'adb_port' | 'enabled'>>;

export interface AdbProbeResult {
  ok: boolean;
  message: string;
  model?: string;
}

export const androidDevicesApi = {
  list: () => api.get<AndroidDevice[]>('/android-devices').then((r) => r.data),
  create: (body: NewAndroidDevice) =>
    api.post<AndroidDevice>('/android-devices', body).then((r) => r.data),
  update: (
    id: string,
    patch: Partial<
      Pick<
        AndroidDevice,
        | 'name'
        | 'description'
        | 'adb_host'
        | 'adb_port'
        | 'mirror_max_size'
        | 'mirror_bit_rate'
        | 'mirror_max_fps'
        | 'mirror_audio'
        | 'mirror_audio_codec'
        | 'enabled'
      >
    >,
  ) => api.patch<AndroidDevice>(`/android-devices/${id}`, patch).then((r) => r.data),
  /** Deleting also unlinks the device from every agent that referenced it. */
  remove: (id: string) =>
    api.delete<{ unlinked_agents: number }>(`/android-devices/${id}`).then((r) => r.data),
  /** Complete an adb handshake against the device and record the verdict on the doc. */
  test: (id: string) =>
    api.post<AdbProbeResult>(`/android-devices/${id}/test`).then((r) => r.data),
};

/** Handshake for the live phone mirror. No credential: the WS upgrade carries the same JWT. */
export interface AndroidSession {
  /** Backend path to open the raw-binary WebSocket relay at (append `?token=`). */
  ws_path: string;
}

export const androidApi = {
  /** POST the mirror handshake for an agent; `409` with a code when it isn't set up for Android. */
  session: (id: string) =>
    api.post<AndroidSession>(`/agents/${id}/container/android/session`).then((r) => r.data),
  /** Signal that a human has taken (`true`) or released (`false`) manual control, pausing `android_act`. */
  control: (id: string, human: boolean) =>
    api.post(`/agents/${id}/container/android/control`, { human }).then((r) => r.data),
  /**
   * Turn the device. `{ step: 1 | -1 }` for a quarter turn, `{ rotation: 0..3 }` for an absolute
   * orientation. Replies with where it landed.
   */
  rotate: (id: string, body: { step?: 1 | -1; rotation?: number }) =>
    api.post<{ rotation: number }>(`/agents/${id}/container/android/rotate`, body).then((r) => r.data),
  /** Same JWT-in-query scheme as the VNC relay — browsers can't set headers on a WebSocket. */
  wsUrl: (wsPath: string): string => visualApi.wsUrl(wsPath),
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
  /**
   * `synthetic` → produced by the Conversation Generator; `forum` → spawned by the operator running
   * an @-mention (`FORUM_PLAN.md` §11.3), which is an ordinary conversation they can continue.
   */
  origin?: 'user' | 'synthetic' | 'forum';
  /** Forum-origin only: the thread the mention came from, so the Workspace can link back to it. */
  forum_thread_id?: string | null;
  forum_mention_id?: string | null;
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

/** One self-driving conversation (`AUTO_AGENT_PLAN.md` §3), as the API returns it. */
export interface AutoLoop {
  _id: string;
  session_id: string;
  agent_name: string;
  status: 'idle' | 'running' | 'waiting' | 'done' | 'stopped' | 'error';
  goal: string;
  seed: string;
  continue_text: string;
  interval_sec: number;
  iteration: number;
  progress: { n: number; at: string; summary: string }[];
  done_reason: string;
  last_error: string;
  next_run_at: string | null;
}

export interface StartAutoLoopInput {
  goal: string;
  seed: string;
  continueText: string;
  intervalSec: number;
}

/**
 * Arming and disarming a loop is durable state the operator sets once, so it goes over REST; the
 * live half (status, iteration, countdown) streams back as the `auto_loop` socket event.
 */
export const autoLoopsApi = {
  /** `null` for a conversation that has never looped — the normal case when the panel opens. */
  get: (sessionId: string) =>
    api.get<AutoLoop | null>(`/auto-loops/${sessionId}`).then((r) => r.data),
  start: (sessionId: string, body: StartAutoLoopInput) =>
    api.post<AutoLoop>(`/auto-loops/${sessionId}/start`, body).then((r) => r.data),
  stop: (sessionId: string) =>
    api.post<AutoLoop>(`/auto-loops/${sessionId}/stop`).then((r) => r.data),
};

export const sessionsApi = {
  /**
   * Sessions for one agent. `origin` defaults to `all` — the Workspace shows generated conversations
   * alongside the operator's own, marked as such (the Conversation Generator is meant to be read).
   */
  listByAgent: (agentId: string, origin: 'user' | 'synthetic' | 'forum' | 'all' = 'all') =>
    api.get<Session[]>('/sessions', { params: { agentId, origin } }).then((r) => r.data),
  /** One session — resolves the owning agent when a `?session=` deep link opens the Workspace. */
  get: (id: string) => api.get<Session>(`/sessions/${id}`).then((r) => r.data),
  create: (agentId: string) => api.post<Session>('/sessions', { agentId }).then((r) => r.data),
  rename: (id: string, title: string) =>
    api.patch<Session>(`/sessions/${id}`, { title }).then((r) => r.data),
  remove: (id: string) => api.delete(`/sessions/${id}`).then((r) => r.data),
  messages: (id: string) => api.get<StoredMessage[]>(`/sessions/${id}/messages`).then((r) => r.data),
  /** Every agent's task list in the session, so a reload restores the pinned checklist. */
  todos: (id: string) =>
    api
      .get<{ agentId: string; agent: string; items: TodoItem[]; updatedAt: string }[]>(
        `/sessions/${id}/todos`,
      )
      .then((r) => r.data),
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
  /**
   * Direct URL for a `<video>`/`<audio>` element. Those fetch their own bytes and can't be given an
   * Authorization header, so the token rides as a query param (the backend accepts it on this route
   * only). Unlike {@link objectUrl} this streams and seeks — a ten-minute clip starts playing
   * immediately instead of downloading in full first.
   */
  streamUrl(sessionId: string, handle: string): string {
    const token = localStorage.getItem('pleiades_token') ?? '';
    const path = `${API_BASE}/api/resources/${encodeURIComponent(sessionId)}/${encodeURIComponent(handle)}/content`;
    return token ? `${path}?token=${encodeURIComponent(token)}` : path;
  },
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
  /** Names a server-side options provider; the backend fills `options`/`optionLabels` before sending. */
  optionsSource?: string;
  /** Display name per option value, so a select can store an id and show a name. */
  optionLabels?: Record<string, string>;
  hint?: string;
  default: string | number | boolean;
  /** True when the operator can lock this field so an agent's tool-call argument for it is ignored. */
  lockable?: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  configSchema: ToolConfigField[];
  config: Record<string, string | number | boolean>;
  enabled: boolean;
  /** Field keys the operator has locked — see `ToolConfigField.lockable`. */
  locked: string[];
}

export const toolsApi = {
  list: () => api.get<ToolInfo[]>('/tools').then((r) => r.data),
  update: (name: string, patch: { enabled?: boolean; config?: Record<string, unknown>; locked?: string[] }) =>
    api.put<ToolInfo>(`/tools/${encodeURIComponent(name)}`, patch).then((r) => r.data),
};

// --- Media generation (ComfyUI) -------------------------------------------------------------

/** Keep in step with `WORKFLOW_KINDS` in the backend's `media-workflow.model.ts`. */
export type WorkflowKind = 'image' | 'video' | 'audio' | 'edit' | 'video_edit';

/** One logical parameter pinned to a node input in the workflow graph. */
export interface WorkflowBinding {
  node_id: string;
  input: string;
  spec?: {
    type: 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'ENUM' | 'LINK';
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    tooltip?: string;
  };
  /** The input was fed by another node — binding it overrides whatever that node computed. */
  overrides_link?: boolean;

  // ---- custom parameters only (a `custom:` key) ----
  /** Operator-facing name; defaults to the key without its prefix. */
  label?: string;
  description?: string;
  /** Allowed values, when the operator declares them (a ComfyUI combo whose list is built by its widget). */
  choices?: string[];
  /** Used when nothing else supplies a value. */
  default?: string | number;
  /** Whether the media tools let an agent set this on a tool call. */
  agent_editable?: boolean;
}

export interface MediaWorkflow {
  id: string;
  name: string;
  kind: WorkflowKind;
  description: string;
  output_node_id: string;
  output_kind: 'image' | 'video' | 'audio';
  source: 'discovered' | 'manual';
  enabled: boolean;
  avg_duration_ms: number;
  node_count: number;
  bound: string[];
  unbound: string[];
  last_validated_at: string | null;
  last_validation_error: string;
  updated_at: string;
}

/** One input of a workflow node, as the mapping canvas draws and binds it. */
export interface WorkflowNodeInput {
  name: string;
  type: 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'ENUM' | 'LINK';
  is_link: boolean;
  value: string | number | boolean | null;
  options?: string[];
  /** `[sourceNodeId, slot]` when another node feeds it — drawn as a graph edge. */
  link?: [string, number];
  /** False for tensor inputs (MODEL/CLIP/LATENT…): no literal can ever be written there. */
  bindable: boolean;
  min?: number;
  max?: number;
  step?: number;
  tooltip?: string;
}

export interface WorkflowNode {
  id: string;
  class_type: string;
  title: string;
  category: string;
  inputs: WorkflowNodeInput[];
  outputs: { name: string; type: string; slot: number }[];
  is_output: boolean;
}

/** A tool or flow node that runs this workflow — the Tools/Flows side of the mapping. */
export interface WorkflowConsumer {
  kind: 'tool' | 'flow';
  name: string;
  detail: string;
}

export interface MediaWorkflowDetail extends MediaWorkflow {
  bindings: Record<string, WorkflowBinding>;
  /** App-side ports for this workflow's own custom parameters, to append to the static catalog. */
  custom_catalog: BindingMeta[];
  graph: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;
  nodes: WorkflowNode[];
  models: string[];
  notes: string;
  graph_hash: string;
  source_prompt_id: string;
  consumers: WorkflowConsumer[];
}

/**
 * The app half of a binding: what a logical parameter is and which tool/flow setting fills it.
 * Served by the backend so the canvas' app-side ports can't drift from `BINDING_KEYS`.
 */
export interface BindingMeta {
  key: string;
  label: string;
  port: 'text' | 'number' | 'image' | 'audio' | 'video';
  description: string;
  source: string;
  kinds: WorkflowKind[];
  expected: boolean;
  /** Set on a parameter this one workflow invents (a `custom:` key), as opposed to the static catalog. */
  custom?: true;
  choices?: string[];
  default?: string | number;
  agent_editable?: boolean;
}

/** What the auto-binder proposes for a workflow, before the operator accepts it. */
export interface AutoBindProposal {
  bindings: Record<string, WorkflowBinding>;
  output_node_id: string;
  output_kind: 'image' | 'video' | 'audio';
  kind: WorkflowKind;
  unbound: string[];
}

export interface DiscoveryCandidate {
  prompt_id: string;
  graph_hash: string;
  /** The operator's saved ComfyUI workflow file this run came from ('' when unmatched). */
  source_file: string;
  suggested_name: string;
  kind: WorkflowKind;
  output_node_id: string;
  output_kind: 'image' | 'video' | 'audio';
  node_count: number;
  model_files: string[];
  key_classes: string[];
  output_filename: string;
  duration_ms: number;
  status: string;
  run_count: number;
  already_imported: boolean;
  bindings: Record<string, WorkflowBinding>;
  unbound: string[];
}

export interface ComfyStatus {
  ok: boolean;
  error?: string;
  base_url?: string;
  version?: string;
  python?: string;
  ram_free?: number;
  ram_total?: number;
  queue_remaining?: number;
  devices?: { name: string; vram_free: number; vram_total: number }[];
}

export const mediaApi = {
  status: () => api.get<ComfyStatus>('/media/comfy/status').then((r) => r.data),
  discover: () => api.get<DiscoveryCandidate[]>('/media/comfy/discover').then((r) => r.data),
  list: (kind?: WorkflowKind) =>
    api.get<MediaWorkflow[]>('/media/workflows', { params: kind ? { kind } : {} }).then((r) => r.data),
  get: (id: string) => api.get<MediaWorkflowDetail>(`/media/workflows/${id}`).then((r) => r.data),
  import: (body: { prompt_id: string; name: string; kind?: WorkflowKind }) =>
    api.post<MediaWorkflow>('/media/workflows/import', body).then((r) => r.data),
  create: (body: { name: string; graph: unknown; kind?: WorkflowKind; description?: string }) =>
    api.post<MediaWorkflow>('/media/workflows', body).then((r) => r.data),
  bindingKeys: (kind?: WorkflowKind) =>
    api.get<BindingMeta[]>('/media/binding-keys', { params: kind ? { kind } : {} }).then((r) => r.data),
  autobind: (id: string) =>
    api.post<AutoBindProposal>(`/media/workflows/${id}/autobind`).then((r) => r.data),
  /** Just one workflow's custom parameters — what a flow's media node needs to render its fields. */
  params: (id: string) =>
    api.get<BindingMeta[]>(`/media/workflows/${id}/params`).then((r) => r.data),
  update: (id: string, patch: Partial<Pick<MediaWorkflow, 'name' | 'kind' | 'enabled' | 'description'>> & {
    bindings?: Record<string, WorkflowBinding>;
    output_node_id?: string;
    output_kind?: 'image' | 'video' | 'audio';
    notes?: string;
  }) => api.put<MediaWorkflow>(`/media/workflows/${id}`, patch).then((r) => r.data),
  remove: (id: string) => api.delete(`/media/workflows/${id}`).then((r) => r.data),
  validate: (id: string) =>
    api
      .post<{ ok: boolean; issues: { level: string; message: string; node_id?: string }[] }>(
        `/media/workflows/${id}/validate`,
      )
      .then((r) => r.data),
  test: (id: string, prompt: string) =>
    api
      .post<{ ok: boolean; duration_ms: number; files: { filename: string; subfolder: string; type: string; kind: string }[] }>(
        `/media/workflows/${id}/test`,
        { prompt },
      )
      .then((r) => r.data),
  /**
   * Authenticated proxy to ComfyUI's own `/view`, for previewing a test render. Carries the token in
   * the query for the same reason the resource stream does: an `<img>`/`<video>` fetches its own
   * bytes and can't be handed a header.
   */
  viewUrl: (file: { filename: string; subfolder: string; type: string }) => {
    const token = localStorage.getItem('pleiades_token') ?? '';
    const qs = new URLSearchParams({ ...file, ...(token ? { token } : {}) }).toString();
    return `${API_BASE}/api/media/view?${qs}`;
  },
};

// --- Flows (FLOWS_PLAN.md) ------------------------------------------------------------------

export type PortType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'json' | 'signal';

export interface FlowValue {
  type: PortType;
  text?: string;
  handles?: string[];
  json?: unknown;
}

export interface PortSpec {
  name: string;
  types: PortType[];
  required?: boolean;
  description?: string;
}

/**
 * A node type as declared by the backend registry. The canvas builds its palette, its ports and its
 * inspector form entirely from these — adding a node type server-side needs no change here.
 */
export interface FlowNodeType {
  type: string;
  label: string;
  group: 'io' | 'agent' | 'media' | 'tool' | 'control';
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  config: ToolConfigField[];
}

export interface FlowNode {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  run_as_agent?: string;
}

export interface FlowEdge {
  id: string;
  source: string;
  source_port: string;
  target: string;
  target_port: string;
}

export interface FlowIssue {
  level: 'error' | 'warning';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FlowInputSpec {
  nodeId: string;
  key: string;
  label: string;
  type: PortType;
  default: unknown;
  required: boolean;
}

export interface FlowDetail extends FlowSummary {
  nodes: FlowNode[];
  edges: FlowEdge[];
  issues: FlowIssue[];
  runnable: boolean;
  inputs: FlowInputSpec[];
}

export type FlowRunStatus = 'running' | 'awaiting_input' | 'success' | 'error' | 'aborted';
export type FlowNodeStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface FlowRunSummary {
  id: string;
  flowId: string;
  flowName: string;
  status: FlowRunStatus;
  /** `timer` is the sub-minute Time trigger that keeps a live stream fed (STREAMING_PLAN.md §4). */
  trigger: 'manual' | 'agent' | 'cron' | 'api' | 'timer';
  sessionId: string;
  startedAt: string;
  endedAt?: string | null;
  error?: string;
}

export interface FlowRunNodeState {
  node_id: string;
  status: FlowNodeStatus;
  started_at?: string | null;
  ended_at?: string | null;
  output?: Record<string, FlowValue> | null;
  error?: string;
  iteration?: number | null;
}

export type FlowLogSource = 'node' | 'agent' | 'tool' | 'media' | 'system';

export interface FlowLogEntry {
  at: string;
  node_id: string;
  source: FlowLogSource;
  text: string;
  iteration?: number | null;
}

export interface FlowRunDetail extends FlowRunSummary {
  inputs: Record<string, unknown>;
  nodes: FlowRunNodeState[];
  /** The persisted debug trace (capped per node) — what the Debug tab replays for a past run. */
  logs: FlowLogEntry[];
  pending: { node_id: string; kind: 'approval'; question: string; artifacts: string[] } | null;
  output: Record<string, FlowValue> | null;
  live: boolean;
  resources: { handle: string; kind: 'image' | 'blob'; mime: string; size: number; filename?: string }[];
}

export interface FlowUpload {
  handle: string;
  filename?: string;
  mime: string;
  size: number;
  kind: 'image' | 'blob';
}

export const flowsApi = {
  nodeTypes: () =>
    api.get<{ types: FlowNodeType[]; portTypes: PortType[] }>('/flows/node-types').then((r) => r.data),
  list: () => api.get<FlowSummary[]>('/flows').then((r) => r.data),
  get: (id: string) => api.get<FlowDetail>(`/flows/${id}`).then((r) => r.data),
  create: (body: { name: string; description?: string }) =>
    api.post<FlowDetail>('/flows', body).then((r) => r.data),
  update: (
    id: string,
    patch: Partial<Pick<FlowSummary, 'name' | 'description' | 'enabled'>> & {
      nodes?: FlowNode[];
      edges?: FlowEdge[];
    },
  ) => api.put<FlowDetail>(`/flows/${id}`, patch).then((r) => r.data),
  remove: (id: string) => api.delete(`/flows/${id}`).then((r) => r.data),
  duplicate: (id: string) => api.post<FlowDetail>(`/flows/${id}/duplicate`).then((r) => r.data),
  /** Validate an unsaved graph — called as you wire, before anything is persisted. */
  validate: (nodes: FlowNode[], edges: FlowEdge[]) =>
    api
      .post<{ issues: FlowIssue[]; runnable: boolean }>('/flows/validate', { nodes, edges })
      .then((r) => r.data),
  run: (id: string, inputs: Record<string, unknown>) =>
    api.post<FlowRunSummary>(`/flows/${id}/run`, { inputs }).then((r) => r.data),
  runs: (flowId?: string, limit = 50) =>
    api.get<FlowRunSummary[]>('/flows/runs/list', { params: { flowId, limit } }).then((r) => r.data),
  getRun: (runId: string) => api.get<FlowRunDetail>(`/flows/runs/${runId}`).then((r) => r.data),
  approve: (runId: string, approved: boolean) =>
    api.post(`/flows/runs/${runId}/approve`, { approved }).then((r) => r.data),
  stop: (runId: string) => api.post(`/flows/runs/${runId}/stop`).then((r) => r.data),
  /** Ports a node currently exposes — refetched when a router's choices change. */
  ports: (node: FlowNode) =>
    api.post<{ inputs: PortSpec[]; outputs: PortSpec[] }>('/flows/ports', { node }).then((r) => r.data),

  /**
   * Upload a file for an `input` node. Multipart rather than a base64 body: a start frame or a source
   * clip is the realistic payload, and base64 would inflate it by a third on the way up.
   */
  upload: (flowId: string, file: File, onProgress?: (percent: number) => void) => {
    const form = new FormData();
    form.append('file', file);
    return api
      .post<FlowUpload & { sessionId: string }>(`/flows/${flowId}/uploads`, form, {
        onUploadProgress: (e) =>
          onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
      })
      .then((r) => r.data);
  },

  /** Files already staged on this flow, offered instead of a re-upload. */
  uploads: (flowId: string) =>
    api.get<{ sessionId: string; files: FlowUpload[] }>(`/flows/${flowId}/uploads`).then((r) => r.data),
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
  /** Per-attempt time-to-first-token budget (ms); on timeout the turn fails over to the next endpoint. */
  inference_first_token_timeout_ms: number;
  /** How often the background health breaker probes every endpoint (ms). */
  inference_health_poll_interval_ms: number;
  /** Consecutive failures before an endpoint is parked down and skipped by routing. */
  inference_health_failure_threshold: number;
  /** How long a down endpoint stays excluded before one trial request may re-check it (ms). */
  inference_health_cooldown_ms: number;
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
  /** ComfyUI server behind the media tools ('' → they report they're unconfigured). */
  comfy_url: string;
  /** Refuse a media job when ComfyUI already has this many queued (0 → no check). */
  comfy_queue_max: number;
  /** Host self-update master switch — gates the "Update app" action + the periodic check. */
  update_enabled: boolean;
  /** How often the backend triggers a read-only host update check (git fetch + compare). */
  update_check_interval_hours: number;
  /** Forum auto-reply: a summons runs the agent by itself and posts the answer back to the thread. */
  forum_auto_reply: boolean;
  /** How many automatic runs one thread may spend before its mentions fall back to a manual Run. */
  forum_auto_reply_max_per_thread: number;
  forum_auto_reply_window_hours: number;
  /** Whether a bare `@name` from an agent summons it, or merely addresses it (spec §11.7). */
  forum_bare_mention_summons: boolean;
  /** How many agent-to-agent summonses may chain off one human starting point. */
  forum_mention_max_chain: number;
  /** How often one agent may summon the same agent on the same thread, per window. */
  forum_mention_max_per_pair: number;
  /** Whether the board runs mentions nobody summoned, on its own clock (`FORUM_AUTORUN_PLAN.md`). */
  forum_sweep_enabled: boolean;
  forum_sweep_interval_minutes: number;
  /** How long a mention must sit before the board runs it for you. */
  forum_sweep_min_age_minutes: number;
  /** Past this, a pending mention is left for the operator rather than run. */
  forum_sweep_max_age_hours: number;
  /** Automatic runs a project may spend per window, shared by every thread naming the same hub. */
  forum_auto_reply_max_per_project: number;
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

/** Token breakdown for one captured request (chat page Prompt view). */
export interface PromptTokenBreakdown {
  /** Per-message content tokens, index-aligned with the request's messages. `null` = unavailable. */
  perMessage: (number | null)[];
  /** Exact templated prompt total — larger than the sum, which excludes template scaffolding. */
  total: number | null;
  contextWindow?: number;
}

export const llmDebugApi = {
  list: (limit: number) =>
    api.get<LlamaCallRecord[]>('/llama-logs', { params: { limit } }).then((r) => r.data),
  /** Every chat-turn call of one session, oldest first — the Prompt view's backing data. */
  bySession: (sessionId: string, limit = 60) =>
    api
      .get<LlamaCallRecord[]>(`/llama-logs/session/${sessionId}`, { params: { limit } })
      .then((r) => r.data),
  tokenize: (messages: unknown[], agentId?: string | null) =>
    api
      .post<PromptTokenBreakdown>('/llama-logs/tokenize', { messages, agentId: agentId ?? null })
      .then((r) => r.data),
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
  { scope: 'android:write', label: 'register and test Android devices' },
  { scope: 'flows:write', label: 'create, edit, delete and run flows' },
  { scope: 'media:write', label: 'import, edit and test ComfyUI workflows' },
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

// ---------------------------------------------------------------- live streaming

/** One clip that has been (or is being) aired on a live stream. */
export interface StreamClip {
  id: string;
  title: string;
  durationSec: number;
  queuedAt: string;
  airedAt?: string;
  replays: number;
}

/** A live stream, keyed by the flow feeding it (STREAMING_PLAN.md). */
export interface StreamInfo {
  flowId: string;
  flowName: string;
  kind: 'audio' | 'video';
  /** The MSE codec string the player must hand to `MediaSource.addSourceBuffer`. */
  mime: string;
  startedAt: string;
  nowPlaying: string | null;
  /** True while the last clip is being re-aired because nothing new has landed. */
  starved: boolean;
  bufferedSec: number;
  queuedClips: number;
  totalClips: number;
  listeners: number;
  recent: StreamClip[];
}

/** A stream plus the signed URL a media element can actually fetch. */
export interface StreamSession extends StreamInfo {
  timerArmed: boolean;
  token: string;
  tokenExpiresInSeconds: number;
  /** Already carries `?t=<token>` — a `<video src>` can't send an Authorization header. */
  url: string;
}

export const streamsApi = {
  list: () => api.get<{ streams: StreamInfo[] }>('/streams').then((r) => r.data.streams),
  /** Fetches the stream *and* mints a playback token, so the player needs exactly one call. */
  get: (flowId: string) => api.get<StreamSession>(`/streams/${flowId}`).then((r) => r.data),
  stop: (flowId: string) => api.delete(`/streams/${flowId}`).then((r) => r.data),
  /** Arm or disarm the flow's Time trigger — "keep feeding this stream" / "stop feeding it". */
  setTimer: (flowId: string, armed: boolean) =>
    api.post<{ ok: boolean; armed: boolean }>(`/streams/${flowId}/timer`, { armed }).then((r) => r.data),
};

// --- Forum (FORUM_PLAN.md) --------------------------------------------------

/** Who wrote a thread or post. Built server-side from the run's identity — never client-supplied. */
export interface ForumAuthor {
  kind: 'agent' | 'operator';
  agent_id: string | null;
  display_name: string;
}

export interface ForumCategory {
  id: string;
  name: string;
  slug: string;
  description: string;
  position: number;
  enabled: boolean;
  agentsCanPost: boolean;
  createdAt: string;
  threadCount: number;
  postCount: number;
  lastThread: { id: string; title: string; lastPostAt: string; lastPostAuthor: string } | null;
}

/**
 * Where the work a thread tracks has got to — a different axis from `status`, which is the thread's
 * own lifecycle on the board. `null` means the thread is not a work item at all.
 */
export type ForumWorkState = 'todo' | 'in_progress' | 'blocked' | 'done';

/** What is left of a thread's automatic-reply allowance. Null when fleet auto-reply is off. */
export interface ForumAutoRun {
  spent: number;
  budget: number;
  remaining: number;
  /** When the rolling window resets. Null when windowing is disabled and the budget is a hard cap. */
  resetsAt: string | null;
  exhausted: boolean;
}

export interface ForumThread {
  id: string;
  categoryId: string;
  title: string;
  author: ForumAuthor;
  status: 'open' | 'locked' | 'archived';
  workState: ForumWorkState | null;
  assignee: ForumAuthor | null;
  pinned: boolean;
  tags: string[];
  postCount: number;
  viewCount: number;
  lastPostAt: string;
  lastPostAuthor: string;
  resolvedPostId: string | null;
  /** The project's hub thread, when this thread is part of one. Threads sharing a hub share a budget. */
  hubThreadId: string | null;
  createdAt: string;
}

/** What a `#thread` reference chip shows: the thread, plus the two things its card needs. */
export interface ForumThreadRef extends ForumThread {
  categoryName: string | null;
  excerpt: string;
}

/** A file in the board's registry (`FORUM_PLAN.md` §10). Bytes are fetched by id, never inlined. */
export interface ForumFile {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'archive' | 'document' | 'other';
  sha256: string;
  uploadedBy: ForumAuthor;
  createdAt: string;
  /** Live posts referencing it. Present on the Files page listing; absent on a post's own chips. */
  refCount?: number;
  /** Set on upload when the bytes were already in the registry, so the UI can say "reused". */
  deduped?: boolean;
}

/** Where a registry file is referenced — the Files page's "used by" panel. */
export interface ForumFileUsage {
  postId: string;
  threadId: string;
  threadTitle: string;
  author: string;
  createdAt: string;
}

export interface ForumPost {
  id: string;
  threadId: string;
  author: ForumAuthor;
  body: string;
  attachments: ForumFile[];
  replyTo: string | null;
  editedAt: string | null;
  editedBy: string;
  /** Why the last edit happened (the moderator always gives one) and the body it replaced. */
  editReason: string;
  previousBody: string;
  createdAt: string;
}

/**
 * One `@somebody` written into a post (`FORUM_PLAN.md` §11). A row, not a substring: it carries the
 * status the operator moves it through, and the session/reply a Run produced.
 */
/**
 * What a post the operator wrote actually did: who it started a turn for, who it merely told, and
 * who a guard held back and why. The agent-side `forum` tool has always reported this; the composer
 * now does too, so a post that summoned nobody says so instead of looking like it worked.
 */
export interface SummonsOutcome {
  woke: string[];
  addressed: string[];
  notWoken: Array<{ agent: string; reason: string }>;
}

export interface ForumMention {
  id: string;
  postId: string;
  threadId: string;
  categoryId: string;
  threadTitle: string;
  excerpt: string;
  target: ForumAuthor;
  author: ForumAuthor;
  status: 'pending' | 'answered' | 'dismissed';
  /** False when the target agent has mentions muted — the row exists, it just raised no alert. */
  notified: boolean;
  /**
   * True when this asked the target to take a turn; false when it merely addressed them (§11.7).
   * A bare `@name` from an agent is an address — it notifies and shows on the target's next turn.
   */
  summon: boolean;
  /** Which guard withheld an eligible summons from running by itself. Null when nothing did. */
  runBlocked: 'chain_depth' | 'back_summon' | 'pair_rate' | 'budget' | null;
  /** How many agent-to-agent summonses deep this sits, counting from the last human start. */
  chainDepth: number;
  sessionId: string | null;
  replyPostId: string | null;
  answeredAt: string | null;
  createdAt: string;
}

/** Who can be addressed, for the composer's `@` autocomplete. */
export interface MentionTarget {
  kind: 'agent' | 'operator';
  agentId: string | null;
  name: string;
  /** False → muted: still addressable, but the mention raises no alert. The UI says so. */
  notify: boolean;
  /** False → excluded from running itself, so naming it records the ask and waits for you. */
  autoReply: boolean;
  /** The agent's one-liner, for the composer's pickers. Absent on a large roster. */
  description?: string;
}

/** A thread page: the thread, one page of posts, and each author's total post count. */
export interface ForumThreadDetail extends ForumThread {
  posts: ForumPost[];
  total: number;
  offset: number;
  authorPostCounts: Record<string, number>;
  /** Mentions raised by the posts on this page, so each `@name` chip knows its own state. */
  mentions: ForumMention[];
  /** The thread's automatic-reply allowance, so the page can explain a thread nobody answers. */
  autoRun: ForumAutoRun | null;
}

export interface ForumSearchHit {
  threadId: string;
  postId: string | null;
  title: string;
  categoryId: string;
  author: string;
  createdAt: string;
  snippet: string;
  score: number;
  /** Which index matched — `both` means keyword and semantic agreed, the strongest signal. */
  source: 'keyword' | 'semantic' | 'both';
}

export const forumApi = {
  categories: () => api.get<ForumCategory[]>('/forum/categories').then((r) => r.data),
  createCategory: (body: { name: string; description?: string; position?: number; agentsCanPost?: boolean }) =>
    api.post<ForumCategory>('/forum/categories', body).then((r) => r.data),
  saveCategory: (id: string, patch: Partial<{ name: string; description: string; position: number; enabled: boolean; agentsCanPost: boolean }>) =>
    api.patch<ForumCategory>(`/forum/categories/${id}`, patch).then((r) => r.data),
  removeCategory: (id: string, force = false) =>
    api.delete(`/forum/categories/${id}`, { params: force ? { force: 1 } : {} }).then((r) => r.data),

  threads: (
    categoryId?: string,
    limit = 50,
    includeArchived = false,
    filter: { workState?: Array<ForumWorkState | 'none'>; assignee?: string; sort?: 'pinned' | 'active' } = {},
  ) =>
    api
      .get<ForumThread[]>('/forum/threads', {
        params: {
          category: categoryId,
          limit,
          includeArchived: includeArchived ? '1' : undefined,
          workState: filter.workState?.length ? filter.workState.join(',') : undefined,
          assignee: filter.assignee || undefined,
          sort: filter.sort === 'active' ? 'active' : undefined,
        },
      })
      .then((r) => r.data),
  /** Batch-resolve raw thread ids quoted in a post or a chat turn. Unknown ids are simply absent. */
  resolveThreads: (ids: string[]) =>
    api.get<ForumThreadRef[]>('/forum/threads/resolve', { params: { ids: ids.join(',') } }).then((r) => r.data),
  createThread: (body: {
    category: string;
    title: string;
    body: string;
    tags?: string[];
    attachments?: string[];
    /** Agents to run over this post now, by exact name — the composer's version of the tool's `wake`. */
    wake?: string[];
    assignee?: string | null;
    workState?: ForumWorkState | 'none' | null;
    hubThreadId?: string | null;
  }) =>
    api
      .post<ForumThread & { posts: ForumPost[]; summons: SummonsOutcome }>('/forum/threads', body)
      .then((r) => r.data),
  thread: (id: string, limit = 50, offset = 0) =>
    api.get<ForumThreadDetail>(`/forum/threads/${id}`, { params: { limit, offset } }).then((r) => r.data),
  saveThread: (
    id: string,
    patch: Partial<{
      title: string;
      pinned: boolean;
      status: string;
      categoryId: string;
      resolvedPostId: string | null;
      hubThreadId: string | null;
      workState: ForumWorkState | null;
      assignee: ForumAuthor | null;
    }>,
  ) => api.patch<ForumThread>(`/forum/threads/${id}`, patch).then((r) => r.data),
  removeThread: (id: string) => api.delete(`/forum/threads/${id}`).then((r) => r.data),

  reply: (threadId: string, body: string, replyTo?: string | null, attachments?: string[]) =>
    api.post<ForumPost>(`/forum/threads/${threadId}/posts`, { body, replyTo, attachments }).then((r) => r.data),
  savePost: (id: string, body: string, attachments?: string[]) =>
    api.patch<ForumPost>(`/forum/posts/${id}`, { body, attachments }).then((r) => r.data),
  removePost: (id: string) => api.delete(`/forum/posts/${id}`).then((r) => r.data),

  search: (q: string, mode: 'keyword' | 'semantic' | 'both' = 'both', category?: string) =>
    api.get<ForumSearchHit[]>('/forum/search', { params: { q, mode, category } }).then((r) => r.data),

  // --- mentions (FORUM_PLAN.md §11) ----------------------------------------

  /** Who can be addressed. Muted agents are included, flagged — you can still address them. */
  mentionRoster: () => api.get<MentionTarget[]>('/forum/mentions/roster').then((r) => r.data),
  mentions: (params: { status?: string; agentId?: string; threadId?: string; operator?: 1 } = {}) =>
    api.get<ForumMention[]>('/forum/mentions', { params }).then((r) => r.data),
  mentionCount: (agentId?: string) =>
    api
      .get<{ count: number; byAgent?: Record<string, number> }>('/forum/mentions/count', {
        params: { agentId },
      })
      .then((r) => r.data),
  /**
   * Answer a mention: spawns a `forum`-origin session and runs one turn, whose answer is posted back
   * to the thread. Returns as soon as the session exists — the turn streams into the Chat page.
   */
  runMention: (id: string) =>
    api.post<{ sessionId: string; agentName: string }>(`/forum/mentions/${id}/run`).then((r) => r.data),
  setMentionStatus: (id: string, status: 'pending' | 'dismissed') =>
    api.post<{ ok: true; status: string }>(`/forum/mentions/${id}/status`, { status }).then((r) => r.data),

  // --- the file registry ---------------------------------------------------

  files: (params: { q?: string; kind?: string; limit?: number } = {}) =>
    api.get<ForumFile[]>('/forum/files', { params }).then((r) => r.data),
  fileUsage: (id: string) => api.get<ForumFileUsage[]>(`/forum/files/${id}/usage`).then((r) => r.data),
  removeFile: (id: string) => api.delete(`/forum/files/${id}`).then((r) => r.data),
  /** Detach a file from one post, leaving it in the registry — the reversible half of a delete. */
  detachFile: (postId: string, fileId: string) =>
    api.delete(`/forum/posts/${postId}/attachments/${fileId}`).then((r) => r.data),

  async uploadFile(file: File, onProgress?: (percent: number) => void): Promise<ForumFile> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post<ForumFile>('/forum/files', form, {
      onUploadProgress: (e) =>
        onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
    });
    return data;
  },

  /**
   * Direct URL for an `<img>`/`<video>`/download link. Those fetch their own bytes and can't carry an
   * Authorization header, so the token rides as a query param — the forum router accepts it, exactly
   * as the resources router does for session media.
   */
  fileUrl(id: string, download = false): string {
    const token = localStorage.getItem('pleiades_token') ?? '';
    const q = new URLSearchParams();
    if (token) q.set('token', token);
    if (download) q.set('download', '1');
    const query = q.toString();
    return `${API_BASE}/api/forum/files/${id}/content${query ? `?${query}` : ''}`;
  },
};
