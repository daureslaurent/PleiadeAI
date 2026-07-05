import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createLogger } from '../config/logger';
import { isolationRepository } from '../domain/isolations/isolation.repository';
import { decryptSecret } from './ssh.service';

const log = createLogger('isolation-vpn');

/** The fields we lift out of a WireGuard `.conf` and hand to gluetun's custom provider. */
export interface VpnConfig {
  privateKey: string;
  addresses?: string;
  publicKey?: string;
  endpointIp?: string;
  endpointPort?: string;
  presharedKey?: string;
  dns?: string;
}

/**
 * Parse a standard WireGuard `.conf` (INI-style `[Interface]` / `[Peer]` sections) into the fields
 * gluetun needs. Tolerant of comments (`#`/`;`), blank lines, and case-insensitive keys. Throws with
 * a human-readable message when the mandatory `PrivateKey` is missing so the caller can surface it.
 */
export function parseWireguardConf(text: string): VpnConfig {
  let section = '';
  const iface: Record<string, string> = {};
  const peer: Record<string, string> = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const sec = /^\[(.+)]$/.exec(line);
    if (sec) {
      section = (sec[1] ?? '').trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (section === 'interface') iface[key] = value;
    else if (section === 'peer') peer[key] = value;
  }

  const privateKey = iface.privatekey;
  if (!privateKey) throw new Error('WireGuard config is missing [Interface] PrivateKey');

  const endpoint = peer.endpoint;
  let endpointIp: string | undefined;
  let endpointPort: string | undefined;
  if (endpoint) {
    // Endpoint is `host:port` (host may be an IPv4/DNS name, or a bracketed IPv6 literal).
    const m = /^(.*):(\d+)$/.exec(endpoint.trim());
    if (m) {
      endpointIp = (m[1] ?? '').replace(/^\[|]$/g, '');
      endpointPort = m[2];
    } else {
      endpointIp = endpoint.trim();
    }
  }

  return {
    privateKey,
    addresses: iface.address || undefined,
    publicKey: peer.publickey || undefined,
    endpointIp,
    endpointPort,
    presharedKey: peer.presharedkey || undefined,
    dns: iface.dns || undefined,
  };
}

/**
 * Resolve a profile's VPN config for gluetun provisioning: decrypts the stored WireGuard `.conf` and
 * parses it into env fields. Returns `null` when the profile has no usable config (no `.conf`, or it
 * can't be decrypted/parsed) — the caller treats that as "not ready" so an isolated tool errors
 * instead of leaking the real IP.
 */
export async function vpnConfigForIsolation(isoId: string): Promise<VpnConfig | null> {
  const iso = await isolationRepository.findByIdWithVpn(isoId);
  if (!iso || !iso.vpn_conf_enc) return null;

  let conf: string;
  try {
    conf = decryptSecret(iso.vpn_conf_enc);
  } catch (err) {
    log.warn({ isoId, err: String(err) }, 'failed to decrypt wireguard .conf');
    return null;
  }

  let cfg: VpnConfig;
  try {
    cfg = parseWireguardConf(conf);
  } catch (err) {
    log.warn({ isoId, err: String(err) }, 'failed to parse wireguard .conf');
    return null;
  }

  // gluetun's container has no IPv6, so it rejects an IPv6 interface address. WireGuard `.conf`
  // files usually list both (`Address = 10.x/32, fd7d::/128`); keep only the IPv4 entries — the
  // tunnel works fine over IPv4 alone.
  if (cfg.addresses) {
    const kept = cfg.addresses
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .filter((a) => isIP(a.split('/')[0] ?? '') !== 6);
    if (kept.length !== cfg.addresses.split(',').filter((a) => a.trim()).length) {
      log.info({ isoId }, 'dropped IPv6 wireguard interface address(es) (gluetun has no IPv6)');
    }
    cfg.addresses = kept.join(',') || undefined;
  }

  // gluetun's WIREGUARD_ENDPOINT_IP must be a literal IP — WireGuard `.conf` files commonly use a
  // DNS hostname (e.g. `nl3.vpn.airdns.org:51820`), so resolve it here before provisioning.
  if (cfg.endpointIp && isIP(cfg.endpointIp) === 0) {
    try {
      const { address } = await lookup(cfg.endpointIp);
      log.info({ isoId, host: cfg.endpointIp, address }, 'resolved wireguard endpoint host to ip');
      cfg.endpointIp = address;
    } catch (err) {
      log.warn({ isoId, host: cfg.endpointIp, err: String(err) }, 'failed to resolve wireguard endpoint host');
      return null;
    }
  }

  return cfg;
}

/**
 * Build the gluetun `-e KEY=value` argv pairs for a WireGuard `.conf`. We always use gluetun's
 * `custom` provider since the `.conf` carries the peer key + endpoint directly (no server list).
 */
export function gluetunEnvArgs(cfg: VpnConfig): string[] {
  const env: Record<string, string> = {
    VPN_SERVICE_PROVIDER: 'custom',
    VPN_TYPE: 'wireguard',
    WIREGUARD_PRIVATE_KEY: cfg.privateKey,
  };
  if (cfg.addresses) env.WIREGUARD_ADDRESSES = cfg.addresses;
  if (cfg.publicKey) env.WIREGUARD_PUBLIC_KEY = cfg.publicKey;
  if (cfg.endpointIp) env.WIREGUARD_ENDPOINT_IP = cfg.endpointIp;
  if (cfg.endpointPort) env.WIREGUARD_ENDPOINT_PORT = cfg.endpointPort;
  if (cfg.presharedKey) env.WIREGUARD_PRESHARED_KEY = cfg.presharedKey;

  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}
