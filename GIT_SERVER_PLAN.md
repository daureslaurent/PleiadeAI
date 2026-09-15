# GIT_SERVER_PLAN — internal git server (Forgejo)

## Context
The fleet has no shared place to keep code. Agents can `git clone` out over SSH, but nothing inside
the stack versions their work, and the operator can't see who changed what. Goal: a Forgejo server in
docker-compose. Isolated agents reach it from their containers, each under its own account. A new
**Git** page lets the operator browse repos, files, logs and diffs, manage access and see per-agent
activity. A new **Git** prompt module tells agents how to use it.

Decisions (from Q&A):
- **Server:** Forgejo.
- **Network:** a dedicated git network.
- **Accounts:** one Forgejo account per agent.
- **Agent tool:** a small `git_repos` tool.
- **Repo policy:** agents may create repos; repos are fleet-readable by default.
- **Scope:** isolated agents only.
- **Forgejo UI:** hidden, never published through Caddy.

The first implementation step copies this plan to the repo root as `GIT_SERVER_PLAN.md` (house
convention: source comments cite spec §).

## 1. Compose + networking
`docker-compose.yml`:

**New `forgejo` service**
- Image: `codeberg.org/forgejo/forgejo:16-rootless`.
- `container_name: pleiades_forgejo`, volume `pleiades_forgejo_data` at `/var/lib/gitea`, SQLite database. The rootless image keeps its `app.ini` there too, so it needs no config volume.
- Env:
  - `FORGEJO__security__INSTALL_LOCK=true`
  - `FORGEJO__service__DISABLE_REGISTRATION=true`
  - `FORGEJO__service__REQUIRE_SIGNIN_VIEW=true`
  - `FORGEJO__server__DISABLE_SSH=true` (HTTP only)
  - `FORGEJO__server__OFFLINE_MODE=true`
  - `ROOT_URL=http://forgejo:3000/`
- Healthcheck: `wget -qO- http://127.0.0.1:3000/api/healthz`.
- Networks:
  - `pleiades_net`, so the backend can reach the API.
  - `pleiades_git_net` at the fixed address `172.31.250.10`.
- Ports: `127.0.0.1:${GIT_HOST_PORT:-3300}:3000`, loopback only. Only `host`-mode agents need it. It
  is not public and does not conflict with "caddy is the only published port".

**New network**
```yaml
pleiades_git_net: { name: pleiades_git_net, driver: bridge, internal: true,
  ipam: { config: [{ subnet: 172.31.250.0/24 }] } }
```
- A fixed `name:` removes the compose project prefix.
- `internal: true` means it never becomes a container's default route and gives no egress.
- Agents on it can reach Forgejo and nothing else (not mongo, qdrant or the backend).

**Backend service**
- Env: `GIT_ADMIN_PASSWORD`. `depends_on: forgejo: service_started`.
- `.env.example` documents `GIT_ADMIN_PASSWORD` and `GIT_HOST_PORT`.

**Validated env** (`backend/src/config/env.ts`)
- `GIT_SERVER_URL` (default `http://forgejo:3000`)
- `GIT_ADMIN_USER` (`pleiades-admin`)
- `GIT_ADMIN_PASSWORD` (optional; **empty means the Git feature is off**: the module renders
  "unavailable", the tool is refused and the page shows setup instructions)
- `GIT_ORG` (`pleiades`)
- `GIT_CONTAINER` (`pleiades_forgejo`)
- `GIT_AGENT_NETWORK` (`pleiades_git_net`)
- `GIT_AGENT_HOST` (`forgejo`) and `GIT_AGENT_PORT` (`3000`): the hostname and port an agent uses on the git network. These are the container port, not the loopback bind.
- `GIT_FORGEJO_IP` (`172.31.250.10`)
- `GIT_HOST_URL` (`http://127.0.0.1:3300`)

**How each isolation mode reaches git.** A single helper, `gitAccessFor(iso)` in `domain/git/`,
decides this, and both the container manager and the prompt module use it.

| mode | wiring | agent URL |
|---|---|---|
| `bridge` | `docker network connect pleiades_git_net <ctr>` | `http://forgejo:3000` |
| `host` | none (shares the host netns) | `http://127.0.0.1:3300` |
| `vpn` | connect **gluetun** to the git net before it starts. gluetun treats every attached ethernet subnet as a local network, adding main-table rules and a firewall allow at boot, so no `FIREWALL_OUTBOUND_SUBNETS` is needed; that setting would route the subnet through eth0's gateway instead | `http://172.31.250.10:3000` (gluetun's DNS can't resolve docker names) |
| `none` | none | unavailable ("offline profile") |
| `ssh` | none (commands run on the remote host) | unavailable |
| no isolation | none | unavailable ("needs an isolation profile") |

