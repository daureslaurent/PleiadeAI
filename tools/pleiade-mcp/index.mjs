#!/usr/bin/env node
/**
 * PleiadeAI MCP server — read-only access to a deployed instance via an API key.
 *
 * Speaks MCP over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout. Implemented by hand
 * against the three methods a tools-only server needs (`initialize`, `tools/list`, `tools/call`)
 * so it runs with a bare `node` and no dependency install.
 *
 * stdout carries protocol frames *only* — diagnostics go to stderr, or a client will choke.
 *
 * Config: PLEIADE_API_URL + PLEIADE_API_KEY, from the environment or the repo's `.env.prod`.
 */
import readline from 'node:readline';
import { apiGet, loadConfig, PleiadeError } from './client.mjs';
import { ENDPOINTS, inputSchemaOf } from './endpoints.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_PREFIX = 'pleiade_';

const byToolName = new Map(ENDPOINTS.map((e) => [`${TOOL_PREFIX}${e.name}`, e]));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** MCP tool results are content blocks; a failed call is `isError`, not a JSON-RPC error. */
function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

async function callTool(name, args) {
  const endpoint = byToolName.get(name);
  if (!endpoint) return toolResult(`Unknown tool: ${name}`, true);

  for (const [argName, spec] of Object.entries(endpoint.args)) {
    if (spec.required && (args?.[argName] === undefined || args[argName] === '')) {
      return toolResult(`Missing required argument "${argName}" for ${name}.`, true);
    }
  }

  try {
    const { path, query } = endpoint.resolve(args ?? {});
    const data = await apiGet(path, query);
    return toolResult(JSON.stringify(data, null, 2));
  } catch (err) {
    // Surface the instance's own explanation (403 read-only, 404, auth) rather than a stack trace.
    const detail = err instanceof PleiadeError ? err.message : `${err}`;
    return toolResult(detail, true);
  }
}

async function handle(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'pleiade', version: '1.0.0' },
      });
      return;

    case 'tools/list':
      reply(id, {
        tools: ENDPOINTS.map((e) => ({
          name: `${TOOL_PREFIX}${e.name}`,
          description: e.description,
          inputSchema: inputSchemaOf(e),
        })),
      });
      return;

    case 'tools/call':
      reply(id, await callTool(params?.name, params?.arguments));
      return;

    case 'ping':
      reply(id, {});
      return;

    default:
      // Notifications (no `id`) are fire-and-forget — `notifications/initialized` lands here.
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  // Fail fast and loudly if the instance URL/key aren't configured: a client that connects to a
  // silently broken server just sees every tool call error.
  try {
    const { baseUrl } = loadConfig();
    process.stderr.write(`[pleiade-mcp] read-only, pointed at ${baseUrl}\n`);
  } catch (err) {
    process.stderr.write(`[pleiade-mcp] ${err.message}\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stderr.write(`[pleiade-mcp] ignoring non-JSON line\n`);
      return;
    }
    handle(request).catch((err) => {
      process.stderr.write(`[pleiade-mcp] handler failed: ${err?.stack ?? err}\n`);
      if (request.id !== undefined) replyError(request.id, -32603, `Internal error: ${err?.message ?? err}`);
    });
  });
  rl.on('close', () => process.exit(0));
}

main();
