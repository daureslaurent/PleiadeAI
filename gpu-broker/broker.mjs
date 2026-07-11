#!/usr/bin/env node
/**
 * gpu-broker — a VRAM mutex in front of several GPU-heavy inference containers that can't fit in
 * VRAM at the same time (e.g. a llama.cpp vision server and the image-gen FLUX server on one box).
 *
 * It exposes one HTTP listener per service. When a request arrives, it makes that service the *only*
 * one loaded: it stops whichever other service is running (freeing its VRAM), starts the target
 * container if needed, waits for it to become healthy, then proxies the request. After a service
 * sits idle for `idleTimeoutSec` with no in-flight requests it is stopped again, so the box returns
 * to zero GPU use between bursts.
 *
 * Design notes / invariants:
 *   - At most one managed container runs at a time (the mutex). Enforced by a single serialized
 *     `withLock` critical section around every start/stop decision.
 *   - A swap away from the active service waits until that service has drained (0 in-flight). New
 *     requests can't start during a swap because acquiring a slot also runs inside the lock, so
 *     in-flight only ever decreases while we wait — no deadlock.
 *   - GET /v1/models is answered *locally* from config (no swap), so a client polling for the model
 *     list — the way PleiadesAI discovers an endpoint's models — never triggers an expensive load.
 *   - It only start/stops containers that already exist; it never creates them. Bring each service
 *     up once (its own compose) so the container exists, ideally with `restart: "no"` so the daemon
 *     doesn't fight the broker by respawning a container it just stopped.
 *
 * No dependencies — a bare `node >= 18 broker.mjs` runs it. Config path via BROKER_CONFIG
 * (default ./config.json). Talks to the Docker Engine API over the unix socket.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';

const CONFIG = JSON.parse(readFileSync(process.env.BROKER_CONFIG || './config.json', 'utf8'));
const DOCKER_SOCK = CONFIG.dockerSocket || '/var/run/docker.sock';
const IDLE_MS = (CONFIG.idleTimeoutSec ?? 300) * 1000;
const START_TIMEOUT_MS = (CONFIG.startTimeoutSec ?? 180) * 1000;
const STOP_SETTLE_MS = CONFIG.stopSettleMs ?? 2000; // grace for the driver to reclaim VRAM after stop
const SERVICES = CONFIG.services ?? [];
const byName = new Map(SERVICES.map((s) => [s.name, s]));

const log = (...a) => console.log(new Date().toISOString(), '[gpu-broker]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Docker Engine API over the unix socket (no docker CLI needed in the image).
// ---------------------------------------------------------------------------
function docker(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCK, method, path }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function isRunning(container) {
  const r = await docker('GET', `/containers/${encodeURIComponent(container)}/json`);
  if (r.status === 404) throw new Error(`container "${container}" does not exist (create it first)`);
  if (r.status >= 400) throw new Error(`inspect ${container}: HTTP ${r.status} ${r.body}`);
  return JSON.parse(r.body).State?.Running === true;
}

async function dockerStart(container) {
  const r = await docker('POST', `/containers/${encodeURIComponent(container)}/start`);
  if (r.status >= 400 && r.status !== 304) throw new Error(`start ${container}: HTTP ${r.status} ${r.body}`);
}

async function dockerStop(container) {
  // ?t=30: SIGTERM then SIGKILL after 30s. Returns once the container is actually stopped.
  const r = await docker('POST', `/containers/${encodeURIComponent(container)}/stop?t=30`);
  if (r.status >= 400 && r.status !== 304) throw new Error(`stop ${container}: HTTP ${r.status} ${r.body}`);
}

// ---------------------------------------------------------------------------
// Health probe against the upstream (the container's own port).
// ---------------------------------------------------------------------------
function probe(svc) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: svc.upstreamHost || '127.0.0.1', port: svc.upstreamPort, path: svc.healthPath || '/v1/models', method: 'GET', timeout: 3000 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitHealthy(svc) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(svc)) return true;
    await sleep(1500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The mutex + in-flight accounting.
// ---------------------------------------------------------------------------
let active = null; // name of the currently-loaded service, or null
let lock = Promise.resolve(); // serializes every start/stop decision
const inflight = new Map(); // service name -> count of requests currently being proxied
const idleTimers = new Map();

/** Run `fn` in the single global critical section. */
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function clearIdle(name) {
  const t = idleTimers.get(name);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(name);
  }
}

