import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../config/logger';

const log = createLogger('ffmpeg');

/** Ceiling on any single ffmpeg invocation. A stitch of a dozen clips is seconds, not minutes. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export interface MediaInput {
  bytes: Buffer;
  /** Only the extension matters to ffmpeg's demuxer probing; the name itself is irrelevant. */
  filename: string;
}

/** What `ffprobe` tells us about one file — enough to normalise it before concatenating. */
export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

function run(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new FfmpegError(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      // ffmpeg is famously chatty on stderr even when healthy; keep only the tail for diagnostics.
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`ffmpeg could not be started: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new FfmpegError(`ffmpeg exited ${code}: ${lastMeaningfulLine(stderr)}`));
    });
  });
}

/** ffmpeg's real error is usually the last non-progress line; the rest is banner and stream info. */
function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('frame=') && !l.startsWith('size=') && !l.startsWith('  '));
  return lines[lines.length - 1] ?? stderr.slice(-200);
}

/** Inspect a media file. Never throws for a missing stream — the caller decides what is acceptable. */
export async function probe(file: string): Promise<ProbeResult> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (err) => reject(new FfmpegError(`ffprobe could not be started: ${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new FfmpegError(`ffprobe failed: ${stderr.slice(-200)}`)),
    );
  });

  const parsed = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }[];
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  return {
    durationSec: Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0) || 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseFps(video?.r_frame_rate),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}

/** `30000/1001` → 29.97. Defaults to 24 when absent or malformed. */
function parseFps(raw: string | undefined): number {
  if (!raw) return 24;
  const [num, den] = raw.split('/').map(Number);
  if (!num || !den) return Number(raw) || 24;
  return num / den;
}

/** Scratch directory for one operation, always cleaned up. */
async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pleiades-ffmpeg-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeInputs(dir: string, inputs: MediaInput[]): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const ext = path.extname(inputs[i]!.filename) || '.bin';
    const file = path.join(dir, `in_${i}${ext}`);
    await writeFile(file, inputs[i]!.bytes);
    paths.push(file);
  }
  return paths;
}

/**
 * Join clips end to end into one video.
 *
 * Everything is re-encoded to a single geometry and frame rate rather than stream-copied. Clips from
 * a generative pipeline are not reliably uniform — a different resolution, frame rate, or a missing
 * audio track on one clip makes `-c copy` produce a file that plays until the first mismatch and
 * then falls apart. Silent clips get a generated silent track for the same reason: the concat filter
 * demands the same stream layout from every input.
 */
