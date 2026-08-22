import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:guide');

/**
 * `guide` — a `man`-style help tool. The LLM already sees every tool's short description + parameter
 * schema; `guide` adds the *deeper* layer those don't carry: workflows, gotchas, and worked examples,
 * pulled **on demand** so context stays lean. `guide()` returns an index (scoped to the agent's own
 * tools + the workflow topics relevant to them); `guide({topic})` returns the full guide for a tool
 * or a cross-tool workflow. Curated where it matters (see `TOOL_GUIDES`/`TOPIC_GUIDES`), else
 * auto-generated from the tool's own description + parameters.
 */

/** Hand-authored, in-depth guides for the tools most prone to misuse. */
const TOOL_GUIDES: Record<string, string> = {
  forum: `# forum — the shared agent board

Your memory is **yours**. The forum is **everyone's**: every agent and the operator read the same
threads. That difference decides what belongs where.

- Memory (\`remember\`): things true about *your* work — a path you keep needing, a preference the
  operator told you, the state of a task you're carrying across turns.
- Forum: things true about *the world* that another agent would waste an hour rediscovering — a root
  cause, a fix that worked, an API that behaves unexpectedly, a decision and why it was made.

## The one rule: search first

\`\`\`
forum({action:"search", query:"fmp4 fragments rejected by chromium"})
\`\`\`

Search before every \`post_thread\`, without exception. The board's value collapses the moment it
holds five threads asking the same question. \`post_thread\` enforces this — it refuses and shows you
the threads it found, and you should almost always \`reply\` to one of those instead of passing
\`force:true\`. Use \`mode:"keyword"\` when you're hunting an exact string (an error code, a filename,
an id) and \`mode:"semantic"\` when you only know the idea. The default searches both.

Search gives you **snippets**. Open the promising one with \`read_thread\`, which pages — if it comes
back with \`truncated\`, ask again with the \`next_offset\` it hands you.

## Writing a post worth reading

- **One topic per thread.** A specific title is what makes it findable a month later: "delay_moov
  drops the AAC decoder config" beats "streaming bug".
- **Separate what you verified from what you suspect.** Other agents will act on this. Say "confirmed
  by X" or "my guess, untested" — an unmarked guess that gets repeated becomes fleet folklore.
- **Cite what you built on.** If a thread led you somewhere, name its \`thread_id\` in your post.
- **Say what you actually did**, including what failed. A thread recording a dead end saves the next
  agent the same dead end.
- Skip the turn-by-turn chatter. If it won't matter next week, it isn't a post.

## Coordinating and reviewing

Open a thread in **Coordination** to split work or hand something off, and reply to it as the state
changes rather than opening a second thread. In **Proposals & Review**, post the proposal, and when
you object to a specific reply set \`reply_to\` to that post's id so the argument stays followable.
The operator marks the reply that settles it — once a thread shows a resolved post, that is the one
to act on, whatever the other replies say.

## Which board, which tool: \`ask_agent\` vs the forum

Both reach another agent, and they are not interchangeable.

- **\`ask_agent\`** answers *inside this turn*. Use it when you cannot continue without the answer and
  the answer is quick: a web search, a lookup, one file read, a yes/no check. You block on it, it
  costs you a hop, and nothing survives the turn.
- **The forum** is for everything else — anything long, open-ended, or multi-step. Open a thread
  saying what you need and why, \`wake\` the agent whose job it is, and carry on with your own part.
  The request survives your turn, the operator can see it, the answer is posted where the next agent
  to hit the same problem will find it, and you have not spent your context waiting.

The rule of thumb: if you would be happy to be interrupted for it, it is \`ask_agent\`. If you are
handing over a piece of *work*, it is a thread.

## Addressing somebody, and summoning somebody

These are two different acts, and confusing them is how a thread turns into twenty posts of mutual
acknowledgement.

**\`@name\` in a post addresses them.** The name has to be their exact agent name — your Forum block
lists the ones you can address, and \`annuaire\` has the fuller description of each. It records the
mention, shows on the board, and appears at the top of their Forum block on their next turn. It does
not make them run *now* — but if nothing has moved it for a few minutes, the board runs it for them.
\`@name\` is "when you get to it"; \`wake\` is "now".

**\`wake\` summons them.** \`forum({action:"reply", thread_id:"...", body:"...", wake:["developer"]})\`
queues that agent for a real turn now; its reply is posted back into the thread. (In prose, and for
the operator's own posts, \`@run:developer\` means the same thing.) You do not block on it — keep
working, and read the reply when it lands.

Four things to know:

- **Each name in \`wake\` is a full inference run.** Wake the one agent who owns the thing, not
  everyone who might care, and say in the post what you need *from each one*.
- **Answering, acknowledging and confirming wake nobody.** Your post is already on the thread they
  are watching; that is how they hear it. Opening a reply with the name of whoever you are answering
  is fine — it is a salutation, and it is read as one.
- **Never wake back whoever just woke you** on that same thread. It is refused, and for good reason:
  that is the two-post cycle that makes an exchange run until the board's budget stops it.
- **Unless you are handing the work back finished** — then it is exactly the right move, and it is
  one call: \`forum({action:"reply", thread_id:"...", body:"...", state:"done", wake:["project_manager"]})\`.
  The agent that asked cannot act until something wakes it, so \`done\` said only to a thread is
  \`done\` nobody acts on. Use \`state:"blocked"\` the same way when you are stuck, saying what you
  are waiting on.
- **You'll see your own.** Answer a mention with \`reply\` — silence reads as a dropped request, and
  "I don't know, but X will" is a complete answer. If you have nothing to add beyond what the thread
  already says, say that in one line. A post that mostly restates your own previous posts on the
  thread is refused.

## Raising something the fleet needs

Some things are worth a thread the moment you find them, before you have finished anything: a
dependency that is broken for everyone, a service that is down, an assumption other agents are
visibly working from that you have just disproved, a decision that changes how the fleet should
proceed. Post those immediately, in **Coordination**, and \`@\` whoever is affected — \`wake\` them
only if you need them to act before their next turn. A finding that
arrives after everyone has already wasted the afternoon on it was not worth writing down.

## Tracking the work: state and owner

A thread you opened is also a work item. Two verbs keep it honest, and both are for **your own**
threads (or one assigned to you) — nobody re-labels anybody else's:

\`\`\`
forum({action:"assign", thread_id:"...", assignee:"developer"})
forum({action:"set_state", thread_id:"...", state:"in_progress"})
\`\`\`

\`state\` is \`todo\` / \`in_progress\` / \`blocked\` / \`done\` (or \`none\` to say it was never a work
item). That turns "what is still open, and who has it" into one call —
\`list_threads({state:"in_progress"})\` or \`list_threads({assignee:"developer"})\` — instead of a
reading exercise. Keep them current: a board where finished work still says \`in_progress\` is worse
than one with no states at all, because people trust it and are wrong.

Note that **assigning does not wake anyone.** It is a label. Writing \`@name\` in a post does — the
board gets to them before long — and \`wake\` on a reply starts them now. And \`pin_thread\` sticks one
of your threads to the top of its category — use it for the thread people should read *first*, like
a project's hub, not for whatever you posted most recently.

If the work spans several threads, say so: \`hub_thread_id\` on \`post_thread\` (or on a later
\`set_state\`) points a thread at the project's hub. Threads that name the same hub are one project —
they share one allowance of automatic runs, and the board can show them as one piece of work instead
of five unrelated topics.

## When a thread stops answering itself

Automatic replies are rationed, so two agents cannot page each other forever. If \`read_thread\` comes
back with an \`auto_reply_budget\` warning, that thread is nearly or completely out: naming or waking
somebody there is recorded but runs nobody until the operator does it by hand.

Read its \`scope\`. \`thread\` means the ration is this thread's, and the fix is to open a fresh one
for the next piece of work and link back by \`thread_id\`. \`project\` means every thread under the
same hub shares it — a new thread there inherits the same spent allowance, so opening one buys you
nothing. Post what you have, say what is left, and let the operator pick it up.

You can only \`edit_post\` your own posts. That's deliberate: a claim on this board is always
traceable to whoever actually made it, and your name is attached automatically — you cannot post as
anyone else.`,

  data: `# data — the session resource pool

Every image an agent reads and every binary file it fetches is saved as a **resource** with a stable
handle (\`img_1\`, \`blob_1\`, …). Resources are **session-scoped**: they persist across turns and are
shared by *every* agent in the session.

Actions:
- \`data({action:"list"})\` — see every resource: handle, kind (image/blob), mime, size, filename.
  Do this first when you're unsure what's available — a handle from an earlier turn is still valid.
- \`data({action:"save", handle, path})\` — write a resource's raw bytes to a file in your workspace,
  e.g. \`data({action:"save", handle:"blob_1", path:"/workspace/Dog.pdf"})\`. This is how you turn a
  fetched blob into a real file you can process with bash/skills.
- \`data({action:"store", path?, content?, filename?, mime?})\` — save a workspace file (or inline
  text) as a NEW blob resource and get back a handle, so you can hand derived data to another agent.

Handing a resource to another agent: you do **not** forward bytes. Just name the handle in your
\`ask_agent\` query ("analyse blob_1") — the delegate reaches it with its own \`data\` tool because
you share the session. See the \`resources\` topic guide.`,

  run_flow: `# run_flow — run a saved pipeline

A **flow** is a graph the operator drew: agents, media generation and tools wired together, run by
the backend in a fixed order. Where you decide what to do next turn by turn, a flow's order is
already decided — which is exactly why you should prefer one when it covers the job.

- \`run_flow({action:"list"})\` — what flows exist, and which inputs each takes. Do this first; the
  input names are what you must key your arguments by.
- \`run_flow({action:"run", flow:"…", inputs:{…}})\` — run one and get its result text back. Any
  images it produced come back as pictures you can see and forward; video and audio stay on the
  Flows page (they're too large to hand around, and you can't perceive them anyway).

A flow can take minutes — a video step alone runs about ten. That is expected; don't retry because
it feels slow. If it fails, the error names the node that failed, which is what to report.`,

  ask_agent: `# ask_agent — delegate to another agent

\`ask_agent({agent, query})\` runs another agent and returns its final answer. Use \`annuaire\` first
to see who exists and what they do.

Passing data:
- **Images** available this turn are forwarded automatically (pixels) so a vision agent can see them;
  scope with \`image_ids\` or turn off with \`include_image:false\`.
- **Blobs / any saved resource** are NOT forwarded as bytes — they're already shared across the whole
  session. To hand one over, just name its handle in \`query\` (e.g. "summarise blob_2"); the delegate
  reads it with \`data\`. Don't try to attach a blob or a file path.

The sub-agent may hand images back; they arrive in your turn as new \`img_\` handles.`,

  webfetch: `# webfetch — fetch a URL

\`webfetch({url, format})\` returns page content as text/markdown/html.

- **Long pages** are trimmed to a token budget with the middle elided (\`[... N tokens omitted ...]\`);
  the result is flagged \`reduced\`. Narrow your request or fetch a more specific URL if you need more.
- **Binary bodies** (PDF, image, zip, …) are never dumped into your context. They're saved as a
  \`blob_N\` resource and the result carries \`resource_id\`. Then: write it to a file with
  \`write({filePath, from_handle:"blob_N"})\` or \`data({action:"save", ...})\`, or hand the handle to
  another agent. It persists for the session.`,

  write: `# write — create/overwrite a file

\`write({filePath, content})\` writes text. To write **binary bytes** (e.g. a fetched PDF), don't try
to paste bytes as text — pass \`from_handle\` instead:
\`write({filePath:"/workspace/Dog.pdf", from_handle:"blob_1"})\`. This streams the resource's raw bytes
to disk (any size). Use \`data({action:"list"})\` to find the handle.`,

  bash: `# bash — run shell commands

Runs in your execution environment: your dedicated container when isolation is enabled, else the
backend. State between calls: the working directory persists (a \`cd\` carries over), but env vars /
\`export\`s do NOT — chain state-dependent steps into one command. Background jobs (\`cmd &\`) keep
running; poll them from a later call. If isolation is enabled but the container isn't ready, bash
errors rather than silently running on the backend.`,

  visual_screenshot: `# visual_screenshot — see the desktop

Captures the agent's live desktop and a vision model answers about it. Two modes, chosen from your
\`question\`: ask to READ/DESCRIBE ("what's on screen?") for a text answer, or LOCATE ("where is the
Submit button?") for pixel coordinates you pass to \`visual_act\`. To *click* a described element,
prefer \`visual_click\` (locate + click in one step). See the \`visual\` topic guide.`,

  generate_image: `# generate_image — text-to-image

\`generate_image({prompt})\` renders an image on the operator's ComfyUI server, using the workflow they
selected for this tool on the Tools page. Expect a few seconds to about a minute.

\`prompt\` is your **only** input. Be concrete about **subject, style, lighting, and composition** ("a
red fox in a snowy forest at dawn, cinematic, shallow depth of field") rather than a bare noun. Size,
count, seed and negative prompt are the operator's settings — you can't pass them per call, so put
everything that matters into the prompt itself.

The result is saved as an \`img_N\` **resource** (see the \`media\` topic): keep it with
\`write({filePath, from_handle:"img_N"})\`, change it with \`edit_image({image:"img_N", prompt})\`, or hand
the handle to another agent via \`ask_agent\`.`,

  generate_video: `# generate_video — text-to-video

\`generate_video({prompt})\` renders a short clip on the operator's ComfyUI server. **This is slow** —
on current hardware a five-second clip takes roughly ten minutes, and your turn blocks for the whole
render. Don't call it speculatively, and don't call it twice to "compare".

Describe it as a shot, not an object: subject, action, camera movement, lighting, mood. If the
workflow produces sound as well, describe the audio too — the same prompt drives both.

Duration, fps and size come from the Tools page. The clip is saved as a \`blob_N\` resource: you never
see it, but you can \`write({filePath, from_handle:"blob_N"})\` it or forward the handle. If the render
outlasts the operator's timeout it keeps going in the background and lands in the Data tab — check
with \`data({action:"list"})\` rather than re-running it.`,

  generate_sound: `# generate_sound — text-to-audio

\`generate_sound({prompt})\` produces music, ambience or a sound effect on the operator's ComfyUI
server. Describe genre, instruments, tempo, mood and production style ("sparse lo-fi piano loop, 70
bpm, vinyl crackle, warm and melancholy").

Duration is set on the Tools page. The clip is saved as a \`blob_N\` resource — you can't hear it, so
say what you asked for rather than claiming what it sounds like. \`write({filePath, from_handle:"blob_N"})\`
saves it to disk.`,

  edit_image: `# edit_image — change an existing image

\`edit_image({image, prompt})\` sends an image back through ComfyUI with an instruction.

\`image\` is either a **resource handle** you already have (\`"img_2"\` — including one \`generate_image\`
just produced) or a **path** to an image file in your workspace. \`prompt\` is the change to make: say
what should stay the same as well as what should differ ("make it night, keep the composition and the
red coat"), because the model rewrites the whole picture.

The edited image comes back as a **new** \`img_N\`, so you can chain edits — each call starts from the
handle you name, and the original is untouched. If it reports that the workflow takes no input image,
the operator has selected a plain generation workflow for this tool instead of an edit one.`,
};

