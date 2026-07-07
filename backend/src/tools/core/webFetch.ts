import { createLogger } from '../../config/logger';
import { agentRepository } from '../../domain/agents/agent.repository';
import { resourceRepository } from '../../domain/resources/resource.repository';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { resolveInference } from '../../inference/inference-resolver';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { Tool, ToolConfigField } from '../types';

const log = createLogger('tool:webfetch');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Heuristic characters-per-token for the response budget (no tokenizer dependency in the tool layer). */
const CHARS_PER_TOKEN = 4;

/** Operator-tunable options rendered on the Tools page. */
const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'default_format',
    label: 'Default format',
    type: 'select',
    options: ['markdown', 'text', 'html'],
    default: 'markdown',
    hint: 'Used when the model omits the `format` argument.',
  },
  {
    key: 'max_bytes',
    label: 'Max response size (bytes)',
    type: 'number',
    default: 5_000_000,
    hint: 'Hard ceiling on the fetched body size (also caps a stored binary blob).',
  },
  {
    key: 'max_response_tokens',
    label: 'Max response tokens',
    type: 'number',
    default: 16000,
    hint: 'Trim long text responses to about this many tokens (~4 chars each), eliding the middle. 0 = fall back to half the agent model’s context window.',
  },
];

/** Compact byte size for the binary-blob note (e.g. `2.4 MB`). */
function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** True when the body is textual (renderable in context); false for PDFs, images, archives, … */
function looksTextual(contentType: string, buf: Buffer): boolean {
  const ct = contentType.toLowerCase();
  if (ct) {
    if (ct.startsWith('text/')) return true;
    if (/(json|xml|javascript|html|csv|yaml|x-www-form-urlencoded)/.test(ct)) return true;
    if (
      ct.startsWith('image/') ||
      ct.startsWith('audio/') ||
      ct.startsWith('video/') ||
      ct.startsWith('font/') ||
      /(pdf|zip|gzip|octet-stream|msword|excel|spreadsheet|presentation|protobuf|x-tar|x-7z)/.test(ct)
    ) {
      return false;
    }
  }
  // Unknown/blank type: sniff for a NUL byte in the head — a reliable binary tell for text-ish formats.
  return !buf.subarray(0, 4096).includes(0);
}

/** Best-effort download filename from Content-Disposition, else the URL's last path segment. */
function deriveFilename(url: string, disposition: string | null): string {
  const m = disposition && /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  try {
    const base = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (base) return base;
  } catch {
    /* fall through */
  }
  return 'download';
}

/** Resolve the agent's model context window (n_ctx), for the token-budget fallback. */
async function agentContextWindow(agentId: string): Promise<number> {
  try {
    const agent = await agentRepository.findById(agentId);
    if (!agent) return 8192;
    const inf = await resolveInference(agent);
    return inf.contextWindow || 8192;
  } catch {
    return 8192;
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/** Drop script/style/head noise so neither format leaks JS/CSS into the model's context. */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript|svg)[\s\S]*?<\/\1>/gi, '');
}

