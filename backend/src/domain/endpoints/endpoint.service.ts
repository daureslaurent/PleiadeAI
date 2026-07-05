import OpenAI from 'openai';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { endpointRepository } from './endpoint.repository';
import { EndpointModel, type EndpointDoc } from './endpoint.model';

const log = createLogger('endpoint-service');

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
    log.info({ endpoint: ep.name, count: models.length }, 'discovered models');
    await endpointRepository.setModels(id, models);
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
