/**
 * scrcpy wire protocol: the video stream parser and the control-message encoder.
 *
 * Kept as pure, transport-free functions so the one fragile thing here — a binary layout that
 * belongs to a specific scrcpy-server release — lives in exactly one file, next to the version the
 * image pins (`ANDROID_DOCKERFILE_SNIPPET`'s `SCRCPY_VERSION`). The relay
 * (`transport/ws/android-proxy.ts`) owns the sockets; the browser never sees these bytes, only the
 * decoded H.264 packets and a JSON control vocabulary.
 *
 * ## Video socket
 *
 * With the defaults the server is started with (`send_dummy_byte`, `send_device_meta`,
 * `send_codec_meta`, `send_frame_meta` all on, `tunnel_forward=true`), a video socket opens with a
 * fixed 77-byte prelude:
 *
 * ```
 *   1  byte   dummy 0x00           (tunnel_forward handshake: connect() succeeds before accept())
 *  64  bytes  device name          (NUL-padded UTF-8)
 *   4  bytes  codec id             ('h264' as big-endian ASCII = 0x68323634)
 *   4  bytes  initial width
 *   4  bytes  initial height
 * ```
 *
 * then a stream of frames, each:
 *
 * ```
 *   8  bytes  pts, with bit63 = "config packet" (SPS/PPS) and bit62 = "key frame"
 *   4  bytes  payload length
 *   N  bytes  H.264 Annex-B payload
 * ```
 *
 * Everything is big-endian: the server writes through Java's `DataOutputStream`.
 *
 * ## Control socket
 *
 * Client → device messages, each a type byte plus a fixed layout. Only the handful the mirror panel
 * actually needs are implemented; the device → client direction (clipboard sync, acks) is drained
 * and ignored, since the panel offers no clipboard feature.
 */
import { createLogger } from '../config/logger';

const log = createLogger('scrcpy');

/** Fixed prelude on the video socket: dummy byte + 64-byte device name + 12-byte codec meta. */
const PRELUDE_BYTES = 1 + 64 + 12;
/** `PACKET_FLAG_CONFIG` / `PACKET_FLAG_KEY_FRAME` — the top two bits of the 64-bit pts field. */
const FLAG_CONFIG = 1n << 63n;
const FLAG_KEY_FRAME = 1n << 62n;

export interface ScrcpyMeta {
  /** The device's own name, e.g. "sdk_gphone64_x86_64". */
  deviceName: string;
  /** Four-character codec id as sent, e.g. "h264". */
  codec: string;
  width: number;
  height: number;
}

export interface ScrcpyPacket {
  /** A codec-config packet (SPS/PPS): not displayable on its own, it configures the decoder. */
  config: boolean;
  keyFrame: boolean;
  /** Presentation timestamp in microseconds (flag bits masked off). */
  pts: bigint;
  data: Buffer;
}

/**
 * Incremental parser for one video socket. Fed arbitrary chunks (a socket never respects message
 * boundaries), it emits the metadata once and then one callback per complete H.264 access unit.
 *
 * Buffers are concatenated rather than kept as a chunk list because packets are small (a keyframe at
 * 4 Mbps is tens of kB) and the copy cost is irrelevant next to the H.264 encode already happening on
 * the device — clarity wins here.
 */
export class ScrcpyVideoParser {
  private buffer: Buffer = Buffer.alloc(0);
  private meta: ScrcpyMeta | null = null;

