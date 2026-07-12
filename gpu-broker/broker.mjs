#!/usr/bin/env node
/**
 * gpu-broker — a VRAM mutex in front of several GPU-heavy inference containers that can't fit in
 * VRAM at the same time (e.g. a llama.cpp chat/vision server and the image-gen FLUX server on one box).
 *
 * It exposes one HTTP listener per service. When a request arrives, it makes that service the *only*
 * one loaded: it stops whichever other service is running (freeing its VRAM), starts the target
 * container if needed, waits for it to become **ready**, then proxies the request. A loaded service is
 * only ever stopped when another service needs its VRAM (a swap) — finishing a task does not unload
 * it, so back-to-back requests to the same service stay warm.
 *
 * Design notes / invariants:
 *   - At most one managed container runs at a time (the mutex). Enforced by a single serialized
 *     admission loop (`pump`) around every start/stop decision.
 *   - **Ready means ready to serve, not merely listening.** A llama.cpp server binds its port and
 *     answers `/health` with 503 for many seconds *while it loads the model*, and it closes any
 *     request that arrives in that window ("socket hang up"). Forwarding into that window is what
 *     makes a client see failures, retry, and drag the box into a swap-per-retry ping-pong. So a
 *     probe only counts as ready when the upstream answers with an accepted status (default: 2xx).
 *     A service whose upstream legitimately never returns 2xx until first use (an on-demand model
 *     router) can opt out with `"readyAnyStatus": true`.
 *   - **Swaps are the expensive thing, so we avoid pointless ones.** Admission prefers waiters for
 *     the *already-loaded* service, and after the active service drains we wait `swapGraceMs` and
 *     re-check the queue — a follow-up request for the loaded service (e.g. an agent's chat turn
 *     continuing right after its image tool returned) cancels the swap instead of racing it.
 *     `maxWaitMs` bounds the resulting starvation: a waiter older than that always wins.
 *   - A swap away from the active service waits until it has drained (0 in-flight). New requests
 *     can't be admitted while we wait (admission is serialized), so in-flight only ever decreases —
 *     no deadlock.
 *   - An upstream that drops the connection *before we've sent the client anything* is retried
 *     (`upstreamRetries`) after re-checking readiness, instead of surfacing a 502 the client will
 *     turn into its own retry (and another swap).
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
const IDLE_MS = (CONFIG.idleTimeoutSec ?? 0) * 1000; // 0 → no idle-unload; a service only stops on a swap
const START_TIMEOUT_MS = (CONFIG.startTimeoutSec ?? 180) * 1000;
const STOP_TIMEOUT_SEC = CONFIG.stopTimeoutSec ?? 30; // SIGTERM → SIGKILL grace handed to docker
const STOP_SETTLE_MS = CONFIG.stopSettleMs ?? 2000; // grace for the driver to reclaim VRAM after stop
const SWAP_GRACE_MS = CONFIG.swapGraceMs ?? 1500; // pause before committing a swap, to catch a follow-up
const MAX_WAIT_MS = (CONFIG.maxWaitSec ?? 180) * 1000; // starvation guard: an older waiter always wins
const UPSTREAM_RETRIES = CONFIG.upstreamRetries ?? 3; // retries when the upstream drops us pre-response
const RETRY_DELAY_MS = CONFIG.retryDelayMs ?? 2000;
const MAX_BODY_BYTES = CONFIG.maxBodyBytes ?? 64 * 1024 * 1024; // above this we stream (and can't retry)
const LOG_LEVEL = CONFIG.logLevel || 'info'; // 'debug' also logs probes and per-chunk timings
const SERVICES = CONFIG.services ?? [];
const byName = new Map(SERVICES.map((s) => [s.name, s]));

const log = (...a) => console.log(new Date().toISOString(), '[gpu-broker]', ...a);
const debug = (...a) => {
  if (LOG_LEVEL === 'debug') log(...a);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

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
  const t0 = Date.now();
  const r = await docker('POST', `/containers/${encodeURIComponent(container)}/start`);
  if (r.status >= 400 && r.status !== 304) throw new Error(`start ${container}: HTTP ${r.status} ${r.body}`);
  return Date.now() - t0;
}

async function dockerStop(container) {
  // SIGTERM then SIGKILL after stopTimeoutSec. Returns once the container is actually stopped — a
  // process that ignores SIGTERM (sd-server mid-generation does) burns the whole grace here, which is
  // why the stop duration is logged: a stop that always takes exactly the timeout means SIGKILL.
  const t0 = Date.now();
  const r = await docker('POST', `/containers/${encodeURIComponent(container)}/stop?t=${STOP_TIMEOUT_SEC}`);
  if (r.status >= 400 && r.status !== 304) throw new Error(`stop ${container}: HTTP ${r.status} ${r.body}`);
  return Date.now() - t0;
}

// ---------------------------------------------------------------------------
// Readiness. "Ready" = the upstream answered the health path with an accepted status — NOT merely
// "the socket is open". llama.cpp answers /health with 503 while it loads the model and hangs up on
// anything sent in that window; treating 503 as ready is what produced the socket-hang-up storms.
// `readyAnyStatus: true` restores the lax behaviour for an upstream that only loads on first use.
// ---------------------------------------------------------------------------
function probe(svc) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: svc.upstreamHost || '127.0.0.1',
        port: svc.upstreamPort,
        path: svc.healthPath || '/v1/models',
        method: 'GET',
        timeout: 3000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        const ok = svc.readyAnyStatus ? status > 0 : status >= 200 && status < 300;
        debug(`[${svc.name}] probe ${svc.healthPath || '/v1/models'} → ${status} ${ok ? 'ready' : 'not ready'}`);
        resolve({ ok, status });
      },
    );
    req.on('error', (e) => {
      debug(`[${svc.name}] probe error: ${e.message}`);
      resolve({ ok: false, status: 0 });
    });
    req.on('timeout', () => {
      req.destroy();
      debug(`[${svc.name}] probe timed out`);
      resolve({ ok: false, status: 0 });
    });
    req.end();
  });
}

/** Poll until the service is ready to serve, or START_TIMEOUT_MS elapses. Returns ms waited, or null. */
async function waitReady(svc, tag) {
  const t0 = Date.now();
  const deadline = t0 + START_TIMEOUT_MS;
  let last = 0;
  while (Date.now() < deadline) {
    const r = await probe(svc);
    if (r.ok) return Date.now() - t0;
    // Progress line every ~10s so a slow model load doesn't look like a hang.
    if (Date.now() - last > 10_000) {
      last = Date.now();
      log(`${tag} waiting for ${svc.name} to be ready (last probe: ${r.status || 'no answer'}, ${secs(Date.now() - t0)} elapsed)`);
    }
    await sleep(1500);
  }
  return null;
}

