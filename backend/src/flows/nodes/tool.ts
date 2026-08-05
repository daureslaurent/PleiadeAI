import { createLogger } from '../../config/logger';
import { agentRepository } from '../../domain/agents/agent.repository';
import { isolationRepository } from '../../domain/isolations/isolation.repository';
import {
  agentContainerManager,
  type AgentExecutor,
  type IsolatedAgent,
  type IsolationProfile,
} from '../../isolation/AgentContainerManager';
import { getCoreTool } from '../../tools/registry';
import { skillRepository } from '../../domain/skills/skill.repository';
import { skillRunner } from '../../tools/sandbox/SkillRunner';
import type { Tool, ToolContext } from '../../tools/types';
import type { ImageBlock } from '../../core/event-bus/events.types';
import { handleValue, jsonValue, textValue, type FlowValue } from '../port-types';
import type { FlowNodeContext, FlowNodeHandler } from '../types';

const log = createLogger('flow:tool-node');

/**
 * `tool` — run any registered core tool or enabled skill as a graph node.
 *
 * This is what keeps the palette from being a fixed list: `web_search`, `bash`, the file tools, Gmail
 * and every user-authored skill are already uniform `Tool`s with a JSON schema, so one node type
 * exposes all of them. Arguments come from a JSON object the operator writes (templated), because the
 * per-tool schema is only known at run time — the inspector shows the schema alongside the field.
 */
export const toolNode: FlowNodeHandler = {
  type: 'tool',
  label: 'Tool',
  group: 'tool',
  description: 'Runs any core tool or skill (web_search, bash, the file tools, your own skills…).',
  inputs: [
    { name: 'text', types: ['text', 'json'], description: 'Available to the arguments as {{input}}.' },
    { name: 'run', types: ['signal'] },
  ],
  outputs: [
    { name: 'default', types: ['json'], description: "The tool's result." },
    { name: 'text', types: ['text'], description: 'The result rendered as text.' },
    { name: 'images', types: ['image'], description: 'Images the tool produced, by handle.' },
    { name: 'done', types: ['signal'] },
  ],
  config: [
    {
      key: 'tool',
      label: 'Tool',
      type: 'select',
      optionsSource: 'tools',
      default: '',
      hint: 'Which tool or skill this node calls.',
    },
    {
      key: 'args',
      label: 'Arguments (JSON)',
      type: 'string',
      default: '{}',
      hint: 'The tool\'s arguments. Supports {{node_id}} references, e.g. {"query": "{{n1}}"}.',
    },
    {
      key: 'run_as_agent',
      label: 'Run as agent',
      type: 'select',
      optionsSource: 'agents',
      default: '',
      hint: "Execute inside this agent's isolation container or SSH host. Leave empty to run in the backend.",
    },
  ],

  validate(node) {
    const errors: string[] = [];
    const name = String(node.config.tool ?? '').trim();
    if (!name) errors.push('no tool is selected');
    const args = String(node.config.args ?? '').trim();
    // Templates make the string invalid JSON until interpolation, so only check literal argument sets.
    if (args && !args.includes('{{')) {
      try {
        const parsed: unknown = JSON.parse(args);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          errors.push('arguments must be a JSON object');
        }
      } catch {
        errors.push('arguments are not valid JSON');
      }
    }
    return errors;
  },

  async run(ctx, inputs, config) {
    const name = String(config.tool ?? '').trim();
    if (!name) throw new Error('no tool is selected for this node');

    const tool = await resolveTool(name);
    if (!tool) throw new Error(`tool "${name}" is not available (disabled, or the skill was removed)`);

    const args = parseArgs(config.args, inputs.text);
    const toolCtx = await buildToolContext(ctx, String(config.run_as_agent ?? '').trim());

    log.debug({ runId: ctx.runId, node: ctx.node.id, tool: name }, 'flow tool node running');
    const result = await tool.execute(args, toolCtx);

    // Images the tool produced are persisted here (tools hand back raw data URLs, as they do to the
    // agent runner) so they travel on as handles like every other artifact in the graph.
    const handles = await storeImages(ctx, result.images);
    for (const resource of result.resources ?? []) {
      if (resource.id) handles.push(resource.id);
    }

    const rendered = typeof result.result === 'string' ? result.result : safeStringify(result.result);
    return {
      default: jsonValue(result.result),
      text: textValue(rendered),
      ...(handles.length ? { images: handleValue('image', handles) } : {}),
      done: { type: 'signal' as const },
    };
  },
};

