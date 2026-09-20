import crypto from 'node:crypto';
import { encryptSecret, decryptSecret } from '../../isolation/ssh.service';
import { createLogger } from '../../config/logger';

const log = createLogger('migration-secrets');

/**
 * Re-wrapping of the env-key-encrypted credential fields (spec `INSTANCE_MIGRATION_PLAN.md` §5).
 *
 * These fields are AES-GCM'd under `ISOLATION_ENC_KEY || JWT_SECRET` — an **environment variable**,
 * which a file dropped into the UI cannot rewrite. Copying them verbatim would therefore force the
 * operator to hand-carry that one key to the new box, and a mistake there fails *silently*: the rows
 * arrive, look present in the UI, and only break when an agent first tries to SSH somewhere.
 *
 * So export decrypts each field with the local key and re-encrypts it under the archive passphrase;
 * import reverses that under whatever key the target happens to have. The new server gets a
 * completely fresh `.env` and every stored credential still decrypts.
 *
 * A field that will not decrypt on the source (the key was rotated after it was written) is carried
 * **verbatim and flagged**, never dropped: the bytes may still be recoverable with the old key, and
 * losing them silently is the one outcome worth ruling out.
 */

/** Collection → the fields in it that hold an `encryptSecret()` payload. */
export const SECRET_FIELDS: Record<string, string[]> = {
  isolations: ['ssh_private_key_enc', 'vpn_conf_enc', 'sudo_password_enc'],
  api_sources: ['secret_enc'],
  mail_accounts: ['refresh_token_enc'],
  finetune_servers: ['api_key_enc'],
  monitor_targets: ['api_key_enc'],
};

export interface RewrapStats {
  rewrapped: number;
  /** Fields carried verbatim because they would not decrypt with this instance's key. */
  unreadable: number;
  warnings: string[];
}

export function newRewrapStats(): RewrapStats {
  return { rewrapped: 0, unreadable: 0, warnings: [] };
}

/** Marker prefix distinguishing an archive-wrapped value from an instance-wrapped one. */
const ARCHIVE_PREFIX = 'plmig1:';

function archiveKey(passphraseKey: Buffer): Buffer {
  // A distinct sub-key, so the value that encrypts documents never also encrypts credentials.
  return crypto.createHash('sha256').update(passphraseKey).update('secret-rewrap').digest();
}

function seal(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', archiveKey(key), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ARCHIVE_PREFIX + [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}

function open(key: Buffer, payload: string): string {
  const [ivb, tagb, datab] = payload.slice(ARCHIVE_PREFIX.length).split(':');
  if (!ivb || !tagb || !datab) throw new Error('malformed re-wrapped secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', archiveKey(key), Buffer.from(ivb, 'base64'));
  decipher.setAuthTag(Buffer.from(tagb, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(datab, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Export direction: instance key → archive passphrase. Mutates the document in place (it is a fresh
 * plain object from the driver, never a live Mongoose doc).
 */
export function rewrapForExport(
  collection: string,
  doc: Record<string, unknown>,
  key: Buffer,
  stats: RewrapStats,
): void {
  const fields = SECRET_FIELDS[collection];
  if (!fields) return;
  for (const field of fields) {
    const value = doc[field];
    if (typeof value !== 'string' || value === '') continue;
    try {
      doc[field] = seal(key, decryptSecret(value));
      stats.rewrapped++;
    } catch {
      stats.unreadable++;
      const msg = `${collection}.${field} on _id ${String(doc._id)} would not decrypt with this instance's key — carried as-is`;
      if (stats.warnings.length < 20) stats.warnings.push(msg);
      log.warn({ collection, field, id: String(doc._id) }, 'secret field carried un-rewrapped');
    }
  }
}

/** Import direction: archive passphrase → this instance's key. */
export function rewrapForImport(
  collection: string,
  doc: Record<string, unknown>,
  key: Buffer,
  stats: RewrapStats,
): void {
  const fields = SECRET_FIELDS[collection];
  if (!fields) return;
  for (const field of fields) {
    const value = doc[field];
    if (typeof value !== 'string' || !value.startsWith(ARCHIVE_PREFIX)) continue;
    try {
      doc[field] = encryptSecret(open(key, value));
      stats.rewrapped++;
    } catch {
      // Cannot happen with the right passphrase (the archive itself already decrypted), so this is
      // a corrupt field rather than a wrong key. Null it: a value that is neither instance- nor
      // archive-wrapped would throw on every later read.
      doc[field] = null;
      stats.unreadable++;
      const msg = `${collection}.${field} on _id ${String(doc._id)} was corrupt in the archive — cleared, re-enter it`;
      if (stats.warnings.length < 20) stats.warnings.push(msg);
      log.warn({ collection, field, id: String(doc._id) }, 'secret field cleared on import');
    }
  }
}

/** Does this collection hold anything that needs re-wrapping? Lets the hot path skip the per-doc call. */
export function hasSecrets(collection: string): boolean {
  return SECRET_FIELDS[collection] !== undefined;
}
