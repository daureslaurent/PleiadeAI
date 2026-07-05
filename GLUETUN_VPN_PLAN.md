# Gluetun VPN for Isolated Agents — Implementation Plan

## Goal
Add an optional **VPN network mode** to isolation profiles. When a profile's network mode is
`vpn`, its agent containers route all traffic through a dedicated **gluetun** container (WireGuard),
so the agent's real IP never leaks.

## Decisions (locked with operator)
- **Topology:** one gluetun container **per isolation profile** (not a single shared one). The
  backend spins it up dynamically via the host Docker daemon (Docker-out-of-Docker), same as it
  already builds agent containers. **No new docker-compose service.**
- **Config source:** the operator **uploads a standard WireGuard `.conf`** in the Isolation UI tab.
  The backend parses it (`[Interface]`/`[Peer]` INI) into gluetun's `custom`-provider env vars. The
  whole `.conf` contains the private key, so it is **AES-256-GCM encrypted at rest** and write-only
  (reuses the SSH key crypto in `ssh.service.ts`), stored as a single `vpn_conf_enc` blob.
- **Network model:** extend the existing `network` enum to `host | bridge | none | **vpn**`.
  Selecting `vpn` routes the container through gluetun and ignores the other modes.
- **Config shape:** a raw WireGuard `.conf` → gluetun `VPN_SERVICE_PROVIDER=custom`, `VPN_TYPE=wireguard`
  with `WIREGUARD_PRIVATE_KEY` / `WIREGUARD_ADDRESSES` / `WIREGUARD_PUBLIC_KEY` / `WIREGUARD_ENDPOINT_IP`
  / `WIREGUARD_ENDPOINT_PORT` (+ optional `WIREGUARD_PRESHARED_KEY`). The `.conf` is validated (parsed)
  at save time, so a malformed upload is rejected by the API (400), not at container start.
- **Kill-switch:** gate `ensureReady` on the gluetun healthcheck. If the tunnel never comes up,
  isolated tools throw `IsolationNotReadyError` (never fall back / leak the real IP).

## How it works at runtime
1. Agent runs a tool → `AgentContainerManager.ensureReady`.
2. If `iso.network === 'vpn'`:
   - Ensure the profile's gluetun container (`<prefix>_iso_vpn_<isoId>`) is created (from decrypted
     VPN config) and running, then **wait until its healthcheck is `healthy`** (bounded by
     `AGENT_VPN_HEALTH_TIMEOUT_MS`). Throw `IsolationNotReadyError` on timeout / missing config.
   - The agent container is created with `--network container:<gluetun name>` so it shares gluetun's
     network namespace (kill-switch protects it).
3. Non-vpn modes behave exactly as before.

Because a `container:` network binds the agent container to gluetun's netns, whenever gluetun is
(re)created the agent container is dropped so it re-attaches to the fresh namespace.

## Files to change

### Backend
- `src/config/env.ts` — add `GLUETUN_IMAGE` (default `qmcgaw/gluetun:latest`) and
  `AGENT_VPN_HEALTH_TIMEOUT_MS` (default 60000).
- `src/domain/isolations/isolation.model.ts` — add `'vpn'` to `network` enum; add a single encrypted
  `select:false` `vpn_conf_enc` (the whole uploaded `.conf`).
- `src/domain/isolations/isolation.repository.ts` — thread `vpn_conf_enc` through `create`;
  add `findByIdWithVpn` (`+vpn_conf_enc`) and `hasVpnConf`.
- `src/isolation/names.ts` — add `isoGluetunName(isolationId)`.
- `src/isolation/vpn.service.ts` (new) — `parseWireguardConf` (INI parser) + `vpnConfigForIsolation`
  (decrypt the stored `.conf` and parse it) + `gluetunEnvArgs` (custom-provider env from the parsed
  fields). Reuses `encryptSecret`/`decryptSecret` from `ssh.service.ts`.
- `src/isolation/docker.service.ts` — add `createGluetun`, `containerHealth`, `waitHealthy`.
- `src/isolation/AgentContainerManager.ts` — add `network` resolution for `vpn`
  (`ensureGluetun` → wait healthy → `--network container:…`), plus `teardownGluetun`; extend
  `IsolationProfile` and teardown paths.
- `src/transport/http/routes/isolations.routes.ts` — accept write-only `vpn_conf` on create/PATCH
  (validate by parsing → 400 on bad input; encrypt/clear/keep like the SSH key), recreate gluetun +
  agent containers when VPN config or network mode changes, tear down gluetun on profile delete, and
  surface `vpn_conf_set` + gluetun state in `/status`.
- `src/transport/http/routes/transfer.routes.ts` — VPN config is **omitted** from profile
  export/import (the `.conf` is secret, like the SSH private key); operator re-uploads on the target.
- `migrations/` — migrate-mongo file defaulting `vpn_conf_enc: null` on existing docs.

### Frontend
- `src/lib/api.ts` — extend `Isolation` (`network` union), `NewIsolation`/`IsolationPatch`
  (write-only `vpn_conf?`), and `IsolationStatus` (`vpn_conf_set`, `vpn_state`).
- `src/views/IsolationsView.tsx` — add the `vpn` option to the Network select and a VPN block with a
  **`.conf` file upload** (+ paste/edit textarea), a config-set indicator + remove, shown when network
  mode is `vpn`.

## Verify
`npm run typecheck` in both `backend/` and `frontend/`.
