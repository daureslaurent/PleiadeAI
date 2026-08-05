import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Trash2 } from 'lucide-react';
import type { FlowEdge, FlowIssue, FlowNode, FlowNodeType, PortType } from '../../lib/api';
import { FlowNodeCard, type FlowNodeData, type NodeRunState } from './FlowNodeCard';
import { canConnect, GROUP_COLORS, portColor } from './portStyle';

const NODE_TYPES = { flowNode: FlowNodeCard };

/**
 * The graph canvas.
 *
 * Node and edge state is owned by the parent (`FlowsView`) in the backend's own `FlowNode`/`FlowEdge`
 * shape, and mapped into React Flow's here. Keeping the domain shape upstream means saving is a
 * straight PUT of what's already in state — no round-tripping through a library-specific
 * representation, and no drift between what the canvas shows and what the runner will execute.
 */
export function FlowCanvas({
  nodes,
  edges,
  nodeTypes,
  issues,
  runStates,
  selectedId,
  onSelect,
  onNodesChange,
  onEdgesChange,
  readOnly = false,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  nodeTypes: Map<string, FlowNodeType>;
  issues: FlowIssue[];
  runStates?: Map<string, NodeRunState>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNodesChange: (nodes: FlowNode[]) => void;
  onEdgesChange: (edges: FlowEdge[]) => void;
  readOnly?: boolean;
}) {
  /**
   * Measured node sizes, fed back from React Flow's `dimensions` changes.
   *
   * Because this canvas is fully controlled — every node object is rebuilt from `props.nodes` on each
   * render — the library's own measurements would be thrown away every time. Anything that reasons
   * about node *bounds* (the minimap's blips, `fitView`'s zoom) then has nothing to work from. Holding
   * them here and merging them back is what makes those work.
   */
  const [sizes, setSizes] = useState<Map<string, { width: number; height: number }>>(new Map());

  const issueByNode = useMemo(() => {
    const map = new Map<string, 'error' | 'warning'>();
    for (const issue of issues) {
      if (!issue.nodeId) continue;
      // An error outranks a warning on the same node — the blocking problem is the one to show.
      if (issue.level === 'error' || !map.has(issue.nodeId)) map.set(issue.nodeId, issue.level);
    }
    return map;
  }, [issues]);

  const rfNodes = useMemo<Node<FlowNodeData>[]>(
    () =>
      nodes.map((node) => {
        const type = nodeTypes.get(node.type);
        const size = sizes.get(node.id);
        return {
          id: node.id,
          type: 'flowNode',
          position: node.position,
          selected: node.id === selectedId,
          draggable: !readOnly,
          ...(size ? { measured: size, width: size.width, height: size.height } : {}),
          data: {
            nodeType: type,
            label: node.label || type?.label || node.type,
            subtitle: subtitleOf(node, type),
            inputs: type?.inputs ?? [],
            outputs: outputsOf(node, type),
            run: runStates?.get(node.id),
            issue: issueByNode.get(node.id),
          },
        };
      }),
    [nodes, nodeTypes, selectedId, runStates, issueByNode, readOnly, sizes],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const source = nodes.find((n) => n.id === edge.source);
        const type = source ? outputsOf(source, nodeTypes.get(source.type)) : [];
        const portType = (type.find((p) => p.name === edge.source_port)?.types[0] ?? 'text') as PortType;
        const color = portColor(portType);
        return {
          id: edge.id,
          source: edge.source,
          sourceHandle: edge.source_port,
          target: edge.target,
          targetHandle: edge.target_port,
          animated: portType === 'signal',
          style: { stroke: color, strokeWidth: 1.6 },
        };
      }),
    [edges, nodes, nodeTypes],
  );

  /** Port type of a specific handle, for connection validation. */
  const portTypeOf = useCallback(
    (nodeId: string | null | undefined, handle: string | null | undefined, side: 'in' | 'out'): PortType | null => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return null;
      const type = nodeTypes.get(node.type);
      const ports = side === 'out' ? outputsOf(node, type) : (type?.inputs ?? []);
      const port = ports.find((p) => p.name === handle);
      return (port?.types[0] as PortType) ?? null;
    },
    [nodes, nodeTypes],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const source = portTypeOf(connection.source, connection.sourceHandle, 'out');
      const target = portTypeOf(connection.target, connection.targetHandle, 'in');
      if (!source || !target) return false;
      if (connection.source === connection.target) return false;
      return canConnect(source, target);
    },
    [portTypeOf],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Measurements arrive as `dimensions` changes and are kept regardless of edit mode — a
      // read-only run replay still needs a minimap and a sane fit.
      const measured = changes.filter(
        (c): c is Extract<NodeChange, { type: 'dimensions' }> => c.type === 'dimensions' && Boolean(c.dimensions),
      );
      if (measured.length) {
        setSizes((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const change of measured) {
            const current = next.get(change.id);
            const { width, height } = change.dimensions!;
            if (current?.width === width && current?.height === height) continue;
            next.set(change.id, { width, height });
            changed = true;
          }
          return changed ? next : prev;
        });
      }

      if (readOnly) {
        for (const change of changes) if (change.type === 'select' && change.selected) onSelect(change.id);
        return;
      }
      let next = nodes;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          next = next.map((n) => (n.id === change.id ? { ...n, position: change.position! } : n));
        } else if (change.type === 'remove') {
          next = next.filter((n) => n.id !== change.id);
          if (selectedId === change.id) onSelect(null);
        } else if (change.type === 'select' && change.selected) {
          onSelect(change.id);
        }
      }
      if (next !== nodes) onNodesChange(next);
    },
    [nodes, onNodesChange, onSelect, selectedId, readOnly],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readOnly) return;
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
      if (removed.size) onEdgesChange(edges.filter((e) => !removed.has(e.id)));
    },
    [edges, onEdgesChange, readOnly],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || !isValidConnection(connection)) return;
      const edge: FlowEdge = {
        id: `e_${connection.source}_${connection.sourceHandle}_${connection.target}_${connection.targetHandle}`,
        source: connection.source!,
        source_port: connection.sourceHandle ?? 'default',
        target: connection.target!,
        target_port: connection.targetHandle ?? 'default',
      };
      // One value per input port: re-wiring a port replaces what was there rather than silently
      // merging two sources into a prompt nobody meant to concatenate.
      const cleaned = edges.filter(
        (e) => !(e.target === edge.target && e.target_port === edge.target_port) && e.id !== edge.id,
      );
      onEdgesChange([...cleaned, edge]);
    },
    [edges, onEdgesChange, isValidConnection, readOnly],
  );

  const deleteSelected = useCallback(() => {
    if (readOnly || !selectedId) return;
    onNodesChange(nodes.filter((n) => n.id !== selectedId));
    onEdgesChange(edges.filter((e) => e.source !== selectedId && e.target !== selectedId));
    onSelect(null);
  }, [selectedId, nodes, edges, onNodesChange, onEdgesChange, onSelect, readOnly]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={NODE_TYPES}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={!readOnly}
      elementsSelectable
      proOptions={{ hideAttribution: true }}
      fitView
      // Clamp the initial fit. `maxZoom: 1` stops a two-node flow from being blown up to fill the
      // pane; `minZoom` is a legibility floor — the canvas sits between two rails, so a long pipeline
      // would otherwise fit itself down to an unreadable smear. Below the floor it overflows and the
      // operator pans, which is the better of the two bad options.
      fitViewOptions={{ padding: 0.15, minZoom: 0.35, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={1.75}
      defaultEdgeOptions={{ type: 'smoothstep' }}
      connectionLineStyle={{ stroke: '#64748b', strokeWidth: 1.6 }}
      className="flow-canvas"
    >
      {/* Faint dots only: the app's starfield is the backdrop, and a second strong grid over it
          turns into moiré as you zoom. */}
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(148,163,184,0.14)" />
      <Controls showInteractive={false} className="flow-controls">
        {!readOnly && (
          <ControlButton onClick={deleteSelected} title="Delete selected node">
            <Trash2 size={12} />
          </ControlButton>
        )}
      </Controls>
      {/* Node blips are coloured by the node's *group*, matching the palette and each card's top
          rule — the minimap is a map of the same territory, so it must use the same key. */}
      <MiniMap
        pannable
        zoomable
        className="flow-minimap"
        maskColor="rgba(2,6,23,0.55)"
        nodeStrokeWidth={3}
        nodeBorderRadius={3}
        nodeColor={groupColorOf}
        nodeStrokeColor={groupColorOf}
      />
    </ReactFlow>
  );
}

function groupColorOf(node: Node): string {
  return GROUP_COLORS[(node.data as FlowNodeData).nodeType?.group ?? 'io'] ?? GROUP_COLORS.io!;
}

/**
 * Output ports, including the config-driven ones. The agent router declares one signal port per
 * choice, so its ports change as you type them — mirrored here rather than refetched, so the canvas
 * keeps up with the keystroke instead of the round trip.
 */
export function outputsOf(node: FlowNode, type: FlowNodeType | undefined) {
  if (!type) return [];
  if (node.type !== 'router') return type.outputs;
  const choices = String(node.config.choices ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  return [
    ...type.outputs,
    ...choices.map((choice) => ({ name: choice, types: ['signal' as PortType] })),
  ];
}

/** The one config value that says what this node actually does, shown under its title. */
function subtitleOf(node: FlowNode, type: FlowNodeType | undefined): string {
  const config = node.config ?? {};
  switch (node.type) {
    case 'input':
      return `${String(config.key ?? 'input')} · ${String(config.port_type ?? 'text')}`;
    case 'ask_agent':
    case 'router':
      return String(config.agent ?? '') || 'no agent selected';
    case 'tool':
      return String(config.tool ?? '') || 'no tool selected';
    case 'condition':
      return String(config.expression ?? '') || 'no condition';
    case 'for_each':
      return `×${String(config.max_items ?? 20)} max`;
    case 'note':
      return String(config.text ?? '');
    default:
      if (type?.group === 'media') {
        const label = type.config.find((f) => f.key === 'workflow')?.optionLabels?.[String(config.workflow ?? '')];
        return label ?? (config.workflow ? 'workflow selected' : 'no workflow selected');
      }
      return '';
  }
}
