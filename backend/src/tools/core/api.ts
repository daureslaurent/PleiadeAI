import { createLogger } from '../../config/logger';
import { apiSourceRepository } from '../../domain/apis/api-source.repository';
import { ApiCallError, callOperation } from '../../domain/apis/api-caller.service';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import type { ApiOperation, ApiSourceDoc } from '../../domain/apis/api-source.model';
import type { Tool, ToolConfigField } from '../types';

const log = createLogger('tool:api');

/**
 * `api_man` + `api` — the operator's HTTP APIs, callable by name (see `API_TOOL_PLAN.md`).
 *
 * The split is the point. `api_man` is the catalogue: it says which APIs this instance has been
 * given and what each can be asked. `api` is the caller: it takes one entry from that catalogue and
 * returns parsed JSON. The agent never composes a URL, never holds a credential, and never reaches a
 * host the operator hasn't configured — it names an operation and fills its declared parameters.
 */

/** Operator-tunable options rendered on the Tools page. */
const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'max_response_tokens',
    label: 'Max response tokens',
    type: 'number',
    default: 8000,
    hint: 'Budget for one response (~4 chars each). Over it, long arrays lose their tail rather than the JSON being cut mid-structure.',
  },
  {
    key: 'timeout_ms',
    label: 'Timeout override (ms)',
    type: 'number',
    default: 0,
    hint: '0 = use each API’s own configured timeout (Settings → APIs).',
  },
];

/** One operation's signature, e.g. `forecast(latitude*, longitude*, forecast_days)`. */
function signature(op: ApiOperation): string {
  const args = op.params.map((p) => `${p.name}${p.required ? '*' : ''}`).join(', ');
  return `${op.id}(${args})`;
}

/** The index entry for one API: what it is, and what it can be asked. */
function summarize(source: ApiSourceDoc) {
  return {
    api: source.name,
    description: source.description,
    operations: source.operations
      .filter((op) => op.enabled && source.methods_allowed.includes(op.method))
      .map((op) => `${source.name}.${signature(op)}${op.description ? ` — ${op.description}` : ''}`),
  };
}

/**
 * The full contract for one API. Deliberately shows the base URL and the paths — the agent can't act
 * on them, but knowing an operation is `GET /v1/forecast` on open-meteo.com is often what tells the
 * model which of two similar operations it actually wants.
 */
function detail(source: ApiSourceDoc) {
  return {
    api: source.name,
    description: source.description,
    base_url: source.base_url,
    authentication:
      source.auth_type === 'none'
        ? 'none required'
        : 'handled automatically — you never pass a key, and you cannot read it',
    methods_allowed: source.methods_allowed,
    notes: source.notes || undefined,
    operations: source.operations
      .filter((op) => op.enabled && source.methods_allowed.includes(op.method))
      .map((op) => ({
        operation: `${source.name}.${op.id}`,
        description: op.description,
        method: op.method,
        path: op.path,
        params: op.params.map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required,
          sent_as: p.in,
          description: p.description || undefined,
          default: p.default || undefined,
        })),
      })),
  };
}

export const apiMan: Tool = {
  name: 'api_man',
  description:
    'List the HTTP APIs this instance can call and the named operations each one offers. Call it with ' +
    'no arguments for the catalogue, or with `api` for one API’s full contract (every operation, its ' +
    'method, path and parameters). Use it before `api` — an operation id from here is exactly what ' +
    '`api` takes. Credentials are configured by the operator and never appear here.',
  parameters: {
    type: 'object',
    properties: {
      api: {
        type: 'string',
        description: 'Name of one API (from the catalogue) to describe in full. Omit for the index.',
      },
    },
  },
  async execute(args) {
    const wanted = String(args.api ?? '').trim().toLowerCase();
    const sources = await apiSourceRepository.listEnabled();
    const usable = sources.filter((s) => s.operations.some((op) => op.enabled));

    if (!usable.length) {
      return {
        result: {
          ok: true,
          apis: [],
          note: 'no APIs are configured on this instance — the operator adds them in Settings → APIs',
        },
      };
    }

    if (wanted) {
      const source = usable.find((s) => s.name === wanted);
      if (!source) {
        return {
          result: {
            ok: false,
            error: `no API named "${wanted}" — available: ${usable.map((s) => s.name).join(', ')}`,
          },
        };
      }
      return { result: { ok: true, ...detail(source) } };
    }

    return {
      result: {
        ok: true,
        apis: usable.map(summarize),
        note: 'call `api` with one of these operation ids, e.g. api({operation:"<api>.<operation>", params:{…}}). `api_man({api:"<name>"})` gives the full parameter list.',
      },
    };
  },
};

export const api: Tool = {
  name: 'api',
  description:
    'Call one operation of a configured HTTP API and get its JSON response. Take the `operation` id ' +
    'from `api_man` (e.g. "weather.forecast") and pass its arguments in `params` — the base URL, the ' +
    'credential and the request shape are all configured by the operator, so there is nothing else to ' +
    'supply. Returns parsed JSON; a failing service, an unknown operation or a bad argument comes ' +
    'back as an error you can read and correct.',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Operation id from `api_man`, in the form "<api>.<operation>" — e.g. "weather.forecast".',
      },
      params: {
        type: 'object',
        description:
          'Arguments for the operation, keyed by the parameter names `api_man` lists. Unknown names are refused.',
        additionalProperties: true,
      },
    },
    required: ['operation'],
  },
  configSchema: CONFIG_SCHEMA,
  async execute(args, ctx) {
    const { config } = await toolConfigService.resolve('api', CONFIG_SCHEMA);
    const operation = String(args.operation ?? '').trim();
    const params = (args.params ?? {}) as Record<string, unknown>;

    if (!operation) {
      return { result: { ok: false, error: 'pass `operation` — call `api_man` first to see what is available' } };
    }

    try {
      const outcome = await callOperation(operation, params, {
        maxResponseTokens: Number(config.max_response_tokens) || 8000,
        timeoutMs: Number(config.timeout_ms) > 0 ? Number(config.timeout_ms) : undefined,
        signal: ctx.signal,
        via: 'agent',
        agent: ctx.agentName,
      });
      log.info(
        { agent: ctx.agentName, operation, status: outcome.status, ms: outcome.duration_ms },
        'api call ok',
      );
      return {
        result: {
          ok: true,
          operation,
          status: outcome.status,
          duration_ms: outcome.duration_ms,
          truncated: outcome.truncated,
          data: outcome.data,
        },
      };
    } catch (err) {
      if (err instanceof ApiCallError) {
        return { result: { ok: false, operation, status: err.status, error: err.message } };
      }
      throw err;
    }
  },
};
