import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  AlertTriangle,
  Check,
  Copy,
  Play,
  Images,
  Save,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Workflow,
} from 'lucide-react';
import { ListRow, MasterDetail } from '../../components/MasterDetail';
import { Button, EmptyState, Spinner, Toggle, useConfirm } from '../../components/ui';
import {
  flowsApi,
  type FlowDetail,
  type FlowEdge,
  type FlowIssue,
  type FlowNode,
  type FlowNodeType,
  type FlowSummary,
} from '../../lib/api';
import { FlowCanvas } from './FlowCanvas';
import { NodeInspector } from './NodeInspector';
import { NodePalette } from './NodePalette';
import { FlowDebugPanel } from './FlowDebugPanel';
import { FlowMediaPanel } from './FlowMediaPanel';
import { FlowRunPanel, messageOf } from './FlowRunPanel';
import { FlowRunsPanel } from './FlowRunsPanel';
import { useFlowRun } from './useFlowRun';

type Tab = 'design' | 'runs';
type RailTab = 'run' | 'debug' | 'media' | 'params';

/** Remembers the last-opened flow across reloads/navigation, scoped to this page. */
const LAST_FLOW_KEY = 'pleiades.flows.lastSelectedId';

const RAIL_TABS = [
  { key: 'run' as const, label: 'Run', icon: Play },
  { key: 'debug' as const, label: 'Debug', icon: Terminal },
  { key: 'media' as const, label: 'Media', icon: Images },
  { key: 'params' as const, label: 'Params', icon: SlidersHorizontal },
];

/**
 * The Flows page (FLOWS_PLAN.md §8).
 *
 * Graph state is held here in the backend's own `FlowNode`/`FlowEdge` shape, so saving is a straight
 * PUT of what the canvas is already showing. The two tabs share one canvas on purpose: **Design**
 * edits it, **Runs** replays a past execution's node states onto the very same cards, so a failure is
 * inspected where it happened instead of in a separate log view.
 */
