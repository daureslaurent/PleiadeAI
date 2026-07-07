import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { transformSync } from 'esbuild';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { circuitBreaker } from '../../core/circuit-breaker/CircuitBreaker';
import { eventBus } from '../../core/event-bus/EventBus';
import { skillRepository } from '../../domain/skills/skill.repository';
import type { SkillDoc } from '../../domain/skills/skill.model';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { ToolContext, ToolResult } from '../types';

const log = createLogger('skill-sandbox');

/** A base64 image data URL, e.g. `data:image/png;base64,...`. */
const IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * Let a skill hand an image to the agent the same way `read` does: if its result carries an
 * `image` (data URL string) or `images` (array of data URL strings / `{dataUrl}` blocks), lift
 * those out as `ToolResult.images` — so they join the turn's image pool (addressable by handle) and
 * reach a multimodal agent's context — and strip them from the textual result so a big base64 blob
 * never bloats the model's context. Returns the cleaned result + the extracted images.
 */
function extractSkillImages(result: unknown): { result: unknown; images?: ImageBlock[] } {
  if (!result || typeof result !== 'object') return { result };
  const rec = result as Record<string, unknown>;
  const blocks: ImageBlock[] = [];
  const toBlock = (v: unknown): ImageBlock | null => {
    if (typeof v === 'string' && IMAGE_DATA_URL.test(v)) return { dataUrl: v };
    if (v && typeof v === 'object' && typeof (v as { dataUrl?: unknown }).dataUrl === 'string') {
      const url = (v as { dataUrl: string }).dataUrl;
      if (IMAGE_DATA_URL.test(url)) return { dataUrl: url };
    }
    return null;
  };

  if ('image' in rec) {
    const b = toBlock(rec.image);
    if (b) blocks.push(b);
  }
  if (Array.isArray(rec.images)) {
    for (const item of rec.images) {
      const b = toBlock(item);
      if (b) blocks.push(b);
    }
  }
  if (blocks.length === 0) return { result };

  const { image: _image, images: _images, ...rest } = rec;
  return { result: { ...rest, image_count: blocks.length }, images: blocks };
}

/** Result contract shared by the TS worker and the Python runner. */
interface SandboxOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Minimal counting semaphore bounding concurrent sandbox spin-ups. */
class Semaphore {
  private inUse = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.inUse >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.inUse++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse--;
      this.queue.shift()?.();
    };
  }
}

class SkillRunner {
  private readonly pool = new Semaphore(env.SKILL_WORKER_POOL_SIZE);

  /**
   * Execute a dynamic skill under sandbox limits. Guards on the durable `enabled` flag and the
   * in-memory circuit; enforces the hard timeout; on repeated failure trips the breaker,
   * disables the skill in Mongo, and emits a `system:alert`.
   */
  async run(skill: SkillDoc, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!skill.enabled) {
      return { result: { ok: false, error: `skill "${skill.name}" is disabled` } };
    }
    // Isolation enabled but the agent's container isn't ready — hard error, no backend fallback.
    if (ctx.isolationError) {
      return { result: { ok: false, error: ctx.isolationError } };
    }
    if (circuitBreaker.isTripped(skill.name)) {
      return { result: { ok: false, error: `skill "${skill.name}" circuit is open` } };
    }

    const release = await this.pool.acquire();
    const startedAt = Date.now();
    log.info({ skill: skill.name, language: skill.language }, 'sandbox spin-up');