// ---------------------------------------------------------------------------
// State: the mutex, the admission queue, in-flight accounting.
// ---------------------------------------------------------------------------
let active = null; // name of the currently-loaded service, or null
let activeReady = false; // has the active service passed a readiness probe since it started?
let admitting = false; // an admission (possibly a swap + cold start) is in progress
const queue = []; // waiters: { svc, resolve, reject, at, tag }
const inflight = new Map(); // service name -> count of requests currently being proxied
const idleTimers = new Map();
const swaps = []; // timestamps, for the thrash warning
let reqSeq = 0;

const inflightOf = (name) => inflight.get(name) || 0;
const queuedFor = (name) => queue.filter((w) => w.svc.name === name).length;
const stateLine = () => `active=${active ?? 'none'} inflight=${active ? inflightOf(active) : 0} queue=${queue.length}`;

function clearIdle(name) {
  const t = idleTimers.get(name);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(name);
  }
}

function scheduleIdle(svc) {
  clearIdle(svc.name);
  // idleTimeoutSec <= 0 disables idle-unload: the service stays loaded until a swap needs its VRAM.
  if (IDLE_MS <= 0) return;
  idleTimers.set(
    svc.name,
    setTimeout(() => {
      // Don't fight an admission in progress; and never unload a service that still has work queued.
      if (admitting || active !== svc.name || inflightOf(svc.name) > 0 || queuedFor(svc.name) > 0) return;
      admitting = true;
      void (async () => {
        try {
          log(`idle ${IDLE_MS / 1000}s → stopping ${svc.name} (${svc.container})`);
          const took = await dockerStop(svc.container);
          active = null;
          activeReady = false;
          log(`idle stop of ${svc.name} done in ${secs(took)}`);
        } catch (e) {
          log(`idle stop of ${svc.name} failed: ${e.message}`);
        } finally {
          admitting = false;
          void pump();
        }
      })();
    }, IDLE_MS),
  );
}

