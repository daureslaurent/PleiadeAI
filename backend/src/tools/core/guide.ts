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
