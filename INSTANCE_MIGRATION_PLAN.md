# Instance migration — moving a whole PleiadesAI to another server

Status: spec + implementation. Surface: **Settings → Instance migration** (`/settings/migration`).

## 1. What problem this solves, and why the existing exports don't

Three export paths already exist and **none of them is a migration**:

| Surface | Carries | Deliberately drops |
|---|---|---|
| `transfer.routes.ts` `pleiades-config` | agents + isolations, *by name* | secrets, ids, everything else |
| `clone.service.ts` `pleiades-clone` | agents/sessions/messages/scores, ids preserved | endpoints, skills, settings, Qdrant, GridFS, secrets |
| `maintenance/export` | four operational categories as JSON | everything else |

They are built for *merging a fleet into a foreign instance*, which is why they mint new ids and
strip credentials. A server move is the opposite problem: the target must end up **byte-identical in
meaning** to the source, ids and all, and then nobody should be able to tell the move happened.

So this is a fourth, separate artifact — `pleiades-instance` — and it is whole-instance by
construction rather than by a maintained list of collections (see §3).

## 2. The state that actually has to travel

| Store | Holds | How it travels |
|---|---|---|
| Mongo `pleiades` | ~35 collections, incl. `changelog` (migrate-mongo) | every collection, raw BSON |
| GridFS `resources`, `forum_files` | generated media, uploads | *as collections* — `.files`/`.chunks` are ordinary collections |
| Qdrant | one collection per agent `qdrant_namespace` + shared `forum_index` | scroll with vectors+payload, config recorded |
| `.env` | `JWT_SECRET`, `ISOLATION_ENC_KEY`, `AUTH_PASSWORD`, `LLAMA_API_URL`, … | snapshot **shown** on import, never auto-applied (§5) |
| Docker images for isolation profiles | build state, machine-local | not carried; rebuilt lazily on first tool use |
| Caddy TLS certs | ACME state | not carried; re-issued on the new host |

Deliberately *not* carried: the embeddings/fallback GGUF caches (they re-download), and anything
keyed to the old host's docker daemon.

## 3. Whole-instance by construction

The dump enumerates collections from `db.listCollections()` at run time rather than from a hand-kept
registry. A release that adds a collection is therefore migrated without anyone remembering to add
it — which is the only way "nothing must be missing" survives contact with a moving schema. The same
applies to Qdrant (`getCollections()`).

Documents are serialized as **raw BSON** via the driver's own `BSON.serialize`, not Extended JSON.
Two reasons: exact type fidelity (`ObjectId`, `Date`, `Binary`, `Long`, `Decimal128` all survive
round-trip unchanged), and no base64 inflation — which matters because GridFS chunk documents are
255 KB of binary each and a media-heavy instance is most of the archive.

Reads go through the **native driver**, not Mongoose. Every credential field in this codebase is
`select: false`, so a Mongoose read would silently omit exactly the rows that must not be lost.

## 4. The archive format (`.plmig`)

Streamed end to end in both directions — nothing is ever fully buffered, because the target is
multi-GB.

```
magic "PLEIADESMIG\0" | u32 headerLen | header JSON (plaintext)
frame*                                  frame := u32 len | iv(12) | ciphertext | tag(16)
```

The plaintext header carries only the format version, the scrypt salt/params and the creation
stamp — enough to prompt for a passphrase, not enough to learn anything. Concatenating the decrypted
frames yields a gzip stream; inflating it yields the entry stream:

```
entry := u32 headerLen | header JSON | chunk* | u32 0
chunk := u32 len | len bytes
```

Chunked rather than length-prefixed because a collection's byte length isn't knowable before it is
read. Entry kinds: `manifest`, `collection`, `qdrant`, `env`, `fingerprint` (always last — its
presence is how truncation is detected).

Crypto: `scrypt(passphrase, salt, N=2^15)` → 32-byte key; every frame gets a fresh IV and
AES-256-GCM, with the frame index as AAD so frames can't be reordered or dropped undetected.

## 5. Secrets: re-wrap, don't copy the key

`isolations.{ssh_private_key_enc, vpn_conf_enc, sudo_password_enc}`, `api_sources.secret_enc`,
`mail_accounts.refresh_token_enc`, `finetune_servers.api_key_enc` and `monitor_targets.api_key_enc`
are AES-GCM'd under `ISOLATION_ENC_KEY || JWT_SECRET` — an **env var**, which a dropped file cannot
rewrite.

Rather than make the operator copy that key by hand, export **re-wraps**: each field is decrypted
with the local key in-process and re-encrypted under the archive passphrase; import reverses it
under whatever key the *new* box has. The new server therefore gets a completely fresh `.env` and
every stored credential still decrypts. A field that won't decrypt on the source (a previously
rotated key) is carried verbatim and reported as a warning rather than silently dropped.

`plk_…` API keys need none of this: they are sha256 hashes in Mongo, so they travel in the dump and
keep working. Only the operator login is env-bound — you log in once on the new box.

The env snapshot is carried inside the (encrypted) archive and **displayed** on the import preflight
as a diff against the target's live env, with a copy button. It is never written: the backend
doesn't mount the host `.env`, and applying it would need a restart anyway.

## 6. Flow

**Export** (source box) — one button. A single-flight job writes `<id>.plmig` into the backup volume
with live per-phase progress polled at 1 Hz, then the page offers the download (range-capable, so a
dropped multi-GB download resumes). Retention: the last 3 archives, plus manual delete.

**Import** (target box) — drop the file. Upload is **chunked** (16 MB) and resumable: a dropped
connection re-offers the same file and resumes from the byte count the server reports.

1. **Preflight** — decrypts the header and streams the *entire* archive once, parsing and discarding
   payloads, to prove it is complete and decryptable **before** anything is dropped. This is what
   turns a corrupt archive from a half-restored instance into a clean refusal. Returns the source
   fingerprint, the env diff, and what currently exists on this box that would be destroyed.
2. **Restore** — typed `REPLACE` confirmation. Quiesce (Agenda, pollers, flow timers, sockets;
   everything but `/api/migration/*`, `/api/auth` and `/health` answers 503), then drop and stream in
   each collection, recreate indexes, replace Qdrant collections, re-wrap secrets under the local key.
3. **Verify** — recompute the fingerprint and diff it against the archive's. Per-collection row
   counts, GridFS byte totals, Qdrant point counts. Any mismatch is reported, not swallowed.
4. **Restart** — the backend restarts its own container through the docker.sock it already holds
   (`os.hostname()` is the container id; falls back to `pleiades_backend`, and to a manual
   instruction if the socket is absent). The page polls `/health` and reloads when it answers.

Known limitation, stated rather than hidden: the restore is not transactional. A failure *after*
step 2 begins leaves a partly-restored database — the instance stays in maintenance mode with the
error and a retry button. The full-archive verification in step 1 is what makes that outcome
unlikely; the intended target is a fresh box, where there is nothing to lose anyway.

## 7. Operator runbook

1. New box: clone the repo, write a `.env` (fresh secrets are fine — only `LLAMA_API_URL` and the
   host-specific vars need real values), `docker compose up -d --build`.
2. Old box: Settings → Instance migration → **Export**, passphrase, wait, **Download**.
3. New box: Settings → Instance migration → drop the file, same passphrase, read the preflight,
   paste any env values it flags, type `REPLACE`.
4. Wait for the restart, log in with the new box's `AUTH_PASSWORD`, compare the fingerprint panel.
5. Isolation images rebuild on first tool use; point DNS at the new host.
