import type { ComfyFileRef, ComfyHistoryEntry, ComfyNodeOutputs } from './types';

/** What a produced file actually is, decided by extension rather than by which key it arrived under. */
export type MediaKind = 'image' | 'video' | 'audio' | 'other';

export interface ComfyArtifact extends ComfyFileRef {
  kind: MediaKind;
  /** Node that produced it — used to prefer the workflow's declared output node. */
  nodeId: string;
}

const EXT_KIND: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', bmp: 'image', tiff: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video', avi: 'video', gif: 'video',
  mp3: 'audio', flac: 'audio', wav: 'audio', opus: 'audio', ogg: 'audio', m4a: 'audio',
};

/**
 * `.gif` is deliberately classed as video: ComfyUI's animation nodes publish GIFs as motion output,
 * and the UI wants a player, not a still. A single-frame gif still renders fine in a `<video>`-less
 * fallback because the resource keeps its real `image/gif` mime.
 */
export function kindForFilename(filename: string): MediaKind {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_KIND[ext] ?? 'other';
}

/** Whether a value looks like ComfyUI's `{filename, subfolder, type}` file descriptor. */
function isFileRef(v: unknown): v is ComfyFileRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as ComfyFileRef).filename === 'string' &&
    (v as ComfyFileRef).filename.length > 0
  );
}

/**
 * Collect every artifact a run produced.
 *
 * The one rule that matters: **never key off the outputs key name**. `SaveVideo` publishes its mp4
 * under `images` with a sibling `animated: [true]` (verified on this server), `SaveAudio*` uses
 * `audio`, animation nodes use `gifs`. So we walk *every* array-valued key of *every* node and
 * classify each descriptor by its filename extension.
 *
 * Ordering: the workflow's declared output node first (that's the one the operator wired as the
 * result), then the remaining nodes. `temp` files — live previews the sampler emits — are dropped
 * unless the run produced nothing else at all.
 */
export function collectArtifacts(entry: ComfyHistoryEntry, preferNodeId?: string): ComfyArtifact[] {
  const nodeIds = Object.keys(entry.outputs ?? {});
  if (preferNodeId && nodeIds.includes(preferNodeId)) {
    nodeIds.splice(nodeIds.indexOf(preferNodeId), 1);
    nodeIds.unshift(preferNodeId);
  }

  const found: ComfyArtifact[] = [];
  for (const nodeId of nodeIds) {
    const outputs = entry.outputs[nodeId] as ComfyNodeOutputs | undefined;
    if (!outputs) continue;
    for (const value of Object.values(outputs)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!isFileRef(item)) continue;
        found.push({
          filename: item.filename,
          subfolder: item.subfolder ?? '',
          type: item.type || 'output',
          kind: kindForFilename(item.filename),
          nodeId,
        });
      }
    }
  }

  const persisted = found.filter((a) => a.type !== 'temp');
  return persisted.length > 0 ? persisted : found;
}

/**
 * The artifacts worth returning for a workflow of the given kind — e.g. a video workflow that also
 * saves a contact-sheet PNG should hand back the mp4. Falls back to everything when the expected kind
 * is absent, so a mis-declared workflow still returns *something* the operator can see and diagnose.
 */
export function selectArtifacts(artifacts: ComfyArtifact[], want: MediaKind): ComfyArtifact[] {
  const matching = artifacts.filter((a) => a.kind === want);
  return matching.length > 0 ? matching : artifacts;
}
