import type { ImagePromptState, PromptContext, PromptModule } from '../types';

/**
 * Tell the model, in the user turn, what images it can act on and how — otherwise it has no reliable
 * signal an image exists and silently ignores it. What the note says depends on whether the agent
 * can actually see:
 *  - multimodal: every image in scope IS in its context (attachments and carried-over alike), so the
 *    note only says where they came from and how to forward them on;
 *  - text-only: it gets no pixels at all, so the note is what makes an image reachable — by index,
 *    through `analyze_image` (the Vision endpoint) or `ask_agent`.
 *
 * Returns null when the turn has no images in scope, which is most of them.
 */
export function renderImageNote(images: ImagePromptState): string | null {
  const { supportsVision, current, session, pooled } = images;
  const idxRange = (n: number) => (n > 1 ? `..${n - 1}` : '');
  const plural = (n: number) => (n > 1 ? 'them' : 'it');
  /**
   * `img_3` / `img_3 and img_4`. Naming the handles is what lets an agent *act* on an image:
   * `analyze_image` takes an index, but `edit_image`, `write from_handle` and `data` all take a
   * handle, and numbering continues across the session — so "the first image" is not `img_1`.
   * Without this the model guesses, and prod transcripts show it guessing `0`, `img_0`, `img_1`
   * in turn before falling back to `data list`.
   */
  const handleList = (): string => {
    const ids = pooled.map((i) => i.id).filter(Boolean);
    if (ids.length === 0) return '';
    return ids.length === 1
      ? ` It is \`${ids[0]}\`.`
      : ` They are ${ids.map((id) => `\`${id}\``).join(', ')}.`;
  };

  if (supportsVision) {
    // Carried-over images are re-fed to a multimodal agent, but they are NOT part of this message
    // — say so, or the model reads a stale screenshot as the thing the user just sent.
    if (current.length === 0 && session.length) {
      const n = session.length;
      return `[The ${n} image${n > 1 ? 's' : ''} shown ${n > 1 ? 'are' : 'is'} from earlier in this conversation, not newly sent. You can see ${plural(
        n,
      )}.${handleList()} Use that handle to edit ${plural(n)} (\`edit_image\`), save ${plural(
        n,
      )} (\`write from_handle\`) or forward ${plural(n)} to another agent with \`ask_agent\` (include_image: true).]`;
    }
    return null;
  }
  if (current.length) {
    const n = current.length;
    return `[${n} image${n > 1 ? 's are' : ' is'} attached to this message. You cannot see ${plural(
      n,
    )} directly — call the \`analyze_image\` tool (index 0${idxRange(n)}) to read ${
      n > 1 ? 'each one' : 'it'
    } before answering.${handleList()} Use that handle for any tool that acts on the image — \`edit_image\`, \`write from_handle\`, \`data\`.]`;
  }
  if (session.length) {
    const n = session.length;
    return `[${n} image${n > 1 ? 's' : ''} from earlier in this conversation ${
      n > 1 ? 'are' : 'is'
    } available. You cannot see ${plural(n)} directly — call \`analyze_image\` (index 0${idxRange(
      n,
    )}) to read ${plural(n)}, or forward ${plural(
      n,
    )} to another agent with \`ask_agent\` (include_image: true).${handleList()} Use that handle for \`edit_image\`, \`write from_handle\` or \`data\`.]`;
  }
  return null;
}

export const visualsModule: PromptModule = {
  id: 'visuals',
  name: 'Visuals',
  description: 'Media generation and editing, and the note that makes an image reachable by handle.',
  group: 'capabilities',
  tools: ['generate_image', 'generate_video', 'generate_sound', 'edit_image', 'analyze_image'],
  settingsKeys: ['comfy_url', 'comfy_queue_max'],
  blocks: [
    {
      title: 'Images in scope',
      placement: 'user_suffix',
      order: 10,
      // Every variant of the note opens the same way: `[3 images are attached…`, `[1 image from
      // earlier…`, `[The 2 images shown…`.
      detect: /^\[(?:The )?\d+ images?\b/,
      render: (ctx: PromptContext) => renderImageNote(ctx.images),
    },
  ],
};

/**
 * Tools-only modules. They contribute no prompt text — the tool's own description and `guide` entry
 * do that job — but they are part of what this instance is made of, so each gets a row and a switch.
 * Every core tool belongs to exactly one module; `tools/registry.ts` derives its categories from
 * this list rather than keeping a second hand-maintained table.
 */
export const filesModule: PromptModule = {
  id: 'files',
  name: 'Files',
  description: 'Reading, writing, searching and patching files where the agent executes.',
  group: 'capabilities',
  tools: ['read', 'write', 'edit', 'list', 'glob', 'grep', 'patch'],
};

export const shellModule: PromptModule = {
  id: 'shell',
  name: 'Shell',
  description: 'Running commands on the backend host, in an isolated container, or over SSH.',
  group: 'capabilities',
  tools: ['bash'],
};

export const webModule: PromptModule = {
  id: 'web',
  name: 'Web',
  description: 'Searching the web through SearXNG and fetching a page.',
  group: 'capabilities',
  tools: ['web_search', 'webfetch'],
};

export const apisModule: PromptModule = {
  id: 'apis',
  name: 'APIs',
  description: 'The configured HTTP APIs catalogue and the caller that runs one named operation.',
  group: 'capabilities',
  tools: ['api', 'api_man'],
};

export const flowsModule: PromptModule = {
  id: 'flows',
  name: 'Flows',
  description: 'Running an operator-authored node graph from inside a turn.',
  group: 'capabilities',
  tools: ['run_flow'],
};

export const automationModule: PromptModule = {
  id: 'automation',
  name: 'Automation',
  description: 'Scheduling a headless job for later.',
  group: 'capabilities',
  tools: ['schedule_task'],
};

export const mailModule: PromptModule = {
  id: 'mail',
  name: 'Mail',
  description: 'Reading the linked Gmail mailboxes.',
  group: 'capabilities',
  tools: ['list_mail', 'read_mail'],
  settingsKeys: ['google_client_id', 'public_base_url'],
};

export const desktopModule: PromptModule = {
  id: 'desktop',
  name: 'Desktop control',
  description: "Seeing and driving an isolated container's GUI.",
  group: 'capabilities',
  tools: ['visual_screenshot', 'visual_act', 'visual_click', 'visual_windows'],
  settingsKeys: ['screen_control_mode', 'vision_endpoint_id', 'vision_model'],
};

export const androidModule: PromptModule = {
  id: 'android',
  name: 'Android',
  description: 'Seeing and driving a linked Android device.',
  group: 'capabilities',
  tools: [
    'android_ui',
    'android_screenshot',
    'android_act',
    'android_app',
    'android_shell',
    'android_logcat',
    'android_file',
  ],
};
