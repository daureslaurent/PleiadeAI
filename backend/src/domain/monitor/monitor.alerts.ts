import { createLogger } from '../../config/logger';
import { alertEngine } from '../../alerts/AlertEngine';
import type { EffectiveSettings } from '../settings/settings.service';
import type { MonitorBreach, MonitorSnapshot } from './monitor.types';

const log = createLogger('monitor-alerts');

/**
 * Threshold evaluation for the Monitor page.
 *
 * Two jobs, deliberately separate:
 *   - {@link evaluate} is **pure** — snapshot + thresholds → the breaches currently active. The
 *     dashboard tints its meters from this on every poll, with no side effects and no config
 *     needed beyond the settings doc.
 *   - {@link dispatch} decides what is worth *waking the operator for*, and is where the noise
 *     control lives.
 *
 * Noise control is the whole design problem here. A box sitting at 86°C under sustained inference
 * would otherwise alert every poll tick — ten times a minute, forever — which trains the operator
 * to ignore the channel. So:
 *   - a breach alerts once, then goes quiet for `monitor_alert_cooldown_minutes`;
 *   - **escalation re-alerts immediately** (warn → critical is news, even inside the cooldown);
 *   - clearing a breach sends one recovery notice, so "it got hot" always has a matching "it's fine
 *     again" and silence unambiguously means nothing changed;
 *   - de-escalation (critical → warn) is not itself an alert; it resolves when it fully clears.
 */

/** Per-target breach state, keyed by `MonitorBreach.key`. In memory — a restart re-alerts once, which is correct. */
interface ActiveBreach {
  severity: 'warn' | 'critical';
  /** Epoch ms of the last alert we actually sent for this key. */
  alertedAt: number;
  label: string;
}

const active = new Map<string, Map<string, ActiveBreach>>();

/** Compare a reading against warn/critical limits. Returns null when the reading is fine or absent. */
function grade(
  value: number | null | undefined,
  warn: number,
  critical: number,
): { severity: 'warn' | 'critical'; limit: number } | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (critical > 0 && value >= critical) return { severity: 'critical', limit: critical };
  if (warn > 0 && value >= warn) return { severity: 'warn', limit: warn };
  return null;
}

/**
 * Every threshold rule, evaluated against one snapshot. Sensors that a box doesn't expose simply
 * produce no breach — a machine without a CPU temperature sensor is not "0°C and healthy", it is
 * unmeasured, and {@link grade} returns null for it.
 */
export function evaluate(snapshot: MonitorSnapshot | null, s: EffectiveSettings): MonitorBreach[] {
  if (!snapshot) return [];
  const breaches: MonitorBreach[] = [];

  const cpu = grade(snapshot.cpu?.temperature_celsius, s.monitor_cpu_temp_warn, s.monitor_cpu_temp_critical);
  if (cpu) {
    breaches.push({
      key: 'cpu_temp',
      rule: 'cpu_temp',
      label: 'CPU temperature',
      value: snapshot.cpu.temperature_celsius,
      limit: cpu.limit,
      severity: cpu.severity,
    });
  }

  const mem = grade(snapshot.memory?.used_percent, s.monitor_memory_warn, s.monitor_memory_critical);
  if (mem) {
    breaches.push({
      key: 'memory',
      rule: 'memory',
      label: 'Memory used',
      value: snapshot.memory?.used_percent ?? null,
      limit: mem.limit,
      severity: mem.severity,
    });
  }

  for (const gpu of snapshot.gpus ?? []) {
    const id = gpu.index ?? 0;
    const name = gpu.name ? `GPU${id} ${gpu.name}` : `GPU${id}`;

    const temp = grade(gpu.temperature_celsius, s.monitor_gpu_temp_warn, s.monitor_gpu_temp_critical);
    if (temp) {
      breaches.push({
        key: `gpu_temp:${id}`,
        rule: 'gpu_temp',
        label: `${name} temperature`,
        value: gpu.temperature_celsius,
        limit: temp.limit,
        severity: temp.severity,
      });
    }

    const vram = grade(gpu.memory_used_percent, s.monitor_vram_warn, s.monitor_vram_critical);
    if (vram) {
      breaches.push({
        key: `vram:${id}`,
        rule: 'vram',
        label: `${name} VRAM`,
        value: gpu.memory_used_percent,
        limit: vram.limit,
        severity: vram.severity,
      });
    }
  }

  for (const disk of snapshot.disks ?? []) {
    const d = grade(disk.used_percent, s.monitor_disk_warn, s.monitor_disk_critical);
    if (d) {
      breaches.push({
        key: `disk:${disk.label}`,
        rule: 'disk',
        label: `Disk ${disk.label}`,
        value: disk.used_percent ?? null,
        limit: d.limit,
        severity: d.severity,
      });
    }
  }

  return breaches;
}

/** Human phrasing for one breach — temps in °C, everything else a percentage. */
function describe(b: MonitorBreach): string {
  const unit = b.rule === 'cpu_temp' || b.rule === 'gpu_temp' ? '°C' : '%';
  if (b.rule === 'offline') return b.label;
  return `${b.label}: ${b.value ?? '?'}${unit} (limit ${b.limit}${unit})`;
}

/**
 * Fan out newly-breached and newly-cleared rules for one target. Called after every poll, including
 * failed ones — `breaches` carries the synthetic `offline` rule in that case, so an unreachable box
 * alerts through exactly the same path as a hot one.
 */
export async function dispatch(
  targetId: string,
  targetName: string,
  breaches: MonitorBreach[],
  s: EffectiveSettings,
): Promise<void> {
  const previous = active.get(targetId) ?? new Map<string, ActiveBreach>();
  const next = new Map<string, ActiveBreach>();
  const now = Date.now();
  const cooldownMs = Math.max(0, s.monitor_alert_cooldown_minutes) * 60_000;

  const fresh: MonitorBreach[] = [];

  for (const b of breaches) {
    const was = previous.get(b.key);
    // Re-alert when it's new, when it escalated, or when the cooldown has expired and it's still bad.
    const escalated = was && was.severity === 'warn' && b.severity === 'critical';
    const expired = was && cooldownMs > 0 && now - was.alertedAt >= cooldownMs;
    const shouldAlert = !was || escalated || expired || cooldownMs === 0;

    fresh.push(...(shouldAlert ? [b] : []));
    next.set(b.key, {
      severity: b.severity,
      label: b.label,
      alertedAt: shouldAlert ? now : (was?.alertedAt ?? now),
    });
  }

  const cleared = [...previous.keys()].filter((k) => !next.has(k)).map((k) => previous.get(k)!);

  active.set(targetId, next);

  if (!s.monitor_alerts_enabled || (!fresh.length && !cleared.length)) return;

  try {
    if (fresh.length) {
      const worst = fresh.some((b) => b.severity === 'critical') ? 'CRITICAL' : 'Warning';
      await alertEngine.dispatch({
        title: `${worst} — ${targetName}`,
        content: fresh.map(describe).join('\n'),
      });
    }
    if (cleared.length) {
      await alertEngine.dispatch({
        title: `Recovered — ${targetName}`,
        content: `Back within limits: ${cleared.map((c) => c.label).join(', ')}`,
      });
    }
  } catch (err) {
    // An alert that can't be delivered must never break the poll loop that produced it.
    log.error({ err, target: targetName }, 'monitor alert dispatch failed');
  }
}

/** Drop a target's breach state when it's deleted or disabled, so re-adding it starts clean. */
export function forget(targetId: string): void {
  active.delete(targetId);
}