/** Record a swap and warn when we're thrashing — the symptom that a client is interleaving services. */
function noteSwap(from, to) {
  const now = Date.now();
  swaps.push(now);
  while (swaps.length && now - swaps[0] > 5 * 60_000) swaps.shift();
  if (swaps.length >= 4) {
    log(
      `WARNING: ${swaps.length} swaps in the last 5 min (latest ${from}→${to}). Each swap cold-loads ` +
        `weights; a client alternating between services on every request will spend most of its time loading.`,
    );
  }
}

/**
 * Pick the next waiter to admit. Prefers the already-loaded service (no swap) so a burst of work for
 * the hot service drains before we pay for a swap — unless a waiter has been queued longer than
 * MAX_WAIT_MS, which always wins so the other service can't be starved out.
 */
function pickNext() {
  const now = Date.now();
  const starved = queue.find((w) => now - w.at >= MAX_WAIT_MS);
  if (starved) {
    if (active && starved.svc.name !== active) {
      log(`${starved.tag} waited ${secs(now - starved.at)} (> maxWaitSec) — forcing the swap away from ${active}`);
    }
    return starved;
  }
  if (active) {
    const sameService = queue.find((w) => w.svc.name === active);
    if (sameService) return sameService;
  }
  return queue[0];
}

/** Serialized admission: at most one start/stop decision at a time. */
async function pump() {
  if (admitting) return;
  admitting = true;
  try {
    while (queue.length) {
      const w = pickNext();
      queue.splice(queue.indexOf(w), 1);
      try {
        await ensureLoaded(w.svc, w.tag);
        inflight.set(w.svc.name, inflightOf(w.svc.name) + 1);
        clearIdle(w.svc.name);
        w.resolve();
      } catch (e) {
        w.reject(e);
      }
    }
  } finally {
    admitting = false;
  }
}

/** Make `svc` the loaded, ready service — swapping the other one out if needed. Runs inside `pump`. */
async function ensureLoaded(svc, tag) {
  if (active === svc.name && activeReady) {
    debug(`${tag} ${svc.name} already loaded and ready`);
    return;
  }

  if (active && active !== svc.name) {
    const cur = byName.get(active);
    // Wait for the outgoing service to drain. In-flight can't grow while we're admitting (new
    // requests queue behind us), so this terminates.
    const drainStart = Date.now();
    if (inflightOf(active) > 0) {
      log(`${tag} waiting for ${active} to drain (${inflightOf(active)} in-flight) before the swap`);
      while (inflightOf(active) > 0) await sleep(200);
    }
    // Last chance to avoid the swap: a request for the loaded service may have arrived while it was
    // draining (e.g. an agent's chat turn resuming right after its image tool returned). Serving that
    // first is strictly cheaper than swapping out and back in.
    if (SWAP_GRACE_MS > 0) await sleep(SWAP_GRACE_MS);
    const followUp = queue.some((w) => w.svc.name === active && Date.now() - w.at < MAX_WAIT_MS);
    if (followUp) {
      log(
        `${tag} swap to ${svc.name} deferred — ${queuedFor(active)} request(s) for the loaded ${active} ` +
          `arrived while it drained; serving those first`,
      );
      throw new RequeueError(svc); // `acquire` re-queues this waiter, keeping its original arrival time
    }

    log(`${tag} swap: stopping ${active} (${cur.container}) to free VRAM for ${svc.name}`);
    clearIdle(active);
    const stopMs = await dockerStop(cur.container);
    const forced = stopMs >= STOP_TIMEOUT_SEC * 1000;
    log(
      `${tag} stopped ${active} in ${secs(stopMs)}${forced ? ` (hit the ${STOP_TIMEOUT_SEC}s SIGTERM grace → SIGKILL; it was probably mid-generation)` : ''}` +
        ` (drain took ${secs(Date.now() - drainStart)})`,
    );
    noteSwap(active, svc.name);
    await sleep(STOP_SETTLE_MS);
    active = null;
    activeReady = false;
  }

  const running = await isRunning(svc.container);
  if (!running) {
    log(`${tag} starting ${svc.name} (${svc.container})`);
    await dockerStart(svc.container);
  } else {
    debug(`${tag} ${svc.name} container already running`);
  }

  const first = await probe(svc);
  if (!first.ok) {
    log(`${tag} ${svc.name} not ready yet (probe: ${first.status || 'no answer'}) — waiting for the model to load`);
    const waited = await waitReady(svc, tag);
    if (waited == null) {
      throw new Error(`${svc.name} did not become ready within ${START_TIMEOUT_MS / 1000}s (probe ${svc.healthPath || '/v1/models'})`);
    }
    log(`${tag} ${svc.name} ready after ${secs(waited)}`);
  } else {
    log(`${tag} ${svc.name} ready`);
  }

  active = svc.name;
  activeReady = true;
}

