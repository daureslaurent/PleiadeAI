#!/usr/bin/env node
/**
 * TypeScript/JS skill harness (in-container variant).
 *
 * Mirrors the backend's `tools/sandbox/ts-worker.ts` contract but over stdin/stdout instead of
 * worker_threads (a worker thread can't cross into another container). Reads a single JSON object
 * from stdin — { "code": <transpiled CJS>, "args": <obj> } — evaluates the skill in a CommonJS
 * wrapper, resolves its exported function (`default` / `run` / bare function), invokes it with
 * `args`, and writes { "ok": true, "result": ... } to stdout. Any throw becomes
 * { "ok": false, "error": <str> } with exit code 1.
 *
 * `docker cp`'d into the agent container at /opt/pleiades/node_runner.cjs at create time.
 */
'use strict';
const vm = require('node:vm');

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
  });
}

async function main() {
  const raw = (await readStdin()) || '{}';
  const { code, args } = JSON.parse(raw);

  const moduleObj = { exports: {} };
  const wrapper = new vm.Script(`(function (module, exports, require) {\n${code}\n})`, {
    filename: 'skill.js',
  });
  wrapper.runInThisContext()(moduleObj, moduleObj.exports, require);

  const exported = moduleObj.exports;
  const fn =
    (typeof exported === 'function' && exported) ||
    (exported && exported.default) ||
    (exported && exported.run);

  if (typeof fn !== 'function') {
    throw new Error('skill must export a default function or a `run` function');
  }

  const result = await fn(args);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.stack || err.message : String(err) }),
  );
  process.exit(1);
});
