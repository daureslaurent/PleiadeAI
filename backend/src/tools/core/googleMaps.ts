import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { googleCredentials, googleGet, NO_KEY_ERROR } from './google-api';
import type { Tool, ToolConfigField } from '../types';

const log = createLogger('tool:google_maps');

const API = 'https://maps.googleapis.com/maps/api';

/** Operator-tunable options rendered on the Tools page (the API key lives in Settings → Connections). */
const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'max_results',
    label: 'Max results',
    type: 'number',
    default: 5,
    hint: 'How many places a search returns to the model.',
  },
];

/** One place as reported back to the model (and rendered as a rich card by the UI). */
interface PlaceHit {
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating: number | null;
  ratings_count: number;
  open_now: boolean | null;
  types: string[];
  /** Canonical Google Maps link for the place. */
  url: string;
}

interface RawPlace {
  name?: string;
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  rating?: number;
  user_ratings_total?: number;
  opening_hours?: { open_now?: boolean };
  types?: string[];
  place_id?: string;
}

function toPlace(r: RawPlace): PlaceHit {
  const lat = r.geometry?.location?.lat ?? 0;
  const lng = r.geometry?.location?.lng ?? 0;
  return {
    name: r.name ?? '',
    address: r.formatted_address ?? '',
    lat,
    lng,
    rating: typeof r.rating === 'number' ? r.rating : null,
    ratings_count: r.user_ratings_total ?? 0,
    open_now: r.opening_hours?.open_now ?? null,
    types: (r.types ?? []).slice(0, 4),
    url: r.place_id
      ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}`
      : `https://www.google.com/maps?q=${lat},${lng}`,
  };
}

async function places(query: string, apiKey: string, limit: number): Promise<PlaceHit[]> {
  const params = new URLSearchParams({ key: apiKey, query });
  const data = (await googleGet(`${API}/place/textsearch/json?${params}`)) as { results?: RawPlace[] };
  return (data.results ?? []).slice(0, limit).map(toPlace);
}

/** Forward (`address`) or reverse (`lat,lng`) geocoding — the API distinguishes by parameter. */
async function geocode(location: string, apiKey: string): Promise<Record<string, unknown>[]> {
  const isCoords = /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(location);
  const params = new URLSearchParams({ key: apiKey });
  params.set(isCoords ? 'latlng' : 'address', location.trim());
  const data = (await googleGet(`${API}/geocode/json?${params}`)) as {
    results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } }; types?: string[] }>;
  };
  return (data.results ?? []).slice(0, 3).map((r) => ({
    address: r.formatted_address ?? '',
    lat: r.geometry?.location?.lat ?? 0,
    lng: r.geometry?.location?.lng ?? 0,
    types: (r.types ?? []).slice(0, 3),
  }));
}

/** Strip the HTML markup the Directions API embeds in step instructions. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function directions(
  origin: string,
  destination: string,
  mode: string,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({ key: apiKey, origin, destination, mode });
  const data = (await googleGet(`${API}/directions/json?${params}`)) as {
    routes?: Array<{
      summary?: string;
      legs?: Array<{
        distance?: { text?: string };
        duration?: { text?: string };
        start_address?: string;
        end_address?: string;
        steps?: Array<{ html_instructions?: string; distance?: { text?: string } }>;
      }>;
    }>;
  };
  const leg = data.routes?.[0]?.legs?.[0];
  if (!leg) return null;
  return {
    summary: data.routes?.[0]?.summary ?? '',
    mode,
    origin: leg.start_address ?? origin,
    destination: leg.end_address ?? destination,
    distance: leg.distance?.text ?? '',
    duration: leg.duration?.text ?? '',
    steps: (leg.steps ?? []).slice(0, 25).map((s) => ({
      instruction: stripHtml(s.html_instructions ?? ''),
      distance: s.distance?.text ?? '',
    })),
  };
}

/**
 * `google_maps` — the Maps web services behind one tool: `places` text-searches points of interest,
 * `geocode` converts address ↔ coordinates (either direction), `directions` routes between two
 * points. Uses the shared Google API key from Settings → Connections (opt-in per agent via
 * `tools_allowed`).
 */
export const googleMaps: Tool = {
  name: 'google_maps',
  description:
    'Query Google Maps. action="places" searches places by text ("pizzeria near Lyon") with rating/address/coords; action="geocode" converts an address to coordinates or "lat,lng" to an address; action="directions" routes between two points (distance, duration, steps).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['places', 'geocode', 'directions'], description: 'What to do.' },
      query: { type: 'string', description: 'Places text query (action="places").' },
      location: { type: 'string', description: 'Address, place name, or "lat,lng" (action="geocode").' },
      origin: { type: 'string', description: 'Route start — address or "lat,lng" (action="directions").' },
      destination: { type: 'string', description: 'Route end — address or "lat,lng" (action="directions").' },
      mode: {
        type: 'string',
        enum: ['driving', 'walking', 'bicycling', 'transit'],
        description: 'Travel mode for directions (default driving).',
      },
      max_results: { type: 'number', description: 'Optional cap on places results (bounded by the tool config).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  configSchema: CONFIG_SCHEMA,

  async execute(args) {
    const action = String(args.action ?? '');
    const { apiKey } = await googleCredentials();
    if (!apiKey) return { result: { ok: false, error: NO_KEY_ERROR } };
    const { config } = await toolConfigService.resolve(googleMaps.name, CONFIG_SCHEMA);

    try {
      if (action === 'places') {
        const query = String(args.query ?? '').trim();
        if (!query) return { result: { ok: false, error: 'query is required for action="places"' } };
        const configured = Number(config.max_results) || 5;
        const requested = Number(args.max_results);
        const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : configured, configured));
        const results = await places(query, apiKey, limit);
        log.info({ query, count: results.length }, 'maps places search');
        return { result: { ok: true, action, query, count: results.length, results } };
      }

      if (action === 'geocode') {
        const location = String(args.location ?? '').trim();
        if (!location) return { result: { ok: false, error: 'location is required for action="geocode"' } };
        const results = await geocode(location, apiKey);
        log.info({ location, count: results.length }, 'maps geocode');
        return { result: { ok: true, action, location, count: results.length, results } };
      }

      if (action === 'directions') {
        const origin = String(args.origin ?? '').trim();
        const destination = String(args.destination ?? '').trim();
        if (!origin || !destination) {
          return { result: { ok: false, error: 'origin and destination are required for action="directions"' } };
        }
        const mode = ['driving', 'walking', 'bicycling', 'transit'].includes(String(args.mode))
          ? String(args.mode)
          : 'driving';
        const route = await directions(origin, destination, mode, apiKey);
        if (!route) return { result: { ok: false, error: `no route found from "${origin}" to "${destination}"` } };
        log.info({ origin, destination, mode }, 'maps directions');
        return { result: { ok: true, action, route } };
      }

      return { result: { ok: false, error: `unknown action "${action}" — use "places", "geocode" or "directions"` } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ action, err: message }, 'google_maps call failed');
      return { result: { ok: false, action, error: message } };
    }
  },
};
