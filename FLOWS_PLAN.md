# Flows — a visual node graph for chaining agents, media generation and tools

> **Status: implemented.** Design record for `backend/src/flows/`, the `flows` / `flow_runs`
> collections, the `/api/flows` surface, the `run_flow` tool, and the `/flows` page. Source comments
> reference it as "flows spec §N", the way they reference `COMFYUI_MEDIA_PLAN.md`.
>
> **Verified live** against the compose stack: migration, node-type catalogue with its
> database-backed selects, save/validate/run/history/delete, execution with run-supplied inputs, a
> `condition` gating a branch (with the untaken side marked `skipped`), `for_each`/`collect` with one
> trace row per iteration, the `approval` gate answered over HTTP (409 on re-answer), the generic
> `tool` node, and refusal of invalid wires, bad expressions, dangling `{{refs}}`, cycles and
> unpaired loops. The canvas, palette, inspector, run rail and read-only run replay were checked in a
> browser.
>
> **Not yet exercised on real hardware:** the `ask_agent` / `router` nodes (need a reachable
> inference server) and the four media nodes (need the ComfyUI server + an imported workflow). Both
> call the same services the chat tools already use, through the same arguments.

## §1 Context

Every multi-step job in PleiadesAI is currently expressed *inside a model's head*: you ask an agent,
it decides which tools to call, in what order, and whether to hand off via `ask_agent`. That is the
right shape for conversation and the wrong shape for a repeatable production pipeline. "Write a
prompt with agent A, render it with ComfyUI workflow B, feed the still into a video workflow, wait
for me to approve it" should be a **program**, not a suggestion the model may or may not follow.

A **Flow** is that program: an operator-authored directed graph of typed nodes, executed by the
backend in a fixed order, with live per-node progress, run history, and three triggers — manual, a
cron schedule, or a tool an agent can call.

### Naming

`media_workflows` (imported ComfyUI graphs) already owns the word *workflow* across the model, the
Media page, the routes and every media tool's `workflow` config field. The new concept is **Flow**
everywhere — `/flows`, `flows` / `flow_runs`, `FlowNode`, `run_flow` — so no reader has to
disambiguate. A Flow *node* may run a ComfyUI *workflow*; those are different layers and keep
different names.

### §1.1 The one decision that buys most of the feature

**A flow run executes under `sessionId = <flowRunId>`.** Consequences, all free:

- every artifact a node produces is stored by `resourceRepository` as an ordinary session resource
  with an `img_N` / `blob_N` handle, and is previewable through the existing
  `GET /api/resources/:sessionId/:handle/content` — Range requests included, so a generated video
  scrubs in the run panel without a line of new streaming code;
- the Flow page joins the run's socket room with the existing `session:subscribe`, and immediately
  receives `stream_chunk`, `tool_progress` and `media_gen` from the agent and media nodes running
  inside it, because `bridge.ts` already routes every event by `ctx.sessionId`;
- an `ask_agent` node's sub-agents reach artifacts produced by earlier nodes **by handle**, through
  the `data` tool, exactly as they do in a chat session.

### §1.2 What this reuses

| Need | Existing seam |
|---|---|
| Run an agent headlessly | `agentRunner.run({ agentName, sessionId, depth, userText, images })` — `autonomy/agenda.setup.ts` already does this with a synthetic session id |
| Generate image/video/audio/edit | `media/media-generate.service.ts#generateMedia()` — a plain service; no `ToolContext` needed |
| Typed artifacts on edges | `domain/resources/` — GridFS-backed, session-scoped handles |
| Live progress | EventBus → `transport/ws/bridge.ts`, room = `ctx.sessionId` |
| Any tool as a node | `tools/registry.ts` — every core tool and enabled skill is a uniform `Tool` with a JSON-schema `parameters` |
| Per-node isolation | `agentContainerManager` + the `ToolContext` literal in `orchestrator/AgentRunner.ts` |
| DB-backed selects in a config form | `tools/config-options.ts#resolveDynamicOptions` (`optionsSource`) |
| Cron + inbox/Telegram fan-out | `autonomy/agenda.setup.ts`, `run-result.repository`, `alertEngine.dispatch` |

