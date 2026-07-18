import { BellRing, MonitorDot, Thermometer } from 'lucide-react';
import { Section } from '../../../components/ui';
import { MonitorTargetsManager } from '../managers/MonitorTargetsManager';
import { SettingNumber, SettingToggle } from '../controls';

/** `/settings/monitor` — which machines are watched, how often, and what counts as too hot or too full. */
export function MonitorPanel() {
  return (
    <div className="animate-fade-up space-y-5">
      <Section title="Monitored machines" icon={<MonitorDot size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Each machine runs the <code className="font-mono text-slate-400">monitor-client</code> service, which
          exposes CPU, GPU, temperature, fan, disk and network readings on one URL. The backend polls
          them and renders the fleet on the Monitor page — the API key stays server-side and is never
          sent to this browser.
        </p>
        <MonitorTargetsManager />
      </Section>

      <Section title="Polling & alerts" icon={<BellRing size={13} />}>
        <div className="space-y-4">
          <SettingNumber
            field="monitor_poll_seconds"
            label="Poll interval (seconds)"
            min={5}
            hint="How often every enabled machine is read. Minimum 5s. History holds the last 720 samples per machine (2h at 10s), in memory — it resets when the backend restarts."
          />
          <SettingToggle
            field="monitor_alerts_enabled"
            label="Send threshold alerts"
            hint="When on, a breached threshold fires into the inbox and Telegram, plus a recovery notice when it clears. The dashboard tints its meters either way."
          />
          <SettingNumber
            field="monitor_alert_cooldown_minutes"
            label="Alert cooldown (minutes)"
            min={0}
            hint="A breach alerts once, then stays quiet this long. Escalation from warning to critical re-alerts immediately. 0 = alert on every poll (noisy)."
          />
        </div>
      </Section>

      <Section title="Thresholds" icon={<Thermometer size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Fleet-wide limits. <span className="text-amber-300">Warning</span> tints a meter amber,{' '}
          <span className="text-red-300">critical</span> turns it red. Defaults suit consumer hardware — an
          Intel package reports its own limit around 82°C, and NVIDIA consumer cards throttle in the
          83–93°C range. A sensor a machine doesn't expose is simply never evaluated.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingNumber field="monitor_cpu_temp_warn" label="CPU temp — warning (°C)" min={0} />
          <SettingNumber field="monitor_cpu_temp_critical" label="CPU temp — critical (°C)" min={0} />
          <SettingNumber field="monitor_gpu_temp_warn" label="GPU temp — warning (°C)" min={0} />
          <SettingNumber field="monitor_gpu_temp_critical" label="GPU temp — critical (°C)" min={0} />
          <SettingNumber field="monitor_memory_warn" label="Memory used — warning (%)" min={0} />
          <SettingNumber field="monitor_memory_critical" label="Memory used — critical (%)" min={0} />
          <SettingNumber field="monitor_vram_warn" label="VRAM used — warning (%)" min={0} />
          <SettingNumber field="monitor_vram_critical" label="VRAM used — critical (%)" min={0} />
          <SettingNumber field="monitor_disk_warn" label="Disk used — warning (%)" min={0} />
          <SettingNumber field="monitor_disk_critical" label="Disk used — critical (%)" min={0} />
        </div>
      </Section>
    </div>
  );
}