**`isolation/docker.service.ts`**
- Add `networkConnect(net, container)`.
- Add `networks(container)`, an inspect of `.NetworkSettings.Networks`.

**`isolation/AgentContainerManager.ts`**
- In `doEnsure`, after create/start: when git is enabled and the mode is `bridge`, connect the
  container if it isn't attached yet. This is idempotent and also fixes containers that existed before
  this change.
- In `ensureGluetun`, label gluetun `pleiades.git=1` and connect it before `start`. A gluetun without
  that label is recreated once, through the existing recreate path, which already handles stale netns.
- Isolation PATCH already removes containers when `network` changes, so a mode switch rewires itself.

## 2. Backend domain `domain/git/`
- **`forgejo.client.ts`**
  - A thin fetch client with admin basic auth plus a `Sudo: <user>` header when acting as an agent.
  - Timeouts and typed errors, logged through `createLogger('git')`.
  - It is the single request builder for the routes, the tool, the module fetch and bootstrap, the
    same idea as `api-caller.service.ts`.
- **`git-bootstrap.ts`**, called fire-and-forget at boot in `index.ts` (next to `installBuiltins`):
  1. Wait for healthz.
  2. Create the admin if it's missing via
     `dockerService.exec(GIT_CONTAINER, ['forgejo','admin','user','create','--admin',…])`.
  3. Ensure org `GIT_ORG` exists.
  4. Ensure team `fleet` exists (permission `read`, not `includes_all_repositories`, so read access
     can be controlled per repo).
- **`git-identity.model.ts`**: a new collection `git_identities`:
  - `agent_id` (unique), `username` (`agent-<slug>-<id6>`, stable across renames)
  - `forgejo_user_id`, `email` (`<username>@agents.pleiades.local`)
  - `token_enc` (AES via `encryptSecret`/`decryptSecret` from `isolation/ssh.service.ts`, `select:false`)
  - `provisioned_at`
  - Migration: `backend/migrations/2026091600000-git-identities.js` (collection + unique index).
- **`git-identity.service.ts`**
  - `ensureIdentity(agent)`: create the Forgejo user (random password, `must_change_password:false`),
    mint a token with scopes `write:repository` and `read:user`, store it, and add the user to team
    `fleet`.
  - `rotate(agentId)`.
  - `remove(agentId)`: delete the Forgejo user (commits keep their author email). Hooked into
    `agentsRouter.delete('/:id')` (`transport/http/routes/agents.routes.ts:178`).
  - Also updates the Forgejo `full_name` when the agent is renamed.
- **`git-credentials.ts`**, planted into the container like `installSshKey`
  (`AgentContainerManager.ts:924`), via `dockerService.exec` with stdin (never argv):
  - `~/.git-credentials` (mode 600, `http://<user>:<token>@<agent URL host>`)
  - `git config --global credential.helper store`
  - `user.name <agent name>` and `user.email`
  - Planted on create, and re-planted in `doEnsure` if a marker file `/opt/pleiades/git.ok` holding the
    token hash is missing or stale. That covers existing containers and token rotation.
- **`git-repo.service.ts`**. All repo creation goes through the backend admin client, so agent tokens
  never need org rights.
  - `create(name, desc, creatorAgentId?)`: create the org repo, add the creator as a `write`
    collaborator, and add the repo to team `fleet` (fleet-readable by default).
  - `setFleetReadable(repo, bool)`: add or remove the team's repo.
  - `setAccess(repo, agentId, 'read'|'write'|'none')`: collaborators API.
  - `delete`
  - `listForAgent(agentId)`: `GET /user/repos` with the Sudo header.
  - Browse wrappers: contents/tree at a ref, raw file, commits (`sha`, `path`, `page`), commit detail
    and `.diff`, branches, org activity feed (`/orgs/{org}/activities/feeds`), each mapped back to
    agents through `git_identities`.

## 3. HTTP routes `transport/http/routes/git.routes.ts`
Mounted as `app.use('/api/git', requireAuth, gitRouter)`. API keys stay read-only by default through
the existing middleware.
- **Server and identities**
  - `GET /status`: enabled, reachable, version, org. Always 200 `{ok, error}`, like `comfy/status`.
  - `GET /identities`: agents ↔ git usernames and provision state.
  - `POST /identities/:agentId/provision|rotate`
