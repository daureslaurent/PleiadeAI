import { createLogger } from '../../config/logger';
import { ffmpegAvailable, mixAudio, type MediaInput } from '../../media/ffmpeg.service';
import { asHandles, handleValue, type FlowValue } from '../port-types';
import type { FlowNodeContext, FlowNodeHandler } from '../types';

const log = createLogger('flow:audio-mix');

/**
 * `audio_mix` — lay a music bed under a narration (flows spec §3).
 *
 * The two audio sources in a narrated film come from different models: a TTS workflow speaks the
 * line, a music model scores the mood. Playing both at full level buries the voice, so the bed is
 * attenuated and — by default — *ducked*: pulled down while the voice is speaking and allowed back
 * up between lines. That is the difference between a soundtrack and a mess, and it is why this is a
 * node rather than something the operator is expected to arrange downstream.
 */
export const audioMixNode: FlowNodeHandler = {
  type: 'audio_mix',
  label: 'Mix Audio',
  group: 'media',
  description: 'Lays a music bed under a narration, ducking the music while the voice speaks.',
  inputs: [
    { name: 'voice', types: ['audio', 'file'], required: true, description: 'The narration — sets the length.' },
    { name: 'music', types: ['audio', 'file'], description: 'The bed. Looped or trimmed to the voice.' },
    { name: 'run', types: ['signal'] },
  ],
  outputs: [
    { name: 'default', types: ['audio'] },
    { name: 'done', types: ['signal'] },
  ],
  config: [
    {
      key: 'music_gain_db',
      label: 'Music level (dB)',
      type: 'number',
      default: -14,
      hint: 'Relative to the narration. Negative is quieter; -14 is a typical bed under speech.',
    },
    {
      key: 'duck',
      label: 'Duck under the voice',
      type: 'boolean',
      default: true,
      hint: 'Pull the music down while the voice speaks and let it back up between lines.',
    },
  ],

  async run(ctx, inputs, config) {
    if (!(await ffmpegAvailable())) {
      throw new Error('ffmpeg is not available in the backend container — rebuild the backend image');
    }

    const voice = await load(ctx, inputs.voice, 'voice');
    // No music wired is not a failure: the narration alone is a perfectly good track, and this keeps
    // the same graph working before a music workflow is selected.
    const musicHandles = asHandles(inputs.music);
    if (musicHandles.length === 0) {
      ctx.emitOutput('no music wired — passing the narration through unchanged\n');
      return { default: handleValue('audio', asHandles(inputs.voice)), done: { type: 'signal' } };
    }

    const music = await load(ctx, inputs.music, 'music');
    const gain = Number(config.music_gain_db);
    const bytes = await mixAudio(voice, music, {
      musicGainDb: Number.isFinite(gain) ? gain : -14,
      duck: config.duck !== false,
    });

    const handle = await ctx.storeResource({
      bytes,
      kind: 'blob',
      mime: 'audio/mp4',
      filename: 'mixed.m4a',
    });
    log.info({ runId: ctx.runId, handle, size: bytes.length }, 'audio mixed');
    ctx.emitOutput(`produced ${handle} (${(bytes.length / 1024).toFixed(0)} KB)\n`);
    return { default: handleValue('audio', [handle]), done: { type: 'signal' } };
  },
};

async function load(ctx: FlowNodeContext, value: FlowValue | undefined, port: string): Promise<MediaInput> {
  const handles = asHandles(value);
  if (handles.length === 0) throw new Error(`nothing is wired into the ${port} input`);
  const res = await ctx.readResource(handles[0]!);
  if (!res) throw new Error(`resource "${handles[0]}" not found in this run`);
  return { bytes: res.bytes, filename: res.filename || `${handles[0]}.wav` };
}
