import { useState } from 'react';
import { Plus, Trash2, Plug, Loader2, Check, TriangleAlert } from 'lucide-react';
import { Button, Callout, Input, Row, useConfirm } from '../../../components/ui';
import {
  androidDevicesApi,
  ANDROID_AUDIO_CODECS,
  type AndroidAudioCodec,
  type AndroidDevice,
} from '../../../lib/api';
import { useSettings } from '../context';

/**
 * CRUD for the Android devices agents can drive (`android_devices`). Mirrors `FinetuneServersManager`
 * — edit-on-blur, confirm-to-delete — plus a "Test" action that completes a real adb handshake and
 * reports what answered.
 *
 * The address is the one thing operators get wrong, so the hint is explicit: it is resolved from
 * inside the *agent's container*, not from the browser and not from the backend. `127.0.0.1` there
 * means the container itself, which is almost never where the emulator is.
 */
export function AndroidDevicesManager() {
  const { androidDevices: devices, reloadAndroidDevices: reload } = useSettings();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('5555');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || !host.trim()) return;
    setError(null);
    try {
      await androidDevicesApi.create({
        name: name.trim(),
        adb_host: host.trim(),
        adb_port: Number(port) || 5555,
      });
      setName('');
      setHost('');
      setPort('5555');
      setAdding(false);
      await reload();
    } catch {
      setError('Could not add the device — is the name already taken?');
    }
  }

  async function patch(id: string, p: Parameters<typeof androidDevicesApi.update>[1]) {
    await androidDevicesApi.update(id, p);
    await reload();
  }

  async function test(id: string) {
    setTesting(id);
    try {
      await androidDevicesApi.test(id);
      await reload();
    } finally {
      setTesting(null);
    }
  }

  async function remove(d: AndroidDevice) {
    const ok = await confirm({
      title: `Delete Android device “${d.name}”?`,
      body: 'Any agent linked to it loses its Android tools and its live mirror.',
      danger: true,
    });
    if (!ok) return;
    await androidDevicesApi.remove(d._id);
    await reload();
  }

  return (
    <div className="space-y-3">
      {devices.map((d) => (
        <Row key={d._id} className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <Input
              defaultValue={d.name}
              onBlur={(ev) => ev.target.value !== d.name && void patch(d._id, { name: ev.target.value })}
              className="flex-1 py-1.5 font-medium"
            />
            <button
              onClick={() => void patch(d._id, { enabled: !d.enabled })}
              title={d.enabled ? 'Disable (agents refuse to use it)' : 'Enable'}
              className={[
                'shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors',
                d.enabled
                  ? 'border-emerald-500/30 text-emerald-400'
                  : 'border-white/[0.12] text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {d.enabled ? 'enabled' : 'disabled'}
            </button>
            <Button
              onClick={() => void test(d._id)}
              disabled={testing === d._id}
              title="Complete an adb handshake with the device"
              className="px-2"
            >
              {testing === d._id ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
            </Button>
            <Button variant="danger" onClick={() => void remove(d)} title="Delete device" className="px-2">
              <Trash2 size={13} />
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
            <Input
              defaultValue={d.adb_host}
              onBlur={(ev) => ev.target.value !== d.adb_host && void patch(d._id, { adb_host: ev.target.value })}
              placeholder="172.17.0.1"
              className="py-1.5 font-mono text-xs"
            />
            <Input
              type="number"
              defaultValue={d.adb_port}
              onBlur={(ev) =>
                Number(ev.target.value) !== d.adb_port &&
                void patch(d._id, { adb_port: Number(ev.target.value) || 5555 })
              }
              placeholder="5555"
              className="py-1.5 font-mono text-xs"
            />
          </div>

          {/* Mirror encoding. Only worth touching when the stream is too heavy for the link. */}
          <div className="grid gap-2 sm:grid-cols-3">
            <LabelledNumber
              label="Max size (px)"
              value={d.mirror_max_size}
              placeholder="1080"
              title="Longest edge of the mirrored video. 0 = the device's native resolution."
              onCommit={(v) => void patch(d._id, { mirror_max_size: v })}
            />
            <LabelledNumber
              label="Bitrate (bps)"
              value={d.mirror_bit_rate}
              placeholder="4000000"
              title="Video bitrate for the mirror."
              onCommit={(v) => void patch(d._id, { mirror_bit_rate: v })}
            />
            <LabelledNumber
              label="Max FPS"
              value={d.mirror_max_fps}
              placeholder="30"
              title="Frame-rate ceiling for the mirror."
              onCommit={(v) => void patch(d._id, { mirror_max_fps: v })}
            />
          </div>

          {/* Audio. Off by default and codec-sensitive, so both live next to each other. */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={d.mirror_audio}
                onChange={(ev) => void patch(d._id, { mirror_audio: ev.target.checked })}
                className="accent-accent"
              />
              Forward audio
            </label>
            {d.mirror_audio && (
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                codec
                <select
                  value={d.mirror_audio_codec}
                  onChange={(ev) =>
                    void patch(d._id, { mirror_audio_codec: ev.target.value as AndroidAudioCodec })
                  }
                  className="rounded-md border border-white/[0.12] bg-black/25 px-2 py-1 text-[11px] text-slate-300 outline-none focus:border-accent"
                >
                  {ANDROID_AUDIO_CODECS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <span className="text-slate-600">
                  AAC is the safe choice — many images (redroid included) have no Opus encoder, and a
                  missing one disables audio entirely.
                </span>
              </label>
            )}
          </div>

          {d.last_status === 'ok' && (
            <p className="flex items-center gap-1.5 text-[11px] text-emerald-400">
              <Check size={12} /> {d.last_seen_model || 'adb handshake succeeded'}
              <span className="text-slate-500">— reachable from the backend container</span>
            </p>
          )}
          {d.last_status === 'error' && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span>{d.last_error}</span>
            </p>
          )}
        </Row>
      ))}

      {devices.length === 0 && !adding && (
        <p className="text-[11px] text-slate-500">
          No Android devices yet. Add the address an agent’s container can reach adb on — for an
          emulator on the Docker host that is usually the bridge gateway (<code>172.17.0.1</code>) or
          the host’s LAN address, on port 5555.
        </p>
      )}

      {error && <Callout tone="error">{error}</Callout>}

      {adding ? (
        <div className="space-y-2 rounded-xl border border-dashed border-white/[0.12] bg-black/25 p-3">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. pixel-emulator)"
          />
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="172.17.0.1"
              className="font-mono text-xs"
            />
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="5555"
              className="font-mono text-xs"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void create()}>
              Add device
            </Button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>
          <Plus size={13} /> Add device
        </Button>
      )}
    </div>
  );
}

/** A small labelled number input that only patches when the value actually changed. */
function LabelledNumber({
  label,
  value,
  placeholder,
  title,
  onCommit,
}: {
  label: string;
  value: number;
  placeholder: string;
  title: string;
  onCommit: (value: number) => void;
}) {
  return (
    <label className="space-y-1" title={title}>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <Input
        type="number"
        defaultValue={value}
        onBlur={(ev) => {
          const next = Number(ev.target.value);
          if (Number.isFinite(next) && next !== value) onCommit(next);
        }}
        placeholder={placeholder}
        className="py-1.5 font-mono text-xs"
      />
    </label>
  );
}
