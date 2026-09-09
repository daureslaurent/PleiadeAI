import type { ChatLayoutId } from '../../../theme/layouts';
import type { ConversationProps } from './shared';
import { HybridConversation } from './Hybrid';
import { TranscriptConversation } from './Transcript';
import { WorkbenchConversation } from './Workbench';
import { TimelineConversation } from './Timeline';
import { BubblesConversation } from './Bubbles';

/**
 * Chat layout id → the view that renders the conversation for it (THEME_SYSTEM_PLAN.md §4).
 *
 * The chat *shell* — header, banners, todo panel, ask-user prompt, composer — is layout-independent
 * and stays in `ChatPanel`; only this swaps. Adding a layout is one descriptor in
 * `theme/layouts.ts` plus one entry here.
 */
export const CONVERSATION_VIEWS: Record<ChatLayoutId, (p: ConversationProps) => JSX.Element> = {
  hybrid: HybridConversation,
  transcript: TranscriptConversation,
  workbench: WorkbenchConversation,
  timeline: TimelineConversation,
  bubbles: BubblesConversation,
};

export type { ConversationProps };
