import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { dockerService } from './docker.service';
import { sshMaterialForIsolation, sudoPasswordForIsolation } from './ssh.service';
import { vpnConfigForIsolation, gluetunEnvArgs } from './vpn.service';
import {
  agentContainerName,
  agentVolumeName,
  imgImageName,
  isoGluetunName,
  isoSharedVolumeName,
  HARNESS_DIR,
  WORKSPACE_DIR,
} from './names';
import {
  VISUAL_BOOT_FILE,
  VISUAL_BOOT_SCRIPT,
  VISUAL_CONTROL_LOCK,
  VISUAL_DIR,
  VISUAL_PASS_FILE,
  VISUAL_VNC_SOCK,
} from './visual.template';
import {
  controlDirScript,
  explainSshFailure,
  remoteEval,
  remoteSessionScript,
  remoteTargetOf,
  remoteWriteFile,
  sshArgv,
  REMOTE_MKDIR,
  REMOTE_NODE_RUNNER,
  REMOTE_PY_RUNNER,
  type RemoteTarget,
} from './remote-ssh';
import { imageRepository } from '../domain/images/image.repository';
import { agentRepository } from '../domain/agents/agent.repository';
import { isolationRepository } from '../domain/isolations/isolation.repository';

const log = createLogger('agent-container');

/** Fallback Xvfb geometry when the image sets no explicit resolution (matches the boot-script default). */
const DEFAULT_VISUAL_GEOMETRY = '1280x800x24';

// Remote sudo password material, planted at a fixed (home-independent) path so a static
// `SUDO_ASKPASS` env var can point at the helper regardless of which user the image runs as.
const SUDO_PASS_FILE = `${HARNESS_DIR}/sudo_pass`;
const SUDO_ASKPASS_FILE = `${HARNESS_DIR}/askpass.sh`;

// Persistent bash-session state (OpenCode-style): the working directory is stashed here between
// `docker exec` calls so `cd` carries over. Kept under the harness dir (already created at boot).
const SESSION_DIR = `${HARNESS_DIR}/session`;
const SESSION_CWD_FILE = `${SESSION_DIR}/cwd`;

/**
 * Wrap a user command so the container behaves like a persistent shell: restore the previous cwd
 * (default `/workspace`), run the command, then persist the resulting `$PWD` for the next call —
 * all in one `bash -lc` so a `cd` inside the command is captured. The user's exit code is preserved.
 * The command is embedded verbatim (own lines) so heredocs / multi-line scripts keep working.
 */
function wrapWithSession(command: string): string {
  return [
    `mkdir -p ${SESSION_DIR} 2>/dev/null`,
    `cd "$(cat ${SESSION_CWD_FILE} 2>/dev/null)" 2>/dev/null || cd ${WORKSPACE_DIR} 2>/dev/null || cd /`,
    command,
    `__pl_ec=$?`,
    `printf '%s' "$PWD" > ${SESSION_CWD_FILE} 2>/dev/null`,
    `exit $__pl_ec`,
  ].join('\n');
}

/** Thrown when an isolated agent tries to execute but its profile image isn't built (no fallback). */
export class IsolationNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationNotReadyError';
  }
}

/** The agent-side inputs the manager needs (from the agent doc). */
export interface IsolatedAgent {
  _id: unknown;
  isolation_volume_mode: 'individual' | 'shared';
}

/**
 * How the backend VNC proxy reaches an agent's live desktop. The relay streams over the Docker
 * socket (`docker exec -i <container> socat - UNIX-CONNECT:<vncSock>`), so `container` is the docker
 * container name and `vncSock` the path to x11vnc's RFB Unix socket inside it; `password` is the
 * runtime-generated VNC secret handed to the noVNC client. See `VISUAL_SKILL_PLAN.md` §2.
 */
export interface VisualEndpoint {
  container: string;
  vncSock: string;
  password: string;
}

