# pleiade-mcp

Read-only access to a deployed PleiadeAI instance, for an external agent (Claude Code) or a shell.

Two front-ends over one client:

| | |
| --- | --- |
| **MCP server** | `tools/pleiade-mcp/index.mjs`, wired up by the repo-root `.mcp.json` |
| **CLI** | `node scripts/prod.mjs <command> [--key=value …]` |

Both read the same endpoint catalogue (`endpoints.mjs`) and the same credentials, and both speak
only `GET`. No dependencies — a bare `node` runs them.

## Setup

1. In the running app: **Settings → API Keys → Create API key**. The plaintext is shown once.
2. `cp .env.prod.example .env.prod` at the repo root and fill in:

   ```
   PLEIADE_API_URL=https://pleiade.example.com
   PLEIADE_API_KEY=plk_…
   ```

   `.env.prod` is gitignored. Real environment variables override it.

3. Verify: `node scripts/prod.mjs agents`. In Claude Code, `/mcp` should list the `pleiade` server.

## What a key can do

A key authenticates but is **read-only**: the backend rejects any non-`GET`/`HEAD` request with
`403`, refuses `/api/api-keys` entirely, and cannot open a websocket (so it can't drive an agent).
Response bodies are additionally scrubbed of credentials — `GET /api/endpoints` returns each
inference server's `api_key` as `[redacted]`.

Revoke a compromised key from the same Settings panel; it stops working immediately.

## Tools / commands

`pleiade_agents`, `pleiade_agent`, `pleiade_skills`, `pleiade_sessions`, `pleiade_session_messages`,
`pleiade_llama_logs`, `pleiade_llama_log`, `pleiade_llama_stats`, `pleiade_scoring_summary`,
`pleiade_scores`, `pleiade_inbox`, `pleiade_memory`, `pleiade_autonomy_jobs`, and `pleiade_get`
(escape hatch: any `/api/…` path).

The CLI drops the `pleiade_` prefix: `node scripts/prod.mjs llama_logs --limit=25`.
Run it with no arguments for the full list with each command's options.

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

Add `PLEIADE_LOCAL_URL` + `PLEIADE_LOCAL_USERNAME`/`PLEIADE_LOCAL_PASSWORD` to `.env.prod` — the
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
