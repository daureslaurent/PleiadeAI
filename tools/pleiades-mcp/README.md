# pleiades-mcp

Access to a deployed PleiadesAI instance, for an external agent (Claude Code) or a shell.

Two front-ends over one client:

| | |
| --- | --- |
| **MCP server** | `tools/pleiades-mcp/index.mjs`, wired up by the repo-root `.mcp.json` |
| **CLI** | `node scripts/prod.mjs <command> [--key=value …]` |

Both read the same endpoint catalogue (`endpoints.mjs`) and the same credentials. Reads work with any
key; writes need a key carrying the matching scope (below). No dependencies — a bare `node` runs them.

## Setup

1. In the running app: **Settings → API Keys → Create API key**. The plaintext is shown once.
2. `cp .env.prod.example .env.prod` at the repo root and fill in:

   ```
   PLEIADES_API_URL=https://pleiades.example.com
   PLEIADES_API_KEY=plk_…
   ```

   `.env.prod` is gitignored. Real environment variables override it.

3. Verify: `node scripts/prod.mjs agents`. In Claude Code, `/mcp` should list the `pleiades` server.

## What a key can do

A key is **read-only unless you grant it scopes** when you create it. Without one, the backend
rejects any non-`GET`/`HEAD` request with `403`. With one, writes are still confined to that scope's
route family:

| Scope | Unlocks |
| --- | --- |
| `agents:write` | `/api/agents` |
| `isolations:write` | `/api/isolations` |
| `android:write` | `/api/android-devices` |
| `flows:write` | `/api/flows` — editing **and running** a flow, since a run spends real GPU time and can drive agents |
| `media:write` | `/api/media` — importing, correcting and test-running ComfyUI workflows |

Regardless of scope, a key can never reach `/api/api-keys`, and cannot open a websocket (so it can't
drive a chat). Response bodies are scrubbed of credentials — `GET /api/endpoints` returns each
inference server's `api_key` as `[redacted]`.

Revoke a compromised key from the same Settings panel; it stops working immediately.

## Tools / commands

Run the CLI with no arguments for the authoritative list — it is generated from `endpoints.mjs`, so
it can't drift. Broadly: agents, skills, sessions and their transcripts, inference logs and stats,
scoring, inbox, memory, autonomy jobs, flows (below), and `pleiades_get` as an escape hatch onto any
`/api/…` path.

The CLI drops the `pleiades_` prefix: `node scripts/prod.mjs llama_logs --limit=25`.

### Flows

Read: `flows`, `flow`, `flow_node_types`, `flow_runs`, `flow_run`.
Write (needs `flows:write`): `create_flow`, `update_flow`, `delete_flow`, `duplicate_flow`,
`validate_flow`, `run_flow`, `stop_flow_run`, `approve_flow_run`.

Two things worth knowing before authoring a graph from the outside:

- **`flow_node_types` is the source of truth.** It publishes every node type with its port names and
  types and its config fields — including the options resolved from the database, so you see the
  agents, tools and ComfyUI workflows that actually exist on that instance. Guessing a node type or a
  config key without it is how you get a graph that saves but won't run.
- **`update_flow` replaces whole arrays.** Passing `nodes` or `edges` overwrites that array outright,
  so read the flow, modify the list, and send it back complete. The response carries `issues` and
  `runnable` — check them rather than assuming.

`run_flow` returns a run id **immediately**; it does not wait, because a flow with a video node runs
for minutes. Poll `flow_run` for status, output and the debug trace.

### ComfyUI workflows

Read: `media_workflows`, `media_workflow`, `media_status`, `media_discover`.
Write (needs `media:write`): `import_media_workflow`, `update_media_workflow`,
`delete_media_workflow`, `validate_media_workflow`.

A flow's media nodes reference workflows **by id**, so `media_workflows` is how you find the id to
put in a node's `workflow` config. Two things to check on an imported workflow before wiring a flow
to it: that its `kind` is what you expect (a graph ending in a preview rather than a save used to be
misclassified), and that `bindings.prompt` exists — without one the run is refused, because
submitting it would silently regenerate the workflow author's own prompt.

```
node scripts/prod.mjs flow_node_types
node scripts/prod.mjs create_flow --body='{"name":"nightly render"}'
node scripts/prod.mjs update_flow --id=<id> --body=@graph.json
node scripts/prod.mjs run_flow --id=<id> --inputs='{"topic":"a lighthouse"}'
node scripts/prod.mjs flow_run --run_id=<run>
```

`object` and `array` options take inline JSON or `@file.json` — a flow graph is far too big to paste
on a command line.

## Cloning prod into local

`scripts/clone-prod.mjs` mirrors a prod instance into your local one: it reads through the read-only
key (`GET /api/transfer/export/clone`) and writes through the local operator API
(`POST /api/transfer/import/clone`).

```
node scripts/clone-prod.mjs                    # dry run — fetch, save a snapshot, show the diff
node scripts/clone-prod.mjs --apply            # replace local data (prompts for confirmation)
node scripts/clone-prod.mjs --file=d.json --apply   # re-import a saved snapshot, no refetch
node scripts/clone-prod.mjs --logs=1000        # deeper inference-log history (default 200)
```

Add `PLEIADES_LOCAL_URL` + `PLEIADES_LOCAL_USERNAME`/`PLEIADES_LOCAL_PASSWORD` to `.env.prod` — the
import writes, so it needs the *target's* operator login, not an API key.

**The import is destructive.** It drops the target's agents, isolations, sessions, messages, scores
and inference logs and reinserts prod's *with their original `_id`s*. That's what keeps
session→agent and message→session references resolving; it also means it replaces rather than
merges. (For merging one agent into an existing fleet, use Settings → Backup & Transfer, which
carries agents by name.) Guards: dry-run by default, refuses when source and target are the same
instance, refuses a non-loopback target without `--force`, and the API needs `{confirm:'REPLACE'}`.

Never copied: **endpoints** (they hold inference credentials), images, skills, settings, API keys,
Qdrant vectors. Agents relink to a same-named local endpoint, else the fleet default. Isolations
arrive with `image_id` cleared — rebuild the image locally. SSH private keys and secret-looking
agent parameters are stripped in transit. Snapshots land in `.dumps/` (gitignored — they contain
real conversation data).

## Adding a capability

Add one entry to `ENDPOINTS` in `endpoints.mjs`. It becomes both an MCP tool and a CLI subcommand.