## §2 Port types

```ts
type PortType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'json' | 'signal';

interface FlowValue {
  type: PortType;
  text?: string;        // text / json rendering
  handles?: string[];   // image | video | audio | file — resource handles, never bytes
  json?: unknown;       // structured payload (tool results, lists)
}
```

Media never travels as inlined bytes: the bytes are already in GridFS under the run's session, so an
edge carries the **handle**. That is what keeps a 200 MB video out of the run document, and what lets
a downstream agent node reach the same artifact by name.

`signal` is the control-flow ("action") edge from the feature request: it carries no data, only
*"I finished, now you run"*. Every node also has an implicit ordering constraint from its data edges,
so `signal` is only needed to sequence nodes that don't exchange data.

**Compatibility** (`canConnect`, enforced server-side at validate time *and* client-side before an
edge is drawn):

| Source → target | Allowed |
|---|---|
| same type | yes |
| `image`/`video`/`audio`/`file` → `file` | yes (a file port accepts any binary) |
| anything except `signal` → `text` | yes (stringified) |
| `text` → `json` | yes (parsed; a parse failure is a run-time node error) |
| `signal` → anything but `signal` | no |
| `text` → `image` and friends | no |

## §3 Node catalogue

Every node type is a `FlowNodeHandler` in `backend/src/flows/nodes/`, registered in
`nodes/index.ts`. The registry is the **single source of truth** and is served to the frontend at
`GET /api/flows/node-types` (through `resolveDynamicOptions`), so the palette, the port colours and
the inspector form render themselves — a new node type needs no frontend change.

```ts
interface FlowNodeHandler {
  type: string;
  label: string;
  group: 'io' | 'agent' | 'media' | 'tool' | 'control';
  description: string;
  inputs: PortSpec[];            // { name, types: PortType[], required? }
  outputs: PortSpec[];           // { name, type }
  config: ToolConfigField[];     // the Tools-page field type, reused verbatim
  dynamicOutputs?(config): PortSpec[];   // router: one port per choice
  run(ctx, inputs, config): Promise<FlowValue | Record<string, FlowValue>>;
}
```