  constructor(
    private readonly onMeta: (meta: ScrcpyMeta) => void,
    private readonly onPacket: (packet: ScrcpyPacket) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    if (!this.meta) {
      if (this.buffer.length < PRELUDE_BYTES) return;
      // Skip the dummy byte; the device name is NUL-padded to a fixed 64 bytes.
      const name = this.buffer.subarray(1, 65).toString('utf8').replace(/\0.*$/, '');
      const codec = this.buffer.subarray(65, 69).toString('ascii');
      this.meta = {
        deviceName: name,
        codec,
        width: this.buffer.readUInt32BE(69),
        height: this.buffer.readUInt32BE(73),
      };
      this.buffer = this.buffer.subarray(PRELUDE_BYTES);
      log.info({ ...this.meta }, 'scrcpy video stream opened');
      this.onMeta(this.meta);
    }

    // Drain every complete frame currently buffered.
    for (;;) {
      if (this.buffer.length < 12) return;
      const raw = this.buffer.readBigUInt64BE(0);
      const length = this.buffer.readUInt32BE(8);
      if (this.buffer.length < 12 + length) return;
      this.onPacket({
        config: (raw & FLAG_CONFIG) !== 0n,
        keyFrame: (raw & FLAG_KEY_FRAME) !== 0n,
        pts: raw & ~(FLAG_CONFIG | FLAG_KEY_FRAME),
        data: this.buffer.subarray(12, 12 + length),
      });
      this.buffer = this.buffer.subarray(12 + length);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Control messages
// ---------------------------------------------------------------------------------------------

const TYPE_INJECT_KEYCODE = 0;
const TYPE_INJECT_TEXT = 1;
const TYPE_INJECT_TOUCH_EVENT = 2;
const TYPE_INJECT_SCROLL_EVENT = 3;

/** `android.view.MotionEvent` actions. */
export const MOTION_DOWN = 0;
export const MOTION_UP = 1;
export const MOTION_MOVE = 2;

/** `android.view.KeyEvent` actions. */
const KEY_DOWN = 0;
const KEY_UP = 1;

/** `AMOTION_EVENT_BUTTON_PRIMARY` — the only button a touchscreen reports. */
const BUTTON_PRIMARY = 1;

/**
 * A single-finger pointer id. scrcpy reserves -1 for "mouse"; a plain 0 makes the injected events
 * look like a finger on the touchscreen, which is what apps expect and what `adb shell input`
 * produces too.
 */
const POINTER_ID_FINGER = 0n;

/** scrcpy caps a single text injection; longer strings are split by the caller. */
export const TEXT_INJECT_MAX_BYTES = 300;

/** Encode a float in [0,1] as scrcpy's unsigned 16-bit fixed point. */
function u16Fixed(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 0xffff);
}

/** Encode a float in [-1,1] as scrcpy's signed 16-bit fixed point (scroll deltas). */
function i16Fixed(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(clamped * 0x7fff);
}

/**
 * A touch event. `width`/`height` are the dimensions the coordinates are expressed in — the *video*
 * frame size, not the device's: the server rescales, which is what lets the panel work at whatever
 * `max_size` the device registry asked for without the browser knowing the real resolution.
 */
export function encodeTouch(opts: {
  action: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pressure?: number;
}): Buffer {
  const buf = Buffer.alloc(32);
  let off = 0;
  buf.writeUInt8(TYPE_INJECT_TOUCH_EVENT, off); off += 1;
  buf.writeUInt8(opts.action, off); off += 1;
  buf.writeBigUInt64BE(POINTER_ID_FINGER, off); off += 8;
  buf.writeInt32BE(Math.round(opts.x), off); off += 4;
  buf.writeInt32BE(Math.round(opts.y), off); off += 4;
  buf.writeUInt16BE(Math.max(0, Math.round(opts.width)), off); off += 2;
  buf.writeUInt16BE(Math.max(0, Math.round(opts.height)), off); off += 2;
  // A released finger reports zero pressure; anything else reports full.
  buf.writeUInt16BE(u16Fixed(opts.pressure ?? (opts.action === MOTION_UP ? 0 : 1)), off); off += 2;
  // `actionButton` is the button that changed state — meaningless mid-drag, hence only on down/up.
  buf.writeInt32BE(opts.action === MOTION_MOVE ? 0 : BUTTON_PRIMARY, off); off += 4;
  // `buttons` is what is held *now*, so it clears on release.
  buf.writeInt32BE(opts.action === MOTION_UP ? 0 : BUTTON_PRIMARY, off);
  return buf;
}

/** A scroll (mouse wheel / trackpad) at a point, in the same coordinate space as {@link encodeTouch}. */
export function encodeScroll(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  hscroll: number;
  vscroll: number;
}): Buffer {
  const buf = Buffer.alloc(21);
  let off = 0;
  buf.writeUInt8(TYPE_INJECT_SCROLL_EVENT, off); off += 1;
  buf.writeInt32BE(Math.round(opts.x), off); off += 4;
  buf.writeInt32BE(Math.round(opts.y), off); off += 4;
  buf.writeUInt16BE(Math.max(0, Math.round(opts.width)), off); off += 2;
  buf.writeUInt16BE(Math.max(0, Math.round(opts.height)), off); off += 2;
  buf.writeInt16BE(i16Fixed(opts.hscroll), off); off += 2;
  buf.writeInt16BE(i16Fixed(opts.vscroll), off); off += 2;
  buf.writeInt32BE(0, off); // buttons held during the scroll — none
  return buf;
}

/** One half of a key press. Callers almost always want {@link encodeKeyPress}. */
function encodeKeyEvent(action: number, keycode: number, metaState = 0): Buffer {
  const buf = Buffer.alloc(14);
  let off = 0;
  buf.writeUInt8(TYPE_INJECT_KEYCODE, off); off += 1;
  buf.writeUInt8(action, off); off += 1;
  buf.writeInt32BE(keycode, off); off += 4;
  buf.writeInt32BE(0, off); off += 4; // repeat count
  buf.writeInt32BE(metaState, off);
  return buf;
}

/** A complete key press (down then up), which is what every panel interaction actually means. */
export function encodeKeyPress(keycode: number, metaState = 0): Buffer {
  return Buffer.concat([
    encodeKeyEvent(KEY_DOWN, keycode, metaState),
    encodeKeyEvent(KEY_UP, keycode, metaState),
  ]);
}

/**
 * Inject text. Returns one message per chunk: scrcpy refuses a payload over
 * {@link TEXT_INJECT_MAX_BYTES}, and a paste of a long message is a normal thing for an operator to
 * do, so splitting is the caller's default rather than an error.
 */
export function encodeText(text: string): Buffer[] {
  const messages: Buffer[] = [];
  let remaining = Buffer.from(text, 'utf8');
  while (remaining.length) {
    let take = Math.min(remaining.length, TEXT_INJECT_MAX_BYTES);
    // Never split a multi-byte character: back off to the start of the last complete code point.
    while (take > 0 && take < remaining.length && (remaining[take]! & 0xc0) === 0x80) take -= 1;
    if (take <= 0) break;
    const slice = remaining.subarray(0, take);
    const buf = Buffer.alloc(5 + slice.length);
    buf.writeUInt8(TYPE_INJECT_TEXT, 0);
    buf.writeUInt32BE(slice.length, 1);
    slice.copy(buf, 5);
    messages.push(buf);
    remaining = remaining.subarray(take);
  }
  return messages;
}

/**
 * The Android keycodes the panel exposes. Printable characters go through `encodeText` instead —
 * mapping a browser `KeyboardEvent.key` to a keycode plus meta state is a losing game across
 * layouts, whereas text injection is exact.
 */
export const KEYCODES = {
  home: 3,
  back: 4,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  power: 26,
  tab: 61,
  enter: 66,
  del: 67, // backspace
  escape: 111,
  forward_del: 112,
  move_home: 122,
  move_end: 123,
  app_switch: 187,
} as const;

export type KeyName = keyof typeof KEYCODES;

export function isKeyName(value: string): value is KeyName {
  return Object.prototype.hasOwnProperty.call(KEYCODES, value);
}