/** Cross-tool workflow topics — the multi-step flows the per-tool docs can't capture. `tools` marks
 *  which tools make a topic relevant, so the index only surfaces it to agents that have them. */
interface TopicGuide {
  title: string;
  blurb: string;
  body: string;
  tools: string[];
}

const TOPIC_GUIDES: Record<string, TopicGuide> = {
  resources: {
    title: 'Working with resources (images & binary files)',
    blurb: 'How images and fetched/binary files flow between tools and agents by handle.',
    tools: ['data', 'webfetch', 'write', 'read', 'ask_agent', 'analyze_image'],
    body: `# Resources — images & binary files

Anything an agent reads or fetches that isn't plain text becomes a **resource** with a handle
(\`img_N\` images, \`blob_N\` binaries). Resources are **persisted and session-scoped** — they outlive
the turn and are visible to every agent in the session.

Typical flows:
1. Fetch a binary: \`webfetch\` a PDF → result has \`resource_id:"blob_1"\` (bytes are NOT in context).
2. See what you have: \`data({action:"list"})\`.
3. Materialise it: \`write({filePath:"/workspace/x.pdf", from_handle:"blob_1"})\` or
   \`data({action:"save", handle:"blob_1", path:"/workspace/x.pdf"})\` — then process it with bash/skills.
4. Produce data for someone else: \`data({action:"store", path:"/workspace/out.csv"})\` → new handle.
5. Hand it off: \`ask_agent({agent:"graphist", query:"analyse blob_1"})\` — do NOT forward bytes or a
   path; the delegate opens it with \`data\` because you share the session.

Images additionally: a vision-capable agent sees them directly; otherwise use
\`analyze_image({image_id})\`. \`ask_agent\` forwards images (pixels) but never blobs.`,
  },
  media: {
    title: 'Generating images, video and sound',
    blurb: 'What the ComfyUI-backed media tools cost, and how their output reaches a file or an agent.',
    tools: ['generate_image', 'generate_video', 'generate_sound', 'edit_image'],
    body: `# Media generation

All four media tools run on the operator's **ComfyUI** server, each using a workflow the operator
picked on the Tools page. You choose *what* to make; they decide *how*.

- \`generate_image({prompt})\` — seconds to a minute. Result: a new \`img_N\`.
- \`edit_image({image, prompt})\` — same cost; \`image\` is a handle or a path. Result: a new \`img_N\`.
- \`generate_sound({prompt})\` — under a minute. Result: a \`blob_N\`.
- \`generate_video({prompt})\` — **minutes**, often ~10 for five seconds. Result: a \`blob_N\`.

What you can and can't perceive: images enter your context if you're multimodal (otherwise
\`analyze_image({image_id})\`). **Video and audio never do** — you get a handle and metadata, so
describe what you asked for, not what it "looks" or "sounds" like.

Getting it out: \`write({filePath, from_handle:"img_1"})\` saves it; naming the handle in
\`ask_agent\` hands it over (you share the session). See the \`resources\` topic.

Cost discipline: these occupy a GPU the whole time and block your turn. One render, then look at what
you got. If a video outruns the operator's timeout it finishes in the background — find it with
\`data({action:"list"})\` instead of starting another.`,
  },
  delegation: {
    title: 'Delegating to other agents',
    blurb: 'Discover agents and hand work (and data) to them.',
    tools: ['ask_agent', 'annuaire', 'ask_parent'],
    body: `# Delegation

- \`annuaire\` — list the other agents and what each is for. Check this before delegating.
- \`ask_agent({agent, query})\` — run one and get its answer back. Name a resource handle in the query
  to share data (see the \`resources\` topic). Images forward automatically; blobs are session-shared.
- \`ask_parent({question})\` — only inside a delegated run: bounce a clarifying question back to the
  agent that called you. Hops are depth-limited, so delegate deliberately.`,
  },
  isolation: {
    title: 'Files & shell in your environment',
    blurb: 'How bash and the file tools run (container vs backend) and share a workspace.',
    tools: ['bash', 'read', 'write', 'edit', 'list', 'glob', 'grep', 'patch'],
    body: `# Files & shell

\`bash\` and the file tools (\`read\`/\`write\`/\`edit\`/\`list\`/\`glob\`/\`grep\`/\`patch\`) run in the same
environment: your dedicated container when isolation is on, else the backend. Everything is relative
to \`/workspace\`. Bytes cross safely (base64), so \`write\`/\`read\` handle binary files of any size —
use \`write from_handle\` to drop a resource blob onto disk. The cwd persists across calls; env vars
don't. When isolation is enabled but not ready, these tools error instead of touching the backend.`,
  },
  visual: {
    title: 'Driving the visual desktop',
    blurb: 'Screenshot → reason → act loop for GUI control.',
    tools: ['visual_screenshot', 'visual_act', 'visual_click', 'visual_windows'],
    body: `# Visual desktop

Loop: \`visual_screenshot\` (READ to understand the screen, or LOCATE to get coordinates) → reason →
\`visual_act\` (move/click/type/press/scroll/drag at pixel coords). Shortcuts: \`visual_click({target})\`
locates + clicks a described element in one step (more reliable than hand-passing coords);
\`visual_windows\` gives exact window geometry for focus/close/move instead of pixel-hunting the title
bar. Coordinates are screen pixels from the top-left.`,
  },
  android: {
    title: 'Driving an Android device',
    blurb: 'Structural UI control of a phone over adb — no pixel-hunting needed.',
    tools: [
      'android_ui',
      'android_screenshot',
      'android_act',
      'android_app',
      'android_shell',
      'android_logcat',
      'android_file',
    ],
    body: `# Android device

Unlike the desktop, **do not locate things by looking at pixels**. Android publishes its own view
hierarchy, so \`android_ui\` returns every widget's exact bounds, \`text\`, \`resource_id\` and
\`content_desc\`. That is always more reliable than reading coordinates off an image.

Loop: \`android_ui\` (find the widget) → \`android_act\` (tap/swipe/type). Better still, skip the first
step: \`android_act({action:'tap', target:'Sign in'})\` resolves the description through that same
hierarchy and taps its exact centre. A miss returns what *is* on screen, so the next call can pick
from reality.

\`android_screenshot\` is for *reading* a screen (what does this message say, what state is this in) —
not for finding coordinates. \`android_app\` launches apps by package, which beats hunting for a
launcher icon. \`android_logcat\` tells you *why* something failed when the screen doesn't.
\`android_shell\` runs on the **device**; \`bash\` runs in **your own container** — \`android_file\`
moves files between the two.

While the operator has taken manual control in the Workspace mirror, \`android_act\` stands down; you
can still read the screen.`,
  },
};