/** The isolation-profile inputs the manager needs (from the isolation doc). */
export interface IsolationProfile {
  _id: unknown;
  /** The image entity this profile runs (see `images` collection); null until one is picked. */
  image_id: unknown;
  cpus: string;
  memory: string;
  network: string;
  idle_timeout_ms: number;
  /** Remote execution target — read only when `network === 'ssh'` (see remote-ssh.ts). */
  ssh_remote_host?: string;
  ssh_remote_port?: number;
  ssh_remote_user?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Handle bound to one agent's running container. Handed to tools via `ToolContext.exec` so `bash`
 * and skills run inside the container instead of the backend.
 */
export class AgentExecutor {
  /**
   * @param remote  Set only in `ssh` network mode: every command is forwarded to this host instead
   *                of running in the container, which becomes a pure jump box. Invisible to the
   *                agent — the tool surface is identical either way.
   * @param controlPersistSec  How long the multiplexed SSH connection is kept warm between calls.
   */
  constructor(
    private readonly container: string,
    private readonly remote?: RemoteTarget,
    private readonly controlPersistSec: number = 1_800,
  ) {}

  /**
   * Run a shell command in the agent's execution environment, streaming combined stdout/stderr
   * through `onOutput`.
   *
   * Each call is a separate `docker exec`, but the container is long-lived, so we give the agent an
   * OpenCode-style *persistent session*: the working directory is carried across calls via a small
   * state file (`<harness>/session/cwd`). A command that `cd`s somewhere leaves the next command
   * there, and a `cmd &` / `nohup … &` background job keeps running under the container's PID 1 after
   * the exec returns (poll it later from a follow-up call). Env-var/`export` state does *not* persist
   * between calls — only the cwd — so agents should chain state-dependent steps into one command.
   *
   * In `ssh` mode the same contract holds on the *remote* host (cwd persisted in the remote
   * `~/.pleiades/session/cwd`, background jobs surviving under the remote sshd).
   */
  async run(
    command: string,
    opts: { timeoutMs: number; onOutput?: (chunk: string) => void; stdin?: string },
  ): Promise<ExecResult> {
    const argv = this.remote
      ? sshArgv(this.remote, remoteEval(remoteSessionScript(command)), {
          controlPersistSec: this.controlPersistSec,
        })
      : ['bash', '-lc', wrapWithSession(command)];

    const res = await dockerService.exec(this.container, argv, {
      timeoutMs: opts.timeoutMs,
      onOutput: opts.onOutput,
      // Large payloads (e.g. writing a fetched blob to a file) arrive on stdin, not as an argv
      // string — an arg that big overflows ARG_MAX (`E2BIG`). Over SSH, stdin is forwarded to the
      // remote command (which is why the remote script is `eval`'d rather than piped into bash).
      stdin: opts.stdin,
    });
    return this.remote ? this.explainTransportFailure(res) : res;
  }

  /**
   * Run a skill harness with a JSON payload on stdin (mirrors the backend sandbox protocol):
   * `python3 /opt/pleiades/py_runner.py` or `node /opt/pleiades/node_runner.cjs`. Returns the raw
   * stdout (the harness prints a `{ok,result|error}` JSON document) for the caller to parse.
   *
   * In `ssh` mode the harnesses were provisioned into the remote's `~/.pleiades/bin` at ensure time,
   * and SSH forwards the JSON payload on stdin — so the protocol is byte-identical.
   */
  async runScript(
    interpreter: 'python3' | 'node',
    payload: unknown,
    opts: { timeoutMs: number },
  ): Promise<ExecResult> {
    const argv = this.remote
      ? sshArgv(
          this.remote,
          `${interpreter} "${interpreter === 'python3' ? REMOTE_PY_RUNNER : REMOTE_NODE_RUNNER}"`,
          { controlPersistSec: this.controlPersistSec },
        )
      : [
          interpreter,
          interpreter === 'python3'
            ? `${HARNESS_DIR}/py_runner.py`
            : `${HARNESS_DIR}/node_runner.cjs`,
        ];

    const res = await dockerService.exec(this.container, argv, {
      stdin: JSON.stringify(payload),
      timeoutMs: opts.timeoutMs,
    });
    if (!this.remote) return res;
    // The remote login shell may source an rc file that prints to stdout, which would corrupt the
    // harness's single JSON document. Keep only the JSON envelope; the caller parses it strictly.
    return { ...this.explainTransportFailure(res), stdout: isolateJsonDocument(res.stdout) };
  }

