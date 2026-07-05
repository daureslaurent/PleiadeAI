import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import type { Tool, ToolConfigField } from '../types';

const log = createLogger('tool:webfetch');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

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
    hint: 'Responses larger than this are truncated before conversion.',
  },
];

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

  async execute(args) {
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
      const raw = (await res.text()).slice(0, maxBytes);
      const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(raw);

      let content = raw;
      if (isHtml && format === 'text') content = htmlToText(raw);
      else if (isHtml && format === 'markdown') content = htmlToMarkdown(raw);

      return {
        result: {
          ok: true,
          url,
          format,
          content_type: contentType,
          truncated: raw.length >= maxBytes,
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
