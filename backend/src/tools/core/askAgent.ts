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
    'Delegate a question or task to another agent by name and receive its final answer. Use for cross-domain work outside your own scope.',
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

    // Forward images unless the caller opts out. `include_image` defaults to true so a plain "delegate
    // this image to X" works; there's nothing to forward when the turn has no image. A subset can be
    // named by handle via `image_ids`; otherwise all of the turn's images go. Handles are preserved on
    // the forwarded blocks so the sub-agent references the same img_N. Never a filesystem path.
    const pool = ctx.attachedImages ?? [];
    let images: typeof pool | undefined;
    if (args.include_image === false || pool.length === 0) {
      images = undefined;
    } else if (Array.isArray(args.image_ids) && args.image_ids.length) {
      const wanted = new Set(args.image_ids.map((v) => String(v)));
      images = pool.filter((i) => i.id != null && wanted.has(i.id));
      if (images.length === 0) {
        const known = pool.map((i) => i.id).filter(Boolean).join(', ') || '(none have handles)';
        return {
          result: { ok: false, error: `no image matched image_ids ${JSON.stringify(args.image_ids)} (available: ${known})` },
        };
      }
    } else {
      images = pool;
    }
    log.info(
      { from: ctx.agentName, to: target, forwarding: images?.length ?? 0 },
      'ask_agent delegating',
    );

    try {
      const answer = await ctx.invokeSubAgent(target, query, images);
      return { result: { ok: true, agent: target, answer, forwarded_images: images?.length ?? 0 } };
    } catch (err) {
      return { result: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  },
};