  /**
   * SSH reports *its own* failures (auth, host key, unreachable) as exit 255 — indistinguishable to
   * the caller from a remote command that happened to exit 255. Rewrite those into an actionable
   * message so the agent (and the operator) see "host key not pinned", not "exit 255". A command
   * that merely failed on the remote passes through untouched.
   */
  private explainTransportFailure(res: ExecResult): ExecResult {
    if (!this.remote || res.exitCode !== 255) return res;
    return { ...res, stderr: explainSshFailure(this.remote, res.stderr, res.exitCode) };
  }
}

/**
 * Slice out the single `{…}` document a skill harness prints, discarding any shell-rc chatter that a
 * remote login shell may have emitted around it. Returns the input untouched when there's no object
 * to find (the caller's parse error is then the honest one).
 */
function isolateJsonDocument(stdout: string): string {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  return start >= 0 && end > start ? stdout.slice(start, end + 1) : stdout;
}

/**
 * Owns the lifecycle of per-agent containers built from shared isolation-profile images. One
 * long-lived container per agent (reused across calls); the profile owns the image and, for
 * `shared` volume mode, the workspace volume. Handles lazy start/reuse, idle auto-stop, teardown.
 */
class AgentContainerManager {
  /** Serialises concurrent `ensureReady` calls for the same agent (parallel tool calls). */
  private readonly inflight = new Map<string, Promise<AgentExecutor>>();
  /** Idle auto-stop timers, keyed by agent id. */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** Booted visual sessions, keyed by agent id (host/port/password for the VNC proxy). */
  private readonly visualSessions = new Map<string, VisualEndpoint>();
  /** Serialises concurrent `ensureVisual` calls for the same agent. */
  private readonly visualInflight = new Map<string, Promise<VisualEndpoint>>();
  /**
   * Agents whose `ssh`-mode remote has been preflighted + harnessed for the current container. Reset
   * whenever the container goes away (the SSH control sockets live inside it), so a fresh container
   * re-verifies the hop instead of trusting a stale success.
   */
  private readonly remoteProvisioned = new Set<string>();

  private readonly harnessLocalDir = path.join(__dirname, 'harness');

  /**
   * Ensure the agent's container (built from its profile's image) is created and running; return an
   * executor bound to it. Throws `IsolationNotReadyError` if the profile image isn't built — callers
   * must surface this as a tool error and never fall back to the backend.
   */
  async ensureReady(agent: IsolatedAgent, iso: IsolationProfile): Promise<AgentExecutor> {
    const agentId = String(agent._id);
    const existing = this.inflight.get(agentId);
    if (existing) return existing;

    const p = this.doEnsure(agent, iso, agentId).finally(() => this.inflight.delete(agentId));
    this.inflight.set(agentId, p);
    return p;
  }

  /**
   * Ensure the agent's visual desktop is booted inside its (already-running) container and return
   * the endpoint the backend VNC proxy should connect to. Idempotent: the boot script is a no-op if
   * the stack is already up, and the generated VNC password is cached per agent so repeat calls hand
   * back a stable secret. The caller must have run `ensureReady` first (the container must exist and
   * be running); otherwise this throws `IsolationNotReadyError`.
   *
   * Surfaces a clear `IsolationNotReadyError` when the profile image lacks the visual layer (the boot
   * script's preflight fails) — mirroring the "never fall back" isolation contract.
   */
  async ensureVisual(agentId: string): Promise<VisualEndpoint> {
    const existing = this.visualInflight.get(agentId);
    if (existing) return existing;

    const p = this.doEnsureVisual(agentId).finally(() => this.visualInflight.delete(agentId));
    this.visualInflight.set(agentId, p);
    return p;
  }

