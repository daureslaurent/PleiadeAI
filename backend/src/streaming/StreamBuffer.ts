import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../config/logger';
import { Fmp4Splitter } from './fmp4';
import { normaliseClip, remuxToTimeline } from './transcode';
import { mimeFor, type ClipInfo, type StreamInfo, type StreamProfile } from './types';

const log = createLogger('stream:buffer');

/** How many aired clips the info endpoint remembers, for the player's history strip. */
const HISTORY_LIMIT = 40;
/** Backoff before respawning a playout muxer that died, so a broken profile can't spin the CPU. */
const RESPAWN_DELAY_MS = 1000;
/**
 * How far ahead of real time the pump is allowed to push material into the muxer.
 *
 * Writing a clip into ffmpeg's stdin is *not* the same as airing it: a few seconds of AAC fits
 * entirely in the pipe buffer, so the write returns at once and `-re` alone never applies
 * backpressure. Without this the pump would treat "written" as "aired" and, on an empty queue, re-air
 * the last clip hundreds of times a second. Keeping a small lead means the muxer always has
 * something to chew on while the pump sleeps.
 */
const LEAD_MS = 4000;

/** Where fanout bytes go. Implemented by the HTTP response in `streams.routes.ts`. */
export interface StreamSink {
  write(chunk: Buffer): void;
  /** Called when the stream itself is torn down, so the response can be ended. */
  close(): void;
}

interface QueuedClip {
  info: ClipInfo;
  /** The normalised mp4 on disk. */
  file: string;
}

interface Subscriber {
  sink: StreamSink;
  /** False until the current muxer's init segment has been written to this sink. */
  initSent: boolean;
}

/**
 * One live stream: a clip queue, a persistent muxer, and a fanout (STREAMING_PLAN.md §3).
 *
 * The three stages exist because generation is bursty and playback is not. Clips land whenever a
 * flow run finishes — every twenty seconds, or every four minutes — while the flux has to keep
 * producing bytes at exactly real time. `-re` on the muxer's input is what enforces that: the pump
 * writes a clip's bytes as fast as ffmpeg will accept them, and ffmpeg accepts them at native rate,
 * so the pipe's own backpressure paces the whole chain with no timers of our own.
 */
export class StreamBuffer {
  readonly flowId: string;
  flowName: string;
  readonly profile: StreamProfile;
  readonly startedAt = new Date();

  private dir = '';
  private ready: Promise<void>;

  private readonly queue: QueuedClip[] = [];
  private lastAired: QueuedClip | null = null;
  private history: ClipInfo[] = [];
  private totalClips = 0;
  /** Seconds of material already handed to the muxer — the offset the next clip is shifted onto. */
  private timelineSec = 0;
  private starved = false;
  private pumping = false;
  /** Wall-clock ms at which the material already written to the muxer runs out. */
  private airDeadline = 0;
  /** The pacing sleep in flight, cleared on stop so teardown isn't held up by it. */
  private paceTimer: NodeJS.Timeout | null = null;
  /** Releases the pacing sleep early (teardown), so the pump doesn't hold the process open. */
  private paceWake: (() => void) | null = null;
  /** Resolves the pump's wait when a clip arrives or the stream stops. */
  private wake: (() => void) | null = null;

  private playout: ChildProcessWithoutNullStreams | null = null;
  private splitter: Fmp4Splitter | null = null;
  private init: Buffer | null = null;
  private readonly subscribers = new Set<Subscriber>();

  private stopped = false;
  private lastClipAt = Date.now();
  private lastListenerAt = Date.now();

  constructor(flowId: string, flowName: string, profile: StreamProfile) {
    this.flowId = flowId;
    this.flowName = flowName;
    this.profile = profile;
    this.ready = this.prepare();
  }

  private async prepare(): Promise<void> {
    this.dir = await mkdtemp(path.join(tmpdir(), 'pleiades-stream-'));
  }

  // ---------------------------------------------------------------- ingest

  /**
   * Add a clip to the stream. Returns once the clip is normalised and queued — not once it has
   * aired, which may be minutes later.
   */
  async push(input: { bytes: Buffer; filename: string; title: string }): Promise<ClipInfo> {
    if (this.stopped) throw new Error('the stream has been stopped');
    await this.ready;

    const id = randomUUID().slice(0, 8);
    const source = path.join(this.dir, `src_${id}${path.extname(input.filename) || '.bin'}`);
    const normalised = path.join(this.dir, `clip_${id}.mp4`);
    await writeFile(source, input.bytes);

    try {
      const durationSec = await normaliseClip(source, normalised, this.profile);
      const info: ClipInfo = {
        id,
        title: input.title,
        durationSec,
        queuedAt: new Date().toISOString(),
        replays: 0,
      };
      this.queue.push({ info, file: normalised });
      this.totalClips += 1;
      this.lastClipAt = Date.now();
      this.trimQueue();
      log.info({ flow: this.flowName, clip: id, durationSec, queued: this.queue.length }, 'clip queued');
      this.kick();
      return info;
    } finally {
      await rm(source, { force: true }).catch(() => undefined);
    }
  }