/** Core tool by name, else an enabled skill wrapped as one. */
async function resolveTool(name: string): Promise<Tool | null> {
  const core = getCoreTool(name);
  if (core) return core;
  const [skill] = await skillRepository.findByNames([name]);
  if (!skill || !skill.enabled) return null;
  return {
    name: skill.name,
    description: skill.description || `Dynamic ${skill.language} skill`,
    parameters: (skill.parameters_schema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    execute: (args, toolCtx) => skillRunner.run(skill, args, toolCtx),
  };
}

/** `{"query": "…"}` → args. `{{input}}` is pre-substituted with whatever is wired into the text port. */
function parseArgs(raw: unknown, wired: FlowValue | undefined): Record<string, unknown> {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  const withInput = text.replace(/\{\{\s*input\s*\}\}/g, () => jsonEscape(wired?.text ?? ''));
  try {
    const parsed: unknown = JSON.parse(withInput);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error('arguments must be a JSON object');
  } catch (err) {
    throw new Error(
      `the arguments are not valid JSON after interpolation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Escape a value being spliced *inside* a JSON string literal. */
function jsonEscape(value: string): string {
  const quoted = JSON.stringify(value);
  return quoted.slice(1, -1);
}

/**
 * Build the `ToolContext` a node's tool executes with — the flow's counterpart to the literal
 * `AgentRunner` assembles per tool call.
 *
 * Two deliberate absences: `invokeSubAgent`/`askParent` (a graph expresses delegation as an edge, not
 * as a hop the tool improvises) and `askUser` (the `approval` node is the flow's way to involve the
 * operator, and it is visible on the canvas). Isolation is honoured exactly as elsewhere: if the
 * agent's container can't be made ready the error is surfaced through `isolationError` rather than
 * silently falling back to the backend.
 */
async function buildToolContext(ctx: FlowNodeContext, runAsAgent: string): Promise<ToolContext> {
  let agentId = 'flow';
  let agentName = ctx.flowName || 'flow';
  let exec: AgentExecutor | undefined;
  let isolationError: string | undefined;

  if (runAsAgent) {
    const agent = await agentRepository.resolveByName(runAsAgent);
    if (!agent) throw new Error(`agent "${runAsAgent}" not found`);
    agentId = String(agent._id);
    agentName = agent.name;

    if (agent.isolation_id) {
      try {
        const profile = await isolationRepository.findById(agent.isolation_id);
        if (!profile) throw new Error('the isolation profile no longer exists');
        exec = await agentContainerManager.ensureReady(
          agent as unknown as IsolatedAgent,
          profile as unknown as IsolationProfile,
        );
      } catch (err) {
        isolationError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    sessionId: ctx.sessionId,
    agentId,
    agentName,
    depth: 0,
    callId: ctx.node.id,
    signal: ctx.signal,
    emitOutput: (chunk) => ctx.emitOutput(chunk),
    emitProgress: (payload) =>
      ctx.emitProgress({
        phase: payload.phase,
        percent: payload.percent,
        message: payload.message ?? payload.nodeLabel,
        preview: payload.preview,
        etaMs: payload.etaMs,
      }),
    exec,
    isolationError,
  };
}

/** Persist a tool's returned images into the run's session, returning their handles. */
async function storeImages(ctx: FlowNodeContext, images: ImageBlock[] | undefined): Promise<string[]> {
  const handles: string[] = [];
  for (const image of images ?? []) {
    if (image.id) {
      handles.push(image.id);
      continue;
    }
    if (!image.dataUrl) continue;
    const comma = image.dataUrl.indexOf(',');
    const bytes = Buffer.from(comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl, 'base64');
    const mime = /^data:([^;,]+)[;,]/.exec(image.dataUrl)?.[1] || 'image/png';
    handles.push(await ctx.storeResource({ bytes, kind: 'image', mime, filename: image.filename }));
  }
  return handles;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
