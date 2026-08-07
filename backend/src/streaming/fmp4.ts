/**
 * A minimal fragmented-MP4 box splitter.
 *
 * The playout muxer writes one endless fMP4 byte stream, but a listener joining ten minutes late
 * cannot be handed bytes from wherever the stream happens to be — `MediaSource` needs the
 * initialisation segment (`ftyp` + `moov`) first, and then whole `moof`+`mdat` fragments starting on
 * a boundary. So the fanout parses boxes rather than blindly teeing bytes: the init segment is
 * cached for late joiners, and everything after it is broadcast one complete fragment at a time.
 *
 * Only box headers are read — sizes and four-character types. Nothing inside a box is interpreted.
 */

const HEADER_BYTES = 8;

export interface Fmp4Handlers {
  /** Fires once per muxer process, with `ftyp`+`moov` concatenated. */
  onInit(segment: Buffer): void;
  /** Fires per complete `moof`+`mdat` pair. */
  onFragment(fragment: Buffer): void;
}

export class Fmp4Splitter {
  private buffer: Buffer = Buffer.alloc(0);
  /** Boxes accumulated for the segment being assembled (init, or the current fragment). */
  private pending: Buffer[] = [];
  private sawInit = false;

  constructor(private readonly handlers: Fmp4Handlers) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < HEADER_BYTES) return;
      const size = this.boxSize();
      // A malformed or `to end of file` size can't be advanced past; hold and wait for more bytes
      // rather than desynchronising the whole stream.
      if (size === null) return;
      if (this.buffer.length < size) return;

      const box = this.buffer.subarray(0, size);
      const type = this.buffer.toString('ascii', 4, 8);
      this.buffer = this.buffer.subarray(size);
      this.consume(type, Buffer.from(box));
    }
  }

  /** Total byte length of the box at the head of the buffer, or null if it isn't determinable yet. */
  private boxSize(): number | null {
    const size32 = this.buffer.readUInt32BE(0);
    if (size32 === 1) {
      if (this.buffer.length < 16) return null;
      const large = this.buffer.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER) || large < 16n) return null;
      return Number(large);
    }
    if (size32 < HEADER_BYTES) return null;
    return size32;
  }

  private consume(type: string, box: Buffer): void {
    if (!this.sawInit) {
      this.pending.push(box);
      // `moov` closes the init segment; anything before it (`ftyp`, and any `free` padding) belongs
      // to it. `moof` arriving first means the muxer emitted no header — nothing playable.
      if (type === 'moov') {
        this.sawInit = true;
        this.handlers.onInit(Buffer.concat(this.pending));
        this.pending = [];
      }
      return;
    }

    if (type === 'moof') {
      // A `moof` with an unflushed predecessor means the previous fragment had no media data;
      // dropping it keeps the stream aligned rather than emitting a header with nothing behind it.
      this.pending = [box];
      return;
    }
    if (type === 'mdat' && this.pending.length > 0) {
      this.pending.push(box);
      this.handlers.onFragment(Buffer.concat(this.pending));
      this.pending = [];
      return;
    }
    // `sidx`, `styp`, `free` and friends between fragments: keep them with the fragment they precede.
    if (this.pending.length > 0) this.pending.push(box);
  }
}