/** Best-effort HTML → plain text: strip every tag, decode entities, tidy whitespace. */
function htmlToText(html: string): string {
  const text = stripNoise(html)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Best-effort HTML → Markdown covering headings, links, emphasis, and lists. */
function htmlToMarkdown(html: string): string {
  let md = stripNoise(html);
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => {
    return `\n\n${'#'.repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`;
  });
  md = md.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, '').trim();
    return label ? `[${label}](${href})` : href;
  });
  md = md
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '_$2_')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${inner.replace(/<[^>]+>/g, '').trim()}`)
    .replace(/<(br)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(md)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * `webfetch` — fetches a URL and returns its content as text, markdown, or raw HTML (mirrors
 * OpenCode's tool name and argument schema so OpenCode-tuned models emit compatible calls).
 * HTML is converted in-process (no external deps); non-HTML bodies are returned verbatim.
 */
export const webFetch: Tool = {
  name: 'webfetch',
  description:
    "Fetches content from a URL and returns it. Use `format` to control the output: 'text' (readable plain text), 'markdown' (structured), or 'html' (raw). Prefer 'markdown' or 'text' for reading pages.",
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute URL to fetch (http/https).' },
      format: {
        type: 'string',
        enum: ['text', 'markdown', 'html'],
        description: 'Output format. Defaults to the tool-configured format.',
      },
      timeout: {
        type: 'number',
        description: `Optional timeout in seconds (max ${MAX_TIMEOUT_MS / 1000}).`,
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  configSchema: CONFIG_SCHEMA,

  async execute(args, ctx) {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { result: { ok: false, error: 'url must be an absolute http(s) URL' } };
    }

    const { config } = await toolConfigService.resolve(webFetch.name, CONFIG_SCHEMA);
    const format = ['text', 'markdown', 'html'].includes(String(args.format))
      ? String(args.format)
      : String(config.default_format);
    const maxBytes = Number(config.max_bytes) || 5_000_000;
    const timeout = Math.min(
      Math.max((Number(args.timeout) || 0) * 1000 || DEFAULT_TIMEOUT_MS, 1_000),
      MAX_TIMEOUT_MS,
    );

    log.info({ url, format, timeout }, 'webfetch');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'user-agent': 'PleiadeAI-webfetch/1.0' },
      });
      if (!res.ok) {
        return { result: { ok: false, status: res.status, error: `request failed (${res.status})` } };
      }

      const contentType = res.headers.get('content-type') ?? '';
      const full = Buffer.from(await res.arrayBuffer());
      const buf = full.subarray(0, maxBytes);
      const overBytes = full.length > maxBytes;

      // Binary body (PDF, image, archive, …): never inline it into context. Persist it as a blob
      // resource and hand the agent a `blob_N` handle it can save to a file (`write` from_handle) or
      // forward — the runner adopts the pre-stored block (storageId set) without re-storing it.
      if (!looksTextual(contentType, buf)) {
        const mime = (contentType.split(';')[0] || 'application/octet-stream').trim();
        const filename = deriveFilename(url, res.headers.get('content-disposition'));
        const stored = await resourceRepository.store({
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          bytes: buf,
          kind: 'blob',
          mime,
          filename,
          source: 'fetch',
        });
        const block: ImageBlock = {
          id: stored.handle,
          kind: 'blob',
          mime,
          size: buf.length,
          filename,
          storageId: String(stored.gridfs_id),
          source: 'tool',
        };
        log.info({ url, mime, size: buf.length, handle: stored.handle }, 'webfetch stored binary blob');
        return {
          result: {
            ok: true,
            url,
            content_type: contentType,
            size: buf.length,
            binary: true,
            reduced: true,
            truncated: overBytes,
            resource_id: stored.handle,
            filename,
            note:
              `[binary ${mime}, ${formatBytes(buf.length)} — saved as ${stored.handle}. ` +
              `Save it with \`write\` (from_handle: "${stored.handle}") or forward with \`ask_agent\`. ` +
              `Not shown inline${overBytes ? '; body exceeded max_bytes and was capped' : ''}.]`,
          },
          resources: [block],
        };
      }

      // Text body: convert, then trim to the token budget with a middle elision so the agent still
      // sees the head and the tail. Budget = configured max, else half the agent model's context.
      const raw = buf.toString('utf8');
      const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(raw);
      let content = raw;
      if (isHtml && format === 'text') content = htmlToText(raw);
      else if (isHtml && format === 'markdown') content = htmlToMarkdown(raw);

      const configuredTokens = Number(config.max_response_tokens);
      const maxTokens =
        configuredTokens > 0 ? configuredTokens : Math.floor((await agentContextWindow(ctx.agentId)) / 2);
      const charBudget = Math.max(200 * CHARS_PER_TOKEN, maxTokens * CHARS_PER_TOKEN);

      let reduced = false;
      let omittedTokens = 0;
      if (content.length > charBudget) {
        const headLen = Math.floor(charBudget * 0.6);
        const tailLen = charBudget - headLen;
        omittedTokens = Math.ceil((content.length - charBudget) / CHARS_PER_TOKEN);
        content =
          content.slice(0, headLen) +
          `\n\n[... ${omittedTokens} tokens omitted ...]\n\n` +
          content.slice(content.length - tailLen);
        reduced = true;
      }

      return {
        result: {
          ok: true,
          url,
          format,
          content_type: contentType,
          truncated: overBytes,
          reduced,
          ...(reduced ? { omitted_tokens: omittedTokens, max_tokens: maxTokens } : {}),
          content,
        },
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const message = aborted ? `timed out after ${timeout}ms` : err instanceof Error ? err.message : String(err);
      log.warn({ url, err: message }, 'webfetch failed');
      return { result: { ok: false, error: message } };
    } finally {
      clearTimeout(timer);
    }
  },
};
