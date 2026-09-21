# RUN_QUEUE_PLAN — one lane for the fleet's autonomous turns

> Status: in build (2026-09-21). Operator decisions taken in the session that opened this file are
> recorded in §1; everything else follows from them.

## 1. What the operator asked for

A tab on the GitLab page listing **the LLM calls that still have to happen** — which agent, what woke
it, where it came from — in the order they will run, **one after another**.

Four decisions, made explicitly:

1. **The tab lists GitLab wakes only.** The other sources exist in the lane but are not enumerated
   there; a GitLab row waiting behind a forum run is explained by a one-line banner naming the
   holder, so a waiting row is never unexplained.
2. **The lane is enforced, not merely observed.** Today `gitlab-wake-runner.ts` and
   `forum-wake-queue.ts` are two independent in-memory queues, each serial *within itself*: a GitLab
   wake and a forum wake can hold the single inference server at the same time, and a cron tick can
   join them. One shared lane replaces both drains.
3. **Mongo-backed, with history.** `queued → running → done | failed | cancelled | interrupted`,
   with agent, source, trigger, project, session link, wait time and run duration. Surviving a
   restart is the point: "why did nothing run last night" has to be answerable after the fact.
4. **The operator can act**: cancel a queued row, pause/resume the lane, and promote a row to the
   front.

## 2. What enters the lane, and what deliberately does not

In the lane — nobody is sitting in front of these, so making them wait costs nothing:

| source | entry point | resumable after a restart |
|---|---|---|
| `gitlab` | webhook wake, poll wake, **Check now** | yes — the row carries the whole `WakeDecision` |
| `forum` | `forumWakeQueue.enqueue` (a post's `wake` argument) | yes — the row carries the mention id |
| `cron` | the Agenda autonomous job | yes — the row carries agent + prompt + schedule id |
| `auto_loop` | an auto-loop tick | no — the tick's caller is a timer in this process |

Out of the lane, and why:

- **Operator chat** (`socket.ts`) and **Telegram** — a human is waiting on the answer. They keep
  their existing priority: `SessionLock` already makes a background run yield to a live chat.
- **Flow agent nodes** — a flow is *already* a deterministic order, and an agent inside a queued run
  can call `run_flow`. Putting a flow node in the lane would let a run wait on a lane held by the
  run that started it: a deadlock, for no gain.
- **Sub-agents and `ask_agent` hops** — they are part of a turn that already holds the lane.

## 3. Shape

`domain/run-queue/`:

- `run-queue.model.ts` — collection `run_queue`. Fields: `source`, `kind`, `origin` (one line: how it
  arrived — `webhook`, `poll · todo`, `Check now`), `agent_id`/`agent_name`, `title`, `detail`
  (`project`, `url`), `payload` (what the handler needs to run it), `priority`, `status`,
  `session_id`, `error`, `dedupe_key`, `queued_at`/`started_at`/`ended_at`.
- `run-queue.repository.ts` — insert, **claim** (`findOneAndUpdate`, sort `priority desc, queued_at
  asc`, `queued → running`, which is also what makes a double drain harmless), finish, cancel,
  promote, list, and `recover()` at boot (a row left `running` by a dead process becomes
  `interrupted` — it did not finish and nothing is going to finish it).
- `run-queue.service.ts` — the lane itself. `register(source, handler)` at boot, `enqueue(row)`,
  `enqueueAndWait(row)` for a caller that needs the turn's result, `pause`/`resume`, `cancel`,
  `promote`, `snapshot`. One drain loop, one row at a time, re-reading the pause flag at each claim.
  A queued row whose source has no registered handler is marked `interrupted` rather than retried
  forever.

Handlers live with their source (`gitlab-wake-runner.ts` registers `gitlab`), so the lane knows
nothing about GitLab, the forum or cron.

Pause is `run_queue_paused` on the settings singleton, so it survives the restart it exists for.

## 4. Routes

A dedicated `transport/http/routes/run-queue.routes.ts`, mounted at `/api/run-queue` behind
`requireAuth` — the lane is not a GitLab concept even though the only page showing it is GitLab's:

- `GET /api/run-queue?source=gitlab&limit=25` → `{ paused, running, holder, queued[], history[] }`.
  `running` is the GitLab row in flight if there is one; `holder` names the *other* source's row when
  the lane is held by something the tab does not list.
- `POST /api/run-queue/pause` `{ paused }`
- `POST /api/run-queue/:id/cancel` — queued rows only; a running turn is stopped from the Workspace.
- `POST /api/run-queue/:id/promote` — above every other queued row.

**Check now** changes shape: it enqueues (priority 10) instead of starting a turn inline, so it
answers `{ queued: true, id }` rather than a session id. The row grows a `session_id` when it starts,
which is what the tab links to.

## 5. The tab

`Queue` on `/gitlab`, fifth: *what exists*, *what did they do*, *what is in flight*, *is it green*,
**what is about to run**. Running card (agent, trigger, project, elapsed, link to the session), the
ordered queue below it with position, waiting time and the two buttons, then the last 25 finished
rows with status, duration and session link. Polls every 3s while the tab is open.
