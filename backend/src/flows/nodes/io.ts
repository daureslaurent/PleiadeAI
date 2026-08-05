import { PORT_TYPES } from '../port-types';
import { asText, handleValue, isBinary, jsonValue, textValue, type FlowValue, type PortType } from '../port-types';
import type { FlowNodeHandler } from '../types';

/**
 * `input` — the graph's injection point (flows spec §3).
 *
 * Its value comes from the run form, the `run_flow` tool's arguments, or the cron schedule, keyed by
 * the node's `key`. Absent an override it falls back to the configured default, so a flow is always
 * runnable as-is — which is what makes "run it once to see" a one-click operation.
 *
 * Binary inputs are handed in already-stored: the HTTP route uploads the file into the run's session
 * before execution starts and passes the handle, so a node never deals in bytes it didn't produce.
 */
export const inputNode: FlowNodeHandler = {
  type: 'input',
  label: 'Input',
  group: 'io',
  description: 'Injects a value into the graph. Set per run, or falls back to its default.',
  inputs: [],
  outputs: [{ name: 'default', types: ['text'] }],
  config: [
    {
      key: 'key',
      label: 'Name',
      type: 'string',
      default: 'input',
      hint: 'How this input is addressed when the flow is run (by the form, an agent, or a schedule).',
    },
    {
      key: 'port_type',
      label: 'Type',
      type: 'select',
      options: [...PORT_TYPES].filter((t) => t !== 'signal'),
      default: 'text',
      hint: 'What travels out of this node. Binary types take an uploaded file or a resource handle.',
    },
    {
      key: 'default',
      label: 'Default value',
      type: 'string',
      default: '',
      hint: 'Used when the run supplies nothing. For binary types, a resource handle.',
    },
    {
      key: 'required',
      label: 'Required',
      type: 'boolean',
      default: false,
      hint: 'Refuse to start the run when this input is empty.',
    },
  ],

  dynamicOutputs(config) {
    const type = portTypeOf(config.port_type);
    return [{ name: 'default', types: [type] }];
  },

  async run(ctx, _inputs, config) {
    const type = portTypeOf(config.port_type);
    // The runner pre-seeds the supplied value under `value`; the default is the fallback.
    const raw = config.value !== undefined && config.value !== '' ? config.value : config.default;
    const text = raw === undefined || raw === null ? '' : String(raw);

    if (Boolean(config.required) && !text) {
      throw new Error(`input "${String(config.key ?? ctx.node.id)}" is required but was not supplied`);
    }
    if (isBinary(type)) {
      // Binary inputs arrive as handles (the route stored any upload before the run started).
      const handles = text.split(',').map((h) => h.trim()).filter(Boolean);
      return handleValue(type, handles);
    }
    if (type === 'json') {
      try {
        return jsonValue(JSON.parse(text || 'null'));
      } catch {
        return jsonValue(text);
      }
    }
    return textValue(text);
  },
};

/**
 * `output` — the flow's result. Whatever reaches it becomes `FlowRun.output`, the value the run panel
 * shows, and what the `run_flow` tool hands back to the calling agent.
 */
export const outputNode: FlowNodeHandler = {
  type: 'output',
  label: 'Output',
  group: 'io',
  description: "The flow's result — shown in the run panel and returned to whoever ran the flow.",
  inputs: [
    { name: 'value', types: [...PORT_TYPES].filter((t) => t !== 'signal'), required: true },
    { name: 'run', types: ['signal'], description: 'Gate: only produce a result on this branch.' },
  ],
  outputs: [],
  config: [],

  async run(_ctx, inputs) {
    return inputs.value ?? textValue('');
  },
};

/**
 * `merge` — join several inputs into one value without writing a template. Handles concatenate into a
 * single list; text joins with the configured separator.
 */
export const mergeNode: FlowNodeHandler = {
  type: 'merge',
  label: 'Merge',
  group: 'control',
  description: 'Combines several inputs into one value (text joined, handles collected into a list).',
  inputs: [
    { name: 'a', types: [...PORT_TYPES].filter((t) => t !== 'signal') },
    { name: 'b', types: [...PORT_TYPES].filter((t) => t !== 'signal') },
    { name: 'c', types: [...PORT_TYPES].filter((t) => t !== 'signal') },
    { name: 'd', types: [...PORT_TYPES].filter((t) => t !== 'signal') },
    { name: 'run', types: ['signal'], description: 'Gate: only merge on this branch.' },
  ],
  outputs: [{ name: 'default', types: ['text'] }],
  config: [
    {
      key: 'separator',
      label: 'Separator',
      type: 'string',
      default: '\n\n',
      hint: 'Placed between the text inputs. Use \\n for a newline.',
    },
  ],

  async run(_ctx, inputs, config) {
    const present = ['a', 'b', 'c', 'd']
      .map((k) => inputs[k])
      .filter((v): v is FlowValue => Boolean(v) && v!.type !== 'signal');
    const handles = present.flatMap((v) => v.handles ?? []);
    if (handles.length && present.every((v) => (v.handles?.length ?? 0) > 0)) {
      return handleValue(present[0]!.type, handles);
    }
    const separator = String(config.separator ?? '\n\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    return textValue(present.map(asText).filter(Boolean).join(separator));
  },
};

/** `note` — a comment card. No ports, never executed; it exists so a canvas can explain itself. */
export const noteNode: FlowNodeHandler = {
  type: 'note',
  label: 'Note',
  group: 'io',
  description: 'A comment on the canvas. Never executed.',
  inputs: [],
  outputs: [],
  config: [{ key: 'text', label: 'Note', type: 'string', default: '' }],

  async run() {
    return textValue('');
  },
};

function portTypeOf(value: unknown): PortType {
  const candidate = String(value ?? 'text') as PortType;
  return (PORT_TYPES as readonly string[]).includes(candidate) ? candidate : 'text';
}