  private async doEnsureVisual(agentId: string): Promise<VisualEndpoint> {
    const container = agentContainerName(agentId);

    // `ssh` mode: the agent's shell, files and skills live on the remote host, but the desktop would
    // run in the container — the agent would be looking at one machine and typing into another. Refuse
    // rather than hand it an incoherent view of "its" environment.
    if (await this.isRemoteExecAgent(agentId)) {
      throw new IsolationNotReadyError(
        'The visual desktop is not available on an "ssh" isolation profile: this agent executes on a remote host, so a desktop in its container would show a different machine than its shell.',
      );
    }

    if ((await dockerService.containerState(container)) !== 'running') {
      throw new IsolationNotReadyError(
        'The agent container is not running. The desktop can only start once the agent has been used at least once in this session.',
      );
    }

    // One VNC password per agent for the container's lifetime; plant it (mode 600) before boot.
    let session = this.visualSessions.get(agentId);
    const password = session?.password ?? crypto.randomBytes(12).toString('base64url').slice(0, 8);
    await dockerService.exec(
      container,
      ['sh', '-c', `umask 077; mkdir -p ${VISUAL_DIR} && cat > ${VISUAL_PASS_FILE}`],
      { stdin: `${password}\n` },
    );

    // Plant the (idempotent) boot script, then run it and interpret the contract on its result.
    await dockerService.exec(container, ['sh', '-c', `cat > ${VISUAL_BOOT_FILE}`], {
      stdin: VISUAL_BOOT_SCRIPT,
    });
    // Inject the image's configured screen resolution (default when unset). The boot script reads
    // PLEIADES_VISUAL_GEOMETRY; since it's idempotent, a changed resolution only takes effect on a
    // fresh boot (i.e. after the container/desktop restarts).
    const geometry = await this.visualGeometry(agentId);
    const res = await dockerService.exec(container, [
      'sh',
      '-c',
      `PLEIADES_VISUAL_GEOMETRY='${geometry}' bash ${VISUAL_BOOT_FILE}`,
    ]);
    if (res.exitCode !== 0) {
      if (res.stderr.includes('VISUAL_MISSING_BINARIES')) {
        throw new IsolationNotReadyError(
          "This agent's Docker image was built without the visual layer. Open the Images page, add the visual layer snippet to its Dockerfile, and rebuild.",
        );
      }
      throw new IsolationNotReadyError(
        `The visual desktop did not come up: ${res.stderr.trim() || 'timed out'}`,
      );
    }

    session = { container, vncSock: VISUAL_VNC_SOCK, password };
    this.visualSessions.set(agentId, session);
    // Keep the container alive while a desktop is attached.
    this.resetIdle(agentId, 0);
    log.info({ agentId, container }, 'visual desktop ready');
    return session;
  }

  /** Is this agent on an `ssh`-mode profile (i.e. executing on a remote host, not in its container)? */
  private async isRemoteExecAgent(agentId: string): Promise<boolean> {
    const agent = await agentRepository.findById(agentId);
    if (!agent?.isolation_id) return false;
    const iso = await isolationRepository.findById(agent.isolation_id);
    return iso?.network === 'ssh';
  }

  /** Resolve the Xvfb geometry (`<w>x<h>x24`) from the agent's image resolution, else the default. */
  private async visualGeometry(agentId: string): Promise<string> {
    try {
      const agent = await agentRepository.findById(agentId);
      if (!agent?.isolation_id) return DEFAULT_VISUAL_GEOMETRY;
      const iso = await isolationRepository.findById(agent.isolation_id);
      const image = iso?.image_id ? await imageRepository.findById(iso.image_id) : null;
      const w = image?.visual_width;
      const h = image?.visual_height;
      if (w && h && Number.isFinite(w) && Number.isFinite(h)) return `${Math.floor(w)}x${Math.floor(h)}x24`;
    } catch (err) {
      log.warn({ agentId, err: String(err) }, 'visual geometry lookup failed — using default');
    }
    return DEFAULT_VISUAL_GEOMETRY;
  }

