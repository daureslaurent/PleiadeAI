import crypto from 'node:crypto';
import { env } from '../config/env';
import { createLogger } from '../config/logger';
import { isolationRepository } from '../domain/isolations/isolation.repository';

const log = createLogger('isolation-ssh');

/** 32-byte AES key derived from the configured secret (dedicated key, else JWT secret). */
function encKey(): Buffer {
  return crypto.createHash('sha256').update(env.ISOLATION_ENC_KEY || env.JWT_SECRET).digest();
}

/** AES-256-GCM encrypt → `iv:tag:ciphertext` (all base64). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join(':');
}

/** Reverse of `encryptSecret`. Throws if the payload is malformed or the key/tag don't match. */
export function decryptSecret(payload: string): string {
  const [ivb, tagb, datab] = payload.split(':');
  if (!ivb || !tagb || !datab) throw new Error('malformed encrypted secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivb, 'base64'));
  decipher.setAuthTag(Buffer.from(tagb, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(datab, 'base64')), decipher.final()]).toString('utf8');
}

export interface SshMaterial {
  privateKey?: string;
  publicKey?: string;
  knownHosts?: string;
}

/**
 * Fetch a profile's SSH material for container provisioning: decrypts the stored private key and
 * returns it alongside the (public) public key + known_hosts. Best-effort — a decrypt failure
 * (e.g. the encryption secret changed) logs and omits the private key rather than blocking boot.
 */
export async function sshMaterialForIsolation(isoId: string): Promise<SshMaterial> {
  const iso = await isolationRepository.findByIdWithSsh(isoId);
  if (!iso) return {};
  const material: SshMaterial = {
    publicKey: iso.ssh_public_key || undefined,
    knownHosts: iso.ssh_known_hosts || undefined,
  };
  if (iso.ssh_private_key_enc) {
    try {
      material.privateKey = decryptSecret(iso.ssh_private_key_enc);
    } catch (err) {
      log.warn({ isoId, err: String(err) }, 'failed to decrypt ssh private key — skipping');
    }
  }
  return material;
}

/**
 * Decrypt a profile's optional remote sudo password for container provisioning. Best-effort — a
 * decrypt failure (e.g. the encryption secret changed) logs and returns undefined rather than
 * blocking boot, exactly like the SSH key path.
 */
export async function sudoPasswordForIsolation(isoId: string): Promise<string | undefined> {
  const iso = await isolationRepository.findByIdWithSudo(isoId);
  if (!iso?.sudo_password_enc) return undefined;
  try {
    return decryptSecret(iso.sudo_password_enc);
  } catch (err) {
    log.warn({ isoId, err: String(err) }, 'failed to decrypt sudo password — skipping');
    return undefined;
  }
}