  /** Drop the oldest un-aired clips when the queue outgrows its cap — a stream is live, not a spool. */
  private trimQueue(): void {
    while (this.queue.length > this.profile.maxQueued) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      log.warn({ flow: this.flowName, clip: dropped.info.id }, 'queue full — dropping the oldest clip');
      void rm(dropped.file, { force: true }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- playout

  private kick(): void {
    this.wake?.();
    if (!this.pumping) void this.pump();
  }

  private waitForClip(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopped) {
        // Looping the last clip is for keeping a *listener's* flux alive; with nobody connected the
        // stream sleeps instead, so an unattended radio doesn't re-mux the same clip all night.
        const replayable = this.profile.underrun === 'loop' && this.subscribers.size > 0;
        const next = this.queue.shift() ?? (replayable ? this.lastAired : null);
        if (!next) {
          this.starved = this.lastAired !== null;
          await this.waitForClip();
          continue;
        }

        const isReplay = next === this.lastAired;
        this.starved = isReplay;
        await this.air(next, isReplay).catch((err) => {
          log.error({ err, flow: this.flowName, clip: next.info.id }, 'failed to air a clip');
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Hold the pump back until the muxer has nearly run out of material.
   *
   * A gap — nobody listening, nothing rendered — makes the deadline fall into the past; it is reset
   * to now rather than carried, so the queue that piles up during a quiet spell is aired at playback
   * speed afterwards instead of being flushed in one burst.
   */
  private async pace(durationSec: number): Promise<void> {
    const now = Date.now();
    if (this.airDeadline < now) this.airDeadline = now;
    const wait = this.airDeadline - now - LEAD_MS;
    this.airDeadline += durationSec * 1000;
    if (wait <= 0) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        this.paceTimer = null;
        this.paceWake = null;
        resolve();
      };
      this.paceWake = finish;
      this.paceTimer = setTimeout(finish, wait);
    });
  }

  /** Shift one clip onto the running timeline and write it into the muxer. */
  private async air(clip: QueuedClip, isReplay: boolean): Promise<void> {
    await this.pace(clip.info.durationSec);
    if (this.stopped) return;
    await this.ensurePlayout();

    // Mark the clip on air *here*, not in the pump: the write below occupies the clip's whole
    // duration, so recording it afterwards would leave `nowPlaying` a clip behind for two minutes,
    // and recording it before `pace` would announce it while its predecessor was still playing.
    if (isReplay) clip.info.replays += 1;
    else {
      clip.info.airedAt = new Date().toISOString();
      this.history = [clip.info, ...this.history].slice(0, HISTORY_LIMIT);
    }
    this.lastAired = clip;

    const ts = path.join(this.dir, `air_${clip.info.id}_${this.timelineSec.toFixed(0)}.ts`);
    try {
      await remuxToTimeline(clip.file, ts, this.timelineSec);
      this.timelineSec += clip.info.durationSec;
      await this.writeToPlayout(ts);
    } finally {
      await rm(ts, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Stream one TS file into the muxer's stdin, honouring backpressure. The await here is where the
   * stream spends nearly all of its life: `-re` makes ffmpeg drain the pipe at playback speed, so
   * this resolves roughly when the clip has finished airing.
   */
  private writeToPlayout(file: string): Promise<void> {
    const child = this.playout;
    if (!child) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const reader = createReadStream(file);
      const done = (err?: Error) => {
        reader.removeAllListeners();
        child.stdin.off('error', onStdinError);
        if (err) reject(err);
        else resolve();
      };
      const onStdinError = (err: Error) => done(err);
      child.stdin.on('error', onStdinError);
      reader.on('error', done);
      reader.on('end', () => done());
      // `end: false` is the crux: closing stdin would end the flux at the first clip.
      reader.pipe(child.stdin, { end: false });
    });
  }

  private async ensurePlayout(): Promise<void> {
    if (this.playout || this.stopped) return;

    const args = [
      '-hide_banner', '-loglevel', 'error',
      // Read the concatenated clips at native rate — this is what makes the output a *live* flux
      // rather than a file dumped down the socket as fast as the client will take it.
      '-re',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-c', 'copy',
      // AAC travels through MPEG-TS as ADTS frames, which MP4 will not accept: without this filter
      // the muxer refuses the very first packet ("Error submitting a packet to the muxer").
      '-bsf:a', 'aac_adtstoasc',
      '-f', 'mp4',
      // An fMP4 the browser's MediaSource can consume: a header with no sample table, fragments cut
      // at keyframes (~1s, matching the ingest GOP) so a late joiner starts decoding immediately.
      // NOTE: deliberately *without* `omit_tfhd_offset` — paired with `default_base_moof` it made
      // Chromium's ChunkDemuxer reject every fragment (CHUNK_DEMUXER_ERROR_APPEND_FAILED /
      // RunSegmentParserLoop) despite ffprobe reading the output as well-formed; `default_base_moof`
      // alone is the well-supported combo and is all MSE actually requires.
      '-movflags', 'empty_moov+frag_keyframe+default_base_moof',
      '-frag_duration', '1000000',
      'pipe:1',
    ];

    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.playout = child;
    this.init = null;
    for (const sub of this.subscribers) sub.initSent = false;

    this.splitter = new Fmp4Splitter({
      onInit: (segment) => {
        this.init = segment;
        for (const sub of this.subscribers) this.sendInit(sub);
      },
      onFragment: (fragment) => {
        for (const sub of this.subscribers) {
          if (sub.initSent) this.safeWrite(sub, fragment);
        }
      },
    });

    child.stdout.on('data', (chunk: Buffer) => this.splitter?.push(chunk));
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    child.on('error', (err) => log.error({ err, flow: this.flowName }, 'the playout muxer could not be started'));
    child.on('close', (code) => {
      if (this.playout === child) this.playout = null;
      if (this.stopped) return;
      log.warn({ flow: this.flowName, code, stderr: stderr.slice(-400) }, 'the playout muxer exited — respawning');
      // Respawning re-emits an init segment, which every subscriber is re-sent before its next
      // fragment; a fresh init with identical codecs is something MediaSource accepts mid-stream.
      setTimeout(() => {
        if (!this.stopped) void this.ensurePlayout().catch(() => undefined);
      }, RESPAWN_DELAY_MS);
    });

    log.info({ flow: this.flowName, kind: this.profile.kind }, 'playout muxer started');
  }

  // ---------------------------------------------------------------- fanout

  /** Attach a listener. Returns the unsubscribe. */
  subscribe(sink: StreamSink): () => void {
    const sub: Subscriber = { sink, initSent: false };
    this.subscribers.add(sub);
    this.lastListenerAt = Date.now();
    if (this.init) this.sendInit(sub);
    // A stream whose queue drained while nobody listened is asleep in `waitForClip`; a new listener
    // is a reason to start looping the last clip again.
    this.kick();
    return () => {
      this.subscribers.delete(sub);
      this.lastListenerAt = Date.now();
    };
  }

  private sendInit(sub: Subscriber): void {
    if (!this.init) return;
    this.safeWrite(sub, this.init);
    sub.initSent = true;
  }

  private safeWrite(sub: Subscriber, chunk: Buffer): void {
    try {
      sub.sink.write(chunk);
    } catch {
      this.subscribers.delete(sub);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  get listeners(): number {
    return this.subscribers.size;
  }

  /** True when nothing has been pushed and nobody has listened for the profile's idle window. */
  isIdle(now = Date.now()): boolean {
    if (this.subscribers.size > 0) return false;
    const window = Math.max(1, this.profile.idleTimeoutMinutes) * 60_000;
    return now - this.lastClipAt > window && now - this.lastListenerAt > window;
  }

  info(): StreamInfo {
    const bufferedSec = this.queue.reduce((sum, c) => sum + c.info.durationSec, 0);
    return {
      flowId: this.flowId,
      flowName: this.flowName,
      kind: this.profile.kind,
      mime: mimeFor(this.profile),
      startedAt: this.startedAt.toISOString(),
      nowPlaying: this.lastAired?.info.title ?? null,
      starved: this.starved,
      bufferedSec: Math.round(bufferedSec),
      queuedClips: this.queue.length,
      totalClips: this.totalClips,
      listeners: this.subscribers.size,
      recent: this.history.slice(0, 10),
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.wake?.();
    if (this.paceTimer) clearTimeout(this.paceTimer);
    this.paceWake?.();

    const child = this.playout;
    this.playout = null;
    if (child) {
      child.stdin.destroy();
      child.kill('SIGKILL');
    }
    for (const sub of this.subscribers) {
      try {
        sub.sink.close();
      } catch {
        /* the response was already gone */
      }
    }
    this.subscribers.clear();
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    log.info({ flow: this.flowName }, 'stream stopped');
  }
}
