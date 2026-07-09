import crypto from 'node:crypto';
import { promisify } from 'node:util';

const generateKeyPair = promisify(crypto.generateKeyPair);

export type SshKeyType = 'ed25519' | 'rsa';

export interface GeneratedSshKey {
  keyType: SshKeyType;
  /**
   * OpenSSH-compatible private key (PEM). ed25519 → `openssh-key-v1` container (the only format the
   * `ssh` client accepts for ed25519); rsa → traditional PKCS#1 (`BEGIN RSA PRIVATE KEY`). Always
   * passphrase-less so non-interactive `ssh`/`git` inside the container works.
   */
  privateKey: string;
  /** authorized_keys line: `ssh-ed25519 AAAA… comment` / `ssh-rsa AAAA… comment`. */
  publicKey: string;
}

/** Big-endian uint32. */
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** SSH wire `string`: 4-byte length prefix + raw bytes. */
function sshString(data: Buffer): Buffer {
  return Buffer.concat([u32(data.length), data]);
}

/** SSH wire `mpint`: minimal big-endian two's-complement, prefixed with 0x00 when the MSB is set. */
function sshMpint(data: Buffer): Buffer {
  let i = 0;
  while (i < data.length - 1 && data[i] === 0) i++; // strip leading zero bytes
  let body = data.subarray(i);
  if (body.length === 0) body = Buffer.from([0]);
  if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return sshString(body);
}

/** Wrap base64 to 70-char lines (OpenSSH PEM body convention). */
function wrap64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 70) lines.push(b64.slice(i, i + 70));
  return lines.join('\n');
}

/** ed25519 public-key blob: `string "ssh-ed25519"` + `string <32-byte pubkey>`. */
function ed25519PubBlob(pub: Buffer): Buffer {
  return Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(pub)]);
}

async function generateEd25519(comment: string): Promise<GeneratedSshKey> {
  const { publicKey, privateKey } = await generateKeyPair('ed25519');
  // The raw 32-byte scalars sit at the tail of the fixed-layout SPKI/PKCS#8 DER encodings.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pub = spki.subarray(spki.length - 32);
  const seed = pkcs8.subarray(pkcs8.length - 32);
  // OpenSSH stores the private scalar as seed(32) || pub(32).
  const priv64 = Buffer.concat([seed, pub]);

  const pubBlob = ed25519PubBlob(pub);
  // Two identical random check-ints let a reader verify a correct decrypt (no-op here — unencrypted).
  const check = crypto.randomBytes(4);
  const privSection = Buffer.concat([
    check,
    check,
    sshString(Buffer.from('ssh-ed25519')),
    sshString(pub),
    sshString(priv64),
    sshString(Buffer.from(comment)),
  ]);
  // Pad to the "none" cipher block size (8) with the sequence 1,2,3,…
  const padLen = (8 - (privSection.length % 8)) % 8;
  const padded = Buffer.concat([
    privSection,
    Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1)),
  ]);

  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'), // AUTH_MAGIC (14 chars + NUL)
    sshString(Buffer.from('none')), // ciphername
    sshString(Buffer.from('none')), // kdfname
    sshString(Buffer.alloc(0)), // kdfoptions (empty)
    u32(1), // number of keys
    sshString(pubBlob),
    sshString(padded),
  ]);

  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrap64(blob.toString('base64'))}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return {
    keyType: 'ed25519',
    privateKey: pem,
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`.trim(),
  };
}

async function generateRsa(comment: string): Promise<GeneratedSshKey> {
  const { publicKey, privateKey } = await generateKeyPair('rsa', { modulusLength: 4096 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const n = Buffer.from(jwk.n, 'base64url');
  const e = Buffer.from(jwk.e, 'base64url');
  const pubBlob = Buffer.concat([sshString(Buffer.from('ssh-rsa')), sshMpint(e), sshMpint(n)]);
  // PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`) is read natively by the OpenSSH client.
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  return {
    keyType: 'rsa',
    privateKey: pem,
    publicKey: `ssh-rsa ${pubBlob.toString('base64')} ${comment}`.trim(),
  };
}

/**
 * Generate a fresh, passphrase-less outbound SSH client keypair server-side. The private key is
 * returned only so the caller can encrypt-and-store it; it is never surfaced to the operator. The
 * public key is an `authorized_keys` line to paste onto the remote host.
 */
export async function generateSshKeyPair(
  type: SshKeyType,
  comment: string,
): Promise<GeneratedSshKey> {
  const safeComment = (comment || 'pleiades').replace(/[^\w.@-]+/g, '-').slice(0, 64) || 'pleiades';
  return type === 'rsa' ? generateRsa(safeComment) : generateEd25519(safeComment);
}
