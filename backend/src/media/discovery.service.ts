import { createLogger } from '../config/logger';
import { comfyClient } from './comfy/ComfyHttpClient';
import { ComfyError } from './comfy/errors';
import { autoBind, loadSchemas, structureHash, type AutoBindResult } from './comfy/graph-introspect';
import { mediaWorkflowRepository } from '../domain/media-workflows/media-workflow.repository';
import type { ComfyGraph, ComfyHistoryEntry } from './comfy/types';
import type { WorkflowKind } from '../domain/media-workflows/media-workflow.model';

const log = createLogger('media-discovery');

/** Suffixes quantisation/format tooling bolts onto filenames — noise in a human-facing name. */
const NAME_NOISE = /(_|-)?(bf16|fp8|fp16|fp32|int8|int4|nvfp4|awq|gguf|pruned|convrot|mixed|scaled|base|dev|full|small|q\d(_\w+)?)$/i;

export interface DiscoveryCandidate {
  prompt_id: string;
  /** {@link structureHash} of the graph — the identity used for dedup and "already imported". */
  graph_hash: string;
  suggested_name: string;
  kind: WorkflowKind;
  output_node_id: string;
  output_kind: 'image' | 'video' | 'audio';
  node_count: number;
  /** The model files the graph loads — the clearest signal of what it actually is. */
  model_files: string[];
  /** Distinctive node classes, for the operator to recognise the workflow at a glance. */
  key_classes: string[];
  /** Filename of something it produced, e.g. `MiniMax_H3_00002_.mp4`. */
  output_filename: string;
  /** Measured runtime of this run, from ComfyUI's own execution timestamps. */
  duration_ms: number;
  status: string;
  /** How many runs in history share this shape. */
  run_count: number;
  already_imported: boolean;
  bindings: AutoBindResult['bindings'];
  unbound: AutoBindResult['unbound'];
}

/** `z_image_turbo_bf16.safetensors` → `Z Image Turbo`. */
function prettifyModelName(filename: string): string {
  let stem = filename.replace(/\.[^.]+$/, '');
  // Strip the format/quant tail, repeatedly — names stack several (`..._pruned_int8_convrot`).
  for (let i = 0; i < 4; i += 1) {
    const next = stem.replace(NAME_NOISE, '');
    if (next === stem) break;
    stem = next;
  }
  return stem
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Model filenames the graph loads, most significant loader first. */
function modelFiles(graph: ComfyGraph): string[] {
  const priority = ['UNETLoader', 'CheckpointLoaderSimple', 'CheckpointLoader', 'DiffusersLoader'];
  const found: { file: string; rank: number }[] = [];
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs)) {
      if (typeof value !== 'string' || !/\.(safetensors|ckpt|pt|gguf|sft)$/i.test(value)) continue;
      const rank = priority.indexOf(node.class_type);
      found.push({ file: value, rank: rank === -1 ? priority.length : rank });
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  return [...new Set(found.map((f) => f.file))];
}

/** Node classes that identify the workflow, skipping the plumbing every graph has. */
function keyClasses(graph: ComfyGraph): string[] {
  const boring = /^(CLIPLoader|DualCLIPLoader|VAELoader|UNETLoader|VAEDecode|VAEEncode|CheckpointLoaderSimple|Primitive\w+|Comfy\w+|Note|MarkdownNote|Reroute)$/;
  return [...new Set(Object.values(graph).map((n) => n.class_type))].filter((c) => !boring.test(c)).slice(0, 8);
}

/** Wall-clock of the run, from ComfyUI's own `execution_start` → terminal message timestamps. */
function durationOf(entry: ComfyHistoryEntry): number {
  const stamps = new Map<string, number>();
  for (const [name, payload] of entry.status?.messages ?? []) {
    const ts = Number(payload.timestamp);
    if (Number.isFinite(ts) && !stamps.has(name)) stamps.set(name, ts);
  }
  const start = stamps.get('execution_start');
  const end = stamps.get('execution_success') ?? stamps.get('execution_error');
  return start && end ? Math.max(0, end - start) : 0;
}

