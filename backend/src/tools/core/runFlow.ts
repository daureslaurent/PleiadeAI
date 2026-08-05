import { createLogger } from '../../config/logger';
import { flowRepository } from '../../domain/flows/flow.repository';
import { resourceRepository } from '../../domain/resources/resource.repository';
import { flowRunner, MAX_FLOW_DEPTH } from '../../flows/FlowRunner';
import { flowDepthOf } from '../../flows/flow-depth';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { Tool, ToolResult } from '../types';

const log = createLogger('tool:run_flow');

/**
 * `run_flow` — let an agent execute one of the operator's saved flows (FLOWS_PLAN.md §7).
 *
 * The bridge between the two halves of the app: an agent decides *whether* a pipeline should run and
 * with what inputs; the flow decides *what happens*, in a fixed order the model can't improvise
 * around. The result comes back as text, with any pictures handed over as `img_` handles the agent
 * can look at, forward or save.
 */
export const runFlow: Tool = {
  name: 'run_flow',
  description:
    'Run one of the operator\'s saved flows (a fixed pipeline of agents, media generation and tools) ' +
    'and get its result. Use `list` first to see what exists and what inputs each one takes. ' +
    'A flow runs its steps in a fixed order — prefer it over improvising the same sequence yourself ' +
    'when one already covers the job. Images it produces come back as handles you can view or forward.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'run'],
        description: "'list' enumerates the available flows and their inputs; 'run' executes one.",
      },
      flow: { type: 'string', description: 'For `run`: the flow name (as shown by `list`).' },
      inputs: {
        type: 'object',
        description: 'For `run`: values for the flow\'s inputs, keyed by input name, e.g. {"topic": "…"}.',
        additionalProperties: true,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    const action = String(args.action ?? '').trim();

    if (action === 'list') {
      const flows = await flowRepository.listEnabled();
      return {
        result: {
          ok: true,
          flows: flows.map((flow) => ({
            name: flow.name,
            description: flow.description || undefined,
            inputs: flow.nodes
              .filter((n) => n.type === 'input')
              .map((n) => ({
                name: String(n.config?.key ?? '').trim() || n.id,
                type: String(n.config?.port_type ?? 'text'),
                required: Boolean(n.config?.required),
              })),
          })),
        },
      };
    }

    if (action !== 'run') {
      return { result: { ok: false, error: "action must be 'list' or 'run'" } };
    }

    const name = String(args.flow ?? '').trim();
    if (!name) return { result: { ok: false, error: 'flow is required' } };

    const flow = await flowRepository.findByIdOrName(name);
    if (!flow) return { result: { ok: false, error: `no flow named "${name}" (use action "list")` } };
    if (!flow.enabled) return { result: { ok: false, error: `flow "${flow.name}" is disabled` } };

    const depth = flowDepthOf(ctx.sessionId) + 1;
    if (depth > MAX_FLOW_DEPTH) {
      return {
        result: {
          ok: false,
          error: `flow nesting limit reached (${MAX_FLOW_DEPTH}); this flow is running inside another one`,
        },
      };
    }

    log.info({ flow: flow.name, agent: ctx.agentName, depth }, 'agent running a flow');
    const outcome = await flowRunner.start({
      flow,
      trigger: 'agent',
      inputs: (args.inputs ?? {}) as Record<string, unknown>,
      depth,
    });

    if (outcome.status !== 'success') {
      return { result: { ok: false, flow: flow.name, status: outcome.status, error: outcome.error } };
    }

    // Artifacts live in the *flow run's* session, not the agent's. Hand images over as pixels (so the
    // agent's own pool re-registers them under a handle it can use) and blobs as a note — their bytes
    // are far too large to inline and no model can perceive them anyway.
    const images: ImageBlock[] = [];
    const blobs: { handle: string; mime: string; size: number; filename?: string }[] = [];
    for (const handle of outcome.handles) {
      const doc = await resourceRepository.findByHandle(outcome.runId, handle);
      if (!doc) continue;
      if (doc.kind === 'image') {
        const bytes = await resourceRepository.readBytes(outcome.runId, handle);
        if (bytes) {
          images.push({
            kind: 'image',
            mime: doc.mime,
            source: 'tool',
            dataUrl: `data:${doc.mime};base64,${bytes.toString('base64')}`,
          });
        }
        continue;
      }
      blobs.push({
        handle,
        mime: doc.mime,
        size: doc.size ?? 0,
        filename: doc.filename || undefined,
      });
    }

    return {
      result: {
        ok: true,
        flow: flow.name,
        run_id: outcome.runId,
        output: outcome.output,
        images: images.length || undefined,
        // Video and audio stay in the flow run's session; the operator sees them on the Flows page.
        files: blobs.length ? blobs : undefined,
      },
      images: images.length ? images : undefined,
    };
  },
};
