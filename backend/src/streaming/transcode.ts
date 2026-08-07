import { spawn } from 'node:child_process';
import { createLogger } from '../config/logger';
import { probe } from '../media/ffmpeg.service';
import type { StreamProfile } from './types';

const log = createLogger('stream:transcode');

/** A clip render is minutes of GPU time; normalising it should never be more than a fraction of that. */
const NORMALISE_TIMEOUT_MS = 5 * 60_000;
/** A stream-copy remux of an already-normalised clip. Seconds, or something is wrong. */
const REMUX_TIMEOUT_MS = 60_000;

export class TranscodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscodeError';
  }
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new TranscodeError(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new TranscodeError(`ffmpeg could not be started: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new TranscodeError(`ffmpeg exited ${code}: ${stderr.split('\n').filter(Boolean).pop() ?? ''}`));
    });
  });
}

/**
 * Bring one arbitrary clip to the stream's canonical format.
 *
 * Everything is re-encoded, never stream-copied: clips arrive from different ComfyUI workflows with
 * different resolutions, frame rates and sometimes no audio at all, and a flux assembled from
 * mismatched parts plays until the first mismatch and then falls apart. The keyframe interval is
 * pinned to one second so `-movflags frag_keyframe` downstream can cut a fragment every second —
 * that interval is also how long a new listener waits before their first frame.
 *
 * A video stream fed an audio-only clip still gets pictures (a black canvas), and vice versa a
 * silent clip gets a silent track, because the playout muxer needs the same stream layout from every
 * clip for the whole run of the stream.
 */
export async function normaliseClip(input: string, output: string, profile: StreamProfile): Promise<number> {
  const info = await probe(input).catch(() => null);
  if (!info) throw new TranscodeError('the clip could not be probed — it is not media ffmpeg understands');
  if (!info.hasAudio && !info.hasVideo) throw new TranscodeError('the clip has neither an audio nor a video stream');

  const wantsVideo = profile.kind === 'video';
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];

  // A still image has no duration of its own; give it the length of its soundtrack, or a default.
  const isStill = info.hasVideo && info.durationSec <= 0;
  if (isStill) args.push('-loop', '1', '-t', String(Math.max(info.durationSec, 4)));
  args.push('-i', input);

  // Synthetic sources fill in whichever half the clip is missing.
  if (wantsVideo && !info.hasVideo) {
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${profile.width}x${profile.height}:r=${profile.fps}`);
  }
  if (!info.hasAudio) {
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=${profile.channels === 1 ? 'mono' : 'stereo'}:sample_rate=${profile.sampleRate}`);
  }

  const audioSource = info.hasAudio ? '0:a:0' : wantsVideo && !info.hasVideo ? '2:a:0' : '1:a:0';
  const gop = Math.max(1, Math.round(profile.fps));

  if (wantsVideo) {
    const videoSource = info.hasVideo ? '0:v:0' : '1:v:0';
    args.push(
      '-filter_complex',
      `[${videoSource}]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,` +
        `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${profile.fps}[v]`,
      '-map', '[v]',
      '-map', audioSource,
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '3.1',
      '-pix_fmt', 'yuv420p', '-b:v', profile.videoBitrate,
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    );
  } else {
    args.push('-map', audioSource, '-vn');
  }

  args.push(
    '-c:a', 'aac', '-profile:a', 'aac_low',
    '-ar', String(profile.sampleRate), '-ac', String(profile.channels), '-b:a', profile.audioBitrate,
    // Stop at the shortest input so a synthetic black/silent source can't run forever.
    '-shortest',
    '-movflags', '+faststart',
    output,
  );

  log.debug({ input, kind: profile.kind }, 'normalising clip for the stream');
  await runFfmpeg(args, NORMALISE_TIMEOUT_MS);

  const out = await probe(output).catch(() => null);
  const duration = out?.durationSec ?? 0;
  if (duration <= 0) throw new TranscodeError('the normalised clip has no duration');
  return duration;
}

/**
 * Remux one normalised clip to MPEG-TS, shifted onto the stream's running timeline.
 *
 * This is the trick that makes a queue of separately-rendered clips into a single continuous input:
 * every normalised clip starts at timestamp zero, so the pump hands each one an `-output_ts_offset`
 * equal to the seconds already aired. The result concatenates byte-wise into one monotonic TS
 * stream, which is exactly what the playout muxer can swallow with `-c copy`. Re-airing a clip on
 * underrun is the same call with a later offset, so looping costs no encoding.
 */
export async function remuxToTimeline(input: string, output: string, offsetSec: number): Promise<void> {
  await runFfmpeg(
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-c', 'copy',
      '-muxdelay', '0', '-muxpreload', '0',
      '-output_ts_offset', offsetSec.toFixed(6),
      '-f', 'mpegts',
      output,
    ],
    REMUX_TIMEOUT_MS,
  );
}
