import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { googleCredentials, googleGet, NO_KEY_ERROR } from './google-api';
import type { Tool, ToolConfigField } from '../types';

const log = createLogger('tool:youtube');

const API = 'https://www.googleapis.com/youtube/v3';

/** Operator-tunable options rendered on the Tools page (the API key lives in Settings → Connections). */
const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'max_results',
    label: 'Max results',
    type: 'number',
    default: 5,
    hint: 'How many videos a search returns to the model (the YouTube API caps a page at 50).',
  },
  {
    key: 'safe_search',
    label: 'Safe search',
    type: 'boolean',
    default: true,
    hint: 'Filter restricted content from search results.',
  },
];

/** One video as reported back to the model (and rendered as a rich card by the UI). */
interface VideoHit {
  video_id: string;
  url: string;
  title: string;
  channel: string;
  published_at: string;
  description: string;
  /** Medium thumbnail (320×180) — the UI renders it; the model just sees the URL. */
  thumbnail: string;
}

/**
 * Pull a video id out of whatever the model hands us: a bare 11-char id, a `watch?v=` URL,
 * `youtu.be/<id>`, or a `/shorts/<id>` URL.
 */
function parseVideoId(input: string): string | null {
  const raw = input.trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/^\/(?:shorts\/|embed\/)?([\w-]{11})$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** `PT1H2M3S` → `1:02:03` (ISO-8601 duration, as the videos endpoint reports it). */
function formatDuration(iso: string): string {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return iso;
  const [h, min, s] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const mm = h ? String(min).padStart(2, '0') : String(min);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

interface SearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
    description?: string;
    thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
  };
}

async function searchVideos(query: string, apiKey: string, limit: number, safe: boolean): Promise<VideoHit[]> {
  const params = new URLSearchParams({
    key: apiKey,
    part: 'snippet',
    type: 'video',
    q: query,
    maxResults: String(Math.min(limit, 50)),
    safeSearch: safe ? 'moderate' : 'none',
  });
  const data = (await googleGet(`${API}/search?${params}`)) as { items?: SearchItem[] };
  return (data.items ?? [])
    .filter((i) => i.id?.videoId)
    .map((i) => ({
      video_id: i.id!.videoId!,
      url: `https://www.youtube.com/watch?v=${i.id!.videoId}`,
      title: i.snippet?.title ?? '',
      channel: i.snippet?.channelTitle ?? '',
      published_at: i.snippet?.publishedAt ?? '',
      description: i.snippet?.description ?? '',
      thumbnail: i.snippet?.thumbnails?.medium?.url ?? i.snippet?.thumbnails?.default?.url ?? '',
    }));
}

async function videoDetails(id: string, apiKey: string): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({
    key: apiKey,
    part: 'snippet,statistics,contentDetails',
    id,
  });
  const data = (await googleGet(`${API}/videos?${params}`)) as {
    items?: Array<{
      snippet?: SearchItem['snippet'] & { tags?: string[] };
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
      contentDetails?: { duration?: string };
    }>;
  };
  const item = data.items?.[0];
  if (!item) return null;
  return {
    video_id: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: item.snippet?.title ?? '',
    channel: item.snippet?.channelTitle ?? '',
    published_at: item.snippet?.publishedAt ?? '',
    description: item.snippet?.description ?? '',
    thumbnail: item.snippet?.thumbnails?.medium?.url ?? '',
    tags: (item.snippet as { tags?: string[] } | undefined)?.tags?.slice(0, 10) ?? [],
    duration: item.contentDetails?.duration ? formatDuration(item.contentDetails.duration) : '',
    views: Number(item.statistics?.viewCount ?? 0),
    likes: Number(item.statistics?.likeCount ?? 0),
    comments: Number(item.statistics?.commentCount ?? 0),
  };
}

/**
 * `youtube` — the YouTube Data API v3 behind one tool: `search` finds videos by query, `video`
 * fetches one video's full stats/metadata by id or URL. Uses the shared Google API key from
 * Settings → Connections (opt-in per agent via `tools_allowed`).
 */
export const youtube: Tool = {
  name: 'youtube',
  description:
    'Query YouTube. action="search" finds videos by query (title, channel, published date, URL). action="video" fetches one video\'s details and stats (duration, views, likes, description, tags) by video URL or id.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'video'], description: 'What to do.' },
      query: { type: 'string', description: 'Search query (action="search").' },
      video: { type: 'string', description: 'Video URL or 11-character id (action="video").' },
      max_results: { type: 'number', description: 'Optional cap on search results (bounded by the tool config).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  configSchema: CONFIG_SCHEMA,

  async execute(args) {
    const action = String(args.action ?? '');
    const { apiKey } = await googleCredentials();
    if (!apiKey) return { result: { ok: false, error: NO_KEY_ERROR } };
    const { config } = await toolConfigService.resolve(youtube.name, CONFIG_SCHEMA);

    try {
      if (action === 'search') {
        const query = String(args.query ?? '').trim();
        if (!query) return { result: { ok: false, error: 'query is required for action="search"' } };
        const configured = Number(config.max_results) || 5;
        const requested = Number(args.max_results);
        const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : configured, configured));
        const results = await searchVideos(query, apiKey, limit, Boolean(config.safe_search));
        log.info({ query, count: results.length }, 'youtube search');
        return { result: { ok: true, action, query, count: results.length, results } };
      }

      if (action === 'video') {
        const id = parseVideoId(String(args.video ?? ''));
        if (!id) return { result: { ok: false, error: 'video must be a YouTube URL or 11-character video id' } };
        const video = await videoDetails(id, apiKey);
        if (!video) return { result: { ok: false, error: `no video found for id ${id}` } };
        log.info({ id }, 'youtube video details');
        return { result: { ok: true, action, video } };
      }

      return { result: { ok: false, error: `unknown action "${action}" — use "search" or "video"` } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ action, err: message }, 'youtube call failed');
      return { result: { ok: false, action, error: message } };
    }
  },
};
