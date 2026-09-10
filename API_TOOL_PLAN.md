# API_TOOL_PLAN.md — the operator's APIs, callable by name

Two tools and one collection. `api_man` is the catalogue: it tells an agent which HTTP APIs this
instance has been given and what each one can be asked. `api` is the caller: it takes one entry from
that catalogue and returns parsed JSON. The agent never sees a URL it could bend, never sees a
credential, and never composes a request — it names an operation and fills its parameters.

That split is the whole design. A tool that took a free URL would be `webfetch` with extra steps; the
value here is that the operator has *already decided* what is reachable and how it authenticates, so
the model's job shrinks to picking an operation and its arguments.

## 1. The unit of configuration: an API with named operations

One document in `api_sources` is one API — a base URL, an auth method, and a list of **operations**.

```
weather                         name (a slug: the namespace)
  "Open-Meteo forecast + geocoding, no key needed."     description — the line `api_man` returns
  https://api.open-meteo.com    base_url
  auth: none                    none | header | query | bearer | basic
  methods_allowed: [GET]        writes are opt-in per API (see §4)
  operations:
    forecast   GET /v1/forecast     params: latitude*, longitude*, forecast_days
    geocode    GET /v1/search       params: name*, count
```

An agent calls `api({operation: "weather.forecast", params: {latitude: 48.85, longitude: 2.35}})`.
The `namespace.operation` id is the only handle it ever holds.

**Parameter placement** is declared per parameter (`in`): `path` substitutes a `{token}` in the
operation's path, `query` appends to the query string, `body` builds the JSON body, `header` sets a
request header. Each declares `type`, `required`, an optional `default` and a description — that
description is what `api_man` shows the model, so it is the actual prompt surface.

## 2. `api_man` — the catalogue

- `api_man({})` → every **enabled** API: name, description, and each operation's signature +
  one-liner. Cheap enough to call at the top of a turn.
- `api_man({api: "weather"})` → the full contract for one API: base URL, whether auth is handled,
  and per operation the method, path, and every parameter with type/required/description, plus the
  operator's free-text `notes`.

It never returns a credential — the secret is `select: false` and the projection drops it.

## 3. `api` — the caller

`api({operation, params})`:

1. Split `namespace.operation`, load the API, refuse if disabled or unknown (listing what *is*
   available, so a wrong guess self-corrects in one turn).
2. Validate: unknown parameter names are refused, missing required ones are refused, values are
   coerced to their declared type.
3. Build the URL — path params `encodeURIComponent`'d, then a hard check that the resolved origin
   still equals the base URL's origin. A path parameter must not be able to walk the request onto
   another host.
4. Inject auth server-side, apply the per-API timeout, honour `ctx.signal` so a stopped turn does
   not leave a request in flight.
5. **Return JSON.** The body is parsed regardless of the declared content type; a body that is not
   JSON is a tool error carrying a snippet, not a silent string. A large payload is elided in the
   middle against a token budget, exactly as `webfetch` does — an API that returns a 4 MB array must
   not eat the context window.

Failures are tool errors the agent reads (`{ok: false, error, status}`), never thrown exceptions:
a 404 from a third party is information, not a crash.

## 4. What an agent may do with it

- **Availability.** `api`/`api_man` in `tools_allowed` grants every enabled API — the same shape as
  `web_search`. The per-API enable switch is the gate; there is no per-agent grant.
- **Methods.** Each API declares `methods_allowed`, defaulting to `GET`/`HEAD` on a new entry. An
  operation whose method is not allowed is refused at call time as well as hidden from `api_man`, so
  turning writes off later is immediate rather than advisory.

## 5. Credentials

Five schemes, and one distinction that matters more than the five: whether the credential is
**required**.

- `none`, key in a header, key in a query parameter, `bearer`, `basic` — the stored secret is sent
  as-is.
