import { createContext, useContext, type ReactNode } from 'react';
import { chatLayoutById, DEFAULT_CHAT_LAYOUT, type ChatLayoutDef } from '../../theme/layouts';
import { usePrefs } from '../../store/prefs';

/**
 * The active chat layout, read by everything that renders a block (THEME_SYSTEM_PLAN.md §3.1).
 *
 * `Blocks` and `ToolCall` are recursive and shared by all five layouts; rather than passing a
 * descriptor down through every sub-agent bubble, they read it from here. The default is the
 * hybrid descriptor, so a block rendered outside the chat page (a preview, a test) still works.
 */
const Ctx = createContext<ChatLayoutDef>(chatLayoutById(DEFAULT_CHAT_LAYOUT));

export const useChatLayout = (): ChatLayoutDef => useContext(Ctx);

export function ChatLayoutProvider({
  layout,
  children,
}: {
  layout: ChatLayoutDef;
  children: ReactNode;
}) {
  return <Ctx.Provider value={layout}>{children}</Ctx.Provider>;
}

/** The layout the operator picked. Only the chat page should need this — everything else reads context. */
export const useActiveChatLayout = (): ChatLayoutDef => chatLayoutById(usePrefs((s) => s.chatLayout));
