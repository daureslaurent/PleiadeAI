import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { env } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('docker');

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface StreamOptions {
  /** Feed this string to the child's stdin, then close it. */
  stdin?: string;
  /** Called for each stdout/stderr chunk as it arrives (live streaming to the UI/build logs). */
  onOutput?: (chunk: string) => void;
  /** Hard wall-clock timeout; on expiry the process is SIGKILL'd and `timedOut` is set. */
  timeoutMs?: number;
}

/**
 * Thin wrapper over the `docker` CLI (available in the backend image via `docker-cli`, talking to
 * the host daemon through the mounted `/var/run/docker.sock`). We shell out rather than add a
 * Docker SDK dependency, matching the codebase's existing "spawn a child process" style.
 */
class DockerService {
  private readonly bin = env.DOCKER_BIN;

  /**
   * Spawn a raw `docker` subcommand and hand back the child process, so callers can pipe binary
   * stdin/stdout directly (used by the file explorer's download/upload — the string-collecting
   * `run` would corrupt non-UTF8 bytes). The caller owns wiring stdio and error handling.
   */
  spawnRaw(argv: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /** Run an arbitrary `docker` subcommand, capturing (and optionally streaming) its output. */
  run(argv: string[], opts: StreamOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : null;

      child.stdout.on('data', (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        opts.onOutput?.(s);
      });
      child.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        opts.onOutput?.(s);
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: timedOut ? 124 : (code ?? -1), stdout, stderr, timedOut });
      });

      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();
    });
  }

  /** Non-throwing existence probe (`docker inspect`). */
  private async exists(kind: 'image' | 'container' | 'volume', ref: string): Promise<boolean> {
    const sub = kind === 'volume' ? ['volume', 'inspect', ref] : [`inspect`, ...(kind === 'image' ? ['--type', 'image'] : []), ref];
    const res = await this.run(sub);
    return res.exitCode === 0;
  }

  imageExists(image: string): Promise<boolean> {
    return this.exists('image', image);
  }

  volumeExists(volume: string): Promise<boolean> {
    return this.exists('volume', volume);
  }

  /** Returns the container's state string (`running`/`exited`/…) or `null` if it doesn't exist. */
  async containerState(container: string): Promise<string | null> {
    const res = await this.run(['inspect', '-f', '{{.State.Status}}', container]);
    if (res.exitCode !== 0) return null;
    return res.stdout.trim();
  }

  /**
   * Container healthcheck status (`starting`/`healthy`/`unhealthy`) or `null` when the container
   * doesn't exist or defines no HEALTHCHECK. The `if` guard emits an empty string for images without
   * a healthcheck so we don't get the literal `<no value>`.
   */
  async containerHealth(container: string): Promise<string | null> {
    const res = await this.run([
      'inspect',
      '-f',
      '{{if .State.Health}}{{.State.Health.Status}}{{end}}',
      container,
    ]);
    if (res.exitCode !== 0) return null;
    const s = res.stdout.trim();
    return s || null;
  }

  /**
   * Poll until a container's healthcheck reports `healthy`, or reject on timeout / `unhealthy` /
   * the container going away. Used to gate isolated agent tools on the VPN tunnel being up.
   */
  async waitHealthy(container: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.containerState(container);
      if (state === null) throw new Error(`container ${container} disappeared while starting`);
      const health = await this.containerHealth(container);
      if (health === 'healthy') return;
      if (health === 'unhealthy') throw new Error(`container ${container} became unhealthy`);
      if (Date.now() >= deadline) {
        throw new Error(`container ${container} not healthy within ${timeoutMs}ms (status: ${health ?? 'none'})`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /**
   * Volume metadata (creation time + host mount path), or `null` if the volume doesn't exist. Parsed
   * from JSON rather than a `-f` template — `docker volume inspect` doesn't process `\t`/`\n` escapes
   * in format strings, so a delimiter-based template would come back malformed.
   */
  async inspectVolume(volume: string): Promise<{ createdAt: string; mountpoint: string } | null> {
    const res = await this.run(['volume', 'inspect', volume]);
    if (res.exitCode !== 0) return null;
    try {
      const [info] = JSON.parse(res.stdout) as Array<{ CreatedAt?: string; Mountpoint?: string }>;
      return { createdAt: info?.CreatedAt ?? '', mountpoint: info?.Mountpoint ?? '' };
    } catch {
      return null;
    }
  }

  /**
   * Containers (running or stopped) that currently mount `volume`. A volume can't be removed while
   * any of these exist, so the caller uses this both to report "in use" and to know what to tear
   * down before a forced delete.
   */
  async containersUsingVolume(volume: string): Promise<Array<{ name: string; state: string }>> {
    const res = await this.run([
      'ps',
      '-a',
      '--filter',
      `volume=${volume}`,
      '--format',
      '{{.Names}}\t{{.State}}',
    ]);
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name = '', state = ''] = l.split('\t');
        return { name, state };
      });
  }

  /**
   * List every pleiade-managed container (agent containers, tagged `pleiade.agent=<agentId>`, and
   * gluetun VPN containers, tagged `pleiade.isolation=<isolationId>`) regardless of run state. Used
   * by the isolation overview to surface running + stale/orphaned instances for cleanup. Two `ps`
   * calls because multiple `--filter label=` are AND-ed, not OR-ed.
   */
  async listManagedContainers(): Promise<
    Array<{ name: string; state: string; agentId?: string; isolationId?: string }>
  > {
    const query = async (label: string) => {
      const res = await this.run([
        'ps',
        '-a',
        '--filter',
        `label=${label}`,
        '--format',
        '{{.Names}}\t{{.State}}\t{{.Label "pleiade.agent"}}\t{{.Label "pleiade.isolation"}}',
      ]);
      if (res.exitCode !== 0) return [];
      return res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name = '', state = '', agentId = '', isolationId = ''] = l.split('\t');
          return { name, state, agentId: agentId || undefined, isolationId: isolationId || undefined };
        });
    };
    const [agents, gluetuns] = await Promise.all([
      query('pleiade.agent'),
      query('pleiade.isolation'),
    ]);
    // De-dupe by container name (a container can't carry both labels today, but be safe).
    const byName = new Map<string, { name: string; state: string; agentId?: string; isolationId?: string }>();
    for (const c of [...agents, ...gluetuns]) byName.set(c.name, c);
    return [...byName.values()];
  }

  /**
   * Build an image from a Dockerfile string. The Dockerfile is streamed to `docker build` via
   * stdin with an empty build context (`-`), so no temp directory or COPY-able files are needed.
   * Build output is streamed through `onOutput`.
   */
  async build(image: string, dockerfile: string, onOutput: (chunk: string) => void): Promise<void> {
    log.info({ image }, 'building agent image');
    // `docker build -` reads the Dockerfile from stdin with an empty build context (no COPY/ADD
    // of local files — the default template doesn't need any). Progress is streamed via onOutput.
    const res = await this.run(['build', '-t', image, '-'], {
      stdin: dockerfile,
      onOutput,
      timeoutMs: env.AGENT_BUILD_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      throw new Error(res.timedOut ? 'docker build timed out' : `docker build failed (exit ${res.exitCode})`);
    }
  }

  async removeImage(image: string): Promise<void> {
    await this.run(['rmi', '-f', image]);
  }

  async removeVolume(volume: string): Promise<void> {
    await this.run(['volume', 'rm', '-f', volume]);
  }

  async stopContainer(container: string): Promise<void> {
    await this.run(['stop', '-t', '5', container]);
  }

  async removeContainer(container: string): Promise<void> {
    await this.run(['rm', '-f', container]);
  }

  async startContainer(container: string): Promise<void> {
    const res = await this.run(['start', container]);
    if (res.exitCode !== 0) throw new Error(`docker start failed: ${res.stderr.trim()}`);
  }

  /**
   * Create (but don't necessarily start) a long-lived container that idles on `sleep infinity`,
   * so we can `docker exec` into it repeatedly. The image's own ENTRYPOINT is reset so a custom
   * one in the operator's Dockerfile can't hijack the keep-alive command.
   */
  async createContainer(opts: {
    container: string;
    image: string;
    volume: string;
    workdir: string;
    cpus: string;
    memory: string;
    network: string;
    agentId: string;
    env?: Record<string, string>;
  }): Promise<void> {
    const argv = [
      'create',
      '--name', opts.container,
      '--label', `pleiade.agent=${opts.agentId}`,
      '-v', `${opts.volume}:${opts.workdir}`,
      '-w', opts.workdir,
      '--cpus', opts.cpus,
      '--memory', opts.memory,
      '--entrypoint', '',
    ];
    // Non-secret env only (e.g. SUDO_ASKPASS path). Passed as argv, never a shell string.
    for (const [k, v] of Object.entries(opts.env ?? {})) argv.push('--env', `${k}=${v}`);
    if (opts.network && opts.network !== 'bridge') argv.push('--network', opts.network);
    argv.push(opts.image, 'sh', '-c', 'tail -f /dev/null');

    const res = await this.run(argv);
    if (res.exitCode !== 0) throw new Error(`docker create failed: ${res.stderr.trim()}`);
  }

  /**
   * Create (but don't start) a dedicated gluetun VPN container for an isolation profile. Needs
   * `NET_ADMIN` + `/dev/net/tun` to bring up the WireGuard tunnel; the profile's agent containers
   * later attach to this container's network namespace. `envArgs` are pre-built `-e KEY=value` pairs
   * (see `gluetunEnvArgs`) and may contain the WireGuard private key — passed as argv, never a shell
   * string. gluetun's own HEALTHCHECK is what `waitHealthy` gates on.
   */
  async createGluetun(opts: {
    container: string;
    image: string;
    envArgs: string[];
    isolationId: string;
  }): Promise<void> {
    const argv = [
      'create',
      '--name', opts.container,
      '--label', `pleiade.isolation=${opts.isolationId}`,
      '--cap-add', 'NET_ADMIN',
      '--device', '/dev/net/tun:/dev/net/tun',
      ...opts.envArgs,
      opts.image,
    ];
    const res = await this.run(argv);
    if (res.exitCode !== 0) throw new Error(`gluetun create failed: ${res.stderr.trim()}`);
  }

  /** Copy a local file into a running/created container (used to plant the skill harnesses). */
  async cpInto(container: string, localPath: string, containerPath: string): Promise<void> {
    const res = await this.run(['cp', localPath, `${container}:${containerPath}`]);
    if (res.exitCode !== 0) throw new Error(`docker cp failed: ${res.stderr.trim()}`);
  }

  /** Run a command inside an already-running container. */
  exec(container: string, argv: string[], opts: StreamOptions = {}): Promise<RunResult> {
    const base = ['exec', ...(opts.stdin !== undefined ? ['-i'] : []), container, ...argv];
    return this.run(base, opts);
  }
}

export const dockerService = new DockerService();