function firstOutputFilename(entry: ComfyHistoryEntry): string {
  for (const outputs of Object.values(entry.outputs ?? {})) {
    for (const value of Object.values(outputs)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const name = (item as { filename?: string })?.filename;
        if (typeof name === 'string' && name) return name;
      }
    }
  }
  return '';
}

/**
 * Workflows ComfyUI has actually run, ready to import.
 *
 * `/history` is the only practical discovery source: its entries carry the **API-format** graph —
 * already flattened, already proven runnable — whereas the workflows the ComfyUI editor saves are in
 * its own format and reference subgraph definitions by UUID, which only the frontend's graph engine
 * can expand. It's also why import *snapshots* the graph: this history lives in RAM and is gone the
 * moment ComfyUI restarts.
 *
 * Candidates are grouped by {@link structureHash}, so five z-image runs that differ only in prompt or
 * step count collapse into one entry showing `run_count: 5`.
 */
export async function discoverWorkflows(): Promise<DiscoveryCandidate[]> {
  const client = await comfyClient();
  const history = await client.history();
  const imported = await mediaWorkflowRepository.importedHashes();

  const byStructure = new Map<string, DiscoveryCandidate>();

  for (const [promptId, entry] of Object.entries(history)) {
    const graph = entry.prompt?.[2];
    if (!graph || typeof graph !== 'object') continue;

    let candidate: DiscoveryCandidate;
    try {
      const schemas = await loadSchemas(client, graph);
      const bound = autoBind(graph, entry.prompt[4] ?? [], schemas);
      const hash = structureHash(graph, schemas);
      const files = modelFiles(graph);
      candidate = {
        prompt_id: promptId,
        graph_hash: hash,
        suggested_name: files[0] ? prettifyModelName(files[0]) : `Workflow ${promptId.slice(0, 8)}`,
        kind: bound.kind,
        output_node_id: bound.output_node_id,
        output_kind: bound.output_kind,
        node_count: Object.keys(graph).length,
        model_files: files,
        key_classes: keyClasses(graph),
        output_filename: firstOutputFilename(entry),
        duration_ms: durationOf(entry),
        // A failed run's graph is still a fine template — the operator may be importing it precisely
        // because it ran out of VRAM and they want it smaller. Keep it, but say so.
        status: entry.status?.status_str ?? 'unknown',
        run_count: 1,
        already_imported: imported.has(hash),
        bindings: bound.bindings,
        unbound: bound.unbound,
      };
    } catch (err) {
      log.warn({ promptId, err: String(err) }, 'skipping undecodable history entry');
      continue;
    }

    const existing = byStructure.get(candidate.graph_hash);
    if (!existing) {
      byStructure.set(candidate.graph_hash, candidate);
      continue;
    }
    existing.run_count += 1;
    // Represent the group with a *successful* run when one exists: its timings are meaningful and its
    // literals are known-good. Otherwise keep the newest, which is what the later entry is.
    if (existing.status !== 'success' || candidate.status === 'success') {
      byStructure.set(candidate.graph_hash, { ...candidate, run_count: existing.run_count });
    }
  }

  // Newest first: ComfyUI returns history in insertion order, so later entries are more recent.
  return [...byStructure.values()].reverse();
}

/** Re-read one run so import works from the server's copy rather than anything the client sent. */
export async function loadCandidate(promptId: string): Promise<{
  graph: ComfyGraph;
  bound: AutoBindResult;
  graph_hash: string;
  duration_ms: number;
  workflow_uuid: string;
}> {
  const client = await comfyClient();
  const entry = await client.historyEntry(promptId);
  if (!entry) {
    throw new ComfyError(
      'ComfyUI no longer has that run — its history lives in memory and is cleared on restart. ' +
        'Re-run the workflow in ComfyUI, then hit Re-probe.',
    );
  }
  const graph = entry.prompt[2];
  const schemas = await loadSchemas(client, graph);
  const bound = autoBind(graph, entry.prompt[4] ?? [], schemas);
  const extra = entry.prompt[3] as { workflow?: { id?: string } } | undefined;
  return {
    graph,
    bound,
    graph_hash: structureHash(graph, schemas),
    duration_ms: durationOf(entry),
    workflow_uuid: String(extra?.workflow?.id ?? ''),
  };
}
