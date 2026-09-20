import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Transform, PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';

/**
 * The `.plmig` container — a streamed, passphrase-encrypted whole-instance archive
 * (spec `INSTANCE_MIGRATION_PLAN.md` §4).
 *
 * Nothing is ever fully buffered in either direction: the target is a multi-GB file holding a
 * media-heavy GridFS, so both writing and reading are chunk-at-a-time.
 *
 *   magic | u32 headerLen | header JSON (plaintext)   ← format/KDF params only, no instance data
 *   frame*                                            frame := u32 len | iv(12) | ciphertext | tag(16)
 *
 * Concatenating the decrypted frames gives a gzip stream; inflating that gives the entry stream:
 *
 *   entry := u32 headerLen | header JSON | chunk* | u32 0
 *   chunk := u32 len | len bytes
 *
 * Entries are *chunked* rather than length-prefixed because a collection's serialized byte length
 * isn't knowable before it has been read. The frame index is bound in as GCM additional data, so
 * frames cannot be reordered or dropped without the tag check failing; truncation is caught by the
 * trailing `fingerprint` entry (§4) being absent.
 */

export const ARCHIVE_MAGIC = Buffer.from('PLEIADESMIG\0', 'ascii');
export const ARCHIVE_FORMAT = 1;
export const ARCHIVE_EXT = '.plmig';

/** 4 MiB of plaintext per GCM frame: ~1.2k frames per GB, and a 28-byte overhead that rounds to 0%. */
const FRAME_PLAINTEXT_BYTES = 4 * 1024 * 1024;
/** scrypt cost. N=2^15 with r=8 needs ~32 MB and ~100 ms — deliberately slow for a typed passphrase. */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The plaintext preamble. Carries what is needed to *prompt* for a passphrase and nothing more. */
export interface ArchiveHeader {
  format: number;
  created_at: string;
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  /** Cosmetic, for the import page before a passphrase is known. */
  label?: string;
}

export interface EntryHeader {
  kind: 'manifest' | 'collection' | 'qdrant' | 'env' | 'fingerprint';
  /** Collection / Qdrant collection name. Absent on singleton entries. */
  name?: string;
  [k: string]: unknown;
}

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // The default maxmem (32 MB) is exactly at N=2^15's requirement and throws; give it headroom.
    crypto.scrypt(
      passphrase,
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Plaintext → frames. Buffers up to one frame, sealing each with a fresh IV and the index as AAD. */
class FrameEncrypt extends Transform {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private index = 0;

  constructor(private readonly key: Buffer) {
    super();
  }

  private seal(data: Buffer): void {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(u32(this.index++));
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    this.push(Buffer.concat([u32(IV_BYTES + ct.length + TAG_BYTES), iv, ct, cipher.getAuthTag()]));
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    while (this.pendingLen >= FRAME_PLAINTEXT_BYTES) {
      const all = Buffer.concat(this.pending, this.pendingLen);
      this.seal(all.subarray(0, FRAME_PLAINTEXT_BYTES));
      const rest = all.subarray(FRAME_PLAINTEXT_BYTES);
      this.pending = rest.length > 0 ? [rest] : [];
      this.pendingLen = rest.length;
    }
    cb();
  }

  override _flush(cb: () => void): void {
    if (this.pendingLen > 0) this.seal(Buffer.concat(this.pending, this.pendingLen));
    cb();
  }
}

/** Frames → plaintext. A wrong passphrase surfaces here as a GCM tag failure on the first frame. */
class FrameDecrypt extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private index = 0;

  constructor(private readonly key: Buffer) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    try {
      for (;;) {
        if (this.buf.length < 4) break;
        const len = this.buf.readUInt32BE(0);
        if (this.buf.length < 4 + len) break;
        const frame = this.buf.subarray(4, 4 + len);
        this.buf = this.buf.subarray(4 + len);
        const iv = frame.subarray(0, IV_BYTES);
        const tag = frame.subarray(len - TAG_BYTES);
        const ct = frame.subarray(IV_BYTES, len - TAG_BYTES);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAAD(u32(this.index++));
        decipher.setAuthTag(tag);
        this.push(Buffer.concat([decipher.update(ct), decipher.final()]));
      }
      cb();
    } catch {
      cb(new WrongPassphraseError());
    }
  }

  override _flush(cb: (err?: Error) => void): void {
    cb(this.buf.length > 0 ? new Error('archive ends mid-frame (truncated download?)') : undefined);
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong passphrase, or the archive is corrupt');
    this.name = 'WrongPassphraseError';
  }
}

/**
 * Streaming writer. Entries are written one at a time and each must be finished before the next
 * begins, which is what lets the format stay a single forward-only pass.
 */
export class ArchiveWriter {
  private constructor(
    private readonly inner: PassThrough,
    private readonly done: Promise<void>,
  ) {}

