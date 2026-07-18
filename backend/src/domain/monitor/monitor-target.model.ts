import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `monitor_targets` collection. Each document is one machine running the `monitor-client/` service
 * (see its README), polled for CPU/GPU/temperature/fan/disk/network telemetry and rendered on the
 * Monitor page.
 *
 * Deliberately a separate entity from `endpoints` rather than fields on it: a monitored box may run
 * no inference at all (a NAS, the gpu-broker host), and one box may serve two endpoints. The
 * optional `endpoint_id` records the association when there is one, so the dashboard can say which
 * inference endpoint lives on which machine.
 *
 * The monitor-client API key is encrypted at rest (`api_key_enc`, AES-256-GCM via
 * `isolation/ssh.service`) and `select: false`, mirroring `finetune-servers` — the browser polls
 * *us*, and the target's credential never leaves the backend.
 */
const MonitorTargetSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    /** Base URL of the monitor-client, e.g. `http://192.168.1.23:9101` (no trailing slash, no path). */
    base_url: { type: String, required: true },
    /** AES-256-GCM encrypted `MONITOR_API_KEY`. Null when the target runs open on a trusted LAN. */
    api_key_enc: { type: String, default: null, select: false },
    /** The inference endpoint that runs on this machine, when there is one. Purely informational. */
    endpoint_id: { type: Schema.Types.ObjectId, ref: 'Endpoint', default: null },
    /** Disabled targets stay configured but are never polled and are hidden from the dashboard. */
    enabled: { type: Boolean, default: true },
    /** Free-text note shown on the card — what this box is for ("2×GPU rig", "backup NAS"). */
    note: { type: String, default: '' },
  },
  { collection: 'monitor_targets', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type MonitorTarget = InferSchemaType<typeof MonitorTargetSchema>;
export type MonitorTargetDoc = HydratedDocument<MonitorTarget>;

export const MonitorTargetModel = model('MonitorTarget', MonitorTargetSchema);
