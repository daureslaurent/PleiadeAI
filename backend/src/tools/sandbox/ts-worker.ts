import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { createRequire } from 'node:module';

/**
 * TypeScript skill worker harness (runs inside a worker_thread).
 *
 * `workerData` = { code: <transpiled CJS>, args: <obj> }. The transpiled skill is expected to
 * export a function — `export default async (args) => ...` or `export async function run(args)`.
 * We evaluate it in a CommonJS wrapper, resolve the exported function, invoke it with `args`,
 * and post the result back. Any throw is reported so the parent can trip the circuit breaker.
 *
 * Isolation note: the worker is a fresh V8 isolate per invocation and, per spec §3, has no OS
 * reach beyond the container — external effects must go through network/SSH defined in params.
 */
interface WorkerInput {
  code: string;
  args: Record<string, unknown>;
}

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('ts-worker must run as a worker thread');

  const { code, args } = workerData as WorkerInput;
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  const req = createRequire(__filename);

  // Wrap transpiled CJS and execute it to populate module.exports.
  const wrapper = new vm.Script(
    `(function (module, exports, require) {\n${code}\n})`,
    { filename: 'skill.js' },
  );
  wrapper.runInThisContext()(moduleObj, moduleObj.exports, req);

  const exported = moduleObj.exports;
  const fn =
    (typeof exported === 'function' && exported) ||
    (exported.default as unknown) ||
    (exported.run as unknown);

  if (typeof fn !== 'function') {
    throw new Error('skill must export a default function or a `run` function');
  }

  const result = await (fn as (a: unknown) => unknown)(args);
  port.postMessage({ ok: true, result });
}

main().catch((err: unknown) => {
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
});
