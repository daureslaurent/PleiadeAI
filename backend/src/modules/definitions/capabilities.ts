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

/**
 * **GitLab** (`GITLAB_PLAN.md` §3).
 *
 * The only capability module here that carries a prompt block, and it needs one for a reason the
 * others don't: the nine tools describe *what can be done*, and nothing in them says what should be.
 * A model handed a token that can merge will merge — to its own branch, into main, without reading
 * the diff — because every one of those is a legal call. The block is where the working practice
 * lives: branch, don't push to the default; commit through the API when you are sure and clone when
 * you need to run something; read the log before you retry; claim work by assigning the issue.
 *
 * It renders from `PromptContext.gitlab`, which `AgentRunner` fills from the settings it has already
 * loaded — so the module still never fetches, and an instance with no GitLab configured renders
 * nothing at all rather than teaching agents to reach for tools they don't have.
 */
export const gitlabModule: PromptModule = {
  id: 'gitlab',
  name: 'GitLab',
  description: 'Projects, code, merge requests, issues-as-work-board, CI and wikis on the configured GitLab.',
  group: 'capabilities',
  tools: [
    'gitlab_projects',
    'gitlab_files',
    'gitlab_commit',
    'gitlab_repo',
    'gitlab_mr',
    'gitlab_issue',
    'gitlab_ci',
    'gitlab_search',
    'gitlab_wiki',
    'gitlab_todo',
  ],
  settingsKeys: [
    'gitlab_url',
    'gitlab_group',
    'gitlab_wake_issues',
    'gitlab_wake_reviews',
    'gitlab_poll_enabled',
    'gitlab_poll_events',
  ],
  blocks: [
    {
      title: 'GitLab',
      placement: 'system_tail',
      order: 150,
      render(ctx: PromptContext) {
        const gl = ctx.gitlab;
        if (!gl) return null;
        const scope = gl.group
          ? `You can reach the projects under the **${gl.group}** group.`
          : 'You can reach every project the fleet account is a member of.';
        return [
          '## GitLab',
          '',
          `This fleet works on ${gl.url}. ${scope} ` +
            (gl.actingAs
              ? `**You act as your own GitLab account, \`@${gl.actingAs}\`.** Every commit, comment, ` +
                'issue and merge you make is recorded under that name and carries exactly the ' +
                'permissions it has been given — so what you can do there is a fact about your ' +
                'account, not about the fleet, and a refusal means you personally lack that access.'
              : 'You act as the shared fleet account, so your work is attributed to the fleet rather ' +
                'than to you by name.'),
          '',
          '**Read the item before you touch it — this is enforced.** `gitlab_issue({action:"get"})` ' +
            'and `gitlab_mr({action:"get"})` return the *whole* thing: the description, every ' +
            'comment and review thread oldest-first, what was closed and reopened, which labels came ' +
            'and went, and what is linked to it. Commenting on, closing, approving or merging an ' +
            'item you have not read this turn is **refused** — because the single most useless thing ' +
            'you can do here is answer a question somebody already answered, and the second most ' +
            'useless is start work a colleague already has a branch open for. When you do reply, ' +
            'reply *inside the thread* (`reply` with the `thread_id` from the timeline), not as a ' +
            'new comment at the bottom where nobody is notified; resolve a review thread once it is ' +
            'genuinely settled (`gitlab_mr({action:"resolve"})`).',
          '',
          '**What is aimed at you.** `gitlab_todo({action:"list"})` is GitLab\'s own answer to ' +
            '"what should I be working on" — issues assigned to you, reviews requested from you, ' +
            'comments naming you, your merge requests that broke. Prefer it to guessing from a ' +
            'project listing, and clear a to-do with `done` once you have actually acted on it.',
          '',
          '**Finding your way in.** `gitlab_search` (scope `projects`, or `blobs` to grep the real ' +
            'source) turns a described task into a project path; `gitlab_projects({action:"get"})` ' +
            'gives you its default branch, which you need before you branch off anything.',
          '',
          '**Changing code — two routes, and they are not interchangeable.** For an edit you are ' +
            'certain of, `gitlab_commit({action:"create"})` writes several files as one commit ' +
            'through the API: no clone, no container, nothing left behind if the turn dies. For ' +
            'anything you need to *run* — install the dependencies, execute the tests, reproduce a ' +
            'bug — `gitlab_repo({action:"clone"})` gives you a real checkout in your container and ' +
            'ordinary `bash` git afterwards (`git commit`, `git push` are already authenticated). ' +
            'Guessing that a change works is not the same as knowing, and a clone is how you know.',
          '',
          '**Never commit to the default branch.** Branch, commit there, then open a merge request ' +
            'with `gitlab_mr({action:"create"})` and say in the description what changed and how you ' +
            'checked it. You are technically permitted to push to main and to merge your own work; ' +
            'the permission exists so that *approved* work can land without waiting for a human at ' +
            'midnight, not so review can be skipped. Read `gitlab_mr({action:"diff"})` before you ' +
            'approve or merge anything, including your own — `get` tells you who has already ' +
            'approved it and which threads are still unresolved, and an unresolved thread is ' +
            'somebody waiting on an answer, not a formality.',
          '',
          '**Issues are the work board.** `gitlab_issue({action:"list"})` with no project shows ' +
            'everything open; with `assignee` it shows what is yours. Claim a piece of work by ' +
            'assigning the issue to yourself and saying so in a comment, report anything that ' +
            'changes your estimate as a comment, and when it is done close it with a comment stating ' +
            'what you actually did and linking the merge request. An issue that is silently assigned ' +
            'and never updated is worse than an unclaimed one — it looks handled. Two issues that ' +
            'turn out to be the same work get `link`ed rather than both worked. GitLab\'s own ' +
            'interface calls these **work items** and puts them at `/-/work_items/…`; it is the same ' +
            'object as an issue and the same `iid`, so do not go looking for a separate tool.',
          '',
          '**A red pipeline gets read, not retried.** `gitlab_ci({action:"jobs", scope:"failed"})` ' +
            'then `job_log` on the job that broke. Retrying without a change runs exactly the same ' +
            'code and wastes a runner; the only honest reasons to retry are a runner timeout or a ' +
            'lost connection, which the job\'s `failure_reason` tells you.',
          '',
          '**Documentation.** What belongs to a project goes in its wiki (`gitlab_wiki`), where its ' +
            'maintainers will find it. What belongs to the fleet goes on the forum.',
        ].join('\n');
      },
    },
  ],
};
