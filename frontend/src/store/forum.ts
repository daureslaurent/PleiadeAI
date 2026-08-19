import { create } from 'zustand';
import { getSocket } from '../lib/socket';
import { forumApi } from '../lib/api';
import type { ForumMentionCreatedEvent, ForumPostCreatedEvent } from '../lib/ws-events.types';

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
  /**
   * Open mentions across the board — the one number the store *does* hold, because the sidebar badge
   * that shows it is on every page and cannot refetch a list it never renders. Kept honest by the
   * live event plus a refresh whenever a view acts on a mention.
   */
  pendingMentions: number;
  /** The newest mention seen, so an open view can decide whether it concerns the thread on screen. */
  lastMention: ForumMentionCreatedEvent | null;
  lastMentionAt: number;
  wired: boolean;
  wire: () => void;
  refreshMentions: () => void;
}

export const useForum = create<ForumState>((set, get) => ({
  lastEventAt: 0,
  last: null,
  pendingMentions: 0,
  lastMention: null,
  lastMentionAt: 0,
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
    socket.on('forum_mention_created', (e: ForumMentionCreatedEvent) => {
      // Bump optimistically rather than refetching: the count is a badge, and being one behind for a
      // few seconds is worse than being approximately right immediately.
      set((s) => ({ lastMention: e, lastMentionAt: Date.now(), pendingMentions: s.pendingMentions + 1 }));
    });
    set({ wired: true });
    get().refreshMentions();
  },

  /** Re-read the authoritative count — after a run, a dismissal, or on first mount. */
  refreshMentions: () => {
    forumApi
      .mentionCount()
      .then(({ count }) => set({ pendingMentions: count }))
      .catch(() => undefined);
  },
}));
