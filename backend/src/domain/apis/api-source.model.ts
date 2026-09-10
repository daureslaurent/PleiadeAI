import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `api_sources` collection (see `API_TOOL_PLAN.md`). One document per HTTP API the operator has
 * given this instance — a base URL, how it authenticates, and the named operations an agent may
 * call on it through the `api` tool.
 *
 * The agent never sees this document: it sees what `api_man` projects out of it (names, parameter
 * descriptions), and it names an operation rather than composing a request. That is why the
 * credential can live here at all — `secret_enc` is AES-256-GCM encrypted (`isolation/ssh.service`)
 * and `select: false`, so it is absent from every read but the one the caller service makes, and
 * the `_enc` suffix keeps it inside `redact.ts`'s secret pattern as a second line of defence.
 */

export const AUTH_TYPES = ['none', 'header', 'query', 'bearer', 'basic', 'oauth2'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods a freshly added API allows: reading only, until the operator opts into writes. */
export const DEFAULT_METHODS: HttpMethod[] = ['GET', 'HEAD'];

export const PARAM_LOCATIONS = ['query', 'path', 'body', 'header'] as const;
export type ParamLocation = (typeof PARAM_LOCATIONS)[number];

export const PARAM_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/**
 * One argument of an operation. `description` is not documentation — it is the text the model reads
 * in `api_man` before deciding what to pass, so it is the real prompt surface of this feature.
 */
const ParamSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Where the value lands: a `{token}` in the path, the query string, the JSON body, a header. */
    in: { type: String, enum: PARAM_LOCATIONS, default: 'query' },
    type: { type: String, enum: PARAM_TYPES, default: 'string' },
    required: { type: Boolean, default: false },
    description: { type: String, default: '' },
    /** Applied when the agent omits the parameter. Empty string means "no default". */
    default: { type: String, default: '' },
  },
  { _id: false },
);

/** A static key/value pair the operator pins on every call (a header, or a query parameter). */
const PairSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    value: { type: String, default: '' },
  },
  { _id: false },
);

/** One callable endpoint. `api_man` lists it as `<api name>.<id>`; that pair is the agent's handle. */
const OperationSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    method: { type: String, enum: HTTP_METHODS, default: 'GET' },
    /** Path appended to the API's base URL, with `{name}` tokens for `in: 'path'` parameters. */
    path: { type: String, default: '/' },
    /** Query parameters sent on every call regardless of what the agent passed. */
    query: { type: [PairSchema], default: [] },
    /**
     * Optional JSON body template with `{name}` tokens. When absent, `in: 'body'` parameters are
     * assembled into a flat object — which covers most APIs and needs no template at all.
     */
    body_template: { type: String, default: '' },
    params: { type: [ParamSchema], default: [] },
    /**
     * Overrides the API's base URL for this operation alone. Some services split one logical API
     * across hosts (Open-Meteo's geocoder is not on the forecast host); without this they would have
     * to be configured as two unrelated APIs, and the model would have to know that. The origin
     * check pins to *this* base when it is set, so the guarantee is unchanged.
     */
    base_url: { type: String, default: '' },
    /** Unticked operations stay configured but are hidden from `api_man` and refused by `api`. */
    enabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const ApiSourceSchema = new Schema(
  {
    /** Slug used as the namespace in `weather.forecast`. Lowercased, unique. */
    name: { type: String, required: true, unique: true, trim: true, lowercase: true },
    /** The one line `api_man` returns for this API — what it is for, in the operator's words. */
    description: { type: String, default: '' },
    base_url: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    auth_type: { type: String, enum: AUTH_TYPES, default: 'none' },
    /** Header carrying the credential when `auth_type` is `header` (e.g. `X-API-Key`). */
    auth_header: { type: String, default: 'X-API-Key' },
    /** Query parameter carrying the credential when `auth_type` is `query` (e.g. `api_key`). */
    auth_query: { type: String, default: 'api_key' },
    /** Username for `basic`, or the client id for `oauth2`; the secret is the password/client secret. */
    auth_username: { type: String, default: '' },
    /** `oauth2` only: where to POST the client-credentials grant for an access token. */
    token_url: { type: String, default: '' },
    /** `oauth2` only: scopes to request, space-separated. Blank asks for the client's default. */
    auth_scope: { type: String, default: '' },
    /**
     * The API answers without a credential, and one only raises limits or unlocks extras (GitHub's
     * 60 vs 5000 requests an hour). Such an API ships working; with this false, a missing credential
     * is refused before any request is made.
     */
    auth_optional: { type: Boolean, default: false },
    /** Shown under the credential field in Settings → APIs: what a key buys, and where to get one. */
    secret_hint: { type: String, default: '' },
    /** AES-256-GCM encrypted credential (key, token, or basic password). Never sent to a client. */
    secret_enc: { type: String, default: null, select: false },
    /** Non-secret headers sent on every request (User-Agent, Accept, a tenant id…). */
    headers: { type: [PairSchema], default: [] },
    /** Verbs this API accepts. New entries are read-only until the operator widens this. */
    methods_allowed: { type: [String], default: () => [...DEFAULT_METHODS] },
    timeout_ms: { type: Number, default: 30_000 },
    operations: { type: [OperationSchema], default: [] },
    /** Free text appended to `api_man({api})` — quirks, rate limits, which operation to prefer. */
    notes: { type: String, default: '' },
    /** Installed from the shipped catalogue (`builtin-catalogue.ts`) rather than hand-added. */
    builtin: { type: Boolean, default: false },
    /** Last failure seen by the caller service, surfaced on the settings page. */
    last_error: { type: String, default: '' },
    last_used_at: { type: Date, default: null },
  },
  { collection: 'api_sources', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type ApiSource = InferSchemaType<typeof ApiSourceSchema>;
export type ApiSourceDoc = HydratedDocument<ApiSource>;
export type ApiOperation = ApiSource['operations'][number];
export type ApiParam = ApiOperation['params'][number];

export const ApiSourceModel = model('ApiSource', ApiSourceSchema);
