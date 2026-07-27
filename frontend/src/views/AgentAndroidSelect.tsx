import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Smartphone, CircleAlert } from 'lucide-react';
import { agentsApi, androidDevicesApi, type AndroidDevice } from '../lib/api';

/**
 * Links an agent to a registered Android device (or none). Changes apply immediately, like the
 * isolation select next to it.
 *
 * Linking a device is what turns an agent into an Android agent: the backend auto-grants the
 * `android_*` tools and the Workspace offers the live phone mirror. It is *not* sufficient on its
 * own — `adb` runs inside the agent's container, so the agent also needs an isolation profile whose
 * image carries the Android layer. That second requirement is easy to miss and produces a confusing
 * runtime error, so it is checked and surfaced here rather than left to the first failed tool call.
 */
export function AgentAndroidSelect({
  agentId,
  deviceId,
  hasAndroidImage,
  hasIsolation,
}: {
  agentId: string;
  deviceId: string | null;
  /** True when the agent's isolation image carries the Android layer (server-computed). */
  hasAndroidImage: boolean;
  hasIsolation: boolean;
}) {
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [selected, setSelected] = useState<string>(deviceId ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void androidDevicesApi.list().then(setDevices).catch(() => undefined);
  }, []);

  useEffect(() => {
    setSelected(deviceId ?? '');
  }, [agentId, deviceId]);

  async function onSelect(id: string) {
    setSelected(id);
    setBusy(true);
    try {
      await agentsApi.update(agentId, { android_device_id: id || null });
    } finally {
      setBusy(false);
    }
  }

  const active = devices.find((d) => d._id === selected);

  return (
    <div className="space-y-3 rounded-md border border-border bg-panel p-4">
      <div className="flex items-center gap-3">
        <select
          value={selected}
          disabled={busy}
          onChange={(e) => void onSelect(e.target.value)}
          className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        >
          <option value="">No device — not an Android agent</option>
          {devices.map((d) => (
            <option key={d._id} value={d._id} disabled={!d.enabled}>
              {d.name} ({d.adb_host}:{d.adb_port}){d.enabled ? '' : ' — disabled'}
            </option>
          ))}
        </select>
        {active && <StatusBadge device={active} />}
      </div>

      {!active ? (
        <p className="text-xs text-slate-500">
          Link a device to give this agent the <code>android_*</code> tools and a live phone mirror in
          the Workspace. Register devices under{' '}
          <Link to="/settings/connections" className="text-accent hover:underline">
            Settings → Connections
          </Link>
          .
        </p>
      ) : !hasIsolation ? (
        <Warning>
          This agent has no isolation profile. <code>adb</code> runs inside the agent’s container, so
          the Android tools will refuse until one is assigned above.
        </Warning>
      ) : !hasAndroidImage ? (
        <Warning>
          The assigned isolation image doesn’t carry the Android layer. Enable{' '}
          <strong>Android control</strong> on it from the{' '}
          <Link to="/images" className="underline">
            Images
          </Link>{' '}
          page and rebuild, or the Android tools and the phone mirror will both fail.
        </Warning>
      ) : (
        <p className="text-xs text-slate-500">
          Ready. The agent drives <strong>{active.name}</strong> over adb; open the live screen from
          the <strong>Phone</strong> button in the Workspace.
        </p>
      )}
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-400">
      <CircleAlert size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function StatusBadge({ device }: { device: AndroidDevice }) {
  const color =
    device.last_status === 'ok'
      ? 'text-emerald-400 border-emerald-900'
      : device.last_status === 'error'
        ? 'text-amber-400 border-amber-900'
        : 'text-slate-500 border-border';
  return (
    <span
      title={device.last_error || device.last_seen_model || 'Never tested'}
      className={`flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${color}`}
    >
      <Smartphone size={11} /> {device.last_status === 'unknown' ? 'untested' : device.last_status}
    </span>
  );
}