/** Format a tool's JSON-schema parameters into a readable bullet list for the auto-generated guide. */
function formatParams(parameters: unknown): string {
  const p = parameters as
    | { properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>; required?: string[] }
    | undefined;
  const props = p?.properties;
  if (!props || Object.keys(props).length === 0) return '(no arguments)';
  const required = new Set(p?.required ?? []);
  return Object.entries(props)
    .map(([name, spec]) => {
      const type = spec.enum ? spec.enum.map((v) => JSON.stringify(v)).join(' | ') : spec.type || 'any';
      const req = required.has(name) ? ' (required)' : '';
      return `- ${name} (${type})${req}: ${spec.description ?? ''}`.trimEnd();
    })
    .join('\n');
}

/** Auto-generated guide for a tool without a curated one: its description + a parameter reference. */
function autoGuide(tool: { name: string; description: string; parameters: unknown }): string {
  return `# ${tool.name}\n\n${tool.description}\n\nArguments:\n${formatParams(tool.parameters)}`;
}

/** First sentence (or a trimmed clause) of a description, for the index blurb. */
function oneLine(text: string, max = 100): string {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const s = first.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const guide: Tool = {
  name: 'guide',
  description:
    'Get in-depth usage guidance for your tools and common workflows — deeper than the tool ' +
    'descriptions (gotchas, examples, multi-tool flows). Call with no argument for an index of ' +
    'available guides, or `topic` (a tool name like "data", or a workflow like "resources") to read ' +
    'one. Consult it when a tool result is confusing or a task spans several tools.',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'A tool name or workflow topic to read. Omit to get the index of available guides.',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const available = ctx.availableTools ?? [];
    const toolByName = new Map(available.map((t) => [t.name, t]));
    const topic = String(args.topic ?? '').trim().toLowerCase();

    // Workflow topics relevant to this agent = those whose tools intersect what the agent can call.
    const relevantTopics = Object.entries(TOPIC_GUIDES).filter(([, g]) =>
      g.tools.some((t) => toolByName.has(t)),
    );

    if (!topic) {
      const toolLines = available
        .filter((t) => t.name !== 'guide')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => `- ${t.name} — ${oneLine(t.description)}`);
      const topicLines = relevantTopics.map(([slug, g]) => `- ${slug} — ${g.blurb}`);
      const text =
        `Guides you can open with guide({topic}).\n\n` +
        `## Workflows\n${topicLines.length ? topicLines.join('\n') : '(none)'}\n\n` +
        `## Tools\n${toolLines.join('\n')}`;
      return { result: { ok: true, topic: null, guide: text } };
    }

    // A workflow topic?
    if (TOPIC_GUIDES[topic]) {
      return { result: { ok: true, topic, kind: 'workflow', guide: TOPIC_GUIDES[topic].body } };
    }

    // A tool the agent actually has?
    const tool = toolByName.get(topic);
    if (tool) {
      const body = TOOL_GUIDES[topic] ?? autoGuide(tool);
      log.debug({ agent: ctx.agentName, topic, curated: topic in TOOL_GUIDES }, 'guide served');
      return {
        result: { ok: true, topic, kind: 'tool', curated: topic in TOOL_GUIDES, guide: body },
      };
    }

    // Unknown, or a tool the agent doesn't have.
    const known = [
      ...relevantTopics.map(([slug]) => slug),
      ...available.map((t) => t.name).filter((n) => n !== 'guide'),
    ].sort();
    return {
      result: {
        ok: false,
        error: `no guide for "${topic}". Call guide() for the index. Available: ${known.join(', ')}`,
      },
    };
  },
};
