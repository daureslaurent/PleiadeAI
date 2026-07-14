import { useCallback, useEffect, useState } from 'react';
import {
  autonomyApi,
  inboxApi,
  type AutonomyJob,
  type AutonomyJobInput,
  type AutonomyRunResult,
  type Notification,
} from '../lib/api';
import { Markdown } from '../components/Markdown';

type ScheduleMode = 'recurring' | 'oneoff';

interface FormState {
  editingId: string | null;
  agentName: string;
  prompt: string;
  mode: ScheduleMode;
  cron: string;
  alert: boolean;
}

const EMPTY_FORM: FormState = {
  editingId: null,
  agentName: '',
  prompt: '',
  mode: 'recurring',
  cron: '0 * * * *',
  alert: true,
};

function fmt(d: string | null | undefined): string {
  return d ? new Date(d).toLocaleString() : '—';
}

/**
 * Autonomy & Inbox Monitor (spec §5): schedules render as clickable cards; selecting one opens its
 * full run history (each result rendered as markdown). Also hosts full CRUD over the schedules, the
 * unread notifications inbox, and the global execution kill switch.
 */
export function AutonomyInbox() {
  const [jobs, setJobs] = useState<AutonomyJob[]>([]);
  const [notes, setNotes] = useState<Notification[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [results, setResults] = useState<AutonomyRunResult[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);

  const refresh = useCallback(() => {
    autonomyApi.jobs().then(setJobs);
    inboxApi.list().then(setNotes);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadResults = useCallback((id: string) => {
    setResultsLoading(true);
    autonomyApi
      .results(id)
      .then(setResults)
      .finally(() => setResultsLoading(false));
  }, []);

  function selectJob(id: string) {
    setSelectedId(id);
    setResults([]);
    loadResults(id);
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  function editJob(j: AutonomyJob) {
    setForm({
      editingId: j.id,
      agentName: j.data.agentName,
      prompt: j.data.prompt,
      mode: j.once ? 'oneoff' : 'recurring',
      cron: j.cron ?? EMPTY_FORM.cron,
      alert: j.data.alert ?? true,
    });
  }

  async function submit() {
    if (!form.agentName.trim() || !form.prompt.trim() || !form.cron.trim()) return;
    setBusy(true);
    const input: AutonomyJobInput = {
      agentName: form.agentName.trim(),
      prompt: form.prompt.trim(),
      alert: form.alert,
      cron: form.cron.trim(),
      once: form.mode === 'oneoff',
    };
    try {
      if (form.editingId) await autonomyApi.update(form.editingId, input);
      else await autonomyApi.create(input);
      setFormError(null);
      resetForm();
      refresh();
    } catch (err: any) {
      // Typically a 400 for an invalid cron expression — show the server's message inline.
      setFormError(err?.response?.data?.error ?? 'failed to save schedule');
    } finally {
      setBusy(false);
    }
  }

  async function runNow(id: string) {
    await autonomyApi.run(id);
    refresh();
    // The run is queued asynchronously; give it a moment, then refresh the open history.
    if (selectedId === id) setTimeout(() => loadResults(id), 1500);
  }

  async function remove(id: string) {
    await autonomyApi.remove(id);
    if (form.editingId === id) resetForm();
    if (selectedId === id) setSelectedId(null);
    refresh();
  }

  async function kill() {
    if (!confirm('Cancel every scheduled autonomous task?')) return;
    await autonomyApi.kill();
    resetForm();
    setSelectedId(null);
    refresh();
  }

  async function markRead(id: string) {
    await inboxApi.markRead(id);
    setNotes((n) => n.map((x) => (x._id === id ? { ...x, status: 'read' } : x)));
  }

  const canSubmit = form.agentName.trim() && form.prompt.trim() && form.cron.trim() && !busy;
  const selectedJob = jobs.find((j) => j.id === selectedId) ?? null;

  return (
    <div className="grid h-full grid-cols-2 gap-4 overflow-hidden p-4">
      {/* Schedules */}
      <section className="flex min-h-0 flex-col">
        <div className="mb-2 flex items-center">
          <span className="font-mono text-xs uppercase text-slate-500">Schedules</span>
          <button
            onClick={kill}
            className="ml-auto rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white"
          >
            Kill switch
          </button>
        </div>

        {/* Create / edit form */}
        <div className="mb-4 space-y-2 rounded border border-border bg-surface p-3 text-xs">
          <div className="font-mono uppercase text-slate-500">
            {form.editingId ? 'Edit schedule' : 'New schedule'}
          </div>
          <input
            value={form.agentName}
            onChange={(e) => setForm((f) => ({ ...f, agentName: e.target.value }))}
            placeholder="agent name"
            className="w-full rounded border border-border bg-panel px-2 py-1 text-slate-200 outline-none focus:border-accent"
          />
          <textarea
            value={form.prompt}
            onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            placeholder="prompt to run when the task fires"
            rows={2}
            className="w-full rounded border border-border bg-panel px-2 py-1 text-slate-200 outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <select
              value={form.mode}
              onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value as ScheduleMode }))}
              className="rounded border border-border bg-panel px-2 py-1 text-slate-200 outline-none focus:border-accent"
            >
              <option value="recurring">Recurring</option>
              <option value="oneoff">One-off</option>
            </select>
            <input
              value={form.cron}
              onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))}
              placeholder='cron, e.g. "0 9 * * *"'
              className="flex-1 rounded border border-border bg-panel px-2 py-1 font-mono text-slate-200 outline-none focus:border-accent"
            />
          </div>
          <p className="text-slate-600">
            5-field cron ({jobs[0]?.timezone ?? 'server'} time).
            {form.mode === 'oneoff' && ' One-off runs once at the next matching time.'}
          </p>
          {formError && <p className="text-red-400">{formError}</p>}
          <label className="flex items-center gap-2 text-slate-400">
            <input
              type="checkbox"
              checked={form.alert}
              onChange={(e) => setForm((f) => ({ ...f, alert: e.target.checked }))}
            />
            Alert on completion
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="rounded bg-accent px-3 py-1 font-semibold text-white disabled:opacity-40"
            >
              {form.editingId ? 'Save' : 'Schedule'}
            </button>
            {form.editingId && (
              <button onClick={resetForm} className="text-slate-400 hover:text-slate-200">
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Schedule cards */}
        <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
          {jobs.map((j) => {
            const active = j.id === selectedId;
            return (
              <button
                key={j.id}
                onClick={() => selectJob(j.id)}
                className={`w-full rounded border p-3 text-left text-xs transition-colors ${
                  active
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-surface hover:border-slate-600'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-200">{j.data.agentName}</span>
                  <span className="rounded bg-panel px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                    {j.once ? 'once' : 'cron'} {j.cron ?? ''}
                  </span>
                  {j.data.alert === false && (
                    <span className="text-[10px] uppercase text-slate-500">silent</span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        runNow(j.id);
                      }}
                      className="text-accent hover:underline"
                    >
                      run
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        editJob(j);
                      }}
                      className="text-slate-400 hover:text-slate-200"
                    >
                      edit
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(j.id);
                      }}
                      className="text-red-400 hover:text-red-300"
                    >
                      delete
                    </span>
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-slate-500">{j.data.prompt}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-slate-600">
                  <span>next: {fmt(j.nextRunAt)}</span>
                  <span>last: {fmt(j.lastRunAt)}</span>
                </div>
              </button>
            );
          })}
          {!jobs.length && <p className="text-slate-600">No schedules.</p>}
        </div>
      </section>

      {/* Detail: results for selected schedule, else notifications inbox */}
      <section className="flex min-h-0 flex-col">
        {selectedJob ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-xs uppercase text-slate-500">
                Results · {selectedJob.data.agentName}
              </span>
              <button
                onClick={() => loadResults(selectedJob.id)}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                refresh
              </button>
              <button
                onClick={() => setSelectedId(null)}
                className="ml-auto text-xs text-slate-400 hover:text-slate-200"
              >
                ✕ close
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
              {resultsLoading && <p className="text-xs text-slate-600">Loading…</p>}
              {!resultsLoading &&
                results.map((r) => (
                  <div key={r.id} className="rounded border border-border bg-surface">
                    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px]">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono uppercase ${
                          r.status === 'success'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-red-500/15 text-red-400'
                        }`}
                      >
                        {r.status}
                      </span>
                      <span className="text-slate-500">{fmt(r.finishedAt)}</span>
                    </div>
                    <div className="px-3 py-2">
                      <Markdown>{r.output || '_(no output)_'}</Markdown>
                    </div>
                  </div>
                ))}
              {!resultsLoading && !results.length && (
                <p className="text-xs text-slate-600">No runs recorded yet.</p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="mb-2 font-mono text-xs uppercase text-slate-500">Notifications</div>
            <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
              {notes.map((n) => (
                <div
                  key={n._id}
                  className={`rounded border border-border p-2 text-xs ${n.status === 'unread' ? 'bg-surface' : 'bg-panel opacity-60'}`}
                >
                  <div className="flex items-center">
                    <span className="text-slate-200">{n.title}</span>
                    {n.status === 'unread' && (
                      <button onClick={() => markRead(n._id)} className="ml-auto text-accent">
                        mark read
                      </button>
                    )}
                  </div>
                  <div className="text-slate-500">{n.content}</div>
                </div>
              ))}
              {!notes.length && <p className="text-slate-600">Inbox empty.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