- **Repos**
  - `GET /repos`
  - `POST /repos`
  - `DELETE /repos/:repo`, confirmed in the UI.
- **Browsing**
  - `GET /repos/:repo/tree?ref=&path=`
  - `GET /repos/:repo/raw?ref=&path=`: size-capped, with a binary flag.
  - `GET /repos/:repo/commits?ref=&path=&page=`
  - `GET /repos/:repo/commits/:sha`: metadata, files and the unified diff text.
  - `GET /repos/:repo/branches`
- **Access**
  - `GET /repos/:repo/access`: fleet_readable plus a per-agent permission list.
  - `PUT /repos/:repo/access`
- **Activity**
  - `GET /activity?agentId=&repo=&page=`

## 4. Agent tool + prompt module
- **`tools/core/gitRepos.ts`**, registered in `CORE_TOOLS` and `CATEGORY_BY_TOOL`
  (`tools/registry.ts`).
  - Actions:
    - `list`: repos, clone URL for *this* agent's mode, permission.
    - `create`: name and description. The agent becomes writer and the repo is fleet-readable.
    - `info`: branches plus the last 10 commits of a ref.
  - `parallelSafe` for `list`/`info` only.
  - Refuses with `ctx.isolationError` or the "unavailable" reason when git isn't reachable. It never
    falls back to anything else.
  - Also gets a `guide.ts` topic `git`: clone/commit/push workflow, branch etiquette, no force-push to
    `main`.
- **Auto-grant** in `AgentRunner.ts` (~L416): add `git_repos` when the agent is isolated, holds
  `bash` and git is enabled. `resolveTools` still gates it on the module and tool switches.
- **Module `git`** in `modules/definitions/capabilities.ts`, registered in `modules/registry.ts`:
  - Group `capabilities`, `tools: ['git_repos']`, `subagentDefault: true`.
  - One block: `title: 'Git'`, `placement: 'system_tail'`, `order: 140` (after Memory 130).
  - `PromptContext.git?: { available: true; url; username; repos: {name, permission}[]; more: number }
    | { available: false; reason }`. It is filled in `AgentRunner` near L541, only when
    `mods.enabled('git', scope)` and the agent holds `bash` or `git_repos`. That is one
    `listForAgent` call with a ~1.5 s timeout; on failure the block says "server unreachable this
    turn".
  - The rendered block, which also stays short when unavailable:
    ```
    ## Git
    The fleet has an internal git server. You are `<username>`; credentials are already configured —
    never ask for or print a token.
    Server: <url>   Clone: git clone <url>/<org>/<repo>.git
    Repos you can reach (N): repo-a (write), repo-b (read) … +M more — use `git_repos list`.
    Create a repo with `git_repos create` before pushing new work. Commit small, with messages that say
    why; push to a branch and never force-push `main`. Keep clones under /workspace.
    ```
  - Add a sample to `modules/preview.ts`.
  - The block `title` must match its rendered `## Git` heading, for `prompt-usage.ts`.
- **Environment block** (`definitions/core.ts:28`): the Execution line also names the profile's network
  mode (`isolated container, network: bridge`), since git and web reach now depend on it. `PromptContext`
  gets `isolationNetwork`, from the `iso` already loaded at AgentRunner L360.

## 5. Frontend
- **Routing**
  - `App.tsx`: `/git` and `/git/:repo`.
  - `Sidebar.tsx`: a `{ to:'/git', label:'Git', icon: GitBranch }` entry in the Infrastructure group.
- **`lib/api.ts`**: `gitApi` plus types, following the `mediaApi` pattern.
- **`views/git/`**, layout like `views/media/MediaView.tsx` and `components/MasterDetail.tsx`:
  - `GitView.tsx`
    - Rail: repo list with a "New repo" button, a status dot from `/status`, and an Activity entry.
    - Detail pane: the selected repo or the activity feed. A setup `Callout` when git is disabled or
      unreachable.
  - `RepoDetail.tsx`: a header (clone URL, default branch, a ref picker built from branches) and tabs:
    - **Files**: breadcrumb folder browser, adapted from `FileExplorer` in
      `components/workspace/IsolationPanel.tsx:297`.
    - **Commits**: paginated log with author, which links to the agent when it maps to an identity.
    - **Branches**
    - **Access**: fleet-readable toggle and a per-agent read/write/none `Select`.
  - `FileView.tsx`: syntax-highlighted file view. Export `CodeBlock` from `components/Markdown.tsx`
    (Prism, theme-aware) and reuse it. Markdown files render through `Markdown`.
  - `CommitDetail.tsx`: file list with +/- stats and a **unified diff renderer** (`DiffView.tsx`: parse
    `diff --git` / `@@` hunks, per-line classes). No new dependency. Colours use theme tokens
    (`emerald`/`rose` alpha classes, `.well`, `.hairline`), never hex.
  - `ActivityFeed.tsx`: pushes, repo creates and branch events, filterable by agent and repo, each
    linked to `/agents/...` and the commit.
  - `IdentitiesPanel`, inside Activity or a small tab: agent ↔ username, provisioned state,
    provision/rotate buttons.
