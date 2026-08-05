import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CircleStop, Play, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button, Callout, Input, Textarea } from '../../components/ui';
import { flowsApi, type FlowDetail, type FlowInputSpec, type FlowValue } from '../../lib/api';
import { ArtifactPreview } from './ArtifactPreview';
import { ResourceInput } from './ResourceInput';
import type { LiveRun } from './useFlowRun';

/**
 * The right-hand run rail: the inputs form (generated from the flow's `input` nodes), the run
 * controls, the pending approval gate, and the result with its artifacts.
 *
 * Node-level progress lives on the canvas cards, not here — this panel answers "what did I ask for
 * and what came back", which is the part you want to read after the graph has stopped moving.
 */
export function FlowRunPanel({
  flow,
  live,
  onStarted,
}: {
  flow: FlowDetail;
  live: LiveRun & { refresh: () => void };
  onStarted: (runId: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form to the flow's declared defaults whenever the flow (or its inputs) changes.
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const input of flow.inputs) next[input.key] = String(input.default ?? '');
    setValues(next);
  }, [flow.id, flow.inputs]);

  const running = live.detail?.status === 'running' || live.detail?.status === 'awaiting_input';
  const blocking = useMemo(() => flow.issues.filter((i) => i.level === 'error'), [flow.issues]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const run = await flowsApi.run(flow.id, values);
      onStarted(run.id);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setStarting(false);
    }
  };

  const answer = async (approved: boolean) => {
    if (!live.runId) return;
    await flowsApi.approve(live.runId, approved).catch((err) => setError(messageOf(err)));
    live.refresh();
  };

  const stop = async () => {
    if (!live.runId) return;
    await flowsApi.stop(live.runId).catch(() => undefined);
    live.refresh();
  };

  const sessionId = live.detail?.sessionId ?? live.runId;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {blocking.length > 0 && (
          <Callout tone="warn">
            <div className="space-y-1">
              {blocking.slice(0, 4).map((issue, i) => (
                <div key={i} className="flex gap-1.5 text-xs">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>{issue.message}</span>
                </div>
              ))}
            </div>
          </Callout>
        )}

        {flow.inputs.length > 0 && (
          <div className="space-y-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Inputs</div>
            {flow.inputs.map((input) => (
              <InputField
                key={input.key}
                flowId={flow.id}
                spec={input}
                value={values[input.key] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [input.key]: v }))}
              />
            ))}
          </div>
        )}

        {live.pending && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-amber-400">
              Waiting for you
            </div>
            <p className="whitespace-pre-wrap text-xs text-slate-200">{live.pending.question}</p>
            {live.pending.artifacts.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {live.pending.artifacts.map((handle) => (
                  <ArtifactPreview
                    key={handle}
                    sessionId={sessionId}
                    handle={handle}
                    mime={live.detail?.resources.find((r) => r.handle === handle)?.mime}
                  />
                ))}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <Button variant="primary" icon={<ThumbsUp size={13} />} onClick={() => answer(true)}>
                Approve
              </Button>
              <Button variant="danger" icon={<ThumbsDown size={13} />} onClick={() => answer(false)}>
                Reject
              </Button>
            </div>
          </div>
        )}

        {live.detail && (
          <div className="space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Result</div>
            <RunResult live={live} sessionId={sessionId} />
          </div>
        )}

        {error && <Callout tone="error">{error}</Callout>}
      </div>

      <div className="border-t border-white/[0.06] p-3">
        {running ? (
          <Button variant="danger" icon={<CircleStop size={13} />} onClick={stop} className="w-full">
            Stop run
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Play size={13} />}
            loading={starting}
            disabled={blocking.length > 0}
            onClick={start}
            className="w-full"
          >
            Run flow
          </Button>
        )}
      </div>
    </div>
  );
}

function InputField({
  flowId,
  spec,
  value,
  onChange,
}: {
  flowId: string;
  spec: FlowInputSpec;
  value: string;
  onChange: (v: string) => void;
}) {
  const binary = ['image', 'video', 'audio', 'file'].includes(spec.type);
  return (
    <div className="block">
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-xs text-slate-300">{spec.label}</span>
        {spec.required && <span className="text-red-400">*</span>}
        <span className="ml-auto font-mono text-[9px] text-slate-600">{spec.type}</span>
      </div>
      {binary ? (
        <ResourceInput flowId={flowId} type={spec.type} value={value} onChange={onChange} />
      ) : spec.type === 'text' || spec.type === 'json' ? (
        <Textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function RunResult({ live, sessionId }: { live: LiveRun; sessionId: string }) {
  const detail = live.detail;
  if (!detail) return null;

  const output = live.finished?.output ?? textOf(detail.output);
  const handles = live.finished?.handles ?? handlesOf(detail.output);
  const error = live.finished?.error ?? detail.error;
  // An edge carries handles, not metadata, so the mime comes from the run's resource list — without
  // it a generated mp4 would render as a still image placeholder.
  const mimeOf = (handle: string) => detail.resources.find((r) => r.handle === handle)?.mime;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs">
        <StatusChip status={live.finished?.status ?? detail.status} />
        <span className="text-slate-600">{new Date(detail.startedAt).toLocaleString()}</span>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 px-2.5 py-2 text-xs leading-relaxed text-red-300">{error}</div>
      )}

      {output && (
        <div className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-black/25 px-2.5 py-2 text-xs leading-relaxed text-slate-300">
          {output}
        </div>
      )}

      {handles.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {handles.map((handle) => (
            <ArtifactPreview key={handle} sessionId={sessionId} handle={handle} mime={mimeOf(handle)} />
          ))}
        </div>
      )}

      {detail.resources.length > 0 && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer select-none hover:text-slate-300">
            All artifacts ({detail.resources.length})
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {detail.resources.map((r) => (
              <ArtifactPreview
                key={r.handle}
                sessionId={sessionId}
                handle={r.handle}
                mime={r.mime}
                filename={r.filename}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'success'
      ? 'bg-emerald-500/15 text-emerald-400'
      : status === 'error' || status === 'aborted'
        ? 'bg-red-500/15 text-red-400'
        : status === 'awaiting_input'
          ? 'bg-amber-500/15 text-amber-400'
          : 'bg-accent/15 text-accent';
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {status === 'success' && <Check size={10} />}
      {status.replace('_', ' ')}
    </span>
  );
}

function textOf(output: Record<string, FlowValue> | null): string {
  if (!output) return '';
  return Object.values(output)[0]?.text ?? '';
}

function handlesOf(output: Record<string, FlowValue> | null): string[] {
  if (!output) return [];
  return Object.values(output)[0]?.handles ?? [];
}

export function messageOf(err: unknown): string {
  const anyErr = err as { response?: { data?: { error?: string } }; message?: string };
  return anyErr?.response?.data?.error ?? anyErr?.message ?? 'request failed';
}
