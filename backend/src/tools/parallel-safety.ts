import type { Tool } from './types';

/**
 * Which of the calls in one model-emitted batch may overlap.
 *
 * A model that asks for three things in a single assistant message has already judged them
 * independent — that is what the OpenAI tool-call array *means*. It has no idea what they cost us
 * though, and the runner used to execute a batch strictly in sequence, so two 120-second `bash`
 * probes the model deliberately issued together took four minutes end to end.
 *
 * The answer to "may this call overlap?" belongs to the tool, not to the runner: only `forum` knows
 * that `read_thread` is a read and `post_thread` is not. So a tool declares `parallelSafe` (a
 * boolean, or a predicate over the call's own arguments for the verb-style tools), and this module
 * is the single place the runner asks.
 *
 * **Absent means serial.** A tool that says nothing runs alone, which is the behaviour every tool
 * had before this existed — opting in is a deliberate statement that the call has no side effect
 * another call in the same batch could observe.
 *
 * Deliberately *not* declared safe, for the record:
 * - `api` — whether an operation is a `GET` or a `POST` lives in the `api_sources` document, not in
 *   the arguments the model passes, so nothing here can tell a read from a write.
 * - `forum.get_attachment` and `data.store` — they pull bytes into the turn's resource pool, and
 *   handles are assigned in completion order; serialising them keeps a rerun reproducible.
 * - every skill — user-authored code in a sandbox, with a circuit breaker counting consecutive
 *   failures. Overlapping runs would make that count a race.
 */

/**
 * Read-only core tools that can't carry the declaration in their own module yet: these five files
 * are root-owned in the working tree, so they are listed here instead. Move each one onto its tool
 * as `parallelSafe: true` when that is fixed, and delete it from this set — the declaration belongs
 * next to the code that knows why it is true.
 */
const UNDECLARED_READ_ONLY = new Set(['read', 'list', 'grep', 'glob', 'annuaire']);

/** Whether this specific call may run alongside the others the model emitted with it. */
export function isParallelSafe(tool: Tool | undefined, args: Record<string, unknown>): boolean {
  if (!tool) return false;
  if (typeof tool.parallelSafe === 'function') {
    try {
      return tool.parallelSafe(args);
    } catch {
      // A predicate that throws on a malformed argument object must not take the turn down with it;
      // the safe answer is the conservative one.
      return false;
    }
  }
  if (typeof tool.parallelSafe === 'boolean') return tool.parallelSafe;
  return UNDECLARED_READ_ONLY.has(tool.name);
}
