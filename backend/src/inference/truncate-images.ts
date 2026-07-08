import type { LlamaRequestCapture } from '../core/event-bus/events.types';

/**
 * Replace multimodal image data URLs in a captured request's messages with a compact placeholder
 * (`[image image/png, 148KB]`). Used for the LLM Debug live-start event and the capped debug tier so
 * neither carries megabytes of base64 — the full data URLs live only in the durable archive tier.
 */
export function truncateRequestImages(request: LlamaRequestCapture): LlamaRequestCapture {
  const messages = request.messages.map((m) => {
    const msg = m as { content?: unknown };
    if (!Array.isArray(msg.content)) return m;
    const content = msg.content.map((part) => {
      const p = part as { type?: string; image_url?: { url?: string } };
      if (p.type === 'image_url' && typeof p.image_url?.url === 'string') {
        return { type: 'image_url', image_url: { url: describeDataUrl(p.image_url.url) } };
      }
      return part;
    });
    return { ...(m as object), content };
  });
  return { ...request, messages };
}

/** Turn a `data:` URL into a `[image mime, size]` placeholder; pass other URLs through untouched. */
export function describeDataUrl(url: string): string {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) return url;
  const mime = m[1] ?? 'application/octet-stream';
  const bytes = Math.floor((m[2]?.length ?? 0) * 0.75);
  const kb = bytes >= 1024 ? `${(bytes / 1024).toFixed(0)}KB` : `${bytes}B`;
  return `[image ${mime}, ${kb}]`;
}
