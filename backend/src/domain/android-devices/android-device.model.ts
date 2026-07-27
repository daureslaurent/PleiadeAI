import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `android_devices` collection (see `ANDROID_PLAN.md`). One document per Android device the operator
 * has registered: an emulator listening for `adb connect` on a TCP port, or a physical phone in
 * TCP/IP mode. Agents are linked to one device (`agent.android_device_id`) and drive it through the
 * `android_*` tools; the operator watches and takes over through the mirror panel in the Workspace.
 *
 * Mirrors `finetune-server.model.ts` / `mail-account.model.ts` — a small operator-owned registry
 * managed from Settings → Connections, referenced by id from agents. Deliberately *not* a singleton
 * setting: the whole point of the per-agent link is that a fleet can hold several devices (a phone
 * profile, a tablet profile, one per test account) and each agent gets exactly one.
 *
 * There is no secret here: adb over TCP carries no credential, which is exactly why the emulator must
 * only ever be reachable on a trusted network — the host itself, a LAN, or a container network. The
 * backend never exposes the adb port; it only tells the agent's container to connect to it.
 */
const AndroidDeviceSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    /**
     * Host the agent's **container** reaches adb on — resolved from inside that container, not from
     * the backend. An emulator on the Docker host is typically `172.17.0.1` (the default bridge
     * gateway) or the host's LAN IP; `127.0.0.1` only works for a profile on `network: host` or one
     * sharing the device's network namespace.
     */
    adb_host: { type: String, required: true, trim: true },
    /** adb TCP/IP port. 5555 is the emulator/`adb tcpip` default. */
    adb_port: { type: Number, default: 5555 },

    /**
     * Live-mirror encoding, handed to scrcpy-server when the Workspace panel opens (see
     * `isolation/scrcpy.ts`). They trade picture quality against bandwidth and latency over the
     * relay; the defaults are tuned for a phone-sized panel on a LAN.
     *
     * `max_size` caps the *longest* edge in pixels (0 = the device's native resolution). Touch
     * coordinates are always sent in device pixels, so downscaling costs nothing in accuracy.
     */
    mirror_max_size: { type: Number, default: 1080 },
    mirror_bit_rate: { type: Number, default: 4_000_000 },
    mirror_max_fps: { type: Number, default: 30 },

    /** Disabled devices stay configured but are refused by the tools and hidden from the agent form. */
    enabled: { type: Boolean, default: true },

    /**
     * Last connection result, written by the "Test connection" action on Settings → Connections so
     * the operator can tell a typo'd host from a stopped emulator without opening a chat. Purely
     * informational — the tools always re-verify at call time.
     */
    last_status: { type: String, enum: ['unknown', 'ok', 'error'], default: 'unknown' },
    last_error: { type: String, default: '' },
    last_checked_at: { type: Date, default: null },
    /** Device fingerprint (`ro.product.model` + Android release) from the last successful probe. */
    last_seen_model: { type: String, default: '' },
  },
  {
    collection: 'android_devices',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  },
);

export type AndroidDevice = InferSchemaType<typeof AndroidDeviceSchema>;
export type AndroidDeviceDoc = HydratedDocument<AndroidDevice>;

export const AndroidDeviceModel = model('AndroidDevice', AndroidDeviceSchema);

/** The `adb` serial a device is addressed by: adb's own `host:port` form for a TCP/IP device. */
export function deviceSerial(device: Pick<AndroidDevice, 'adb_host' | 'adb_port'>): string {
  return `${device.adb_host.trim()}:${device.adb_port || 5555}`;
}
