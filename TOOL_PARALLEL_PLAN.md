# Tool calls in parallel

A model that emits three tool calls in one assistant message has already decided they are
independent — that is what a `tool_calls` array *means*. It cannot see any of their results until
every one of them comes back, so there is nothing for it to "wait" for and nothing it could have
done differently. The runner, however, executed that batch strictly one call after another, so the
batch cost the **sum** of its calls.

Observed on prod (session `6aa4629d…`, agent `devops`, `Qwen3.8-27B-Q4_1`): ten batched messages
across six captures, including `read+read+bash` and, worst of all,

```
bash(curl cdn.playwright.dev)  → exit 28,  timed out
bash(apt-get update)           → exit 124, [timed out after 120000ms]
```

two independent 120s-capped commands, issued together, run back to back: four minutes of wall clock
before the model saw a single byte.

## What runs together

**The tool decides, per call.** `Tool.parallelSafe` is a boolean or a predicate over the call's own
arguments; `tools/parallel-safety.ts` is the only place the runner asks. The predicate form exists
because the big tools are verbs, not endpoints — one `forum` tool both reads threads and posts to
them, and a boolean would have to mark the whole tool unsafe and lose the common case.

| | |
| --- | --- |
| Safe | `read`, `list`, `grep`, `glob`, `annuaire`, `guide`, `web_search`, `webfetch`, `analyze_image`, `list_mail`, `read_mail`, `api_man`, `forum` (`list_categories` / `search` / `list_threads` / `read_thread` / `list_files`), `board` (`my_tasks` / `read_task` / `list_plan`), `data` (`list`) |
| Serial | everything else — **absent means serial**, so a new tool is safe by default |

Deliberately serial, with reasons: `api` (whether an operation is a GET or a POST lives in the
`api_sources` document, not in the model's arguments), `forum.get_attachment` and `data.store` (they
pull bytes into the turn's resource pool, whose handles are assigned in completion order), and every
**skill** (sandboxed user code behind a circuit breaker that counts consecutive failures — a race
would corrupt that count).

## How it runs

`planToolGroups` cuts a batch into runs *before* executing any of it:

- consecutive parallel-safe calls form one group; anything else is a group of one;
- **order across groups is preserved** — a write between two reads splits them, so `read, write,
  read` stays exactly that;
- **a repeat closes the group** — the duplicate short-circuit answers an identical second call from
  a cache the first one fills, which only works if the first has already finished.

Each call in a group writes its messages into **its own buffer**, and the buffers are spliced into
`messages` in the model's emission order once the group settles. A tool result landing before the
assistant's earlier `tool_call` message would be malformed chat, so completion order is never
allowed anywhere near the transcript: **the prompt the model reads back is byte-identical to the
sequential one.** Concurrency is capped by `runWithConcurrency`.

## Settings → Fleet

| Field | Default | |
| --- | --- | --- |
| `tool_parallel_enabled` | `true` | off restores strictly sequential execution |
| `tool_parallel_max` | `4` | calls in flight at once; **`0` is unlimited** |

Migration `20260911210000-tool-parallel.js` sets both on existing instances.

## In the chat

A batch renders as **one group card** with **a waterfall bar per call**, because two separate things
have to be communicated and only one of them is "these ran together":

- the *card* says the model asked for these as a unit;
- the *bars* answer the question an operator actually has when a batch is slow — **which one held it
  up**. Three 0.2s calls and one 1.8s call are indistinguishable as text; as bars, one of them
  obviously owns the batch. Each bar is placed at its call's offset within the batch's own wall
  clock, never merely sized by its duration.

Each row expands into the full tool card (already open — a row is one click, not two) and, above it,
the call's **complete arguments**. Every header in the app truncates a call to one line, which is
right for scanning and useless the moment you want to know what a long `bash` command actually ran.
`ToolInput` shows the primary string argument verbatim in a scrollable pre, the rest as JSON. The
same fix landed in `BashBlock`, whose expanded card previously showed output but never the command.

Wire: `tool_start` and `tool_end` carry `batch { id, index, size }` (set only when a call actually
overlapped others) plus `startedAt` / `durationMs`. Both the client reducer and the server-side
`TurnRecorder` keep them, and `messages.blocks` is `Schema.Types.Mixed`, so the grouping survives a
reload. `groupBatches` in `Blocks.tsx` folds neighbouring blocks sharing a `batch.id`; the Workbench
layout (`toolStyle: 'none'`) skips it, having moved tools into its trace column entirely.

## The prompt module

`parallel-tools` (`modules/definitions/core.ts`, group **core**, ships **on**, ordinary toggle on
Settings → Modules) contributes one `system_head` block, *Calling several tools at once*, right
after the tool-use contract. Without it the fleet batches only when the work obviously decomposes;
with it, batching is the habit.

Two things the block is careful about:

- **It never promises what this instance doesn't do.** The "they run at the same time" sentence is
  rendered from `ctx.toolParallel`, which `AgentRunner` fills from the same two settings the runner
  obeys. With execution off it says so — and points out that batching still saves an inference pass
  per call, which is true either way and is why the module is worth having on a serial instance.
- **It states the counter-instruction in the same breath.** A model that batches a `read` with the
  `edit` it implies has made things worse, not faster, so "issue it alone and wait" is part of the
  same paragraph rather than a footnote.

Switching the module off stops agents being *told* to batch. Whether batches that arrive anyway
overlap is `tool_parallel_enabled` on Settings → Fleet — a property of the backend, not of the
prompt. Both keys are listed on the module's row (`settingsKeys`).

## Known gap

`read`, `list`, `grep`, `glob` and `annuaire` are root-owned in this working tree, so their
`parallelSafe: true` lives in `UNDECLARED_READ_ONLY` in `tools/parallel-safety.ts` instead of on the
tools themselves. `sudo chown -R $USER:$USER` on those files, then move each declaration onto its
tool and delete the set.
