import { askAgentNode, routerNode } from './agent';
import { approvalNode, collectNode, conditionNode, forEachNode } from './control';
import { dataNode, inputNode, logNode, mergeNode, noteNode, outputNode } from './io';
import { audioMixNode } from './audio';
import { videoComposeNode } from './compose';
import { editImageNode, generateImageNode, generateSoundNode, generateVideoNode } from './media';
import { toolNode } from './tool';
import type { FlowNodeHandler, PortSpec } from '../types';
import type { FlowNode } from '../../domain/flows/flow.model';

/**
 * The node registry — the single source of truth for the whole Flows feature (flows spec §3).
 *
 * `GET /api/flows/node-types` serves it verbatim (with `optionsSource` fields resolved against the
 * database), so the canvas palette, the port colours and the inspector form are all generated from
 * what a handler declares. Adding a node type is therefore a backend-only change: no frontend edit,
 * no wire-schema edit.
 */
const HANDLERS: FlowNodeHandler[] = [
  inputNode,
  outputNode,
  dataNode,
  logNode,
  noteNode,
  askAgentNode,
  routerNode,
  generateImageNode,
  generateVideoNode,
  generateSoundNode,
  editImageNode,
  videoComposeNode,
  audioMixNode,
  toolNode,
  conditionNode,
  approvalNode,
  forEachNode,
  collectNode,
  mergeNode,
];

const BY_TYPE = new Map(HANDLERS.map((h) => [h.type, h]));

export function allHandlers(): FlowNodeHandler[] {
  return HANDLERS;
}

export function getHandler(type: string): FlowNodeHandler | undefined {
  return BY_TYPE.get(type);
}

/** A node's effective output ports, after any config-driven ones (the router's choices). */
export function outputPorts(node: FlowNode): PortSpec[] {
  const handler = getHandler(node.type);
  if (!handler) return [];
  return handler.dynamicOutputs?.(node.config ?? {}) ?? handler.outputs;
}

/** A node's effective input ports. (No handler varies these today; the seam exists for symmetry.) */
export function inputPorts(node: FlowNode): PortSpec[] {
  return getHandler(node.type)?.inputs ?? [];
}

/** Node types the runner never executes as ordinary steps (they carry no work). */
export const NON_EXECUTING_TYPES = new Set(['note']);
