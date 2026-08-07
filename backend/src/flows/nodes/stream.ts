import { createLogger } from '../../config/logger';
import { streamRegistry } from '../../streaming/StreamRegistry';
import { DEFAULT_PROFILE, type StreamKind, type StreamProfile, type UnderrunPolicy } from '../../streaming/types';
import { flowTimerScheduler } from '../TimerScheduler';
import { asHandles, SIGNAL, textValue } from '../port-types';
import type { FlowNodeHandler, PortSpec } from '../types';

const log = createLogger('flow:stream-node');

const MEDIA_INPUT: PortSpec = {
  name: 'media',
  types: ['audio', 'video', 'image', 'file'],
  required: true,
  description: 'The clip to append to the live stream.',
};

/**
 * `stream_out` — StreamingFlow (STREAMING_PLAN.md §4).
 *
 * Hands a generated clip to the flow's live stream. The stream is keyed by **flow id**, not by run,
 * so this node does not create anything per run: the first clip opens the stream, and every clip
 * after it — from this run or from the next hundred runs — appends to the same endless flux. Editing
 * the prompt upstream and running again changes what comes out of the speakers without the listener
 * ever losing playback, which is the whole reason the node exists.
 *
 * The profile fields below are read only when the stream is *opened*. Changing resolution or codec on
 * a flux that already has decoders attached would break them, so a live stream keeps the profile it
 * started with until it is stopped.
 */
export const streamOutNode: FlowNodeHandler = {
  type: 'stream_out',
  label: 'StreamingFlow',
  group: 'media',
  description:
    'Appends a clip to this flow\'s live stream, and opens the stream if it is not already on air. Watch it from the streams badge in the header.',
  inputs: [
    MEDIA_INPUT,
    { name: 'run', types: ['signal'], description: 'Optional ordering-only trigger.' },
  ],
  outputs: [
    { name: 'default', types: ['text'], description: 'The stream URL.' },
    { name: 'done', types: ['signal'] },
  ],
  config: [
    {
      key: 'title',
      label: 'Now playing',
      type: 'string',
      default: '',
      hint: 'Shown in the player while this clip is on air. Supports {{node_id}} — quote the prompt node to label each clip.',
    },
    {
      key: 'kind',
      label: 'Stream type',
      type: 'select',
      options: ['audio', 'video'],
      default: 'audio',
      hint: 'Audio-only streams skip video encoding entirely. A video stream fed an audio clip plays it over black.',
    },
    {
      key: 'width',
      label: 'Width',
      type: 'number',
      default: DEFAULT_PROFILE.width,
      hint: 'Video streams only. Every clip is scaled and padded to this.',
    },
    { key: 'height', label: 'Height', type: 'number', default: DEFAULT_PROFILE.height, hint: 'Video streams only.' },
    { key: 'fps', label: 'Frame rate', type: 'number', default: DEFAULT_PROFILE.fps, hint: 'Video streams only.' },
    {
      key: 'sample_rate',
      label: 'Sample rate (Hz)',
      type: 'number',
      default: DEFAULT_PROFILE.sampleRate,
      hint: 'Audio is resampled to this for every clip.',
    },
    {
      key: 'audio_bitrate',
      label: 'Audio bitrate',
      type: 'string',
      default: DEFAULT_PROFILE.audioBitrate,
      hint: 'e.g. 160k.',
    },
    {
      key: 'video_bitrate',
      label: 'Video bitrate',
      type: 'string',
      default: DEFAULT_PROFILE.videoBitrate,
      hint: 'Video streams only, e.g. 2500k.',
    },
    {
      key: 'underrun',
      label: 'When the buffer runs dry',
      type: 'select',
      options: ['loop', 'silence'],
      default: 'loop',
      hint: 'Loop re-airs the last clip until the next render lands, so the flux never goes quiet. Silence stalls instead.',
    },
    {
      key: 'idle_timeout_minutes',
      label: 'Idle timeout (min)',
      type: 'number',
      default: DEFAULT_PROFILE.idleTimeoutMinutes,
      hint: 'Tear the stream down after this long with no new clips and no listeners.',
    },
    {
      key: 'max_queued',
      label: 'Max queued clips',
      type: 'number',
      default: DEFAULT_PROFILE.maxQueued,
      hint: 'Cap on un-aired material. Past it the oldest waiting clip is dropped — a stream is live, not a spool.',
    },
  ],

  async run(ctx, inputs, config) {
    const handles = asHandles(inputs.media);
    if (handles.length === 0) throw new Error('nothing was wired into the stream — connect a clip to "media"');

    const profile = profileFrom(config);
    const stream = streamRegistry.getOrCreate(ctx.flowId, ctx.flowName, profile);
    const title = String(config.title ?? '').trim() || `${ctx.flowName} — clip`;

    for (const handle of handles) {
      if (ctx.signal.aborted) break;
      const resource = await ctx.readResource(handle);
      if (!resource) throw new Error(`"${handle}" is not a resource in this run`);

      ctx.emitProgress({ phase: 'running', message: `encoding ${handle} for the stream` });
      const clip = await stream.push({ bytes: resource.bytes, filename: resource.filename, title });
      const info = stream.info();
      ctx.emitOutput(
        `queued ${handle} (${clip.durationSec.toFixed(1)}s) — ${info.queuedClips} clip(s) / ${info.bufferedSec}s buffered\n`,
      );
      log.info({ flow: ctx.flowName, handle, clip: clip.id }, 'clip pushed to the live stream');
    }

    const url = `/api/streams/${ctx.flowId}/live.mp4`;
    return { default: textValue(url), done: SIGNAL };
  },
};

