import { PORT_TYPES } from '../port-types';
import { asText, handleValue, isBinary, jsonValue, textValue, type FlowValue, type PortType } from '../port-types';
import { stagingSessionOf } from '../staging';
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
      // Binary inputs are named by handle. A handle here always refers to the flow's **staging
      // session** — the run's own session is empty at input time — so the bytes are imported into the
      // run, giving every node downstream one uniform handle space (see flows/staging.ts).
      const staged = text.split(',').map((h) => h.trim()).filter(Boolean);
      const handles: string[] = [];
      for (const handle of staged) {
        const imported = await ctx.importResource(stagingSessionOf(ctx.flowId), handle);
        if (!imported) {
          throw new Error(
            `"${handle}" is not an uploaded file on this flow — upload one for this input, or clear it`,
          );
        }
        handles.push(imported);
      }
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
 * `data` — a value written into the graph itself (flows spec §3).
 *
 * The constant to `input`'s parameter. An `input` is a question the run asks its caller and appears
 * on the run form; a `data` node is a decision already made, fixed in the flow. Two things follow
 * from that, and both are the point:
 *
 * - **It can be read from anywhere.** A settings-like value — a clip duration, a house style suffix,
 *   a negative prompt — is usually wanted by several nodes *in their config*, where there is no port
 *   to wire. Any config field of any node can quote it as `{{node_id}}`, so the value is written once
 *   and changing it changes every consumer.
 * - **It can also be wired**, for the cases where a port does exist.
 *
 * The runner treats a `{{ref}}` as an ordering constraint (see `settle`), so a consumer never runs
 * before the data it quotes.
 */
export const dataNode: FlowNodeHandler = {
  type: 'data',
  label: 'Data',
  group: 'io',
  description:
    'A fixed value held in the graph — text, a number, JSON or a file. Wire it, or quote it as {{node_id}} in any other node\'s settings.',
  inputs: [{ name: 'run', types: ['signal'], description: 'Gate: only publish on this branch.' }],
  outputs: [{ name: 'default', types: ['text'] }],
  config: [
    {
      key: 'port_type',
      label: 'Type',
      type: 'select',
      options: [...PORT_TYPES].filter((t) => t !== 'signal'),
      default: 'text',
      hint: 'What this holds. A number is text that parses — put it straight into a numeric field with {{node_id}}.',
    },
    {
      key: 'value',
      label: 'Value',
      type: 'string',
      default: '',
      hint: 'The value. Supports {{node_id}} references, so one data node can be built from others.',
    },
  ],

  dynamicOutputs(config) {
    return [{ name: 'default', types: [portTypeOf(config.port_type)] }];
  },

  validate(node) {
    const type = portTypeOf(node.config.port_type);
    if (isBinary(type) && !String(node.config.value ?? '').trim()) {
      return ['no file is attached (upload one in the inspector)'];
    }
    return [];
  },

  async run(ctx, _inputs, config) {
    const type = portTypeOf(config.port_type);
    const text = String(config.value ?? '');

    if (isBinary(type)) {
      // Same as `input`: the value names a file staged on this flow, imported into the run so every
      // node downstream sees one handle space.
      const staged = text.split(',').map((h) => h.trim()).filter(Boolean);
      const handles: string[] = [];
      for (const handle of staged) {
        const imported = await ctx.importResource(stagingSessionOf(ctx.flowId), handle);
        if (!imported) throw new Error(`"${handle}" is not an uploaded file on this flow`);
        handles.push(imported);
      }
      return handleValue(type, handles);
    }
    if (type === 'json') {
      try {
        return jsonValue(JSON.parse(text || 'null'));
      } catch {
        throw new Error(`the value is not valid JSON: ${text.slice(0, 80)}`);
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
 * `log` — a **tap** on a wire: it records whatever reaches it, in the run trace and in the node's
 * live log, so you can see what a step actually produced (flows spec §3).
 *
 * Deliberately a tap rather than a pass-through. A pass-through would have to declare one static
 * output type, which either breaks the wire for every other type or forces the operator to restate a
 * type the graph already knows. Branching the source's output — one wire onward, one into the Log —
 * costs a single extra edge and keeps the canvas honest about where data really flows.
 *
 * Its `default` output is the *text rendering* of what it saw, which is also the useful thing to
 * splice into a later prompt ("here is what the previous step returned").
 */
export const logNode: FlowNodeHandler = {
  type: 'log',
  label: 'Log',
  group: 'io',
  description: 'Records whatever is wired into it, for debugging. Tap a wire by branching it here.',
  inputs: [
    { name: 'value', types: [...PORT_TYPES].filter((t) => t !== 'signal') },
    { name: 'run', types: ['signal'], description: 'Gate: only log on this branch.' },
  ],
  outputs: [
    { name: 'default', types: ['text'], description: 'What it saw, as text.' },
    { name: 'done', types: ['signal'] },
  ],
  config: [
    {
      key: 'note',
      label: 'Note',
      type: 'string',
      default: '',
      hint: 'Prefixed to the entry, so several logs stay tellable apart. Supports {{node_id}}.',
    },
    {
      key: 'detail',
      label: 'Detail',
      type: 'select',
      options: ['summary', 'full'],
      default: 'summary',
      hint: '"full" also dumps the structured payload (JSON) — verbose, but it is what you want when a tool result looks wrong.',
    },
    {
      key: 'max_chars',
      label: 'Max characters',
      type: 'number',
      default: 2000,
      hint: 'Longer values are cut here. The run trace caps entries again at 4000.',
    },
  ],

  async run(ctx, inputs, config) {
    const value = inputs.value;
    const note = String(config.note ?? '').trim();
    const limit = Math.max(80, Math.min(20000, Math.trunc(Number(config.max_chars)) || 2000));

    const lines: string[] = [];
    lines.push(`type: ${value?.type ?? '(nothing wired)'}`);
    if (value?.handles?.length) lines.push(`handles: ${value.handles.join(', ')}`);

    const text = asText(value);
    if (text) lines.push(text.length > limit ? `${text.slice(0, limit)}\n… (${text.length} chars total)` : text);

    if (String(config.detail ?? 'summary') === 'full' && value?.json !== undefined) {
      let dump: string;
      try {
        dump = JSON.stringify(value.json, null, 2);
      } catch {
        dump = String(value.json);
      }
      lines.push(`json:\n${dump.length > limit ? `${dump.slice(0, limit)}\n… (truncated)` : dump}`);
    }

    const body = lines.join('\n');
    const entry = note ? `${note}\n${body}` : body;
    ctx.emitOutput(`${entry}\n`);
    return { default: textValue(entry), done: { type: 'signal' } };
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
  // `file` for the same reason as Collect: when every input carries handles this gathers them all,
  // and `file` narrows to any binary kind downstream while still reaching a text port.
  outputs: [{ name: 'default', types: ['file'] }],
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
