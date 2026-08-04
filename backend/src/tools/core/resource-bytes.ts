import { resourceRepository } from '../../domain/resources/resource.repository';
import type { ToolContext } from '../types';

/**
 * Read a resource's bytes by handle, from wherever that handle actually lives.
 *
 * Resources reach an agent by two different routes and only one of them is the resource store:
 *
 *  - **Tool-acquired** (a generated image, a fetched PDF) is persisted to GridFS by the runner, so a
 *    handle lookup in the store finds it.
 *  - **User-attached** (an image dropped into the chat) is kept on the message document and seeded
 *    into the turn's pool as a data URL. It is *never* written to the store.
 *
 * Consulting only the store therefore makes a user's own photo unreadable by handle — the agent can
 * see it via `analyze_image` (which reads the pool) and then fails to act on it. Check the pool first,
 * fall back to the store.
 */
export async function readResourceBytes(ctx: ToolContext, handle: string): Promise<Buffer | null> {
  const pooled = ctx.attachedImages?.find((i) => i.id === handle && i.dataUrl);
  const base64 = pooled?.dataUrl?.split(',')[1];
  if (base64) {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > 0) return bytes;
  }
  return resourceRepository.readBytes(ctx.sessionId, handle);
}

/** Handles the agent could have used, for an error message that helps rather than just refusing. */
export function knownHandles(ctx: ToolContext): string[] {
  return (ctx.attachedImages ?? []).map((i) => i.id).filter((id): id is string => Boolean(id));
}

/** `no resource with handle "x" in this session. Available: img_1, img_2.` */
export function unknownHandleError(ctx: ToolContext, handle: string): string {
  const known = knownHandles(ctx);
  return (
    `no resource with handle "${handle}" in this session.` +
    (known.length > 0 ? ` Available: ${known.join(', ')}.` : '')
  );
}
