import net from 'node:net';
import { createLogger } from '../../config/logger';

const log = createLogger('adb-probe');

/**
 * A minimal, dependency-free `adb` handshake used only by Settings → Connections' "Test connection".
 *
 * The backend container has no `adb` binary — by design, adb lives in the *agent's* container so the
 * tools inherit its network namespace (VPN mode included). But the operator still needs to tell a
 * typo'd host from a stopped emulator without opening a chat, so we speak just enough of the adb
 * transport protocol to complete a connection handshake with `adbd` on the device.
 *
 * That is ~40 lines and answers three genuinely distinct questions a bare TCP connect cannot:
 * is *anything* listening, is it really adbd, and is it going to demand RSA authorisation. What it
 * cannot tell you is whether the **agent's** container can reach the same address — the backend is a
 * different container, so a `bridge`-network profile has similar reachability but a `vpn` one may
 * not. The probe's verdict is therefore reported as advisory; the tools always re-verify at call
 * time from where it actually matters.
 *
 * Wire format (see AOSP `packet.h`): a 24-byte header of six little-endian u32 —
 * `command, arg0, arg1, data_length, data_crc32, magic` — followed by `data_length` payload bytes.
 * `magic` is `command ^ 0xffffffff`; the "crc32" is really a plain byte sum.
 */

/** `CNXN` — connect. Sent by us, and the device's reply when it accepts unauthenticated access. */
const A_CNXN = 0x4e584e43;
/** `AUTH` — the device wants an RSA-signed token first (i.e. "unauthorized" in `adb devices`). */
const A_AUTH = 0x48545541;
/** Protocol version we claim, and the max payload we advertise (AOSP's own defaults). */
const A_VERSION = 0x01000001;
const MAX_PAYLOAD = 256 * 1024;

export interface AdbProbeResult {
  ok: boolean;
  /** Human-readable verdict, shown verbatim in the Settings row. */
  message: string;
  /** `ro.product.model` + Android release when the device identified itself. */
  model?: string;
  /** The raw banner (`device::ro.product.name=…`), useful when something unexpected answers. */
  banner?: string;
}

function encodePacket(command: number, arg0: number, arg1: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(24);
  let sum = 0;
  for (const byte of payload) sum = (sum + byte) >>> 0;
  header.writeUInt32LE(command, 0);
  header.writeUInt32LE(arg0, 4);
  header.writeUInt32LE(arg1, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(sum, 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, payload]);
}

/** Pull `key=value` out of an adbd banner, tolerating the `;`-separated form it actually uses. */
function bannerProp(banner: string, key: string): string {
  const match = new RegExp(`${key}=([^;\\s]*)`).exec(banner);
  return match?.[1] ?? '';
}

function describe(banner: string): string {
  const model = bannerProp(banner, 'ro\\.product\\.model') || bannerProp(banner, 'ro\\.product\\.name');
  const release = bannerProp(banner, 'ro\\.build\\.version\\.release');
  if (model && release) return `${model} (Android ${release})`;
  return model || '';
}

/**
 * Complete an adb connection handshake against `host:port`. Never throws — every failure mode is
 * returned as a `{ ok: false }` with an operator-actionable message.
 */
export function probeAdb(host: string, port: number, timeoutMs = 5_000): Promise<AdbProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (result: AdbProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () =>
      finish({
        ok: false,
        message: `No adb response from ${host}:${port} within ${Math.round(timeoutMs / 1000)}s. Something is listening but it is not answering as adbd.`,
      }),
    );
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const reason =
        err.code === 'ECONNREFUSED'
          ? 'Connection refused — nothing is listening there. Is the emulator running, and is adb TCP/IP enabled on that port?'
          : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH'
            ? 'Host unreachable from the backend container.'
            : err.code === 'ETIMEDOUT'
              ? 'Connection timed out — usually a firewall, or an address the backend cannot route to.'
              : err.message;
      finish({ ok: false, message: `${host}:${port}: ${reason}` });
    });

    socket.once('connect', () => {
      socket.write(
        encodePacket(A_CNXN, A_VERSION, MAX_PAYLOAD, Buffer.from('host::features=cmd,shell_v2\0', 'ascii')),
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 24) return; // header not complete yet
      const command = buffer.readUInt32LE(0);
      const length = buffer.readUInt32LE(12);
      if (buffer.length < 24 + length) return; // payload still arriving

      if (command === A_AUTH) {
        return finish({
          ok: false,
          message: `${host}:${port} answered, but the device requires RSA authorisation — it will show as "unauthorized". Accept the "Allow USB debugging" prompt on the device, or run the emulator with adb auth disabled.`,
        });
      }
      if (command !== A_CNXN) {
        return finish({
          ok: false,
          message: `${host}:${port} answered, but not with an adb CNXN packet (got 0x${command.toString(16)}). That port is probably not adb.`,
        });
      }

      const banner = buffer.subarray(24, 24 + length).toString('ascii').replace(/\0+$/, '');
      const model = describe(banner);
      log.info({ host, port, model }, 'adb probe ok');
      finish({
        ok: true,
        message: model
          ? `Connected — ${model}.`
          : `Connected to adbd at ${host}:${port}.`,
        model,
        banner,
      });
    });

    socket.connect(port, host);
  });
}