| Type | Group | Behaviour |
|---|---|---|
| `input` | io | Injection point — the "inject data into the graph" node. Config: port type + default value. Overridden per run from the run form / `run_flow` args / the cron schedule. Binary types (image/video/audio/file) are **uploaded** through the run form or the inspector and carried as a handle — see §6.1. |
| `output` | io | Terminal. Its value becomes `FlowRun.output` and the `run_flow` return value. |
| `log` | io | Debug **tap**: records what reaches it (type, handles, text, optionally the JSON) into the run trace and the node's live log. Deliberately a tap, not a pass-through — a pass-through would need one static output type, which either breaks the wire for every other type or makes the operator restate a type the graph already knows. Branch the source's output instead: one wire onward, one into the Log. |
| `data` | io | A value written into the graph — the constant to `input`'s parameter. Wire it, or quote it as `{{node_id}}` in **any other node's config field**, which is how a value reaches a setting that has no port (a clip duration, a house style suffix). Written once, changed once. |
| `note` | io | A comment card. No ports, no execution. |
| `ask_agent` | agent | `agentRunner.run()` as the configured agent. In JSON mode it can declare **output ports** — one text port per named field — so one agent can feed several nodes by wire instead of each node quoting `{{writer.json.field}}`. The dependency then sits on the canvas, is type-checked, and orders the graph. `userText` = prompt template + text inputs; `images` resolved from image-port handles. Outputs `text` + `images`. Yields to a live user session via `sessionLock`, like cron does. |
| `router` | agent | Agent judgement: a question plus N labelled choices; the answer picks one of N `signal` outputs. Unparseable answer → first choice, recorded on the node state. |
| `generate_image` | media | `generateMedia()` on the chosen `media_workflows` image workflow. → `image` handles. |
| `generate_video` | media | Kind `video`, from a prompt, a start frame, an optional soundtrack, **or a source clip** — a video workflow may bind `LoadVideo` (subtitling, restyling, interpolation), and the node offers every input its workflows might need. The service refuses clearly when the chosen graph binds none of them. A supplied clip also relaxes the empty-prompt guard: that guard stops a blank field regenerating the author's prompt, which cannot happen when the clip and the graph define the operation. |
| `generate_sound` | media | Same, kind `audio`. → `audio` handle. |
| `edit_image` | media | Same, kind `edit`; takes a source `image` input. → `image` handles. |
| `animate_image` | media | Image-to-video: a **required** still plus a motion instruction. `generate_video` can also take an image, but its list offers every video graph, and a text-to-video one ignores or refuses the picture — here the pairing is explicit. |
| `edit_video` | media | Video→video (restyle, upscale, interpolate), on its own `video_edit` workflow kind. Separate because a t2v graph has no `LoadVideo` to receive a clip, so offering it would only buy a run that fails after the queue wait. |
| `mix_video_audio` | media | Adds a track to a clip with a level for each side, optional ducking and looping. Unlike `video_compose mux` — which *replaces* the audio — both survive, which is what a clip that already speaks needs. The picture is stream-copied, so changing a volume never re-encodes a ten-minute render. |
| `tool` | tool | Any registered core tool or enabled skill. Args come from the tool's own JSON schema, rendered as templated fields. Runs through a `ToolContext` built like the runner's, honouring `run_as_agent` isolation. |
| `condition` | control | `expr.ts` over upstream outputs → `true` / `false` signal ports. |
| `approval` | control | Human gate: persists `pending` on the run, status → `awaiting_input`, blocks on `FlowApprovalBroker` until answered over HTTP. → `approved` / `rejected` signal ports. |
| `for_each` | control | Fan-out over a list (`json` array, handle list, or split text). Runs the body region once per item, concurrency 1–4. |
| `collect` | control | Closes a `for_each`; joins the body's per-iteration results into one list value. |
| `merge` | control | Joins several inputs into one text/list without a template. |

### §3.1 Identity — `run_as_agent`

Tool and media nodes carry an optional `run_as_agent`. When set, the executor builds the node's
`ToolContext` with that agent's id/name and lazily brings up its isolation container (or SSH jump
box) exactly as `AgentRunner` does — so a `bash` node can run on a remote host while the node next to
it runs in the backend. Unset means plain backend execution, and, as everywhere else in the app, a
container that can't be made ready surfaces `isolationError` rather than silently falling back.

## §4 Execution semantics

- **Validate** (on save and before every run): the graph is a DAG once each `for_each`/`collect`
  body is contracted to a single node; ports are type-compatible; `{{refs}}` resolve to real nodes;
  required inputs are wired or defaulted; at most one `output`.
- **Order**: topological. Independent branches run concurrently (bounded, default 4).
- **Templates**: `{{node_id.text}}`, `{{node_id.json.a.b}}`, `{{node_id.handles}}` interpolate any
  completed node's output into any string config field. This is the escape hatch that keeps the
  canvas readable — one prompt can splice three upstream results without three merge nodes, and it
  is the only way to drive a setting that has no port. **A reference is an ordering constraint**: a
  node waits for everything it quotes, since otherwise it could be scheduled first and silently
  interpolate an empty string. It delays but never skips — the quoted node may legitimately have been
  skipped on an untaken branch.
- **Skip**: the untaken side of a `condition`/`router`/`approval` marks its downstream reachable set
  `skipped`, minus anything still reachable by another path. Mechanically there is no reachability
  pass: a branching node simply omits the output ports it didn't take, and a node whose every
  incoming edge is dead is skipped in turn.
