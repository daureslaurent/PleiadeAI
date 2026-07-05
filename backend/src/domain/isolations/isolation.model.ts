import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DEFAULT_DOCKERFILE } from '../../isolation/dockerfile.template';

/**
 * `isolations` collection — a reusable Docker execution profile that agents are *assigned* to.
 * One Isolation defines a Dockerfile + resource/network policy and builds a single shared image;
 * each assigned agent still runs its own container from that image (see AgentContainerManager),
 * choosing per-agent whether its `/workspace` volume is individual or shared across the profile.
 */
const IsolationSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    dockerfile: { type: String, default: () => DEFAULT_DOCKERFILE },

    // Build lifecycle of the shared image (driven by the manual Build action).
    image_status: { type: String, enum: ['none', 'building', 'built', 'error'], default: 'none' },
    image_built_at: { type: Date, default: null },
    last_build_error: { type: String, default: null },

    // Container policy applied to every agent container created from this profile.
    cpus: { type: String, default: '1' },
    memory: { type: String, default: '1g' },
    /**
     * `host`  — share the host network stack (full LAN + host services reachable). Default.
     * `bridge`— NATed docker bridge (internet + LAN, isolated namespace).
     * `none`  — offline.
     * `vpn`   — route through this profile's dedicated gluetun (WireGuard) container; all traffic
     *           exits via the VPN and is kill-switched until the tunnel is up (see vpn_* below).
     */
    network: { type: String, enum: ['host', 'bridge', 'none', 'vpn'], default: 'host' },
    idle_timeout_ms: { type: Number, default: 1_800_000 },

    // VPN (gluetun / WireGuard) config, used only when `network === 'vpn'`. The operator uploads a
    // standard WireGuard `.conf` file; the backend parses it into gluetun's custom-provider env vars
    // (WIREGUARD_PRIVATE_KEY / WIREGUARD_ADDRESSES / WIREGUARD_PUBLIC_KEY / WIREGUARD_ENDPOINT_* …)
    // and spins up a dedicated gluetun container per profile. The whole `.conf` contains the private
    // key, so it is stored AES-256-GCM encrypted at rest and `select: false` — it never leaves the
    // DB layer unless explicitly requested for provisioning.
    vpn_conf_enc: { type: String, default: null, select: false },

    // Outbound SSH client key, injected into each agent container's ~/.ssh at create time (so the
    // agent can git-clone / ssh out). The private key is AES-256-GCM encrypted at rest and
    // `select: false` so it never leaves the DB layer unless explicitly requested. The public key
    // and known_hosts are not secret.
    ssh_private_key_enc: { type: String, default: null, select: false },
    ssh_public_key: { type: String, default: '' },
    ssh_known_hosts: { type: String, default: '' },

    // Optional remote `sudo` password, injected into each agent container at create time as a
    // mode-600 file (+ a SUDO_ASKPASS helper) so the agent can escalate with `sudo` on a remote host
    // it has SSH'd into (e.g. `ssh host 'sudo -S …' < <pass-file>`). AES-256-GCM encrypted at rest
    // and `select: false` — it never leaves the DB layer unless explicitly requested for provisioning.
    sudo_password_enc: { type: String, default: null, select: false },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'isolations',
  },
);

export type Isolation = InferSchemaType<typeof IsolationSchema>;
export type IsolationDoc = HydratedDocument<Isolation>;

export const IsolationModel = model('Isolation', IsolationSchema);
