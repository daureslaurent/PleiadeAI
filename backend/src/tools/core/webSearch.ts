import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { googleCredentials, googleGet, NO_KEY_ERROR } from './google-api';
import type { Tool, ToolConfigField } from '../types';

const log = createLogger('tool:web_search');

const REQUEST_TIMEOUT_MS = 15_000;

/** Operator-tunable options rendered on the Tools page. */
const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'provider',
    label: 'Provider',
    type: 'select',
    options: ['duckduckgo', 'searxng', 'tavily', 'google'],
    default: 'duckduckgo',
    hint: 'duckduckgo = free, no key required; searxng = self-hosted; tavily = hosted API (needs a key); google = Custom Search API (key + engine id from Settings → Connections → Google APIs).',
  },
  {
    key: 'endpoint',
    label: 'SearXNG endpoint',
    type: 'string',
    default: 'http://searxng:8080',
    hint: 'Base URL of your SearXNG instance (used when provider is searxng).',
  },
  {
    key: 'api_key',
    label: 'API key',
    type: 'password',
    default: '',
    hint: 'Required for the tavily provider. Not needed for duckduckgo or searxng.',
  },
  {
    key: 'max_results',
    label: 'Max results',
    type: 'number',
    default: 5,
    hint: 'How many results to return to the model per search.',
  },
  {
    key: 'safe_search',
    label: 'Safe search',
    type: 'boolean',
    default: true,
    hint: 'Filter explicit results where the provider supports it.',
  },
];

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** GET/POST helper with a hard timeout so a slow provider can't stall the inference loop. */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        // A browser-like UA avoids the barebones bot responses some endpoints serve.
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`provider returned ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  return (await fetchWithTimeout(url, init)).json();
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

/** Strip tags and decode the handful of entities DuckDuckGo emits in titles/snippets. */
function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo wraps result links in a redirect; pull the real target out of the `uddg` param. */
function unwrapDuckUrl(href: string): string {
  const raw = href.startsWith('//') ? `https:${href}` : href;
  try {
    const u = new URL(raw);
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : raw;
  } catch {
    return raw;
  }
}

/**
 * Scrape DuckDuckGo's keyless HTML endpoint. Not an official API, so the markup can shift — we
 * parse defensively and simply return fewer hits if a block doesn't match.
 */
async function searchDuckDuckGo(
  query: string,
  cfg: Record<string, string | number | boolean>,
  limit: number,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, kp: cfg.safe_search ? '1' : '-1' });
  const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?${params}`);
  const html = await res.text();

  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...html.matchAll(snippetRe)].map((m) => cleanText(m[1] ?? ''));

  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    if (hits.length >= limit) break;
    const title = cleanText(m[2] ?? '');
    if (!title) continue;
    hits.push({ title, url: unwrapDuckUrl(m[1] ?? ''), snippet: snippets[i] ?? '' });
    i++;
  }
  return hits;
}

async function searchSearxng(
  query: string,
  cfg: Record<string, string | number | boolean>,
  limit: number,
): Promise<SearchHit[]> {
  const base = String(cfg.endpoint).replace(/\/+$/, '');
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    safesearch: cfg.safe_search ? '1' : '0',
  });
  const data = (await fetchJson(`${base}/search?${params}`)) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

async function searchTavily(
  query: string,
  cfg: Record<string, string | number | boolean>,
  limit: number,
): Promise<SearchHit[]> {
  const apiKey = String(cfg.api_key);
  if (!apiKey) throw new Error('tavily provider requires an API key (set it on the Tools page)');
  const data = (await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      safe_search: Boolean(cfg.safe_search),
    }),
  })) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
}

/**
 * Google Custom Search JSON API. Unlike the other providers, its credentials are the *shared*
 * Google APIs connection (Settings → Connections), not this tool's config — one key serves
 * web_search, youtube and google_maps. The API caps `num` at 10 per request.
 */
async function searchGoogle(query: string, safeSearch: boolean, limit: number): Promise<SearchHit[]> {
  const { apiKey, cseId } = await googleCredentials();
  if (!apiKey) throw new Error(NO_KEY_ERROR);
  if (!cseId) {
    throw new Error(
      'Google Custom Search engine id (cx) not configured — set it in Settings → Connections → Google APIs',
    );
  }
  const params = new URLSearchParams({
    key: apiKey,
    cx: cseId,
    q: query,
    num: String(Math.min(limit, 10)),
    safe: safeSearch ? 'active' : 'off',
  });
  const data = (await googleGet(`https://www.googleapis.com/customsearch/v1?${params}`)) as {
    items?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  return (data.items ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

/**
 * `web_search` — queries the web through an operator-configured provider (self-hosted SearXNG by
 * default, hosted Tavily, or the Google Custom Search API). Provider, endpoint, API key and result
 * count are all set from the Tools page and read fresh on every call, so retuning never needs a
 * redeploy (the google provider's credentials live in Settings → Connections instead).
 */
export const webSearch: Tool = {
  name: 'web_search',
  description:
    'Search the web and return a ranked list of results (title, url, snippet). Use for current events, documentation lookups, and facts outside your training data.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      max_results: {
        type: 'number',
        description: 'Optional cap on the number of results (bounded by the tool config).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  configSchema: CONFIG_SCHEMA,

  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) return { result: { ok: false, error: 'query is required' } };

    const { config } = await toolConfigService.resolve(webSearch.name, CONFIG_SCHEMA);
    const configured = Number(config.max_results) || 5;
    const requested = Number(args.max_results);
    const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : configured, configured));
    const provider = String(config.provider);

    log.info({ query, provider, limit }, 'web search');

    try {
      let results: SearchHit[];
      if (provider === 'google') results = await searchGoogle(query, Boolean(config.safe_search), limit);
      else if (provider === 'tavily') results = await searchTavily(query, config, limit);
      else if (provider === 'searxng') results = await searchSearxng(query, config, limit);
      else results = await searchDuckDuckGo(query, config, limit);
      return { result: { ok: true, provider, query, count: results.length, results } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ query, provider, err: message }, 'web search failed');
      return { result: { ok: false, provider, error: message } };
    }
  },
};
