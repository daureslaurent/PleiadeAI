import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:ask_agent');

/**
 * Core cross-agent tool (spec §4). Delegates a query to another agent and returns its answer.
 *
 * The actual recursion — depth increment, the `MAX_AGENT_HOPS` guard, and the `agent:ask_agent`
 * event — lives in the orchestrator's injected `invokeSubAgent`. This tool stays a thin adapter
 * so the sandbox/tool layer never imports the AgentRunner (avoids a dependency cycle).
 */
export const askAgent: Tool = {
  name: 'ask_agent',
  description:
    'Delegate a question or task to another agent by name and receive its final answer. Use for ' +
    'cross-domain work outside your own scope. Images available this turn are forwarded so the ' +
    'delegate can see them. Binary resources (blob_ handles) are NOT forwarded as pixels — they are ' +
    "already shared across the whole session, so to hand a blob to the delegate just name its handle " +
    'in `query` (e.g. "analyse blob_1"); it reaches it with the `data` tool. The sub-agent may hand ' +
    'images back, loaded into your turn as new img_ handles.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Target agent name, e.g. "home_coordinator".' },
      query: { type: 'string', description: 'The question or task to delegate.' },
      include_image: {
        type: 'boolean',
        description:
          "Forward the image(s) available this turn (attached, or read/acquired by a tool) to the sub-agent — e.g. hand a screenshot to a vision specialist. Defaults to true when any image is present; set false to forward none. The image travels as data, never a file path.",
      },
      image_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Forward only these image handles (e.g. ["img_1"]). Omit to forward all images in this turn (subject to include_image).',
      },
    },
    required: ['agent', 'query'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const target = String(args.agent ?? '').trim();
    const query = String(args.query ?? '').trim();

    if (!ctx.invokeSubAgent) {
      return {
        result: {
          ok: false,
          error: 'Cross-agent hop limit reached; cannot delegate further.',
        },
      };
    }
    if (!target || !query) {
      return { result: { ok: false, error: 'agent and query are required' } };
    }

    // Forward images (pixels) unless the caller opts out — blobs are excluded: they're session-shared,
    // so the delegate reaches them by handle via the `data` tool (no bytes to move, no re-persist).
    // `include_image` defaults to true; a subset can be named by handle via `image_ids`. Handles are
    // preserved on the forwarded blocks so the sub-agent references the same img_N. Never a file path.
    const pics = (ctx.attachedImages ?? []).filter((i) => (i.kind ?? 'image') === 'image' && i.dataUrl);
    let images: typeof pics | undefined;
    if (args.include_image === false || pics.length === 0) {
      images = undefined;
    } else if (Array.isArray(args.image_ids) && args.image_ids.length) {
      const wanted = new Set(args.image_ids.map((v) => String(v)));
      const named = pics.filter((i) => i.id != null && wanted.has(i.id));
      // Named handles that resolve to blobs aren't forwarded as pixels — that's fine, the delegate
      // still reaches them via `data` in the shared session. Only send anything if images matched.
      images = named.length ? named : undefined;
    } else {
      images = pics;
    }
    log.info(
      { from: ctx.agentName, to: target, forwarding: images?.length ?? 0 },
      'ask_agent delegating',
    );

    try {
      const { text, images: returned } = await ctx.invokeSubAgent(target, query, images);
      // Images the sub-agent handed back join this turn's pool (via ToolResult.images → the runner
      // registers them), so the caller can see, analyse, or re-forward them. Only images ride back:
      // any blob the sub-agent made is already session-shared and reachable by handle, so re-handing
      // it would just duplicate it under a new handle. Strip the child's handle (`id`) so the caller's
      // pool assigns a fresh, collision-free one.
      const handedBack =
        returned
          ?.filter((i) => (i.kind ?? 'image') === 'image' && i.dataUrl)
          .map(({ id: _id, ...rest }) => rest) ?? [];
      return {
        result: {
          ok: true,
          agent: target,
          answer: text,
          forwarded_images: images?.length ?? 0,
          returned_images: handedBack.length,
        },
        images: handedBack.length ? handedBack : undefined,
      };
    } catch (err) {
      return { result: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  },
};