    try {
      // Isolated agents run skills inside their own container (via the planted harnesses), so the
      // agent's Dockerfile packages/tools are what the skill sees. Non-isolated agents keep using
      // the in-process worker / local python3 exactly as before.
      const outcome = ctx.exec
        ? await this.runInContainer(skill, args, ctx)
        : skill.language === 'ts'
          ? await this.runTypeScript(skill.source, args)
          : await this.runPython(skill.source, args);

      const durationMs = Date.now() - startedAt;
      if (!outcome.ok) throw new Error(outcome.error ?? 'skill returned ok:false');

      circuitBreaker.recordSuccess(skill.name);
      log.info({ skill: skill.name, durationMs }, 'sandbox exit ok');
      // A skill may hand back an image (data URL) via `image` / `images`; lift it into the turn's
      // image pool so the agent can analyse or forward it by handle, like a picture read from disk.
      return extractSkillImages(outcome.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ skill: skill.name, err: message }, 'sandbox failure');
      await this.handleFailure(skill.name, message, ctx);
      return { result: { ok: false, error: message } };
    } finally {
      release();
    }
  }

  /** Trip-aware failure bookkeeping: disable in Mongo + alert exactly once on the trip. */
  private async handleFailure(skillName: string, error: string, ctx: ToolContext): Promise<void> {
    const { justTripped } = circuitBreaker.recordFailure(skillName, error);
    if (!justTripped) return;

    await skillRepository.disable(skillName, `circuit tripped: ${error}`.slice(0, 500));
    eventBus.emit('system:alert', {
      ctx: {
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        depth: ctx.depth,
      },
      level: 'error',
      message: `Circuit breaker tripped for skill: ${skillName}`,
    });
  }

  /**
   * Run a skill inside the invoking agent's isolated container. TS is still transpiled here
   * (esbuild) and the resulting CJS is fed to the in-container node harness; Python source goes
   * straight to the in-container python harness. Same `{ok,result|error}` contract as the backend
   * sandbox, so the circuit-breaker / timeout bookkeeping is unchanged.
   */
  private async runInContainer(
    skill: SkillDoc,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<SandboxOutcome> {
    const exec = ctx.exec!;
    let res;
    if (skill.language === 'ts') {
      const { code } = transformSync(skill.source, { loader: 'ts', format: 'cjs', target: 'es2022' });
      res = await exec.runScript('node', { code, args }, { timeoutMs: env.SKILL_TIMEOUT_MS });
    } else {
      res = await exec.runScript('python3', { source: skill.source, args }, { timeoutMs: env.SKILL_TIMEOUT_MS });
    }

    if (res.timedOut) throw new Error(`skill timed out after ${env.SKILL_TIMEOUT_MS}ms`);
    try {
      return JSON.parse(res.stdout || '{"ok":false,"error":"empty output"}') as SandboxOutcome;
    } catch {
      const detail = (res.stderr || res.stdout || '').slice(0, 200);
      throw new Error(`skill harness returned non-JSON (exit ${res.exitCode}): ${detail}`);
    }
  }

  /** Transpile TS → CJS in-memory (esbuild) and run in a fresh, timed worker thread. */
  private runTypeScript(source: string, args: Record<string, unknown>): Promise<SandboxOutcome> {
    const { code } = transformSync(source, {
      loader: 'ts',
      format: 'cjs',
      target: 'es2022',
    });

    const workerPath = path.join(__dirname, 'ts-worker.js');

    return new Promise<SandboxOutcome>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { code, args } });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error(`skill timed out after ${env.SKILL_TIMEOUT_MS}ms`));
      }, env.SKILL_TIMEOUT_MS);

      worker.once('message', (msg: SandboxOutcome) => {
        clearTimeout(timer);
        void worker.terminate();
        resolve(msg);
      });
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.once('exit', (exitCode) => {
        clearTimeout(timer);
        if (exitCode !== 0) reject(new Error(`worker exited with code ${exitCode}`));
      });
    });
  }

  /** Spawn python3 running the harness; exchange JSON over stdin/stdout under a hard timeout. */
  private runPython(source: string, args: Record<string, unknown>): Promise<SandboxOutcome> {
    const runnerPath = path.join(__dirname, 'py-runner', 'runner.py');

    return new Promise<SandboxOutcome>((resolve, reject) => {
      const child = spawn('python3', [runnerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`skill timed out after ${env.SKILL_TIMEOUT_MS}ms`));
      }, env.SKILL_TIMEOUT_MS);

      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (stderr.trim()) log.warn({ stderr: stderr.trim() }, 'python stderr');
        try {
          resolve(JSON.parse(stdout || '{"ok":false,"error":"empty output"}') as SandboxOutcome);
        } catch {
          reject(new Error(`python returned non-JSON (exit ${exitCode}): ${stdout.slice(0, 200)}`));
        }
      });

      child.stdin.write(JSON.stringify({ source, args }));
      child.stdin.end();
    });
  }
}

export const skillRunner = new SkillRunner();