function scheduleIdle(svc) {
  clearIdle(svc.name);
  idleTimers.set(
    svc.name,
    setTimeout(() => {
      void withLock(async () => {
        if (active === svc.name && (inflight.get(svc.name) || 0) === 0) {
          log(`idle ${IDLE_MS / 1000}s → stopping ${svc.name} (${svc.container})`);
          try {
            await dockerStop(svc.container);
            active = null;
          } catch (e) {
            log(`idle stop of ${svc.name} failed:`, e.message);
          }
        }
      });
    }, IDLE_MS),
  );
}

/**
 * Ensure `svc` is the loaded service and reserve one in-flight slot — atomically, inside the lock.
 * Swaps out the other service (waiting for it to drain) and cold-starts `svc` if needed.
 */
async function acquire(svc) {
  await withLock(async () => {
    if (active && active !== svc.name) {
      const cur = byName.get(active);
      // In-flight can't grow while we hold the lock (new acquires queue behind us), so this drains.
      while ((inflight.get(active) || 0) > 0) await sleep(200);
      clearIdle(active);
      log(`swap: stopping ${active} (${cur.container}) to free VRAM for ${svc.name}`);
      await dockerStop(cur.container);
      await sleep(STOP_SETTLE_MS);
      active = null;
    }
    if (!(await isRunning(svc.container))) {
      log(`starting ${svc.name} (${svc.container})`);
      await dockerStart(svc.container);
    }
    if (!(await probe(svc))) {
      log(`waiting for ${svc.name} to become healthy…`);
      if (!(await waitHealthy(svc))) throw new Error(`${svc.name} did not become healthy in ${START_TIMEOUT_MS / 1000}s`);
    }
    active = svc.name;
    clearIdle(svc.name);
    inflight.set(svc.name, (inflight.get(svc.name) || 0) + 1);
  });
}

function release(svc) {
  const n = Math.max(0, (inflight.get(svc.name) || 1) - 1);
  inflight.set(svc.name, n);
  if (n === 0) scheduleIdle(svc);
}

// ---------------------------------------------------------------------------
// One HTTP listener per service. Path/port both identify the target service.
// ---------------------------------------------------------------------------
function handle(svc, req, res) {
  const path = (req.url || '/').replace(/\/+$/, '') || '/';

  // Broker liveness — never touches the GPU.
  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, active }));
    return;
  }

  // Model discovery — synthesized from config so polling never forces a load/swap.
  if (req.method === 'GET' && path === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: (svc.models || []).map((id) => ({ id, object: 'model', owned_by: 'gpu-broker' })) }));
    return;
  }

  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      release(svc);
    }
  };

  acquire(svc)
    .then(() => {
      const proxyReq = http.request(
        {
          host: svc.upstreamHost || '127.0.0.1',
          port: svc.upstreamPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', (e) => {
        log(`[${svc.name}] upstream error:`, e.message);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `gpu-broker: upstream ${svc.name} error: ${e.message}` }));
        releaseOnce();
      });
      // Release the slot when the response is done. Only abort the upstream if the *response* closed
      // before it finished (a real client disconnect) — NOT when the request body finished sending
      // (IncomingMessage 'close' fires then too, and killing the upstream there aborts the generation).
      res.on('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
        releaseOnce();
      });
      req.pipe(proxyReq);
    })
    .catch((e) => {
      log(`[${svc.name}] acquire failed:`, e.message);
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `gpu-broker: ${svc.name} unavailable: ${e.message}` }));
    });
}

// ---------------------------------------------------------------------------
// Boot: enforce the invariant (stop everything), then open the listeners.
// ---------------------------------------------------------------------------
async function main() {
  if (!SERVICES.length) throw new Error('config has no services');
  log('enforcing clean state — stopping all managed containers');
  for (const svc of SERVICES) {
    try {
      if (await isRunning(svc.container)) {
        await dockerStop(svc.container);
        log(`stopped ${svc.name} (${svc.container})`);
      }
    } catch (e) {
      log(`warning: could not stop ${svc.name}:`, e.message);
    }
  }
  active = null;

  for (const svc of SERVICES) {
    const server = http.createServer((req, res) => handle(svc, req, res));
    server.requestTimeout = 0; // generations can take minutes — don't cut long requests
    server.headersTimeout = 0;
    server.listen(svc.listenPort, () =>
      log(`[${svc.name}] listening on :${svc.listenPort} → ${svc.upstreamHost || '127.0.0.1'}:${svc.upstreamPort} (container ${svc.container})`),
    );
  }
  log(`ready — one of [${SERVICES.map((s) => s.name).join(', ')}] loaded at a time, idle-unload after ${IDLE_MS / 1000}s`);
}

main().catch((e) => {
  log('fatal:', e.message);
  process.exit(1);
});
