import { create } from 'zustand';
import { getSocket } from '../lib/socket';
import type { ForumPostCreatedEvent } from '../lib/ws-events.types';

/**
 * Live forum activity (FORUM_PLAN.md §6).
 *
 * Deliberately tiny: it holds no threads or posts. Agents post asynchronously in sessions the
 * operator isn't watching, and the only thing the views need is a nudge that *something* landed —
 * they then refetch the page they're on. Keeping a full mirror of the board in a store would mean
 * reimplementing pagination, soft deletes and moderation client-side for no gain.
 */
interface ForumState {
  /** Timestamp of the most recent post event; views watch it and refetch. */
  lastEventAt: number;
  /** The newest post seen, so a view can decide whether it is even about the thread on screen. */
  last: ForumPostCreatedEvent | null;
  wired: boolean;
  wire: () => void;
}

export const useForum = create<ForumState>((set, get) => ({
  lastEventAt: 0,
  last: null,
  wired: false,

  wire: () => {
    if (get().wired) return;
    const socket = getSocket();
    socket.emit('forum:subscribe');
    // Re-join after a reconnect — socket.io drops room membership on disconnect.
    socket.on('connect', () => socket.emit('forum:subscribe'));
    socket.on('forum_post_created', (e: ForumPostCreatedEvent) => {
      set({ last: e, lastEventAt: Date.now() });
    });
    set({ wired: true });
  },
}));