export async function concatVideos(
  inputs: MediaInput[],
  opts: { width?: number; height?: number; fps?: number } = {},
): Promise<Buffer> {
  if (inputs.length === 0) throw new FfmpegError('nothing to concatenate');

  return withWorkspace(async (dir) => {
    const files = await writeInputs(dir, inputs);
    const probes = await Promise.all(files.map(probe));

    const missing = probes.findIndex((p) => !p.hasVideo);
    if (missing >= 0) throw new FfmpegError(`input ${missing + 1} has no video stream`);

    // The first clip sets the geometry unless the caller pinned one; everything else is scaled to
    // fit inside it and padded, so nothing is cropped and nothing is stretched.
    const width = even(opts.width ?? probes[0]!.width);
    const height = even(opts.height ?? probes[0]!.height);
    const fps = Math.round(opts.fps ?? probes[0]!.fps) || 24;
    if (!width || !height) throw new FfmpegError('could not determine the output size');

    const args: string[] = ['-y'];
    for (const file of files) args.push('-i', file);
    // One silent source to borrow from for clips that have no audio of their own.
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    const silentIndex = files.length;

    const filters: string[] = [];
    const concatInputs: string[] = [];
    probes.forEach((p, i) => {
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`,
      );
      if (p.hasAudio) filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
      else filters.push(`[${silentIndex}:a]atrim=duration=${Math.max(0.04, p.durationSec)},asetpts=PTS-STARTPTS[a${i}]`);
      concatInputs.push(`[v${i}][a${i}]`);
    });
    filters.push(`${concatInputs.join('')}concat=n=${files.length}:v=1:a=1[outv][outa]`);

    const out = path.join(dir, 'out.mp4');
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      out,
    );

    log.info({ clips: files.length, width, height, fps }, 'concatenating clips');
    await run(args);
    return readFile(out);
  });
}

/** What to do when the narration and the picture are not the same length. */
export type DurationPolicy = 'audio' | 'video' | 'shortest';

/**
 * Put an audio track onto a video.
 *
 * The default policy is `audio`: the narration is the thing that must not be cut off, so a video
 * shorter than its narration holds its last frame until the voice finishes. That is almost always
 * what you want for a narrated shot, and it is the case a plain `-shortest` silently gets wrong.
 */
export async function muxAudio(
  video: MediaInput,
  audio: MediaInput,
  policy: DurationPolicy = 'audio',
): Promise<Buffer> {
  return withWorkspace(async (dir) => {
    const [videoPath, audioPath] = await writeInputs(dir, [video, audio]);
    const [vp, ap] = await Promise.all([probe(videoPath!), probe(audioPath!)]);
    if (!vp.hasVideo) throw new FfmpegError('the video input has no video stream');
    if (!ap.hasAudio) throw new FfmpegError('the audio input has no audio stream');

    const out = path.join(dir, 'out.mp4');
    const args = ['-y', '-i', videoPath!, '-i', audioPath!];

    const deficit = ap.durationSec - vp.durationSec;
    if (policy === 'audio' && deficit > 0.05) {
      // Hold the final frame for the remainder rather than looping, which reads as a glitch.
      args.push(
        '-filter_complex',
        `[0:v]tpad=stop_mode=clone:stop_duration=${deficit.toFixed(3)}[v]`,
        '-map', '[v]', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      );
    } else {
      args.push('-map', '0:v', '-map', '1:a', '-c:v', 'copy');
      if (policy !== 'audio') args.push('-shortest');
    }
    args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out);

    log.info(
      { videoSec: vp.durationSec.toFixed(2), audioSec: ap.durationSec.toFixed(2), policy },
      'muxing audio onto video',
    );
    await run(args);
    return readFile(out);
  });
}

/**
 * Turn a still image into a clip that lasts as long as its narration — the cheap alternative to a
 * generated video, and the fallback when a video model is unavailable or too slow.
 */
export async function stillToVideo(
  image: MediaInput,
  audio: MediaInput | null,
  opts: { seconds?: number; fps?: number; zoom?: boolean } = {},
): Promise<Buffer> {
  return withWorkspace(async (dir) => {
    const files = await writeInputs(dir, audio ? [image, audio] : [image]);
    const fps = Math.round(opts.fps ?? 25) || 25;
    let seconds = opts.seconds ?? 5;
    if (audio) {
      const ap = await probe(files[1]!);
      if (ap.durationSec > 0) seconds = ap.durationSec;
    }

    const out = path.join(dir, 'out.mp4');
    const args = ['-y', '-loop', '1', '-i', files[0]!];
    if (audio) args.push('-i', files[1]!);

    // Even dimensions are required by yuv420p; a generated image is usually fine but not always.
    const frames = Math.max(1, Math.round(seconds * fps));
    const vf = opts.zoom
      ? `scale=8000:-1,zoompan=z='min(zoom+0.0008,1.12)':d=${frames}:s=1280x720:fps=${fps},` +
        `scale=trunc(iw/2)*2:trunc(ih/2)*2`
      : `scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${fps}`;

    args.push(
      '-vf', vf,
      '-t', seconds.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    );
    if (audio) args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest');
    args.push('-movflags', '+faststart', out);

    log.info({ seconds: seconds.toFixed(2), fps, zoom: Boolean(opts.zoom) }, 'building a clip from a still');
    await run(args);
    return readFile(out);
  });
}

/**
 * Lay a bed of music under a voice.
 *
 * `duck` is what makes this usable rather than a mush: the music is attenuated whenever the voice is
 * speaking (ffmpeg's `sidechaincompress`) and comes back up between lines. Without it a score mixed
 * loud enough to hear swallows the narration, and one quiet enough to stay out of the way is
 * inaudible. The bed is looped or trimmed to the voice, since the voice is the thing with meaning.
 */
export async function mixAudio(
  voice: MediaInput,
  music: MediaInput,
  opts: { musicGainDb?: number; duck?: boolean } = {},
): Promise<Buffer> {
  return withWorkspace(async (dir) => {
    const [voicePath, musicPath] = await writeInputs(dir, [voice, music]);
    const vp = await probe(voicePath!);
    if (!vp.hasAudio) throw new FfmpegError('the voice input has no audio stream');

    const gain = Number.isFinite(opts.musicGainDb) ? (opts.musicGainDb as number) : -14;
    const duck = opts.duck !== false;
    const out = path.join(dir, 'out.m4a');

    // The bed loops so a short cue can underlay a long line, then is cut to the voice's length.
    const bed =
      `[1:a]aloop=loop=-1:size=2e9,atrim=duration=${Math.max(0.1, vp.durationSec).toFixed(3)},` +
      `volume=${gain}dB,aresample=48000,aformat=channel_layouts=stereo[bed]`;

    // Measured on this build: these values duck the bed by ~6dB under speech and let it recover in
    // the gaps, which is the broadcast norm. The defaults (threshold 0.125, ratio 2) manage under
    // 2dB — technically ducking, inaudibly so. `ratio` saturates past 20, so depth comes from the
    // low threshold and the sidechain gain rather than from pushing it further.
    const filter = duck
      ? `[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[v1][v2];${bed};` +
        `[bed][v2]sidechaincompress=threshold=0.015:ratio=20:attack=5:release=250:level_sc=4[ducked];` +
        `[v1][ducked]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[out]`
      : `[0:a]aresample=48000,aformat=channel_layouts=stereo[v1];${bed};` +
        `[v1][bed]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[out]`;

    log.info({ voiceSec: vp.durationSec.toFixed(2), gain, duck }, 'mixing narration with music');
    await run([
      '-y', '-i', voicePath!, '-i', musicPath!,
      '-filter_complex', filter,
      '-map', '[out]',
      '-c:a', 'aac', '-b:a', '192k',
      out,
    ]);
    return readFile(out);
  });
}

export interface VideoMixOptions {
  /** Level of the clip's own audio. `null` mutes it entirely. */
  originalGainDb: number | null;
  /** Level of the added track. */
  addedGainDb: number;
  /** Pull the added track down while the clip's own audio is loud (music under dialogue). */
  duck: boolean;
  /** Loop a short added track to cover the clip, rather than letting it end early. */
  loop: boolean;
}

/**
 * Mix an audio track into a video, keeping the picture untouched.
 *
 * Distinct from `muxAudio`, which *replaces* the audio outright. Here both survive: a clip that
 * already speaks keeps its voice while music is laid underneath at its own level, optionally ducked.
 * The video stream is stream-copied — the picture is not being changed, and re-encoding it would cost
 * minutes and a generation of quality for nothing.
 */
export async function mixVideoAudio(
  video: MediaInput,
  audio: MediaInput,
  opts: VideoMixOptions,
): Promise<Buffer> {
  return withWorkspace(async (dir) => {
    const [videoPath, audioPath] = await writeInputs(dir, [video, audio]);
    const vp = await probe(videoPath!);
    if (!vp.hasVideo) throw new FfmpegError('the video input has no video stream');

    const keepOriginal = opts.originalGainDb !== null && vp.hasAudio;
    const duration = Math.max(0.1, vp.durationSec);
    const out = path.join(dir, 'out.mp4');

    // The added track is trimmed (or looped then trimmed) to the picture: a soundtrack outlasting the
    // clip would otherwise extend the file with a black tail.
    const added =
      `[1:a]${opts.loop ? 'aloop=loop=-1:size=2e9,' : ''}atrim=duration=${duration.toFixed(3)},` +
      `asetpts=PTS-STARTPTS,volume=${opts.addedGainDb}dB,aresample=48000,` +
      `aformat=channel_layouts=stereo[add]`;

    let filter: string;
    if (!keepOriginal) {
      filter = `${added};[add]alimiter=limit=0.95[out]`;
    } else if (opts.duck) {
      filter =
        `[0:a]volume=${opts.originalGainDb}dB,aresample=48000,aformat=channel_layouts=stereo,asplit=2[o1][o2];` +
        `${added};` +
        `[add][o2]sidechaincompress=threshold=0.015:ratio=20:attack=5:release=250:level_sc=4[ducked];` +
        `[o1][ducked]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[out]`;
    } else {
      filter =
        `[0:a]volume=${opts.originalGainDb}dB,aresample=48000,aformat=channel_layouts=stereo[o1];` +
        `${added};` +
        `[o1][add]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[out]`;
    }

    log.info(
      { seconds: duration.toFixed(2), keepOriginal, duck: opts.duck, addedGainDb: opts.addedGainDb },
      'mixing audio into video',
    );
    await run([
      '-y', '-i', videoPath!, '-i', audioPath!,
      '-filter_complex', filter,
      '-map', '0:v', '-map', '[out]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      out,
    ]);
    return readFile(out);
  });
}

/** yuv420p needs even dimensions; an odd one makes libx264 refuse the whole job. */
function even(n: number): number {
  return Math.floor(n / 2) * 2;
}

/** Whether ffmpeg is present, so a node can fail with an operator-readable message. */
export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await run(['-version'], 5000);
    return true;
  } catch {
    return false;
  }
}
