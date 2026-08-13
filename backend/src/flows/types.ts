import type { FlowNode } from '../domain/flows/flow.model';
import type { ToolConfigField } from '../tools/types';
import type { FlowValue, PortType } from './port-types';
import type { TemplateScope } from './template';

/** One input or output socket on a node. */
export interface PortSpec {
  name: string;
  /** Accepted types (inputs) or the produced type (outputs, first entry). */
  types: PortType[];
  /** Inputs only: the run fails validation if nothing is wired and no config default covers it. */
  required?: boolean;
  description?: string;
}

/**
 * What a node hands back: a single primary value, or one value per named output port.
 *
 * **Branching convention:** a node that chooses a path (`condition`, `router`, `approval`) simply
 * omits the ports it didn't take. The runner treats "declared an output port, produced nothing on
 * it" as "that branch is not taken" and marks everything only reachable through it `skipped` — so
 * branching needs no special node result type, just an absent key.
 */
export type NodeResult = FlowValue | Record<string, FlowValue>;

/**
 * Everything a node handler is allowed to touch. Deliberately narrower than `ToolContext`: a node
 * doesn't get an inference loop or a tool list, it gets the run's session, a progress channel, and
 * the resource store its artifacts land in.
 */
export interface FlowNodeContext {
  runId: string;
  /** Equals `runId` — the run's resource + socket session (flows spec §1.1). */
  sessionId: string;
  flowId: string;
  flowName: string;
  /** The node being executed, including its `run_as_agent` identity. */
  node: FlowNode;
  /** Nested-flow depth, capped like `HopGuard` caps agent hops. */
  depth: number;
  /** Cancels the whole run — threaded into agent turns and ComfyUI jobs alike. */
  signal: AbortSignal;
  /** Template scope at this point in the run (completed outputs + the `for_each` item). */
  scope: TemplateScope;
  /** Structured progress for the node's card (percent, ComfyUI preview frames). */
  emitProgress(payload: {
    phase: 'queued' | 'running' | 'downloading';
    percent?: number | null;
    message?: string;
    preview?: string;
    etaMs?: number | null;
  }): void;
  /** A line of live log output for the node (agent tokens, tool stdout). */
  emitOutput(chunk: string): void;
  /** Persist bytes into the run's session and return the `img_N` / `blob_N` handle. */
  storeResource(input: {
    bytes: Buffer;
    kind: 'image' | 'blob';
    mime: string;
    filename?: string;
  }): Promise<string>;
  /** Read a handle's bytes back (an `edit_image` node reading its source, say). */
  readResource(handle: string): Promise<{ bytes: Buffer; mime: string; filename: string } | null>;
  /**
   * Copy a resource from another session into this run's, returning its new handle. Used by `input`
   * to pull an operator-uploaded file out of the flow's staging session (see `flows/staging.ts`), so
   * every node downstream deals in one handle space and the run's artifact list is self-contained.
   */
  importResource(fromSessionId: string, handle: string): Promise<string | null>;
  /** Block on the operator (the `approval` node). Resolves to their decision. */
  askApproval(question: string, artifacts: string[]): Promise<boolean>;
}

/** Grouping in the canvas palette. */
export type NodeGroup = 'io' | 'agent' | 'media' | 'tool' | 'control';

/**
 * A node type. The registry of these (`flows/nodes/index.ts`) is the single source of truth for the
 * whole feature: `GET /api/flows/node-types` serves it, so the palette, the port colours and the
 * inspector form are all generated from what a handler declares. Adding a node type is a backend-only
 * change.
 */
export interface FlowNodeHandler {
  type: string;
  label: string;
  group: NodeGroup;
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  /** Operator-filled options, reusing the Tools-page field type verbatim. */
  config: ToolConfigField[];
  /**
   * Ports that depend on the node's own config — the `router`'s one signal port per choice. Called
   * with the *stored* config (never templated), by both validation and the canvas.
   */
  dynamicOutputs?(config: Record<string, unknown>): PortSpec[];
  /**
   * Ports that depend on the node's own config, input side — a media node gets one per custom
   * parameter its selected workflow declares. Same contract as {@link dynamicOutputs}: called with the
   * *stored* config, synchronously, by both validation and the canvas.
   */
  dynamicInputs?(config: Record<string, unknown>): PortSpec[];
  /** Extra validation beyond ports and required fields. Returns error strings. */
  validate?(node: FlowNode): string[];
  /**
   * Execute. `config` arrives with every `{{ref}}` already interpolated; `inputs` holds the values
   * arriving on wired ports, already coerced to the declared type.
   */
  run(
    ctx: FlowNodeContext,
    inputs: Record<string, FlowValue>,
    config: Record<string, unknown>,
  ): Promise<NodeResult>;
}