- `oauth2` — the operator stores long-lived *client credentials* and the backend spends them on a
  short-lived access token, caches it in memory, renews it a minute before it expires, and drops it
  the moment the API answers 401. Reddit is why this exists: it refuses anonymous API traffic
  outright, so without a token fetched on the agent's behalf it simply cannot be read.
- `auth_optional` marks an API that answers anonymously and answers *better* with a key — GitHub's
  60 requests an hour against 5000. Those ship working, and the settings page says what a key buys
  (`secret_hint`) rather than blocking the operator until they get one.

## 6. Storage

`api_sources` (new collection, new migration). The credential is a single `secret_enc` field —
AES-256-GCM at rest via `isolation/ssh.service`'s `encryptSecret`, `select: false`, and the `_enc`
suffix keeps it inside `redact.ts`'s pattern as second-line defence. Reads report `has_secret`, never
the value; a write with an empty secret leaves the stored one alone (the `monitor_targets` idiom).

## 7. Surfaces

- `domain/apis/` — model, repository, and `api-caller.service.ts` (the request builder + executor,
  shared by the tool and the Test button so they cannot drift).
- `transport/http/routes/api-sources.routes.ts` — CRUD + `POST /:id/test`, mounted at
  `/api/api-sources` behind `requireAuth`.
- `tools/core/api.ts` — both tools, registered in `tools/registry.ts` under the `web` category.
- Settings → **APIs** (`/settings/apis`): a new category card, `panels/ApisPanel.tsx` +
  `managers/ApiSourcesManager.tsx`. Each API is a row that expands into its editor, with its
  operations as a nested list and a Test button that runs one against the live service.

## 8. The shipped catalogue

`domain/apis/builtin-catalogue.ts` holds the APIs this instance comes with — Wikipedia, Wikidata,
OpenAlex, Open Library, Hacker News, Lobsters, 4chan, Reddit, Stack Exchange, GitHub, npm, PyPI,
crates.io, Hugging Face, OSV, Open-Meteo (forecast + air quality), Nominatim, ECB currency rates,
CoinGecko, USGS earthquakes, public holidays, world time, IP lookup, the Wayback Machine and
Datamuse. Twenty-six APIs, eighty-odd operations, all free and all but one usable with no account.

Three things about it are deliberate:

- **Every entry was called before it was written down.** Several obvious candidates did not survive
  that: `worldtimeapi.org` and `dictionaryapi.dev` no longer resolve, and RestCountries v3 answers a
  country lookup with a deprecation notice — v5 wants an account. A catalogue of APIs that *used to*
  work is worse than no catalogue, because the agent pays a turn to discover each corpse. Each
  operation carries a `sample` call, which is what makes the catalogue testable as a whole rather
  than one entry at a time.
- **Presets are starting points, not bindings.** They install into `api_sources` as ordinary
  documents; the operator can edit, disable or delete any of them and nothing re-reads the catalogue
  at call time. Installing is additive only — an API whose name already exists is skipped, never
  reset, or an edited base URL would silently revert on the next deploy.
- **Install is remembered, not inferred.** Boot installs what this instance has *never been offered*
  (tracked on the settings singleton), rather than what is currently missing. Otherwise a preset the
  operator deleted would return on every restart. Settings → APIs can force-install anything missing,
  which is how a deleted one comes back and how a release's new presets can be pulled in early.

Reddit is the one entry that ships **disabled**: it needs the operator's own free app credentials
(client id + secret, two minutes at reddit.com/prefs/apps), after which the OAuth2 grant in §5 keeps
it authenticated. 4chan ships enabled but carries a note in its own description saying what it is —
unmoderated, ephemeral, and never a source.

## 9. Order of work

1. Model + repository + migration.
2. `api-caller.service.ts` — resolve, validate, build, fetch, parse.
3. The two tools + registry wiring + a short `guide` entry pointing at `api_man` first.
4. Routes + mount.
5. `lib/api.ts` client and types.
6. The settings category, panel and manager.
7. `npm run typecheck` on both apps.
