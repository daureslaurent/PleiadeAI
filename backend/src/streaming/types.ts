/**
 * Shared shapes for the live media streaming subsystem (STREAMING_PLAN.md).
 *
 * A *stream* is a long-lived backend object keyed by **flow id**: successive flow runs push clips
 * into it and it muxes one endless flux. Nothing here is per-run — that is the whole point of the
 * feature, since the operator changes a prompt and re-runs without the listener ever reconnecting.
 */

/** Whether the flux carries pictures. Audio-only streams skip every video filter and encoder. */
export type StreamKind = 'audio' | 'video';

/** What the pump does when the clip queue empties before the next render lands. */
export type UnderrunPolicy = 'loop' | 'silence';

/**
 * The canonical format of one stream. Locked by the StreamingFlow node that creates the stream:
 * every clip is transcoded to exactly this on ingest, which is what lets independently-rendered
 * clips concatenate into a gapless flux.
 */
export interface StreamProfile {
  kind: StreamKind;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  channels: number;
  audioBitrate: string;
  videoBitrate: string;
  underrun: UnderrunPolicy;
  /** Tear the stream down after this many minutes with no new clips *and* no listeners. */
  idleTimeoutMinutes: number;
  /** Clips allowed to sit queued; pushing past it drops the oldest un-aired clip. */
  maxQueued: number;
}

export const DEFAULT_PROFILE: StreamProfile = {
  kind: 'audio',
  width: 1280,
  height: 720,
  fps: 24,
  sampleRate: 48000,
  channels: 2,
  audioBitrate: '160k',
  videoBitrate: '2500k',
  underrun: 'loop',
  idleTimeoutMinutes: 10,
  maxQueued: 24,
};

/**
 * The MSE codec string for a profile. Pinned rather than probed: the ingest encoder is forced to
 * H.264 main\@3.1 + AAC-LC precisely so this string is always the truth, because
 * `MediaSource.isTypeSupported` is checked against it before a single byte is appended.
 */
export function mimeFor(profile: StreamProfile): string {
  return profile.kind === 'video'
    ? 'video/mp4; codecs="avc1.4d401f,mp4a.40.2"'
    : 'audio/mp4; codecs="mp4a.40.2"';
}

/** One clip that has been (or is being) aired. */
export interface ClipInfo {
  id: string;
  title: string;
  /** Seconds of material, as probed after normalization. */
  durationSec: number;
  queuedAt: string;
  /** Set when the pump started writing it into the playout muxer. */
  airedAt?: string;
  /** How many times the underrun policy has re-aired it. */
  replays: number;
}

/** A stream as the API reports it. */
export interface StreamInfo {
  flowId: string;
  flowName: string;
  kind: StreamKind;
  mime: string;
  startedAt: string;
  /** Title of the clip currently on air. */
  nowPlaying: string | null;
  /** True while the pump is re-airing the last clip because nothing new arrived. */
  starved: boolean;
  /** Seconds of un-aired material queued up. */
  bufferedSec: number;
  queuedClips: number;
  totalClips: number;
  listeners: number;
  recent: ClipInfo[];
}
