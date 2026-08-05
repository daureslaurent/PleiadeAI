import { PORT_TYPES, type FlowValue, type PortType } from '../domain/flows/flow.model';

export { PORT_TYPES };
export type { FlowValue, PortType };

/** Binary kinds — carried as resource handles, resolvable in the run's session (flows spec §2). */
export const BINARY_TYPES: readonly PortType[] = ['image', 'video', 'audio', 'file'];

export function isBinary(type: PortType): boolean {
  return BINARY_TYPES.includes(type);
}

/**
 * May a `source` output feed a `target` input? (flows spec §2)
 *
 * Enforced twice on purpose: here at validate time, and again in the canvas before an edge is drawn,
 * so the operator learns a video can't be a prompt while dragging rather than ten minutes into a run.
 */
export function canConnect(source: PortType, target: PortType): boolean {
  if (source === target) return true;
  // `signal` is pure sequencing — it carries nothing, so it can only meet another signal port.
  if (source === 'signal' || target === 'signal') return false;
  // A `file` port is the generic binary sink: any handle-bearing kind fits.
  if (target === 'file' && isBinary(source)) return true;
  // …and `file` is equally the generic binary *source*, so it may be narrowed to a specific kind.
  // This is what lets a Collect or Merge — which gather handles without knowing what they hold —
  // feed a node that wants video. The narrowing is the operator's assertion, and the receiving node
  // checks the actual bytes (ffprobe will say "no video stream" long before anything is wasted).
  if (source === 'file' && isBinary(target)) return true;
  // Anything renders to text (a handle list stringifies to its handles).
  if (target === 'text') return true;
  // Text may be parsed as JSON. A malformed string is a run-time node error, not a wiring error.
  if (target === 'json' && source === 'text') return true;
  return false;
}

/** Human-readable reason a connection was refused, for the validate route and the canvas tooltip. */
export function connectionError(source: PortType, target: PortType): string {
  if (source === 'signal' || target === 'signal') {
    return 'a signal (action) port only connects to another signal port';
  }
  return `a ${source} output cannot feed a ${target} input`;
}

/** Build a text value. */
export function textValue(text: string): FlowValue {
  return { type: 'text', text };
}

/** Build a handle-bearing value for a binary kind. */
export function handleValue(type: PortType, handles: string[]): FlowValue {
  return { type, handles, text: handles.join(', ') };
}

/** Build a structured value, with a text rendering so it can also feed a text port. */
export function jsonValue(json: unknown): FlowValue {
  return { type: 'json', json, text: stringifyJson(json) };
}

function stringifyJson(json: unknown): string {
  if (typeof json === 'string') return json;
  try {
    return JSON.stringify(json, null, 2);
  } catch {
    return String(json);
  }
}

/** The `signal` singleton — an edge that says "I ran" and nothing else. */
export const SIGNAL: FlowValue = { type: 'signal' };

/**
 * Adapt a value to the port it is being read through. Widening only — `canConnect` has already
 * refused everything that can't be adapted, so this never has to reject.
 */
export function coerce(value: FlowValue, target: PortType): FlowValue {
  if (value.type === target) return value;
  if (target === 'text') return textValue(asText(value));
  if (target === 'json') {
    if (value.json !== undefined) return jsonValue(value.json);
    try {
      return jsonValue(JSON.parse(value.text ?? ''));
    } catch {
      // Not JSON after all — hand the raw string through as the payload rather than failing the run
      // over a formatting detail the operator can see in the trace.
      return jsonValue(value.text ?? '');
    }
  }
  if (target === 'file' && isBinary(value.type)) return { ...value, type: 'file' };
  return value;
}

/** Text rendering of any value: its own text, else its handles, else its JSON. */
export function asText(value: FlowValue | undefined): string {
  if (!value) return '';
  if (value.text !== undefined && value.text !== '') return value.text;
  if (value.handles?.length) return value.handles.join(', ');
  if (value.json !== undefined) return stringifyJson(value.json);
  return '';
}

/** Every handle a value carries (empty for text/json/signal). */
export function asHandles(value: FlowValue | undefined): string[] {
  return value?.handles ?? [];
}

/**
 * Read a value as a list, for `for_each`. A JSON array iterates element-wise, a handle-bearing value
 * iterates its handles, and text falls back to non-empty lines — the shape an agent naturally
 * produces when asked for "one idea per line".
 */
export function asList(value: FlowValue | undefined): FlowValue[] {
  if (!value) return [];
  if (Array.isArray(value.json)) {
    return value.json.map((item) =>
      typeof item === 'string' ? textValue(item) : jsonValue(item),
    );
  }
  if (value.handles?.length) return value.handles.map((h) => handleValue(value.type, [h]));
  const text = asText(value);
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(textValue);
}