- UI kit only (`components/ui`). No hard-coded colours (THEME_SYSTEM rules).

## 6. Files touched (representative)
- `docker-compose.yml`, `.env.example`
- `backend/src/config/env.ts`, `backend/src/index.ts`
- `backend/src/isolation/{docker.service,AgentContainerManager,vpn.service}.ts`
- `backend/src/domain/git/*` (new), `backend/migrations/<ts>-git-identities.js`
- `backend/src/transport/http/routes/{git.routes.ts (new), agents.routes.ts}`
- `backend/src/tools/core/gitRepos.ts` (new), `tools/registry.ts`, `tools/core/guide.ts`
- `backend/src/modules/{types,registry,preview}.ts`, `modules/definitions/{capabilities,core}.ts`
- `backend/src/orchestrator/AgentRunner.ts`
- `frontend/src/{App.tsx, components/Sidebar.tsx, components/Markdown.tsx, lib/api.ts}`,
  `frontend/src/views/git/*` (new)
- `CLAUDE.md`: a short "Internal git" architecture bullet. `GIT_SERVER_PLAN.md` (new).

## 7. Verification
1. `npm run typecheck` in `backend/` and `frontend/`, then `npm run build` in both.
2. `docker compose up -d --build forgejo backend`, then check:
   - The backend logs show bootstrap creating the admin, org and team.
   - `curl` from the backend container to `http://forgejo:3000/api/healthz` works.
   - `docker network inspect pleiades_git_net` shows only forgejo.
3. Git page: `/status` is green. Create repo `demo`, then check Access shows fleet read.
4. Bridge-profile agent. Chat: "create repo demo2, add a README, push".
   - `git_repos create` succeeds, the container is attached to `pleiades_git_net`, and
     `~/.git-credentials` is present (mode 600).
   - The push succeeds and the commit author is the agent.
   - Inside the container, `curl mongodb:27017` fails (isolation holds).
5. Host-mode agent: clones via `127.0.0.1:3300`.
6. VPN-mode agent: clones via `172.31.250.10`, and general egress still goes out the tunnel.
7. `none`/`ssh`/non-isolated agents: the Git block says unavailable and `git_repos` refuses with the
   reason.
8. Page checks:
   - Files tab browses and highlights.
   - Commits → a commit shows the diff.
   - Activity filters by agent.
   - Revoking write makes the agent's push fail with 403.
   - Rotating the token re-plants credentials on the next turn and the push works again.
9. Debugger context breakdown shows the `Git` block; Settings → Modules lists "Git" and switching it
   off removes the block and the tool.
10. Deleting the agent removes its Forgejo user.
11. Rebuild and restart the backend from dist (memory: stale dist looks like a bug).

## 8. As built — notes
- **Tokens.** Forgejo 16 lets the admin mint a token for another user with basic auth
  (`POST /users/{u}/tokens`), so agent accounts get a random password that nobody ever uses.
- **Prompt fetch.** Lives in `domain/git/git-prompt.ts`. Account creation is capped at 3 s and the repo
  list at 2.5 s. Container provisioning in `AgentContainerManager.ensureGit` waits at most 15 s, then
  finishes in the background. Git trouble never costs the agent its shell.
- **Credential marker.** `/opt/pleiades/git.ok` holds `tokenHash|url|name`. A rotated token, a URL change
  (the profile's network mode) or a rename re-plants credentials on the next ensure.
- **Repo creators.** Repos are created by the admin, so `create_repo` activity shows `pleiades-admin`.
  The agent's pushes show under its own account.
- **Verified locally** against a real bridge-mode agent container:
  - the container is attached to the git network, and `~/.git-credentials` is 600;
  - a push to a fleet-readable repo is refused, and succeeds after a write grant;
  - mongo is unreachable from the agent container;
  - commits and activity map back to the agent;
  - after a rotation the old token fails and the new one is re-planted;
  - a rename syncs the account's `full_name`;
  - deleting the agent removes its Forgejo user.
- **Not verified locally:** `host` and `vpn` modes (no WireGuard config on the dev box).
