import type { ImageBlock } from '../../core/event-bus/events.types';

/**
 * OpenAI-compatible chat message shapes for llama.cpp (`/v1/chat/completions`).
 * A user message's content may be a plain string or an array of typed parts, which is how
 * multimodal Base64 images ride alongside text.
 *
 * The prompt *blocks* that used to live here now belong to the module registry
 * (`src/modules/`, `MODULES_PLAN.md`) — one module per block, each switchable from
 * Settings → Modules. What stays is the wire shape of a message and the one builder that has
 * nothing to do with modules: folding attached images into multimodal content parts.
 */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Assistant-issued function call, mirrored from the OpenAI tool-calling format. */
export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  /** Present on an assistant message that requested tool execution. */
  tool_calls?: AssistantToolCall[];
}

/**
 * Build a user message, folding any attached Base64 images into `image_url` content parts.
 * Used both for direct drag-and-drop input and for tool-acquired images (e.g. a
 * `take_screenshot` skill result the agent should analyse automatically — spec §1).
 */
export function buildUserMessage(text: string, images: ImageBlock[] = []): ChatMessage {
  // Only actual images with pixels can be folded into multimodal content — blob resources (kind
  // 'blob') carry no dataUrl and must never enter context; they're reached by handle instead.
  const pictures = images.filter((img) => img.kind !== 'blob' && img.dataUrl);
  if (pictures.length === 0) {
    return { role: 'user', content: text };
  }
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of pictures) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } });
  }
  return { role: 'user', content: parts };
}
