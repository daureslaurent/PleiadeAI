import { createLogger } from '../../config/logger';
import {
  concatVideos,
  ffmpegAvailable,
  muxAudio,
  stillToVideo,
  type DurationPolicy,
  type MediaInput,
} from '../../media/ffmpeg.service';
import { asHandles, handleValue, type FlowValue } from '../port-types';
import type { FlowNodeContext, FlowNodeHandler } from '../types';

const log = createLogger('flow:compose');

/**
 * `video_compose` — the assembly step (flows spec §3).
 *
 * Generative nodes produce *pieces*: a shot, a narration track, a still. Turning those into a
 * finished video is ordinary CPU work — concatenating, muxing, holding a frame — and it runs on
 * ffmpeg in the backend rather than through ComfyUI, which would spend GPU time on a job that needs
 * none. Handles in, one handle out, like every other node: no file paths cross the graph.
 */
export const videoComposeNode: FlowNodeHandler = {
  type: 'video_compose',
  label: 'Compose Video',
  group: 'media',
  description:
    'Assembles finished video with ffmpeg: join clips, put narration onto a clip, or turn a still into a clip.',
  inputs: [
    {
      name: 'video',
      types: ['video', 'file'],
      description: 'Clip(s). A Collect output carries every iteration, which `concat` joins in order.',
    },
    { name: 'audio', types: ['audio', 'file'], description: 'Narration or music to lay over the video.' },
    { name: 'image', types: ['image'], description: 'For `still`: the picture to hold.' },
    { name: 'run', types: ['signal'] },
  ],
  outputs: [
    { name: 'default', types: ['video'] },
    { name: 'done', types: ['signal'] },
  ],
  config: [
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      options: ['concat', 'mux', 'still'],
      default: 'concat',
      hint:
        'concat: join every clip on the video input into one. ' +
        'mux: lay the audio over the video (one shot). ' +
        'still: hold the image for the length of the audio.',
    },
    {
      key: 'duration_policy',
      label: 'When lengths differ',
      type: 'select',
      options: ['audio', 'video', 'shortest'],
      default: 'audio',
      hint:
        '`mux` only. "audio" holds the last frame until the narration ends — the narration is usually the thing that must not be cut. "video" trims the audio instead.',
    },
    {
      key: 'seconds',
      label: 'Duration (s)',
      type: 'number',
      default: 5,
      hint: '`still` only, and only when no audio is wired — otherwise the narration sets the length.',
    },
    {
      key: 'fps',
      label: 'FPS',
      type: 'number',
      default: 25,
      hint: 'Output frame rate. For `concat`, leave 0 to inherit the first clip\'s.',
    },
    {
      key: 'zoom',
      label: 'Ken Burns zoom',
      type: 'boolean',
      default: false,
      hint: '`still` only: drift a slow zoom across the image so it does not read as a frozen frame.',
    },
    {
      key: 'size',
      label: 'Size',
      type: 'select',
      options: ['auto', '1920x1080', '1280x720', '1080x1920', '720x1280', '1024x1024'],
      default: 'auto',
      hint: '`concat` only. "auto" adopts the first clip\'s geometry; every other clip is fitted and padded to it.',
    },
  ],

  validate(node) {
    const mode = String(node.config.mode ?? 'concat');
    if (!['concat', 'mux', 'still'].includes(mode)) return [`unknown mode "${mode}"`];
    return [];
  },

  async run(ctx, inputs, config) {
    if (!(await ffmpegAvailable())) {
      throw new Error(
        'ffmpeg is not available in the backend container — rebuild the backend image (it is installed in the Dockerfile)',
      );
    }

    const mode = String(config.mode ?? 'concat');
    const fps = Math.trunc(Number(config.fps)) || undefined;

    if (mode === 'mux') {
      const video = await single(ctx, inputs.video, 'video');
      const audio = await single(ctx, inputs.audio, 'audio');
      const bytes = await muxAudio(video, audio, policyOf(config.duration_policy));
      return store(ctx, bytes, 'shot.mp4');
    }

    if (mode === 'still') {
      const image = await single(ctx, inputs.image, 'image');
      const audio = inputs.audio ? await single(ctx, inputs.audio, 'audio') : null;
      const bytes = await stillToVideo(image, audio, {
        seconds: Number(config.seconds) || 5,
        fps,
        zoom: Boolean(config.zoom),
      });
      return store(ctx, bytes, 'still.mp4');
    }

    // concat — the whole point of the Collect output, which carries every iteration's handle in order.
    const handles = asHandles(inputs.video);
    if (handles.length === 0) throw new Error('no clips are wired into the video input');
    const clips: MediaInput[] = [];
    for (const handle of handles) clips.push(await load(ctx, handle));

    const { width, height } = parseSize(config.size);
    log.info({ runId: ctx.runId, clips: clips.length }, 'composing final video');
    const bytes = await concatVideos(clips, { width, height, fps });
    return store(ctx, bytes, 'video.mp4');
  },
};

function policyOf(value: unknown): DurationPolicy {
  const v = String(value ?? 'audio');
  return v === 'video' || v === 'shortest' ? v : 'audio';
}

function parseSize(value: unknown): { width?: number; height?: number } {
  const m = /^(\d+)x(\d+)$/i.exec(String(value ?? '').trim());
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
}

/** Read exactly one handle off a port, with an error that says which port is empty. */
async function single(ctx: FlowNodeContext, value: FlowValue | undefined, port: string): Promise<MediaInput> {
  const handles = asHandles(value);
  if (handles.length === 0) throw new Error(`nothing is wired into the ${port} input`);
  return load(ctx, handles[0]!);
}

async function load(ctx: FlowNodeContext, handle: string): Promise<MediaInput> {
  const res = await ctx.readResource(handle);
  if (!res) throw new Error(`resource "${handle}" not found in this run`);
  return { bytes: res.bytes, filename: res.filename || `${handle}.bin` };
}

async function store(ctx: FlowNodeContext, bytes: Buffer, filename: string): Promise<Record<string, FlowValue>> {
  const handle = await ctx.storeResource({ bytes, kind: 'blob', mime: 'video/mp4', filename });
  ctx.emitOutput(`produced ${handle} (${(bytes.length / (1024 * 1024)).toFixed(1)} MB)\n`);
  return { default: handleValue('video', [handle]), done: { type: 'signal' } };
}
