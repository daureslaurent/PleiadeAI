import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import {
  autonomyApi,
  type Agent,
  type AutonomyJob,
  type AutonomyJobInput,
  type CronPreview,
} from '../../lib/api';
import { agentColor } from '../../lib/agentColor';
import { Button, Callout, Field, Input, Select, Textarea, Toggle } from '../../components/ui';
import { fmtDateTime } from './time';

/** Quick-pick cron expressions for the helper chips. */
const PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'every 15 min', expr: '*/15 * * * *' },
  { label: 'hourly', expr: '0 * * * *' },
  { label: 'daily 9:00', expr: '0 9 * * *' },
  { label: 'weekdays 9:00', expr: '0 9 * * 1-5' },
  { label: 'Mondays 9:00', expr: '0 9 * * 1' },
  { label: '1st of month', expr: '0 9 1 * *' },
];

/**
 * Create / edit modal for an autonomous schedule (glass-card, DIRECT_ART §3). The cron field is
 * validated live against the server's parser (same acceptance as save) and previews the next three
 * occurrences in SCHEDULE_TZ, so an invalid or surprising expression is visible before submitting.
 */
export function ScheduleForm({
  agents,
  initial,
  onClose,
  onSaved,
}: {
  agents: Agent[];
  /** The job being edited, or null to create a new schedule. */
  initial: AutonomyJob | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [agentName, setAgentName] = useState(initial?.data.agentName ?? agents[0]?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.data.prompt ?? '');
  const [once, setOnce] = useState(initial?.once ?? false);
  const [cron, setCron] = useState(initial?.cron ?? '0 9 * * *');
  const [alert, setAlert] = useState(initial?.data.alert ?? true);
  const [preview, setPreview] = useState<CronPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live cron preview, debounced so typing doesn't spam the API.
  useEffect(() => {
    const expr = cron.trim();
    if (!expr) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      autonomyApi
        .cronPreview(expr)
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [cron]);

  const color = useMemo(() => agentColor(agentName), [agentName]);
  const canSubmit = agentName.trim() && prompt.trim() && cron.trim() && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const input: AutonomyJobInput = {
      agentName: agentName.trim(),
      prompt: prompt.trim(),
      cron: cron.trim(),
      once,
      alert,
    };
    try {
      if (initial) await autonomyApi.update(initial.id, input);
      else await autonomyApi.create(input);
      onSaved();
      onClose();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error ?? 'failed to save the schedule');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={initial ? 'Edit schedule' : 'New schedule'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass-card w-full max-w-lg animate-fade-up rounded-2xl border border-white/[0.09] p-5">
        <div className="mb-4 flex items-center gap-2">
          <CalendarClock size={16} className="text-slate-500" />
          <h2 className="text-sm font-semibold text-slate-100">
            {initial ? 'Edit schedule' : 'New schedule'}
          </h2>
          <button
            onClick={onClose}
            title="Close"
            className="ml-auto rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-4">
          <Field label="Agent">
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: color.accent }}
              />
              <Select value={agentName} onChange={(e) => setAgentName(e.target.value)}>
                {!agents.some((a) => a.name === agentName) && agentName && (
                  <option value={agentName}>{agentName} (missing)</option>
                )}
                {agents.map((a) => (
                  <option key={a._id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </Field>

          <Field label="Prompt" hint="What the agent is asked to do each time the schedule fires.">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="e.g. Check the RSS feeds and summarize anything new."
            />
          </Field>

          <div className="flex items-start gap-3">
            <Field label="Mode" className="w-36 shrink-0">
              <Select
                value={once ? 'oneoff' : 'recurring'}
                onChange={(e) => setOnce(e.target.value === 'oneoff')}
              >
                <option value="recurring">Recurring</option>
                <option value="oneoff">One-off</option>
              </Select>
            </Field>
            <Field
              label={`Cron${preview ? ` · ${preview.timezone}` : ''}`}
              className="min-w-0 flex-1"
            >
              <Input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * *"
                className="font-mono"
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.expr}
                onClick={() => setCron(p.expr)}
                className={`rounded-md px-2 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                  cron.trim() === p.expr
                    ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
                    : 'bg-white/[0.06] text-slate-400 hover:bg-white/[0.1] hover:text-slate-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Live cron verdict: the next occurrences, or the parser's error. */}
          {preview && !preview.valid && (
            <p className="text-[11px] leading-relaxed text-red-400">{preview.error}</p>
          )}
          {preview?.valid && (
            <div className="rounded-xl border border-white/[0.06] bg-black/25 px-3 py-2 text-[11px] leading-relaxed">
              <span className="text-slate-500">
                {once ? 'Runs once at' : 'Next runs'} ({preview.timezone}):
              </span>
              <div className="mt-0.5 font-mono text-slate-300">
                {(once ? preview.next.slice(0, 1) : preview.next).map((d) => (
                  <div key={d}>{fmtDateTime(d)}</div>
                ))}
              </div>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2.5 text-xs text-slate-300">
            <Toggle checked={alert} onChange={setAlert} />
            Notify on completion (inbox + Telegram)
          </label>

          {error && <Callout tone="error">{error}</Callout>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} loading={busy} onClick={submit}>
            {initial ? 'Save changes' : 'Schedule'}
          </Button>
        </div>
      </div>
    </div>
  );
}
