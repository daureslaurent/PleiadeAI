import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Wand2 } from 'lucide-react';
import { Button, Callout, EmptyState, Spinner } from '../../components/ui';
import { mediaApi, type ComfyStatus, type MediaWorkflow } from '../../lib/api';
import { ImportPanel } from './ImportPanel';
import { WorkflowDetail } from './WorkflowDetail';
import { WorkflowRail } from './WorkflowRail';

/**
 * `/media` — the workflow library behind the media tools and the flow media nodes.
 *
 * A ComfyUI workflow is a *graph*, not a prompt string, so before an agent can drive one somebody has
 * to say which of its node inputs is "the prompt", which is "the size", and which node's files are the
 * result. That act — mapping the app's parameters onto the graph's inputs — is what this page is for,
 * and `MEDIA_MAPPING_PLAN.md` explains why it is a canvas rather than a list of dropdowns.
 */
export function MediaView() {
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [workflows, setWorkflows] = useState<MediaWorkflow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([mediaApi.status(), mediaApi.list()]);
      setStatus(s);
      setWorkflows(list);
      setError(null);
      // Keep the selection valid across a reload that deleted it.
      setSelected((current) => (current && list.some((w) => w.id === current) ? current : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setWorkflows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!workflows) return <Spinner />;

  return (
    <div className="flex h-full min-h-0">
      <WorkflowRail
        workflows={workflows}
        selectedId={adding ? null : selected}
        onSelect={(id) => {
          setSelected(id);
          setAdding(false);
        }}
        onAdd={() => setAdding(true)}
        onChanged={load}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="glass flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <h1 className="text-sm font-medium text-slate-100">Media workflows</h1>
          {status?.ok ? (
            <span
              className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400"
              title={status.base_url}
            >
              ComfyUI {status.version} · queue {status.queue_remaining}
            </span>
          ) : (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
              ComfyUI unreachable
            </span>
          )}
          <Button className="ml-auto" icon={<RefreshCw size={12} />} onClick={() => void load()}>
            Refresh
          </Button>
        </div>

        {error && (
          <div className="p-3">
            <Callout tone="error" icon={<AlertTriangle size={13} />}>
              {error}
            </Callout>
          </div>
        )}
        {status && !status.ok && !adding && (
          <div className="px-3 pt-3">
            <Callout tone="warn" icon={<AlertTriangle size={13} />}>
              {status.error} Set the server in Settings → Connections → ComfyUI server. Stored workflows
              stay editable meanwhile; only Validate and Run need it.
            </Callout>
          </div>
        )}

        {adding ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <ImportPanel
              comfyOnline={Boolean(status?.ok)}
              onClose={() => setAdding(false)}
              onImported={async (id) => {
                await load();
                setSelected(id);
                setAdding(false);
              }}
            />
          </div>
        ) : selected ? (
          <WorkflowDetail
            key={selected}
            id={selected}
            onChanged={load}
            onDeleted={() => setSelected(null)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <EmptyState icon={<Wand2 size={20} />}>
              {workflows.length === 0
                ? 'No workflow yet — add one from ComfyUI\'s history, or paste an exported API JSON.'
                : 'Pick a workflow to see its graph and map the app\'s parameters onto it.'}
            </EmptyState>
          </div>
        )}
      </section>
    </div>
  );
}