export function FlowsView() {
  const confirm = useConfirm();
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [selectedId, setSelectedIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_FLOW_KEY);
    } catch {
      return null;
    }
  });
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    try {
      if (id) localStorage.setItem(LAST_FLOW_KEY, id);
      else localStorage.removeItem(LAST_FLOW_KEY);
    } catch {
      /* storage unavailable — selection just won't survive a reload */
    }
  }, []);
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [nodeTypes, setNodeTypes] = useState<FlowNodeType[]>([]);

  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<FlowIssue[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('design');
  const [railTab, setRailTab] = useState<RailTab>('run');
  /** Set once the operator picks a rail tab themselves; cleared when a new run starts. */
  const railPinned = useRef(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [runsKey, setRunsKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const live = useFlowRun(runId);

  const typeMap = useMemo(() => new Map(nodeTypes.map((t) => [t.type, t])), [nodeTypes]);

  useEffect(() => {
    flowsApi
      .nodeTypes()
      .then((r) => setNodeTypes(r.types))
      .catch(() => setNodeTypes([]));
    reloadList();
  }, []);

  const reloadList = () =>
    flowsApi
      .list()
      .then((list) => {
        setFlows(list);
        // Keep the current/persisted selection if it still exists; otherwise fall back to the first flow.
        setSelectedIdState((current) => {
          const next = (current && list.some((f) => f.id === current) ? current : list[0]?.id) ?? null;
          try {
            if (next) localStorage.setItem(LAST_FLOW_KEY, next);
            else localStorage.removeItem(LAST_FLOW_KEY);
          } catch {
            /* storage unavailable */
          }
          return next;
        });
      })
      .catch(() => setFlows([]));

  // Load the selected flow into the editor. Deliberately keyed on the id alone: re-fetching on every
  // save would stomp on edits made while the request was in flight.
  useEffect(() => {
    if (!selectedId) {
      setFlow(null);
      return;
    }
    let alive = true;
    flowsApi
      .get(selectedId)
      .then((detail) => {
        if (!alive) return;
        setFlow(detail);
        setNodes(detail.nodes);
        setEdges(detail.edges);
        setIssues(detail.issues);
        setDirty(false);
        setSelectedNodeId(null);
        setRunId(null);
        setTab('design');
      })
      .catch(() => alive && setFlow(null));
    return () => {
      alive = false;
    };
  }, [selectedId]);

  // Re-validate as the graph changes, debounced — the canvas should flag a bad wire while you're
  // still looking at it, without a request per mouse move.
  const validateTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!flow) return;
    if (validateTimer.current) window.clearTimeout(validateTimer.current);
    validateTimer.current = window.setTimeout(() => {
      flowsApi
        .validate(nodes, edges)
        .then((r) => setIssues(r.issues))
        .catch(() => undefined);
    }, 400);
    return () => {
      if (validateTimer.current) window.clearTimeout(validateTimer.current);
    };
  }, [nodes, edges, flow]);

  const changeNodes = useCallback((next: FlowNode[]) => {
    setNodes(next);
    setDirty(true);
  }, []);

  const changeEdges = useCallback((next: FlowEdge[]) => {
    setEdges(next);
    setDirty(true);
  }, []);

  const addNode = (type: FlowNodeType) => {
    const id = `${type.type}_${Math.random().toString(36).slice(2, 7)}`;
    const config: Record<string, unknown> = {};
    for (const field of type.config) config[field.key] = field.default;
    // Drop new nodes below the lowest existing one so they never land on top of the graph.
    const y = nodes.length ? Math.max(...nodes.map((n) => n.position.y)) + 140 : 80;
    changeNodes([
      ...nodes,
      { id, type: type.type, label: type.label, position: { x: 120, y }, config, run_as_agent: '' },
    ]);
    setSelectedNodeId(id);
  };

  const patchNode = (id: string, patch: Partial<FlowNode>) =>
    changeNodes(nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)));

  const deleteNode = (id: string) => {
    changeNodes(nodes.filter((n) => n.id !== id));
    changeEdges(edges.filter((e) => e.source !== id && e.target !== id));
    setSelectedNodeId(null);
  };

  const save = async () => {
    if (!flow) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await flowsApi.update(flow.id, { nodes, edges });
      setFlow(updated);
      setIssues(updated.issues);
      setDirty(false);
      reloadList();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const createFlow = async () => {
    const name = window.prompt('Flow name');
    if (!name?.trim()) return;
    try {
      const created = await flowsApi.create({ name: name.trim() });
      await reloadList();
      setSelectedId(created.id);
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const removeFlow = async () => {
    if (!flow) return;
    const ok = await confirm({
      title: `Delete "${flow.name}"?`,
      body: 'Its run history and every artifact those runs produced go with it.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await flowsApi.remove(flow.id);
    setSelectedId(null);
    reloadList();
  };

  const duplicateFlow = async () => {
    if (!flow) return;
    const copy = await flowsApi.duplicate(flow.id);
    await reloadList();
    setSelectedId(copy.id);
  };

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const errorCount = issues.filter((i) => i.level === 'error').length;

  return (
    <MasterDetail
      newLabel="New flow"
      onNew={createFlow}
      list={
        flows === null ? (
          <Spinner />
        ) : (
          flows.map((f) => (
            <ListRow key={f.id} active={f.id === selectedId} onClick={() => setSelectedId(f.id)}>
              <Workflow size={14} className={f.enabled ? 'text-slate-400' : 'text-slate-700'} />
              <span className={`truncate ${f.enabled ? '' : 'text-slate-600'}`}>{f.name}</span>
              <span className="ml-auto shrink-0 text-[10px] text-slate-600">{f.nodeCount}</span>
            </ListRow>
          ))
        )
      }
    >
      {!flow ? (
        <div className="flex h-full items-center justify-center">
          <EmptyState icon={<Workflow size={22} />}>
            {flows?.length ? 'Select a flow.' : 'No flows yet — create one to wire up a pipeline.'}
          </EmptyState>
        </div>
      ) : (
        <div className="flex h-full flex-col">
          {/* Toolbar */}
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-100">{flow.name}</div>
              {flow.description && (
                <div className="truncate text-[10px] text-slate-600">{flow.description}</div>
              )}
            </div>

            <div className="ml-4 flex rounded-lg bg-black/25 p-0.5">
              {(['design', 'runs'] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-md px-3 py-1 text-xs capitalize transition-colors ${
                    tab === t ? 'bg-accent/20 text-accent' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {errorCount > 0 ? (
                <span className="flex items-center gap-1 text-[11px] text-red-400">
                  <AlertTriangle size={12} /> {errorCount} problem{errorCount > 1 ? 's' : ''}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-emerald-400/80">
                  <Check size={12} /> valid
                </span>
              )}
              <Toggle
                checked={flow.enabled}
                onChange={(v) => {
                  setFlow({ ...flow, enabled: v });
                  flowsApi.update(flow.id, { enabled: v }).then(reloadList).catch(() => undefined);
                }}
              />
              <Button variant="ghost" icon={<Copy size={13} />} onClick={duplicateFlow}>
                Duplicate
              </Button>
              <Button variant="danger" icon={<Trash2 size={13} />} onClick={removeFlow}>
                Delete
              </Button>
              <Button
                variant={dirty ? 'primary' : 'ghost'}
                icon={<Save size={13} />}
                loading={saving}
                disabled={!dirty}
                onClick={save}
              >
                {dirty ? 'Save' : 'Saved'}
              </Button>
            </div>
          </div>

          {error && (
            <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-1.5 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="flex min-h-0 flex-1">
            {/* Left rail: palette when designing, run history when reviewing. */}
            <aside className="glass w-56 shrink-0 border-r">
              {tab === 'design' ? (
                <NodePalette nodeTypes={nodeTypes} onAdd={addNode} />
              ) : (
                <FlowRunsPanel
                  flowId={flow.id}
                  selectedRunId={runId}
                  onSelect={setRunId}
                  reloadKey={runsKey}
                />
              )}
            </aside>

            <div className="min-w-0 flex-1">
              <ReactFlowProvider>
                <FlowCanvas
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={typeMap}
                  issues={issues}
                  runStates={live.states.size ? live.states : undefined}
                  selectedId={selectedNodeId}
                  onSelect={(id) => {
                    setSelectedNodeId(id);
                    // Clicking a node opens its settings — unless the operator has chosen a tab
                    // themselves, in which case leave the rail where they put it.
                    if (id && !railPinned.current) setRailTab('params');
                  }}
                  onNodesChange={changeNodes}
                  onEdgesChange={changeEdges}
                  readOnly={tab === 'runs'}
                />
              </ReactFlowProvider>

            </div>

            {/* Right rail. Run, Debug and Parameters used to fight for this space — selecting a node
                replaced the run controls, and a node's log was an unscrollable overlay on the canvas.
                They are peers now, so watching a run and inspecting a node no longer exclude each
                other. */}
            <aside className="glass flex w-80 shrink-0 flex-col border-l">
              <div className="flex shrink-0 gap-0.5 border-b border-white/[0.06] p-1.5">
                {RAIL_TABS.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => {
                      setRailTab(key);
                      // Any manual choice parks the auto-switching until the next run starts, so the
                      // rail is never yanked away mid-read.
                      railPinned.current = true;
                    }}
                    className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1 text-[11px] transition-colors ${
                      railTab === key ? 'bg-accent/20 text-accent' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon size={11} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1">
                {railTab === 'run' && (
                  <FlowRunPanel
                    flow={{ ...flow, issues }}
                    live={live}
                    onStarted={(id) => {
                      setRunId(id);
                      setRunsKey((k) => k + 1);
                      // A fresh run re-arms auto-switching and jumps to Debug.
                      railPinned.current = false;
                      setRailTab('debug');
                    }}
                  />
                )}
                {railTab === 'debug' && (
                  <FlowDebugPanel
                    logs={live.logs}
                    nodes={nodes}
                    selectedNodeId={selectedNodeId}
                    live={live.detail?.status === 'running' || live.detail?.status === 'awaiting_input'}
                  />
                )}
                {railTab === 'media' && (
                  <FlowMediaPanel
                    artifacts={live.artifacts}
                    states={live.states}
                    nodes={nodes}
                    sessionId={live.detail?.sessionId ?? live.runId}
                  />
                )}
                {railTab === 'params' &&
                  (selectedNode ? (
                    <NodeInspector
                      node={selectedNode}
                      nodeType={typeMap.get(selectedNode.type)}
                      flowId={flow.id}
                      nodes={nodes}
                      readOnly={tab === 'runs'}
                      onChange={(patch) => patchNode(selectedNode.id, patch)}
                      onDelete={() => deleteNode(selectedNode.id)}
                      onClose={() => setSelectedNodeId(null)}
                    />
                  ) : (
                    <div className="p-4">
                      <EmptyState icon={<SlidersHorizontal size={18} />}>
                        Select a node to edit its settings.
                      </EmptyState>
                    </div>
                  ))}
              </div>
            </aside>
          </div>
        </div>
      )}
    </MasterDetail>
  );
}