/** Thrown by `ensureLoaded` when a swap was cancelled in favour of the loaded service's queue. */
class RequeueError extends Error {
  constructor(svc) {
    super(`requeue ${svc.name}`);
  }
}

/** Reserve one in-flight slot on `svc`, loading/swapping as needed. */
function acquire(svc, tag) {
  return new Promise((resolve, reject) => {
    // A deferred swap re-queues the waiter with its *original* arrival time, so MAX_WAIT_MS still
    // eventually forces it through — it can't be deferred forever.
    const at = Date.now();
    const onReject = (err) => {
      if (err instanceof RequeueError) {
        queue.push({ svc, resolve, reject: onReject, at, tag });
        return; // we're inside `pump`'s loop; it will pick this up on the next iteration
      }
      reject(err);
    };
    queue.push({ svc, resolve, reject: onReject, at, tag });
    void pump();
  });
}

function release(svc, tag) {
  const n = Math.max(0, inflightOf(svc.name) - 1);
  inflight.set(svc.name, n);
  debug(`${tag} released (${svc.name} in-flight ${n})`);
  if (n === 0) {
    scheduleIdle(svc);
    void pump(); // a waiter for the other service may have been blocked on this drain
  }
}

// ---------------------------------------------------------------------------
// Proxying. The body is buffered (up to maxBodyBytes) so a request can be replayed when the upstream
// drops us before we've written anything back to the client — the "socket hang up" case, which is
// almost always "the model wasn't actually ready". Once response headers are out, we can't retry.
// ---------------------------------------------------------------------------
/**
 * Buffer the request body so it can be replayed on a retry, unless it's too big / chunked to hold —
 * decided from the headers *before* reading, since a consumed stream can no longer be piped.
 * `null` ⇒ stream it straight through (and this request can't be retried).
 */
function readBody(req) {
  const chunked = typeof req.headers['transfer-encoding'] === 'string';
  const len = Number(req.headers['content-length'] || 0);
  if (chunked || len > MAX_BODY_BYTES) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(svc, req, res, body, tag, attempt) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let bytes = 0;
    const headers = { ...req.headers };
    if (body) headers['content-length'] = String(body.length);
    delete headers['transfer-encoding'];

    const proxyReq = http.request(
      {
        host: svc.upstreamHost || '127.0.0.1',
        port: svc.upstreamPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.on('data', (c) => (bytes += c.length));
        proxyRes.pipe(res);
        proxyRes.on('end', () => {
          log(`${tag} ← ${proxyRes.statusCode} in ${secs(Date.now() - t0)} (${kb(bytes)})`);
          resolve({ done: true });
        });
        proxyRes.on('error', (e) => {
          log(`${tag} upstream stream error after ${secs(Date.now() - t0)} / ${kb(bytes)}: ${e.message}`);
          res.end();
          resolve({ done: true });
        });
      },
    );

    proxyReq.on('error', (e) => {
      // Nothing written to the client yet ⇒ the request is still replayable.
      const replayable = !res.headersSent && body !== null;
      log(
        `${tag} upstream error after ${secs(Date.now() - t0)}: ${e.message}` +
          (replayable ? ` (attempt ${attempt}/${UPSTREAM_RETRIES + 1})` : ' (response already started — cannot retry)'),
      );
      resolve({ done: false, replayable, error: e });
    });

    // Only abort the upstream if the *response* closed before it finished (a real client disconnect) —
    // NOT when the request body finished sending.
    res.on('close', () => {
      if (!res.writableFinished) {
        debug(`${tag} client disconnected — aborting upstream`);
        proxyReq.destroy();
      }
    });

    if (body) proxyReq.end(body);
    else req.pipe(proxyReq);
  });
}