function profileFrom(config: Record<string, unknown>): StreamProfile {
  const kind: StreamKind = config.kind === 'video' ? 'video' : 'audio';
  const underrun: UnderrunPolicy = config.underrun === 'silence' ? 'silence' : 'loop';
  return {
    kind,
    width: even(num(config.width, DEFAULT_PROFILE.width)),
    height: even(num(config.height, DEFAULT_PROFILE.height)),
    fps: clamp(num(config.fps, DEFAULT_PROFILE.fps), 1, 60),
    sampleRate: num(config.sample_rate, DEFAULT_PROFILE.sampleRate),
    channels: DEFAULT_PROFILE.channels,
    audioBitrate: String(config.audio_bitrate || DEFAULT_PROFILE.audioBitrate),
    videoBitrate: String(config.video_bitrate || DEFAULT_PROFILE.videoBitrate),
    underrun,
    idleTimeoutMinutes: clamp(num(config.idle_timeout_minutes, DEFAULT_PROFILE.idleTimeoutMinutes), 1, 24 * 60),
    maxQueued: clamp(num(config.max_queued, DEFAULT_PROFILE.maxQueued), 1, 500),
  };
}

/**
 * `timer` — the Time trigger (STREAMING_PLAN.md §4).
 *
 * A source node that fires the flow again every N seconds. Executing it is a no-op — the node is a
 * marker, and the re-firing lives in `FlowTimerScheduler`, because the interval has to outlive the
 * run that contains it. Agenda would be the obvious home except that its floor is a minute and a
 * generative radio ticks in seconds.
 *
 * Ticks never overlap: if the previous run is still going the tick is skipped, so the interval is a
 * floor rather than a promise. A remote ComfyUI with one GPU cannot honour anything stricter.
 */
export const timerNode: FlowNodeHandler = {
  type: 'timer',
  label: 'Time',
  group: 'control',
  description: 'Re-runs this whole flow every N seconds while armed. Ticks that land on a still-running run are skipped.',
  inputs: [],
  outputs: [{ name: 'default', types: ['signal'], description: 'Fires once per run.' }],
  config: [
    {
      key: 'interval_seconds',
      label: 'Every (seconds)',
      type: 'number',
      default: 30,
      hint: 'Minimum 5. A tick is skipped when the previous run has not finished, so this is a floor.',
    },
    {
      key: 'auto_start',
      label: 'Arm on first run',
      type: 'boolean',
      default: true,
      hint: 'Running the flow once starts the timer, so a stream keeps itself fed. Disarm it from the flow, or by stopping the stream.',
    },
    {
      key: 'max_failures',
      label: 'Disarm after N failures',
      type: 'number',
      default: 5,
      hint: 'Consecutive failed runs before the timer disarms itself, so a broken flow does not tick forever.',
    },
  ],

  validate(node) {
    const seconds = num(node.config?.interval_seconds, 30);
    return seconds < MIN_INTERVAL_SECONDS ? [`the timer interval must be at least ${MIN_INTERVAL_SECONDS} seconds`] : [];
  },

  async run(ctx, _inputs, config) {
    if (config.auto_start !== false) {
      // Arming here (rather than at run start) means "run once to see" is also "go live" — but only
      // once the graph has actually reached the trigger, so a flow that fails validation never arms.
      void flowTimerScheduler
        .arm(ctx.flowId, { persist: true })
        .catch((err) => log.error({ err, flowId: ctx.flowId }, 'failed to arm the flow timer'));
    }
    return SIGNAL;
  },
};

export const MIN_INTERVAL_SECONDS = 5;

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function even(n: number): number {
  const rounded = Math.round(n);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}
