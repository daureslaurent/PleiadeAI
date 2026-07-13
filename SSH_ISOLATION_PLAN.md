# SSH network mode for isolation profiles

Goal: a new isolation `network` mode — `ssh` — where the agent's **entire Linux execution
environment** (the `bash` tool, the file tools, and TS/Python skills) runs on a **remote host over
SSH** (e.g. `10.13.13.5:22`) instead of inside the agent's container. The agent must never see the
SSH hop: it calls `bash` with a plain command and gets output back, exactly as before.

## Decisions (locked with the operator)

| Question | Decision |
| --- | --- |
| Topology | **Container as jump box.** The per-agent container still exists; `AgentExecutor` wraps every command as `ssh remote -- <cmd>` from inside it. Reuses the existing key/known_hosts/sudo-password injection verbatim. |
| Scope | **Everything Linux-side.** `bash` + file tools + skills all execute remotely (harnesses copied to the remote's `~/.pleiades/bin`). One coherent filesystem from the agent's point of view. |
| Data model | New `network` enum value `'ssh'` + `ssh_remote_host` / `ssh_remote_port` / `ssh_remote_user` on the profile. |
| Auth | **Key auth + pinned host key.** Reuse the profile's existing `ssh_private_key_enc`; `StrictHostKeyChecking=yes` against `ssh_known_hosts`. A "scan host key" action fetches + pins the fingerprint. |
| Working dir | The remote user's **`$HOME`**. |
| Failure | **Hard error, never fall back.** Unreachable/auth-failed/host-key-mismatch surfaces as `IsolationNotReadyError` — a command meant for the remote must never silently run elsewhere. |
| Connection | **ControlMaster multiplexing** — one persistent master socket per agent container, `ControlPersist` = the profile's idle timeout. |
| Visual desktop | **Disabled in `ssh` mode** (the desktop would live on a different machine than the shell — exactly the split-brain we're avoiding). |

## Why this seam

`bash` (`tools/core/bash.ts`), the file tools (`tools/core/fs/env-fs.ts`) and skills
(`tools/sandbox/SkillRunner.ts`) *all* execute through `ToolContext.exec` → `AgentExecutor`
(`isolation/AgentContainerManager.ts`). Putting the SSH hop inside `AgentExecutor.run()` /
`runScript()` therefore covers the whole execution surface **without changing a single tool** — and
the agent's tool schemas are untouched, so it cannot see the hop.

## Command transport (injection-safe)

`docker exec` takes an **argv array**, so there is no container-side shell to quote against. The
remote side is the only quoting surface, and we sidestep it by base64-encoding the script:

```
docker exec <ctr> ssh <opts> -p <port> <user>@<host> 'eval "$(printf %s <BASE64> | base64 -d)"'
```

`<BASE64>` is `[A-Za-z0-9+/=]` only — nothing for a remote shell to interpret. `eval` (not a pipe
into `bash`) leaves the remote command's **stdin free**, which the file tools need: they stream
multi-megabyte base64 payloads on stdin to dodge `ARG_MAX`/`E2BIG`.

The decoded script is the existing `wrapWithSession()` logic, re-pointed at remote paths — it
restores `$PWD` from a state file, runs the command, persists the new `$PWD`, and preserves the
user's exit code. So `cd` still carries across `bash` calls, on the remote.

Skills use the same channel: `ssh … -- python3 ~/.pleiades/bin/py_runner.py` with the JSON payload
on stdin (ssh forwards it), matching the existing sandbox protocol byte for byte.

## Remote layout

```
$HOME/                       ← the agent's cwd (session default)
$HOME/.pleiades/bin/         ← py_runner.py, node_runner.cjs (provisioned over ssh)
$HOME/.pleiades/session/cwd  ← persistent-session state
```

## SSH options

`BatchMode=yes` (fail fast, never hang on a password prompt), `StrictHostKeyChecking=yes`,
`ConnectTimeout`, `ControlMaster=auto` + `ControlPath` + `ControlPersist`, `ServerAlive*` keepalives,
`LogLevel=ERROR` (suppress banner noise on stderr without hiding real errors).

## Work items

### Backend
1. `domain/isolations/isolation.model.ts` — `'ssh'` in the `network` enum; `ssh_remote_host`,
   `ssh_remote_port` (default 22), `ssh_remote_user`.
2. `migrations/` — new timestamped migration adding the three fields to existing docs.
3. `isolation/remote-ssh.ts` (new) — remote paths, `sshArgv()`, the base64 `eval` wrapper, the
   remote session wrapper, and the harness-provisioning script.
4. `isolation/names.ts` — control-socket dir inside the container.
5. `isolation/AgentContainerManager.ts` — `AgentExecutor` gains an optional remote target and
   branches `run()`/`runScript()`; `doEnsure` preflights `ssh` in the image + reachability and
   provisions the remote harnesses (throws `IsolationNotReadyError` on any failure); `ensureVisual`
   refuses in `ssh` mode.
6. `transport/http/routes/isolations.routes.ts` — accept the new fields (recreate containers on
   change); `POST /:id/ssh/scan-host` (ssh-keyscan → pin fingerprint) and `POST /:id/ssh/test`
   (end-to-end connectivity check).
7. `backend/Dockerfile` — add `openssh-client` (for keyscan/test from the backend).
8. `isolation/dockerfile.template.ts` — add `openssh-client` to the default agent image.

### Frontend
9. `lib/api.ts` — types + the two new endpoints.
10. `views/IsolationsView.tsx` — the `ssh` network option and a Remote SSH panel (host/port/user,
    scan host key, test connection), plus a note that bash/skills/files run on the remote.

## Verification (done — 2026-07-13)

Typecheck passes on both apps. The transport was then exercised end-to-end against a throwaway
`sshd` container, driving the real `remote-ssh` module through a real `docker exec` (i.e. the exact
path `AgentExecutor.run()` / `runScript()` take). All green:

| Check | Result |
| --- | --- |
| `bash` executes on the **remote** (`hostname` → the remote's, not the container's) | pass |
| Runs as the remote SSH user, in its `$HOME` | pass |
| `cd` persists across separate `bash` calls, on the remote | pass |
| File tools: 300 KB base64 streamed over stdin lands on the remote (the `ARG_MAX` path) | pass |
| A failing remote command surfaces its real non-zero exit code | pass |
| A Python **skill** runs on the remote and returns the harness JSON envelope | pass |
| ControlMaster socket is reused — warm call ≈ 170 ms | pass |
| Heredocs / quotes / `$`/backticks in an agent command survive the hop verbatim | pass |
| Agent text cannot escape the wrapper (injection) | pass |
| **Tampered host key is refused**, and never falls back to running in the container | pass |

The refusal surfaces to the agent as: *"SSH host key verification failed for `user@host:port`. The
remote's host key is not pinned (or has changed). Open the Isolation page and click 'Scan host key'…"*

## Operating notes
- The **agent image** needs `openssh-client` (the default Dockerfile now installs it; existing images
  must be rebuilt, and a missing client is reported as an actionable error, not a silent fallback).
- The **remote host** needs `python3` / `node` for Python / TS skills — `bash` and the file tools work
  on a bare box.
- Changing the remote target (host/port/user) or the SSH material recreates assigned agents'
  containers, so a stale ControlMaster socket can never keep executing against the old host.