- **A value is only converted when the port can't take it as-is.** Coercing unconditionally to a
  port's first declared type flattens everything on a permissive port — `output` accepts every type
  and lists `text` first, so an image reaching it would arrive as a string and lose the handles that
  *are* the result.
- **Each pass of a `for_each` resets its body.** The live node states a page holds are keyed by node
  id, which has no room for "the same node, one shot later" — so a body node kept the previous
  iteration's tick and the canvas claimed work was done that had not been done for the current item.
  `flow:iteration_start` names the body so the page can clear it. The persisted trace never had this
  problem: it already carries one row per node per iteration.
- **A wired `signal` input is a gate.** If the branch feeding it wasn't taken, the node does not run
  — even when its data inputs are all sitting there ready. Without that rule a condition could never
  gate a node that also receives data from upstream, which is the main thing you'd put one in front
  of. Every node therefore exposes a `run` signal input, so anything can be sequenced or gated.
- **Abort**: one `AbortController` per run, threaded into `agentRunner.run({ signal })` and
  `generateMedia({ signal })` — stopping a flow also interrupts a queued ComfyUI job instead of
  leaving a GPU busy for nobody.
- **Recursion guard**: `flowDepth` (mirroring `HopGuard`) caps nested `run_flow` invocations, so a
  flow whose agent calls the same flow cannot loop forever.
- **Boot sweep**: runs left `running` / `awaiting_input` by a restart are failed at startup. A
  half-executed flow must never look live.

## §5 Events

`flow:run_start`, `flow:node_start`, `flow:node_progress`, `flow:node_end`, `flow:run_end`,
`flow:awaiting_approval` — added to `events.types.ts` and relayed by `bridge.ts` with the same
`io.to(ctx.sessionId)` line as every other event, where `ctx.sessionId` is the run id (§1.1).

## §6 Persistence

`flows`: `{ name (unique), description, enabled, nodes[], edges[], created_at, updated_at }`.

`flow_runs`: `{ flow_id, flow_name, status, trigger, session_id, inputs, nodes[] (per-node state,
timing, output, error), pending, output, error, started_at, ended_at }`.

Node outputs are truncated before persistence (text capped, handles kept) — the run document is a
trace, not a data store; the artifacts live in `resources`.

### §6.1 Uploaded inputs — the staging session

An upload can't be written into a run's session, because that session *is* the run id and doesn't
exist until the run starts. So each flow has a **staging session**, `flow-<flowId>`
(`flows/staging.ts`), which `POST /api/flows/:id/uploads` writes into (multipart, via the `multer`
already used by the fine-tune routes). It returns the handle, and that handle is the value the
`input` node stores — as a per-run override *or* as the node's default, so a flow can ship with a
file attached.

Staging per flow rather than per upload is what makes a file reusable: upload once, re-run any number
of times without re-uploading. At input time the runner **imports** the bytes into the run's own
session (`FlowNodeContext.importResource`), so every node downstream deals in one handle space and
the run's artifact list stays self-contained. Previewing a staged file needs no new route — the
existing `GET /api/resources/:sessionId/:handle/content` is generic over the session id.

A handle that isn't in staging fails the run with a message naming the node, rather than quietly
passing nothing along.

### §6.2 The debug trace

Every line a run produces — node output, the agent's streaming reasoning, each tool call, media
submissions, and node start/finish/error — lands in one **flat chronological list** on the run
document. Flat rather than nested per node because the question being asked is almost always "what
happened, in what order"; per-node buckets can't show that two nodes interleaved, and filtering to
one node is a view concern the Debug tab handles.

`RunLogBuffer` owns it, and exists for two reasons:

- **Write volume.** An agent node streams tokens, so persisting per chunk would be thousands of
  round trips per turn. Entries buffer in memory and flush on a 2s timer plus once at run end.