  /**
   * Toggle human manual control of the desktop. When `on`, drop a lock file the `visual_act` driver
   * skill checks and refuses to act against — so the operator (driving via noVNC) and the agent don't
   * fight over the mouse/keyboard. Best-effort: requires a running container with the visual dir.
   */
  async setVisualHumanControl(agentId: string, on: boolean): Promise<void> {
    const container = agentContainerName(agentId);
    const cmd = on
      ? `mkdir -p ${VISUAL_DIR} && : > ${VISUAL_CONTROL_LOCK}`
      : `rm -f ${VISUAL_CONTROL_LOCK}`;
    await dockerService.exec(container, ['sh', '-c', cmd]);
  }

  private async doEnsure(
    agent: IsolatedAgent,
    iso: IsolationProfile,
    agentId: string,
  ): Promise<AgentExecutor> {
    const isoId = String(iso._id);
    const container = agentContainerName(agentId);

    // Resolve the profile's referenced image; the container is created from its tag.
    if (!iso.image_id) {
      throw new IsolationNotReadyError(
        `This agent's isolation profile has no image assigned. Open the Isolation page, select the profile, and pick a Docker image.`,
      );
    }
    const imageId = String(iso.image_id);
    const image = imgImageName(imageId);
    const imageDoc = await imageRepository.findById(imageId);
    if (!imageDoc || imageDoc.image_status !== 'built' || !(await dockerService.imageExists(image))) {
      throw new IsolationNotReadyError(
        `The Docker image for this profile is not built. Open the Images page, select it, and click Build.`,
      );
    }

    // VPN mode: bring up (and health-gate) this profile's gluetun container first, then attach the
    // agent container to its network namespace. A freshly (re)created gluetun means the agent
    // container's netns is stale, so drop it and let it recreate against the new namespace.
    let networkOverride: string | undefined;
    if (iso.network === 'vpn') {
      const gluetun = await this.ensureGluetun(isoId);
      networkOverride = `container:${gluetun.name}`;
      if (gluetun.recreated) {
        await dockerService.removeContainer(container).catch(() => undefined);
      }
    }

    // `ssh` mode: the container is only a jump box (every command is forwarded to the remote), so it
    // gets an ordinary NATed bridge netns — `ssh` is not a Docker network name.
    const remote = iso.network === 'ssh' ? this.requireRemoteTarget(iso) : null;
    if (remote) networkOverride = 'bridge';

    const state = await dockerService.containerState(container);
    const created = state === null;
    if (created) {
      await this.createAndProvision(agent, iso, agentId, image, networkOverride);
    } else if (state !== 'running') {
      await dockerService.startContainer(container);
    }

    this.resetIdle(agentId, iso.idle_timeout_ms);
    if (!remote) return new AgentExecutor(container);

    // Preflight the hop and plant the skill harnesses on the remote. Any failure throws
    // IsolationNotReadyError → tools surface it and never fall back to executing in the container.
    await this.ensureRemote(container, agentId, remote, created);
    return new AgentExecutor(
      container,
      remote,
      Math.floor((iso.idle_timeout_ms || env.AGENT_CONTAINER_IDLE_MS) / 1000),
    );
  }

  /** The profile is in `ssh` mode — its remote target must be fully configured to execute anything. */
  private requireRemoteTarget(iso: IsolationProfile): RemoteTarget {
    const remote = remoteTargetOf(iso);
    if (!remote) {
      throw new IsolationNotReadyError(
        'This agent\'s isolation profile is in "ssh" network mode but has no remote target. Open the Isolation page and set the remote host and user.',
      );
    }
    return remote;
  }

