import OpenAI from 'openai';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { endpointRepository } from './endpoint.repository';
import { EndpointModel, effectiveVision, type EndpointDoc } from './endpoint.model';
import { agentRepository } from '../agents/agent.repository';
import { introspectModels } from '../../inference/llama-introspect';

const log = createLogger('endpoint-service');

/** How long a health probe waits for `/v1/models` before declaring the endpoint down. */
const HEALTH_PROBE_TIMEOUT_MS = 3500;

/** Live reachability snapshot of one endpoint, for the header badge. */
export interface EndpointHealth {
  _id: string;
  name: string;
  up: boolean;
  /** Round-trip of the probe in ms (null when down). */
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
}

/** Display name of the built-in, system-managed local docker fallback endpoint. */
const LOCAL_FALLBACK_NAME = 'Local fallback (CPU)';

/** Strip a trailing slash and append `/v1` so the OpenAI SDK talks to an OpenAI-compatible base. */
function openAiBase(url: string): string {
  return `${url.replace(/\/$/, '')}/v1`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const endpointService = {
  /**
   * Autodiscover the models an endpoint serves via `GET /v1/models` and cache them on the doc.
   * Returns the updated endpoint. Throws on transport/HTTP errors so the route can 502.
   */
  async discoverModels(id: string | Types.ObjectId): Promise<EndpointDoc> {
    const ep = await endpointRepository.findById(id);
    if (!ep) throw new Error('endpoint not found');
    const client = new OpenAI({ baseURL: openAiBase(ep.base_url), apiKey: ep.api_key });
    const res = await client.models.list();
    const models = res.data.map((m) => m.id).filter(Boolean).sort();
    // Probe each model's real context size (runtime n_ctx from /props, else trained n_ctx_train) and
    // vision capability (--mmproj in the launch args / props modalities) so the context meter renders
    // against the honest ceiling and vision turns on without a manual tick.
    const probed = await introspectModels(ep.base_url, ep.api_key);
    log.info(
      {
        endpoint: ep.name,
        count: models.length,
        contexts: Object.keys(probed.contexts).length,
        vision: Object.keys(probed.vision).length,
      },
      'discovered models',
    );
    await endpointRepository.setModels(id, models, probed.contexts, probed.vision);
    // Seed a default model on first discovery (or if the previous default vanished) so agents
    // using this endpoint always resolve to something without an extra manual step.
    let defaultModel = ep.default_model;
    if ((!defaultModel || !models.includes(defaultModel)) && models.length) {
      defaultModel = models[0] ?? '';
    }
    const updated = await endpointRepository.update(id, { default_model: defaultModel });
    return updated ?? ep;
  },

  /**
   * Probe every endpoint's `GET /v1/models` in parallel and report reachability + latency + the
   * served model, annotated with the agents that would route to each endpoint. Never throws: a
   * failed/slow probe just marks that endpoint down.
   */
  async probeHealth(): Promise<EndpointHealth[]> {
    const [endpoints, agents] = await Promise.all([endpointRepository.list(), agentRepository.list()]);
    const defaultId = endpoints.find((e) => e.is_default)?._id.toString();
    return Promise.all(
      endpoints.map(async (ep): Promise<EndpointHealth> => {
        const started = Date.now();
        let up = false;
        let latency: number | null = null;
        let served: string[] = [];
        try {
          const res = await fetch(`${openAiBase(ep.base_url)}/models`, {
            headers: ep.api_key ? { Authorization: `Bearer ${ep.api_key}` } : undefined,
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
          });
          up = res.ok;
          latency = Date.now() - started;
          if (res.ok) {
            const body = (await res.json()) as { data?: Array<{ id?: string }> };
            served = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
          }
        } catch {
          // Unreachable / timed out — reported as down, not an error.
        }
        const epId = ep._id.toString();
        const mine = agents.filter((a) =>
          a.endpoint_id ? a.endpoint_id.toString() === epId : epId === defaultId,
        );
        const model =
          ep.default_model && served.includes(ep.default_model)
            ? ep.default_model
            : (served[0] ?? ep.default_model ?? '');
        return {
          _id: epId,
          name: ep.name,
          up,
          latency_ms: up ? latency : null,
          model,
          vision: effectiveVision(ep, model),
          is_default: ep.is_default,
          fallback_order: ep.fallback_order,
          managed: ep.managed,
          agents: mine.map((a) => ({ name: a.name, color: a.color ?? null })),
        };
      }),
    );
  },

  /**
   * Ensure the built-in local docker fallback shows up as a system-managed endpoint, then kick off
   * background model discovery. Idempotent: creates it on first boot (base_url + a seeded model from
   * env, `fallback_order: 1`), and on later boots only re-asserts the forced URL + managed flag —
   * never clobbering the operator's own model / fallback-position tweaks. Called once at startup;
   * failures are logged, never fatal (the container may still be pulling its GGUF).
   */
  async ensureLocalFallback(): Promise<void> {
    const url = env.LLAMA_FALLBACK_URL;
    const model = env.LLAMA_FALLBACK_MODEL;
    // Match an existing managed endpoint first, else the well-known name (e.g. from the migration seed).
    let ep = (await endpointRepository.findManaged()) ?? (await endpointRepository.findByName(LOCAL_FALLBACK_NAME));

    if (!ep) {
      ep = await endpointRepository.create({
        name: LOCAL_FALLBACK_NAME,
        base_url: url,
        models: [model],
        default_model: model,
        fallback_order: 1,
        managed: true,
      });
      log.info({ url }, 'registered built-in local fallback endpoint');
    } else if (ep.base_url !== url || !ep.managed) {
      // Re-assert the forced URL + managed flag without touching user-tunable fields.
      await EndpointModel.updateOne({ _id: ep._id }, { $set: { base_url: url, managed: true } }).exec();
    }

    const id = ep._id;
    // Discover the served model in the background, retrying while the container finishes booting /
    // downloading its GGUF (first boot can take minutes). Best-effort; a permanent failure is fine.
    void (async () => {
      for (let attempt = 1; attempt <= 30; attempt++) {
        try {
          await this.discoverModels(id);
          log.info('local fallback model discovered');
          return;
        } catch (err) {
          log.debug({ attempt, err: String(err) }, 'local fallback not ready yet — will retry');
          await sleep(20_000);
        }
      }
      log.warn('gave up discovering local fallback model (seeded model name kept)');
    })();
  },
};
