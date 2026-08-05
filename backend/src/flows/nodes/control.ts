import { evaluate, ExprError, parseExpr } from '../expr';
import { asHandles, asList, asText, jsonValue, textValue, type FlowValue } from '../port-types';
import type { FlowNodeHandler } from '../types';

/**
 * `condition` — take one branch or the other based on a deterministic expression (flows spec §3).
 *
 * The cheap counterpart to the agent `router`: no tokens, no GPU, no ambiguity. Only the taken
 * output carries a value; the runner reads an absent output port as "branch not taken" and skips
 * everything reachable solely through it.
 */
export const conditionNode: FlowNodeHandler = {
  type: 'condition',
  label: 'Condition',
  group: 'control',
  description: 'Branches on an expression, e.g. {{writer}} contains "approved".',
  inputs: [
    { name: 'text', types: ['text', 'json'] },
    { name: 'run', types: ['signal'] },
  ],
  outputs: [
    { name: 'true', types: ['signal'] },
    { name: 'false', types: ['signal'] },
  ],
  config: [
    {
      key: 'expression',
      label: 'Condition',
      type: 'string',
      default: '',
      hint:
        'Comparisons over {{node_id}} references, joined with and/or/not. ' +
        'Operators: == != < <= > >= contains matches startswith endswith.',
    },
  ],

  validate(node) {
    const expression = String(node.config.expression ?? '').trim();
    if (!expression) return ['the condition is empty'];
    try {
      parseExpr(expression);
      return [];
    } catch (err) {
      return [err instanceof ExprError ? err.message : String(err)];
    }
  },

  // The expression is evaluated against the live scope rather than the interpolated config: reading
  // `{{n1}} contains "yes"` after interpolation would leave `the answer contains "yes"`, which is
  // prose, not a comparison.
  async run(ctx, _inputs, config): Promise<Record<string, FlowValue>> {
    const expression = String(ctx.node.config.expression ?? config.expression ?? '').trim();
    const result = evaluate(expression, ctx.scope);
    ctx.emitOutput(`${expression} → ${result}\n`);
    return result ? { true: { type: 'signal' } } : { false: { type: 'signal' } };
  },
};

/**
 * `approval` — pause for the operator (flows spec §3).
 *
 * The run's pending question is persisted on its document, not only held in memory, so the page can
 * be reloaded — or opened on another machine — and the gate is still answerable. The artifacts named
 * here are shown next to the question, which is the point: you approve a *picture*, not a node id.
 */
export const approvalNode: FlowNodeHandler = {
  type: 'approval',
  label: 'Approval',
  group: 'control',
  description: 'Pauses the run until you approve or reject, showing the artifacts wired into it.',
  inputs: [
    { name: 'artifacts', types: ['image', 'video', 'audio', 'file'], description: 'Shown with the question.' },
    { name: 'text', types: ['text', 'json'], description: 'Shown with the question.' },
    { name: 'run', types: ['signal'] },
  ],
  outputs: [
    { name: 'approved', types: ['signal'] },
    { name: 'rejected', types: ['signal'] },
  ],
  config: [
    {
      key: 'question',
      label: 'Question',
      type: 'string',
      default: 'Approve this result?',
      hint: 'Supports {{node_id}} references.',
    },
  ],

  async run(ctx, inputs, config): Promise<Record<string, FlowValue>> {
    const question = String(config.question ?? 'Approve this result?').trim();
    const detail = asText(inputs.text);
    const approved = await ctx.askApproval(
      detail ? `${question}\n\n${detail}` : question,
      asHandles(inputs.artifacts),
    );
    ctx.emitOutput(approved ? 'approved\n' : 'rejected\n');
    return approved ? { approved: { type: 'signal' } } : { rejected: { type: 'signal' } };
  },
};

/**
 * `for_each` — fan a list out over the body region that ends at its matching `collect`.
 *
 * The node itself only publishes the list; the runner owns the iteration, because running the body
 * repeatedly means re-executing *other* nodes, which is a scheduling concern rather than a node one.
 * Sources, in order of preference: a JSON array, a handle list, or non-empty lines of text — the
 * shape an agent naturally produces when asked for "one idea per line".
 */
export const forEachNode: FlowNodeHandler = {
  type: 'for_each',
  label: 'For Each',
  group: 'control',
  description: 'Runs the nodes between here and its Collect once per item of a list.',
  inputs: [
    { name: 'list', types: ['text', 'json', 'image', 'video', 'audio', 'file'], required: true },
    { name: 'run', types: ['signal'] },
  ],
  outputs: [
    { name: 'default', types: ['text'], description: 'The current item.' },
    { name: 'index', types: ['text'], description: 'The current 0-based index.' },
    {
      name: 'each',
      types: ['signal'],
      description:
        'Fires once per item. Wire this into a body node that reads its data from {{item.…}} templates rather than from a port — without it that node has no edge from the loop, so it is not part of the body at all.',
    },
  ],
  config: [
    {
      key: 'collect_node',
      label: 'Collect node',
      type: 'string',
      default: '',
      hint: 'Id of the Collect node that closes this loop. Set automatically when you wire them up.',
    },
    {
      key: 'concurrency',
      label: 'Concurrency',
      type: 'number',
      default: 1,
      hint: 'How many items run at once (1–4). Raise only if each item is cheap.',
    },
    {
      key: 'max_items',
      label: 'Max items',
      type: 'number',
      default: 20,
      hint: 'Safety ceiling — a list longer than this is truncated rather than queuing a hundred renders.',
    },
  ],

  // Never reached: the runner intercepts `for_each` to drive the iteration itself. Implemented anyway
  // so the handler interface stays total, and so a loop wired without a `collect` still does the
  // obvious thing (publish the first item) instead of throwing.
  async run(_ctx, inputs) {
    const items = asList(inputs.list);
    return {
      default: items[0] ?? textValue(''),
      index: textValue('0'),
    };
  },
};

/**
 * `collect` — closes a `for_each` and joins the body's per-iteration results into one value.
 *
 * Like `for_each`, the runner drives it: by the time the graph reaches this node the iteration is
 * already done, and the collected value is substituted in.
 */
export const collectNode: FlowNodeHandler = {
  type: 'collect',
  label: 'Collect',
  group: 'control',
  description: 'Ends a For Each and joins every iteration into a single list value.',
  inputs: [
    { name: 'value', types: ['text', 'json', 'image', 'video', 'audio', 'file'], required: true },
  ],
  outputs: [
    // `file` rather than `json`: whenever the body produced artifacts this carries every iteration's
    // handle, which is the whole point of a loop that renders something. It narrows to video/image/
    // audio downstream (see canConnect), and a text-only loop still reaches any text port.
    { name: 'default', types: ['file'], description: 'Every iteration — handles when the body made artifacts.' },
    { name: 'text', types: ['text'], description: 'The iterations joined as text.' },
    { name: 'done', types: ['signal'] },
  ],
  config: [
    {
      key: 'separator',
      label: 'Text separator',
      type: 'string',
      default: '\n',
      hint: 'Placed between iterations in the text output.',
    },
  ],

  async run(_ctx, inputs, config) {
    const value: FlowValue | undefined = inputs.value;
    const separator = String(config.separator ?? '\n').replace(/\\n/g, '\n');
    return {
      default: jsonValue(value?.json ?? []),
      text: textValue(Array.isArray(value?.json) ? value.json.map(String).join(separator) : asText(value)),
      done: { type: 'signal' as const },
    };
  },
};
