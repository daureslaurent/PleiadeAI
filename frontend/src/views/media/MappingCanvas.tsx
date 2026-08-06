import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Eye, EyeOff } from 'lucide-react';
import type { BindingMeta, WorkflowBinding, WorkflowNode } from '../../lib/api';
import { FlowEdgeLine } from '../flows/FlowEdgeLine';
import { bindingPortColor, nodeRoleColor } from './bindingPorts';
import {
  AppInputsNode,
  AppOutputNode,
  ComfyNodeCard,
  IN_HANDLE,
  OUT_HANDLE,
  RESULT_HANDLE,
  type AppInputsData,
  type AppOutputData,
  type ComfyNodeData,
} from './MappingNodes';

const NODE_TYPES = { appIn: AppInputsNode, comfyNode: ComfyNodeCard, appOut: AppOutputNode };
const EDGE_TYPES = { flowEdge: FlowEdgeLine };

export const APP_IN_ID = '__app_in';
export const APP_OUT_ID = '__app_out';

/** Above this many nodes the canvas hides plumbing by default — a 90-node graph is unreadable whole. */
const AUTO_FILTER_ABOVE = 24;

const COLUMN_WIDTH = 300;
const ROW_GAP = 24;

/** Estimated card height, so the layout can stack a column before React Flow has measured anything. */
function heightOf(node: WorkflowNode): number {
  const bindable = node.inputs.filter((i) => i.bindable).length;
  const linked = node.inputs.length - bindable;
  return (
    46 +
    Math.max(1, bindable) * 17 +
    (linked ? 8 + linked * 14 : 0) +
    (node.outputs.length ? 8 + node.outputs.length * 14 : 0) +
    (node.is_output ? 28 : 0)
  );
}

/**
 * Place the graph in topological columns: a node sits one column right of everything that feeds it.
 *
 * ComfyUI's own coordinates don't survive the API format (they live in the editor's save file, which
 * is not what gets imported), so a layout has to be derived. Left-to-right by dependency is the one
 * that matches how the operator already reads the graph: loaders on the left, the sampler in the
 * middle, the save node on the right.
 */
function layoutNodes(nodes: WorkflowNode[]): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depths = new Map<string, number>();

  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // a cycle can't happen in a valid graph, but never hang on one
    seen.add(id);
    const node = byId.get(id);
    const parents = (node?.inputs ?? [])
      .map((i) => i.link?.[0])
      .filter((p): p is string => Boolean(p) && byId.has(p!));
    const depth = parents.length === 0 ? 0 : Math.max(...parents.map((p) => depthOf(p, seen) + 1));
    seen.delete(id);
    depths.set(id, depth);
    return depth;
  };

  for (const node of nodes) depthOf(node.id, new Set());

  const columns = new Map<number, WorkflowNode[]>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth)!.push(node);
  }

  const positions = new Map<string, { x: number; y: number }>();
  let tallest = 0;
  for (const [depth, column] of columns) {
    let y = 0;
    for (const node of column) {
      positions.set(node.id, { x: COLUMN_WIDTH + depth * COLUMN_WIDTH, y });
      y += heightOf(node) + ROW_GAP;
    }
    tallest = Math.max(tallest, y);
  }

  const width = COLUMN_WIDTH * (Math.max(...columns.keys(), 0) + 2);
  return { positions, width, height: tallest };
}

export interface MappingCanvasProps {
  nodes: WorkflowNode[];
  bindings: Record<string, WorkflowBinding>;
  catalog: BindingMeta[];
  outputNodeId: string;
  outputKind: 'image' | 'video' | 'audio';
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onBind: (key: string, nodeId: string, input: string) => void;
  onUnbind: (key: string) => void;
  onOutputNode: (nodeId: string) => void;
}

/**
 * The mapping canvas: app parameters on the left, the ComfyUI graph in the middle, the app's output on
 * the right, and one edge per binding between them.
 *
 * A binding is a *wire* here rather than a pair of dropdowns, which is the whole point: it can only be
 * drawn between a parameter that exists and an input that can hold a value, and it is visible in the
 * context of the graph that will consume it.
 */