async function handle(svc, req, res) {
  const path = (req.url || '/').replace(/\/+$/, '') || '/';

  // Broker liveness — never touches the GPU.
  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        active,
        ready: activeReady,
        admitting,
        inflight: Object.fromEntries(SERVICES.map((s) => [s.name, inflightOf(s.name)])),
        queued: Object.fromEntries(SERVICES.map((s) => [s.name, queuedFor(s.name)])),
        swaps_last_5min: swaps.length,
      }),
    );
    return;
  }

  // Model discovery — synthesized from config so polling never forces a load/swap.
  if (req.method === 'GET' && path === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: (svc.models || []).map((id) => ({ id, object: 'model', owned_by: 'gpu-broker' })) }));
    return;
  }

  const tag = `[${svc.name}#${++reqSeq}]`;
  const t0 = Date.now();
  log(`${tag} ${req.method} ${req.url} — ${stateLine()}`);

  let body;
  try {
    body = await readBody(req);
    if (body === null) log(`${tag} chunked/oversized body — streaming it through (this request can't be retried)`);
  } catch (e) {
    log(`${tag} failed reading request body: ${e.message}`);
    res.writeHead(400).end();
    return;
  }

  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      release(svc, tag);
    }
  };

  try {
    await acquire(svc, tag);
  } catch (e) {
    log(`${tag} acquire failed: ${e.message}`);
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `gpu-broker: ${svc.name} unavailable: ${e.message}` }));
    return;
  }
  debug(`${tag} admitted after ${secs(Date.now() - t0)} — ${stateLine()}`);

  try {
    for (let attempt = 1; attempt <= UPSTREAM_RETRIES + 1; attempt++) {
      const r = await forward(svc, req, res, body, tag, attempt);
      if (r.done) return;
      if (!r.replayable || attempt > UPSTREAM_RETRIES || res.writableEnded) {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `gpu-broker: upstream ${svc.name} error: ${r.error.message}` }));
        return;
      }
      // The upstream took the connection and dropped it: it isn't actually serving yet. Re-probe
      // (which is what readiness should have caught) and replay, rather than handing the client a 502
      // it will retry itself — a client retry can queue behind the other service and cause a swap.
      activeReady = false;
      await sleep(RETRY_DELAY_MS);
      const waited = await waitReady(svc, tag);
      if (waited == null) {
        log(`${tag} ${svc.name} still not ready after the drop — giving up`);
        if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `gpu-broker: ${svc.name} not ready (dropped the connection)` }));
        return;
      }
      activeReady = true;
      log(`${tag} ${svc.name} ready again after ${secs(waited)} — replaying the request (attempt ${attempt + 1})`);
    }
  } finally {
    releaseOnce();
  }
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
        const took = await dockerStop(svc.container);
        log(`stopped ${svc.name} (${svc.container}) in ${secs(took)}`);
      } else {
        log(`${svc.name} (${svc.container}) already stopped`);
      }
    } catch (e) {
      log(`warning: could not stop ${svc.name}: ${e.message}`);
    }
  }
  active = null;
  activeReady = false;

  for (const svc of SERVICES) {
    const server = http.createServer((req, res) => {
      void handle(svc, req, res);
    });
    server.requestTimeout = 0; // generations can take minutes — don't cut long requests
    server.headersTimeout = 0;
    server.listen(svc.listenPort, () =>
      log(
        `[${svc.name}] listening on :${svc.listenPort} → ${svc.upstreamHost || '127.0.0.1'}:${svc.upstreamPort} ` +
          `(container ${svc.container}, ready = ${svc.readyAnyStatus ? 'any answer' : '2xx'} on ${svc.healthPath || '/v1/models'})`,
      ),
    );
  }
  log(
    `ready — one of [${SERVICES.map((s) => s.name).join(', ')}] loaded at a time; ` +
      `${IDLE_MS > 0 ? `idle-unload after ${IDLE_MS / 1000}s` : 'idle-unload disabled (unload only on swap)'}; ` +
      `swapGrace=${SWAP_GRACE_MS}ms maxWait=${MAX_WAIT_MS / 1000}s upstreamRetries=${UPSTREAM_RETRIES} logLevel=${LOG_LEVEL}`,
  );
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — shutting down (managed containers are left as-is)`);
    process.exit(0);
  });
}

main().catch((e) => {
  log('fatal:', e.message);
  process.exit(1);
});