  /**
   * Make the container's SSH hop usable: create the control-socket dir, then (once per container
   * lifetime) verify the hop end-to-end and copy the skill harnesses to the remote's
   * `~/.pleiades/bin`. The provisioning command *is* the connectivity preflight — if SSH can't
   * authenticate, reach the host, or verify its key, this throws and the agent's tools hard-fail
   * with an actionable message rather than silently running in the container.
   */
  private async ensureRemote(
    container: string,
    agentId: string,
    remote: RemoteTarget,
    containerWasCreated: boolean,
  ): Promise<void> {
    if (!containerWasCreated && this.remoteProvisioned.has(agentId)) return;

    await dockerService.exec(container, controlDirScript()).catch(() => undefined);

    const argv = (cmd: string) => sshArgv(remote, cmd, { controlPersistSec: 1_800 });
    const check = await dockerService.exec(container, argv(REMOTE_MKDIR), { timeoutMs: 30_000 });
    if (check.exitCode !== 0) {
      throw new IsolationNotReadyError(explainSshFailure(remote, check.stderr, check.exitCode));
    }

    for (const [local, dest] of [
      ['py_runner.py', REMOTE_PY_RUNNER],
      ['node_runner.cjs', REMOTE_NODE_RUNNER],
    ] as const) {
      const source = await fs.readFile(path.join(this.harnessLocalDir, local), 'utf8');
      const res = await dockerService.exec(container, argv(remoteWriteFile(dest)), {
        stdin: source,
        timeoutMs: 30_000,
      });
      if (res.exitCode !== 0) {
        throw new IsolationNotReadyError(
          `Could not install the skill harness on ${remote.user}@${remote.host}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
        );
      }
    }

    this.remoteProvisioned.add(agentId);
    log.info({ agentId, host: remote.host, port: remote.port }, 'remote ssh execution ready');
  }

  /**
   * Ensure this profile's gluetun VPN container is running and its tunnel is healthy, returning its
   * name (for `--network container:…`) and whether it was just (re)created. Throws
   * `IsolationNotReadyError` if VPN isn't configured or the tunnel never comes up — the kill-switch
   * means no traffic leaves until gluetun is connected, so we must never proceed unhealthy.
   */
  private async ensureGluetun(isoId: string): Promise<{ name: string; recreated: boolean }> {
    const name = isoGluetunName(isoId);

    if ((await dockerService.containerState(name)) === 'running') {
      try {
        await dockerService.waitHealthy(name, env.AGENT_VPN_HEALTH_TIMEOUT_MS);
        return { name, recreated: false };
      } catch (err) {
        log.warn({ isoId, err: String(err) }, 'gluetun unhealthy — recreating');
      }
    }

    await dockerService.removeContainer(name).catch(() => undefined);

    const cfg = await vpnConfigForIsolation(isoId);
    if (!cfg) {
      throw new IsolationNotReadyError(
        'VPN is enabled for this profile but not configured. Open the Isolation page and upload a WireGuard .conf file.',
      );
    }

    log.info({ isoId, endpoint: cfg.endpointIp }, 'starting gluetun vpn container');
    await dockerService.createGluetun({
      container: name,
      image: env.GLUETUN_IMAGE,
      envArgs: gluetunEnvArgs(cfg),
      isolationId: isoId,
    });
    await dockerService.startContainer(name);
    try {
      await dockerService.waitHealthy(name, env.AGENT_VPN_HEALTH_TIMEOUT_MS);
    } catch (err) {
      throw new IsolationNotReadyError(
        `VPN tunnel did not come up: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { name, recreated: true };
  }

  /** Create the container from the profile's image, start it, and plant the skill harnesses. */
  private async createAndProvision(
    agent: IsolatedAgent,
    iso: IsolationProfile,
    agentId: string,
    image: string,
    networkOverride?: string,
  ): Promise<void> {
    const isoId = String(iso._id);
    const volume =
      agent.isolation_volume_mode === 'shared'
        ? isoSharedVolumeName(isoId)
        : agentVolumeName(agentId);

    // Decrypt the optional remote sudo password up front: if present we point SUDO_ASKPASS at the
    // helper at create time (the password file itself is planted post-start, never in image layers).
    const sudoPassword = await sudoPasswordForIsolation(isoId);

    log.info({ agentId, isoId, volumeMode: agent.isolation_volume_mode }, 'creating agent container');
    await dockerService.createContainer({
      container: agentContainerName(agentId),
      image,
      volume,
      workdir: WORKSPACE_DIR,
      cpus: iso.cpus || env.AGENT_CONTAINER_CPUS,
      memory: iso.memory || env.AGENT_CONTAINER_MEMORY,
      // `vpn` mode passes a `container:<gluetun>` netns; otherwise the profile's own network policy.
      network: networkOverride || iso.network || env.AGENT_CONTAINER_NETWORK,
      agentId,
      env: sudoPassword ? { SUDO_ASKPASS: SUDO_ASKPASS_FILE } : undefined,
    });
    await dockerService.startContainer(agentContainerName(agentId));

    // Plant harnesses so Python/TS skills run with the same protocol as the backend sandbox.
    const container = agentContainerName(agentId);
    await dockerService.exec(container, ['mkdir', '-p', HARNESS_DIR]);
    await dockerService.cpInto(
      container,
      path.join(this.harnessLocalDir, 'py_runner.py'),
      `${HARNESS_DIR}/py_runner.py`,
    );
    await dockerService.cpInto(
      container,
      path.join(this.harnessLocalDir, 'node_runner.cjs'),
      `${HARNESS_DIR}/node_runner.cjs`,
    );

    await this.installSshKey(container, isoId);
    await this.installSudoPassword(container, isoId, sudoPassword);
  }

  /**
   * Plant the profile's optional remote sudo password into the container at a fixed path (mode 600)
   * plus a SUDO_ASKPASS helper (mode 700) that echoes it, so `sudo -A` works locally and the agent
   * can pipe it into remote `sudo -S` over SSH. Written at runtime (never baked into image layers).
   * Best-effort: a missing password is skipped. `password` is passed in to avoid a second decrypt.
   */
  private async installSudoPassword(
    container: string,
    isoId: string,
    password: string | undefined,
  ): Promise<void> {
    if (!password) return;
    try {
      await dockerService.exec(
        container,
        ['sh', '-c', `umask 077; cat > "${SUDO_PASS_FILE}" && chmod 600 "${SUDO_PASS_FILE}"`],
        { stdin: ensureTrailingNewline(password) },
      );
      await dockerService.exec(
        container,
        ['sh', '-c', `cat > "${SUDO_ASKPASS_FILE}" && chmod 700 "${SUDO_ASKPASS_FILE}"`],
        { stdin: `#!/bin/sh\nexec cat "${SUDO_PASS_FILE}"\n` },
      );
      log.info({ container, isoId }, 'installed sudo password into container');
    } catch (err) {
      log.warn({ container, isoId, err: String(err) }, 'sudo password install failed');
    }
  }

  /**
   * Install the profile's outbound SSH client key into the container's `~/.ssh` (mode 600), plus
   * the optional public key and known_hosts. Written at runtime (never baked into the image) so the
   * private key doesn't leak into image layers. Best-effort: a missing/undecryptable key is skipped.
   */
  private async installSshKey(container: string, isoId: string): Promise<void> {
    const ssh = await sshMaterialForIsolation(isoId);
    if (!ssh.privateKey) return;

    const write = (relPath: string, content: string, mode: string) =>
      // `sh -lc` resolves $HOME for whatever user the image runs as; umask 077 keeps the key private.
      dockerService.exec(
        container,
        ['sh', '-c', `umask 077; mkdir -p "$HOME/.ssh" && cat > "$HOME/.ssh/${relPath}" && chmod ${mode} "$HOME/.ssh/${relPath}"`],
        { stdin: content },
      );

    // Use the filename `ssh` tries by default for the key's algorithm so no `-i`/IdentityFile config
    // is needed inside the container ('' legacy → ed25519).
    const base = ssh.keyType === 'rsa' ? 'id_rsa' : 'id_ed25519';
    try {
      await write(base, ensureTrailingNewline(ssh.privateKey), '600');
      if (ssh.publicKey) await write(`${base}.pub`, ensureTrailingNewline(ssh.publicKey), '644');
      if (ssh.knownHosts) await write('known_hosts', ensureTrailingNewline(ssh.knownHosts), '644');
      log.info({ container, isoId, keyType: base }, 'installed ssh key into container');
    } catch (err) {
      log.warn({ container, isoId, err: String(err) }, 'ssh key install failed');
    }
  }

  /** (Re)arm the idle auto-stop timer; each exec pushes the stop further out. */
  private resetIdle(agentId: string, idleMs: number): void {
    const prev = this.idleTimers.get(agentId);
    if (prev) clearTimeout(prev);
    const ms = idleMs > 0 ? idleMs : env.AGENT_CONTAINER_IDLE_MS;
    const timer = setTimeout(() => {
      this.idleTimers.delete(agentId);
      this.visualSessions.delete(agentId);
      this.remoteProvisioned.delete(agentId);
      log.info({ agentId }, 'idle timeout — stopping container');
      void dockerService.stopContainer(agentContainerName(agentId)).catch((err) => {
        log.warn({ agentId, err: String(err) }, 'idle stop failed');
      });
    }, ms);
    timer.unref?.();
    this.idleTimers.set(agentId, timer);
  }

  private clearIdle(agentId: string): void {
    const t = this.idleTimers.get(agentId);
    if (t) clearTimeout(t);
    this.idleTimers.delete(agentId);
  }

  /** Stop (but keep) the agent's container. */
  async stopAgent(agentId: string): Promise<void> {
    this.clearIdle(agentId);
    this.visualSessions.delete(agentId);
    this.remoteProvisioned.delete(agentId);
    await dockerService.stopContainer(agentContainerName(agentId));
  }

  /** Remove just the agent's container (e.g. after a rebuild or profile change → recreated fresh). */
  async removeAgentContainer(agentId: string): Promise<void> {
    this.clearIdle(agentId);
    this.visualSessions.delete(agentId);
    this.remoteProvisioned.delete(agentId);
    await dockerService.removeContainer(agentContainerName(agentId));
  }

  /** Teardown for an agent: remove its container and (optionally) its individual workspace volume. */
  async teardownAgent(agentId: string, opts: { removeVolume?: boolean } = {}): Promise<void> {
    await this.removeAgentContainer(agentId);
    if (opts.removeVolume) await dockerService.removeVolume(agentVolumeName(agentId));
  }

  /**
   * Remove a profile's gluetun VPN container (e.g. when VPN config / network mode changes, or the
   * profile is deleted). Its agent containers must be recreated afterwards so they don't reference a
   * dead network namespace — callers handle that via `removeAgentContainer`.
   */
  async teardownGluetun(isoId: string): Promise<void> {
    await dockerService.removeContainer(isoGluetunName(isoId)).catch(() => undefined);
  }

  /**
   * Teardown for an isolation profile: remove every assigned agent's container, its gluetun
   * container, and (optionally) the shared workspace volume. Individual agent volumes are left
   * intact. The image is NOT removed — it belongs to the standalone `Image` entity, which may back
   * other profiles; images are deleted from the Images page.
   */
  async teardownIsolation(
    isoId: string,
    agentIds: string[],
    opts: { removeSharedVolume?: boolean } = {},
  ): Promise<void> {
    for (const agentId of agentIds) {
      await this.removeAgentContainer(agentId).catch(() => undefined);
    }
    await this.teardownGluetun(isoId);
    if (opts.removeSharedVolume) await dockerService.removeVolume(isoSharedVolumeName(isoId));
  }
}

export const agentContainerManager = new AgentContainerManager();

/** SSH keys must end with a newline or OpenSSH rejects them ("invalid format"). */
function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}