  static async create(filePath: string, passphrase: string, label?: string): Promise<ArchiveWriter> {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = await deriveKey(passphrase, salt);
    const header: ArchiveHeader = {
      format: ARCHIVE_FORMAT,
      created_at: new Date().toISOString(),
      kdf: { name: 'scrypt', salt: salt.toString('base64'), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      label,
    };
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');

    const out = fs.createWriteStream(filePath);
    out.write(Buffer.concat([ARCHIVE_MAGIC, u32(headerBuf.length), headerBuf]));

    const inner = new PassThrough();
    // gzip at level 6: the archive is dominated by already-compressed media blobs, so a higher
    // level spends CPU on incompressible bytes for no gain, while level 1 loses real ground on the
    // BSON documents that make up everything else.
    const done = pipeline(inner, zlib.createGzip({ level: 6 }), new FrameEncrypt(key), out);
    return new ArchiveWriter(inner, done);
  }

  private async push(buf: Buffer): Promise<void> {
    if (!this.inner.write(buf)) await once(this.inner, 'drain');
  }

  /** Open an entry, stream its payload through `write`, and close it. */
  async entry(header: EntryHeader, body: (write: (b: Buffer) => Promise<void>) => Promise<void>): Promise<void> {
    const h = Buffer.from(JSON.stringify(header), 'utf8');
    await this.push(Buffer.concat([u32(h.length), h]));
    await body(async (b) => {
      if (b.length === 0) return; // a zero-length chunk is the entry terminator
      await this.push(Buffer.concat([u32(b.length), b]));
    });
    await this.push(u32(0));
  }

  /** Convenience for a small entry that is one JSON object. */
  async json(header: EntryHeader, value: unknown): Promise<void> {
    await this.entry(header, async (write) => write(Buffer.from(JSON.stringify(value), 'utf8')));
  }

  async finish(): Promise<void> {
    this.inner.end();
    await this.done;
  }

  /** Abandon the write (an errored export); the caller unlinks the partial file. */
  destroy(err: Error): void {
    this.inner.destroy(err);
  }
}

/** Pull-based exact-byte reader over an async byte iterable. */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private eof = false;

  constructor(private readonly iter: AsyncIterator<Buffer>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.eof) {
      const { value, done } = await this.iter.next();
      if (done) {
        this.eof = true;
        break;
      }
      this.buf = this.buf.length === 0 ? (value as Buffer) : Buffer.concat([this.buf, value as Buffer]);
    }
    return this.buf.length >= n;
  }

  /** Exactly `n` bytes, or throw. */
  async read(n: number): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0);
    if (!(await this.fill(n))) throw new Error('archive truncated');
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readU32(): Promise<number> {
    return (await this.read(4)).readUInt32BE(0);
  }

  /** A u32, or null when the stream ended cleanly on an entry boundary. */
  async tryReadU32(): Promise<number | null> {
    if (!(await this.fill(4))) {
      if (this.buf.length !== 0) throw new Error('archive truncated');
      return null;
    }
    return this.readU32();
  }
}

/** Read the plaintext preamble without needing a passphrase. Returns the byte offset of frame 0. */
export async function readArchiveHeader(filePath: string): Promise<{ header: ArchiveHeader; offset: number }> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const prefix = Buffer.alloc(ARCHIVE_MAGIC.length + 4);
    const { bytesRead } = await fh.read(prefix, 0, prefix.length, 0);
    if (bytesRead < prefix.length || !prefix.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
      throw new Error('not a PleiadesAI instance archive (.plmig)');
    }
    const headerLen = prefix.readUInt32BE(ARCHIVE_MAGIC.length);
    if (headerLen > 1 << 20) throw new Error('archive header is implausibly large — file is corrupt');
    const headerBuf = Buffer.alloc(headerLen);
    await fh.read(headerBuf, 0, headerLen, prefix.length);
    const header = JSON.parse(headerBuf.toString('utf8')) as ArchiveHeader;
    if (header.format !== ARCHIVE_FORMAT) {
      throw new Error(`archive format ${header.format} is not supported by this build (expected ${ARCHIVE_FORMAT})`);
    }
    return { header, offset: prefix.length + headerLen };
  } finally {
    await fh.close();
  }
}

/**
 * Stream every entry. `onEntry` pulls its payload with `next()` until it returns null; any payload
 * it leaves unread is drained before the next entry, so a consumer may skip entries it doesn't want.
 */
export async function readArchive(
  filePath: string,
  passphrase: string,
  onEntry: (header: EntryHeader, next: () => Promise<Buffer | null>) => Promise<void>,
): Promise<ArchiveHeader> {
  const { header, offset } = await readArchiveHeader(filePath);
  const key = await deriveKey(passphrase, Buffer.from(header.kdf.salt, 'base64'));

  // `.pipe()` does not forward errors, so a wrong passphrase would otherwise surface as an
  // unhandled 'error' event on the decryptor instead of throwing where the entries are consumed.
  // Every stage is therefore routed onto the one stream this function iterates.
  const file = fs.createReadStream(filePath, { start: offset });
  const decrypt = new FrameDecrypt(key);
  const plain = zlib.createGunzip();
  file.on('error', (e) => plain.destroy(e));
  decrypt.on('error', (e) => plain.destroy(e));
  file.pipe(decrypt).pipe(plain);

  const reader = new ByteReader((plain as Readable)[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  try {
    for (;;) {
      const headerLen = await reader.tryReadU32();
      if (headerLen === null) break;
      const entryHeader = JSON.parse((await reader.read(headerLen)).toString('utf8')) as EntryHeader;

      let exhausted = false;
      const next = async (): Promise<Buffer | null> => {
        if (exhausted) return null;
        const len = await reader.readU32();
        if (len === 0) {
          exhausted = true;
          return null;
        }
        return reader.read(len);
      };
      await onEntry(entryHeader, next);
      while (!exhausted) await next(); // drain whatever the consumer skipped
    }
  } finally {
    plain.destroy();
    decrypt.destroy();
    file.destroy();
  }
  return header;
}

/** Collect an entry's whole payload — only for the small JSON entries (manifest, env, fingerprint). */
export async function collectEntry(next: () => Promise<Buffer | null>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (;;) {
    const chunk = await next();
    if (chunk === null) break;
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