export function MappingCanvas({
  nodes,
  bindings,
  catalog,
  outputNodeId,
  outputKind,
  selectedNodeId,
  onSelectNode,
  onBind,
  onUnbind,
  onOutputNode,
}: MappingCanvasProps) {
  const [showAll, setShowAll] = useState(nodes.length <= AUTO_FILTER_ABOVE);
  /** Positions the operator has dragged, layered over the computed layout. */
  const [moved, setMoved] = useState<Map<string, { x: number; y: number }>>(new Map());

  const metaByKey = useMemo(() => new Map(catalog.map((m) => [m.key, m])), [catalog]);

  const boundNodeIds = useMemo(
    () => new Set(Object.values(bindings).map((b) => b.node_id)),
    [bindings],
  );

  /**
   * Which nodes to draw. Filtered down, a card earns its place by being bindable, being the result, or
   * carrying a binding already — the rest is plumbing whose only job is to be wired correctly in
   * ComfyUI, and it can be shown on demand.
   */
  const visible = useMemo(() => {
    if (showAll) return nodes;
    return nodes.filter(
      (n) =>
        boundNodeIds.has(n.id) ||
        n.id === outputNodeId ||
        n.is_output ||
        n.inputs.some((i) => i.bindable && i.type !== 'LINK'),
    );
  }, [nodes, showAll, boundNodeIds, outputNodeId]);

  const layout = useMemo(() => layoutNodes(visible), [visible]);

  const rfNodes = useMemo<Node[]>(() => {
    const bound = new Set(Object.keys(bindings));
    const centre = layout.height / 2;

    const cards: Node[] = visible.map((node) => {
      const boundBy = new Map<string, BindingMeta>();
      for (const [key, binding] of Object.entries(bindings)) {
        const meta = metaByKey.get(key);
        if (binding.node_id === node.id && meta) boundBy.set(binding.input, meta);
      }
      const position = moved.get(node.id) ?? layout.positions.get(node.id) ?? { x: 0, y: 0 };
      return {
        id: node.id,
        type: 'comfyNode',
        position,
        selected: node.id === selectedNodeId,
        data: { node, boundBy, isResult: node.id === outputNodeId, onUnbind } satisfies ComfyNodeData,
      };
    });

    return [
      {
        id: APP_IN_ID,
        type: 'appIn',
        position: moved.get(APP_IN_ID) ?? { x: 0, y: Math.max(0, centre - 140) },
        data: { catalog, bound } satisfies AppInputsData,
        deletable: false,
      },
      ...cards,
      {
        id: APP_OUT_ID,
        type: 'appOut',
        position: moved.get(APP_OUT_ID) ?? { x: layout.width, y: Math.max(0, centre - 40) },
        data: { outputKind, connected: Boolean(outputNodeId) } satisfies AppOutputData,
        deletable: false,
      },
    ];
  }, [visible, layout, bindings, metaByKey, catalog, outputNodeId, outputKind, selectedNodeId, onUnbind, moved]);

  const rfEdges = useMemo<Edge[]>(() => {
    const shown = new Set(visible.map((n) => n.id));
    const edges: Edge[] = [];

    // The graph's own wiring, drawn faintly: context, not something to edit here.
    for (const node of visible) {
      for (const input of node.inputs) {
        if (!input.link || !shown.has(input.link[0])) continue;
        edges.push({
          id: `link:${node.id}:${input.name}`,
          source: input.link[0],
          sourceHandle: OUT_HANDLE(input.link[1]),
          target: node.id,
          targetHandle: IN_HANDLE(input.name),
          type: 'smoothstep',
          selectable: false,
          focusable: false,
          style: { stroke: 'rgba(148,163,184,0.22)', strokeWidth: 1.2 },
        });
      }
    }

    // The bindings themselves.
    for (const [key, binding] of Object.entries(bindings)) {
      if (!shown.has(binding.node_id)) continue;
      const color = bindingPortColor(metaByKey.get(key)?.port);
      edges.push({
        id: `bind:${key}`,
        type: 'flowEdge',
        source: APP_IN_ID,
        sourceHandle: key,
        target: binding.node_id,
        targetHandle: IN_HANDLE(binding.input),
        data: { color, onDelete: (id: string) => onUnbind(id.replace(/^bind:/, '')) },
        style: { stroke: color, strokeWidth: 1.8 },
      });
    }

    if (outputNodeId && shown.has(outputNodeId)) {
      edges.push({
        id: `result:${outputNodeId}`,
        source: outputNodeId,
        sourceHandle: RESULT_HANDLE,
        target: APP_OUT_ID,
        targetHandle: RESULT_HANDLE,
        type: 'smoothstep',
        selectable: false,
        style: { stroke: '#34d399', strokeWidth: 1.8 },
      });
    }

    return edges;
  }, [visible, bindings, metaByKey, outputNodeId, onUnbind]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === APP_IN_ID && connection.sourceHandle && connection.targetHandle) {
        onBind(connection.sourceHandle, connection.target!, connection.targetHandle.replace(/^in:/, ''));
        return;
      }
      if (connection.target === APP_OUT_ID && connection.source) onOutputNode(connection.source);
    },
    [onBind, onOutputNode],
  );

  /** Only two connections mean anything here: parameter → input, and result node → app output. */
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (connection.source === APP_IN_ID) {
        if (connection.target === APP_OUT_ID) return false;
        const node = visible.find((n) => n.id === connection.target);
        const input = node?.inputs.find((i) => IN_HANDLE(i.name) === connection.targetHandle);
        return Boolean(input?.bindable);
      }
      return connection.target === APP_OUT_ID && connection.sourceHandle === RESULT_HANDLE;
    },
    [visible],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          const { id, position } = change;
          setMoved((prev) => new Map(prev).set(id, position));
        } else if (change.type === 'select' && change.selected) {
          onSelectNode(change.id === APP_IN_ID || change.id === APP_OUT_ID ? null : change.id);
        }
      }
    },
    [onSelectNode],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onPaneClick={() => onSelectNode(null)}
      // Deleting a *node* here would mean editing the ComfyUI graph, which this page deliberately
      // doesn't do — the graph is a snapshot of what runs on the server.
      deleteKeyCode={null}
      nodesConnectable
      elementsSelectable
      proOptions={{ hideAttribution: true }}
      fitView
      fitViewOptions={{ padding: 0.15, minZoom: 0.2, maxZoom: 1 }}
      minZoom={0.1}
      maxZoom={1.75}
      defaultEdgeOptions={{ type: 'smoothstep' }}
      connectionLineStyle={{ stroke: '#64748b', strokeWidth: 1.6 }}
      className="flow-canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(148,163,184,0.14)" />
      <Controls showInteractive={false} className="flow-controls" />
      <MiniMap
        pannable
        zoomable
        className="flow-minimap"
        maskColor="rgba(2,6,23,0.55)"
        nodeStrokeWidth={3}
        nodeBorderRadius={3}
        nodeColor={(n) => {
          const card = (n.data as ComfyNodeData).node;
          return card ? nodeRoleColor(card.class_type, card.id === outputNodeId) : '#3b82f6';
        }}
      />

      {/* Only offered when filtering actually removes something — on a small graph the toggle would
          just be a control that does nothing. */}
      {nodes.length > visible.length || showAll ? (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-lg bg-black/40 px-2 py-1 text-[10px] text-slate-300 ring-1 ring-white/[0.08] backdrop-blur-sm transition-colors hover:bg-white/[0.08]"
        >
          {showAll ? <EyeOff size={11} /> : <Eye size={11} />}
          {showAll ? 'Hide plumbing' : `Show all ${nodes.length} nodes`}
        </button>
      ) : null}
    </ReactFlow>
  );
}
