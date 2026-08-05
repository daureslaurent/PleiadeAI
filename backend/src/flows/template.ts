import { asText, type FlowValue } from './port-types';

/**
 * `{{node_id.field}}` interpolation over completed node outputs (flows spec §4).
 *
 * This is what keeps a canvas readable: one prompt can splice three upstream results without three
 * merge nodes and three extra edges. Ports still carry the binary artifacts — templates are for
 * text, and a reference to an image node yields its handles, which is exactly what an agent needs to
 * reach the picture with the `data` tool.
 *
 * Supported forms (`node_id` is the node's id, or its label slug):
 * - `{{n1}}`             — the node's primary output, as text
 * - `{{n1.text}}`        — same, explicit
 * - `{{n1.handles}}`     — its resource handles, comma-joined
 * - `{{n1.json.a.b}}`    — a path into its structured output
 * - `{{n1.images.text}}` — a named output port, then a field
 * - `{{item}}`           — inside a `for_each` body, the current item
 */
const REF = /\{\{\s*([a-zA-Z0-9_\-.]+)\s*\}\}/g;

/** A node's outputs, keyed by port name. `default` is the primary port. */
export type NodeOutputs = Record<string, FlowValue>;

export interface TemplateScope {
  /** Completed node outputs, keyed by node id (and by label slug, when unambiguous). */
  nodes: Map<string, NodeOutputs>;
  /** The current item inside a `for_each` body, exposed as `{{item}}`. */
  item?: FlowValue;
  /** The current 0-based iteration index inside a `for_each` body, as `{{index}}`. */
  index?: number;
}

/** Primary output of a node: the `default` port if present, else the first one declared. */
export function primary(outputs: NodeOutputs | undefined): FlowValue | undefined {
  if (!outputs) return undefined;
  return outputs.default ?? Object.values(outputs)[0];
}

/** Resolve one dotted reference against a scope. Returns undefined when it doesn't resolve. */
export function resolveRef(ref: string, scope: TemplateScope): string | undefined {
  const parts = ref.split('.');
  const head = parts[0]!;

  if (head === 'item') return scope.item ? applyField(scope.item, parts.slice(1)) : undefined;
  if (head === 'index') return scope.index === undefined ? undefined : String(scope.index);

  const outputs = scope.nodes.get(head);
  if (!outputs) return undefined;

  // `{{n1.images.text}}` — second segment may name an output port.
  const rest = parts.slice(1);
  if (rest.length && outputs[rest[0]!]) {
    return applyField(outputs[rest[0]!]!, rest.slice(1));
  }
  const value = primary(outputs);
  if (!value) return undefined;
  return applyField(value, rest);
}

/** Apply a field path (`text` / `handles` / `json.a.b`) to a value, rendering the result as text. */
function applyField(value: FlowValue, path: string[]): string {
  if (path.length === 0) return asText(value);
  const [field, ...rest] = path;
  if (field === 'text') return value.text ?? asText(value);
  if (field === 'handles') return (value.handles ?? []).join(', ');
  if (field === 'json') return renderJsonPath(value.json, rest);
  // Not a known field — treat the whole path as a JSON path, so `{{n1.title}}` works on a tool result.
  return renderJsonPath(value.json, path);
}

function renderJsonPath(json: unknown, path: string[]): string {
  let cursor: unknown = json;
  for (const key of path) {
    if (cursor === null || cursor === undefined) return '';
    if (Array.isArray(cursor)) cursor = cursor[Number(key)];
    else if (typeof cursor === 'object') cursor = (cursor as Record<string, unknown>)[key];
    else return '';
  }
  if (cursor === null || cursor === undefined) return '';
  if (typeof cursor === 'string') return cursor;
  try {
    return JSON.stringify(cursor);
  } catch {
    return String(cursor);
  }
}

/** Interpolate every reference in a string. Unresolved references render empty. */
export function render(input: string, scope: TemplateScope): string {
  if (!input.includes('{{')) return input;
  return input.replace(REF, (_match, ref: string) => resolveRef(ref, scope) ?? '');
}

/** Interpolate every string in a config object (recursively through arrays/objects). */
export function renderConfig<T>(config: T, scope: TemplateScope): T {
  if (typeof config === 'string') return render(config, scope) as unknown as T;
  if (Array.isArray(config)) return config.map((v) => renderConfig(v, scope)) as unknown as T;
  if (config && typeof config === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) out[key] = renderConfig(value, scope);
    return out as unknown as T;
  }
  return config;
}

/** Every node id a string references — used at validate time to reject dangling refs. */
export function referencedNodes(input: string): string[] {
  const ids: string[] = [];
  for (const match of input.matchAll(REF)) {
    const head = match[1]!.split('.')[0]!;
    if (head !== 'item' && head !== 'index') ids.push(head);
  }
  return ids;
}

/** Every node id referenced anywhere in a config object. */
export function referencedNodesDeep(config: unknown): string[] {
  if (typeof config === 'string') return referencedNodes(config);
  if (Array.isArray(config)) return config.flatMap(referencedNodesDeep);
  if (config && typeof config === 'object') return Object.values(config).flatMap(referencedNodesDeep);
  return [];
}
