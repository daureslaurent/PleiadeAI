import { Router } from 'express';
import { endpointRepository } from '../../../domain/endpoints/endpoint.repository';
import { endpointGate, type EndpointStat } from '../../../inference/endpoint-gate';

/**
 * Read-only LLM activity: every configured endpoint joined with its live call metrics (active /
 * queued depth, totals, tokens, per-model breakdown) from the {@link endpointGate}. Powers the LLM
 * page. Metrics are in-process and reset on restart — they describe this backend's live traffic.
 */
export const llmRouter = Router();

const norm = (url: string): string => url.replace(/\/$/, '');

/** Shape one endpoint's stats into a JSON-friendly payload (Maps → arrays). */
function serialize(stat: EndpointStat | undefined) {
  if (!stat) {
    return {
      active: 0,
      queued: 0,
      calls: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      avgDurationMs: 0,
      lastCallAt: null as number | null,
      lastModel: null as string | null,
      byModel: [] as unknown[],
    };
  }
  return {
    active: stat.active,
    queued: stat.queued,
    calls: stat.calls,
    errors: stat.errors,
    promptTokens: stat.promptTokens,
    completionTokens: stat.completionTokens,
    avgDurationMs: stat.calls ? Math.round(stat.totalDurationMs / stat.calls) : 0,
    lastCallAt: stat.lastCallAt,
    lastModel: stat.lastModel,
    byModel: [...stat.models.values()]
      .map((m) => ({
        model: m.model,
        calls: m.calls,
        errors: m.errors,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
        avgDurationMs: m.calls ? Math.round(m.totalDurationMs / m.calls) : 0,
        lastCallAt: m.lastCallAt,
      }))
      .sort((a, b) => b.calls - a.calls),
  };
}

llmRouter.get('/stats', async (_req, res) => {
  const [endpoints, snapshot] = await Promise.all([
    endpointRepository.list(),
    Promise.resolve(endpointGate.snapshot()),
  ]);
  const byUrl = new Map(snapshot.map((s) => [s.url, s]));

  const rows = endpoints.map((ep) => {
    const url = norm(ep.base_url);
    const stat = byUrl.get(url);
    byUrl.delete(url); // consumed — leftovers are calls to unregistered URLs (side tasks)
    return {
      _id: String(ep._id),
      name: ep.name,
      base_url: ep.base_url,
      models: ep.models,
      default_model: ep.default_model,
      is_default: ep.is_default,
      fallback_order: ep.fallback_order,
      managed: ep.managed,
      unregistered: false,
      metrics: serialize(stat),
    };
  });

  // Any remaining metrics belong to URLs with no matching endpoint doc (e.g. the legacy global
  // settings connection used by side tasks). Surface them so no traffic is hidden.
  for (const s of byUrl.values()) {
    rows.push({
      _id: `url:${s.url}`,
      name: s.url,
      base_url: s.url,
      models: [...s.models.keys()],
      default_model: '',
      is_default: false,
      fallback_order: 0,
      managed: false,
      unregistered: true,
      metrics: serialize(s),
    });
  }

  res.json(rows);
});