- **Unbounded growth.** A chatty `bash` node in a 20-item loop would otherwise walk the document
  toward Mongo's 16MB ceiling. Each node keeps a rolling 8KB window — capped per *node*, not per run,
  because a global cap lets one noisy node evict every other node's lines, which is exactly the
  context you still need when that node is the one misbehaving.

The agent/tool/media lines come free: those events already flow on the bus keyed by the run's session
id (§1.1), so the buffer just listens. They carry the *agent's* identity rather than the node's, so
the runner stamps the executing node before each step — best-effort attribution, since a region runs
nodes concurrently, and the alternative would put flow concerns inside the agent runner.

### §6.3 Media, as it is made

The run rail answers "what came out at the end". For a pipeline that renders for an hour that is the
wrong question — you want to see the third shot while the fourth is still rendering, and judge
whether to stop.

Artifacts therefore ride their own `flow:artifact` event, emitted the moment bytes are persisted
rather than when a node finishes. That timing matters twice: a node producing several files announces
each as it lands, and it catches artifacts leaving on a secondary port (an `ask_agent` node handing
images back) which a node-completion event would miss.

The Media tab renders them newest-first, tagged with the producing node and — inside a `for_each` —
the shot number. Nodes still rendering appear as live cards carrying ComfyUI's in-progress preview
frame, because ten minutes of empty grid is indistinguishable from a broken run. Full view is
portalled to `<body>`: the rail is `.glass`, and a `backdrop-filter` ancestor becomes the containing
block for `position: fixed`, which would otherwise trap a full-screen overlay in a 320px column.

## §7 Triggers

1. **Manual** — `POST /api/flows/:id/run` from the Flow page, with the `input` node values.
2. **Agent** — the `run_flow` core tool: list saved flows, run one by name with inputs, get the
   output text back plus any images (as `ToolResult.images`) and blobs (as `resources`).
3. **Cron** — the `flow:scheduled_run` Agenda job, alongside `agent:autonomous_run`, recording into
   `run_results` and firing `alertEngine.dispatch` so a finished flow reaches the inbox and Telegram
   like an autonomous task.
4. **MCP / CLI** — `tools/pleiades-mcp/endpoints.mjs` exposes the whole surface (read: `flows`,
   `flow`, `flow_node_types`, `flow_runs`, `flow_run`; write: create / update / delete / duplicate /
   validate / run / stop / approve). Writes need an API key carrying the **`flows:write`** scope,
   which covers *running* as well as editing — a run spends real GPU time and can drive agents, so it
   is not something a read-only key may trigger. `flow_node_types` is what makes authoring from the
   outside viable: it publishes every node type's ports and config fields with the database-backed
   options already resolved, so an external agent sees the agents, tools and workflows that actually
   exist rather than guessing.

## §8 Frontend

`/flows` (Operate group). The right rail carries three peer tabs — **Run** (inputs, controls, result),
**Debug** (§6.2's stream, filterable by node and by source), **Media** (§6.3), **Params** (the node inspector). They are
peers because they were previously fighting for one space: selecting a node replaced the run
controls, and a node's log was an unscrollable overlay pinned to the canvas. Clicking a node opens
Params and starting a run opens Debug, but any manual tab choice parks that until the next run, so
the rail is never yanked away mid-read.

`@xyflow/react` canvas styled onto the glass/starfield look (DIRECT_ART) — never the stock theme. Palette grouped by `FlowNodeHandler.group`; handles colour-coded per
`PortType` with a legend; incompatible edges refused as you drag. The inspector renders
`config: ToolConfigField[]` with the shared `Field`/`Input`/`Select`/`Toggle` kit, the same renderer
shape as the Tools page. The run panel generates its form from the flow's `input` nodes, subscribes
to the run's session room, and overlays live status, progress and ComfyUI preview frames on the
nodes themselves.
