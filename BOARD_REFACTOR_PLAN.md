# Board refactor: tasks + projects, AI-assisted creation, a PM chat on every item

## Context

Today the Board can only create **projects**, from a single "Goal" textarea (`frontend/src/views/board/BoardView.tsx`).
A plan (`forum_plans`) has no name and no description. One PM serves the whole fleet
(`settings.forum_project_manager_agent`), and it only acts in one-shot turns: "Plan it"/"Replan", or a
scheduler escalation. The operator can't *talk* to the PM: they can't add a feature, ask how things
are going, or re-scope. Standalone tasks exist in the backend (`plan_id: null`) but the UI can't create them.

What we want:
- Create either a **small task** or a **full project** from one form.
- The operator writes a full prompt, picks an agent and presses **Analyse**. The agent suggests a name,
  a description, acceptance criteria and (for a task) an owner and reviewer. Every field stays editable.
- Opening an item shows the board next to a **chat with its PM**, who can report progress and
  propose changes. The operator applies those changes.

## Decisions (operator-chosen, 2026-09-13)

| Question | Decision |
|---|---|
| Task vs project | **One model.** `forum_plans.kind: 'task' \| 'project'`. A task is a plan with exactly one task filed straight from the form. Both get the same page, chat, budget and review. |
| Analyse fills | Name, description, acceptance criteria, owner/reviewer (owner/reviewer only for `kind: task`). |
| Agent selects | **Two selects.** An *analyser* (fills the form, one-shot) and a *PM* (becomes `plan.manager`, defaults to the fleet setting). |
| After create | **Auto-plan, stay draft.** A project gets a manager turn immediately. A task is filed directly. Nothing dispatches until Start. |
| PM powers in chat | **Proposes, operator confirms.** Chat turns can't write to the board. They produce a proposal. |
| Confirm scope | **Chat only.** Automatic manager turns (first plan, escalation replans) still write directly, as today. |
| Apply granularity | **Per change**, with checkboxes, *Apply selected*, *Apply all* and *Reject*. |
| Layout | Board on the left, **PM chat docked on the right** (collapsible). It stacks under the board on narrow screens. |
| Sessions | **One persistent session per plan.** Automatic manager turns land in the same session, so the chat is the project's full history. |
| Budget | Chat turns **don't** count against `turns_max`. Automatic manager turns still do. |
| Legacy | Keep hub and task forum threads. Migrate existing plans to `kind: project`, with a name taken from the goal. |
| Board list | One list with a kind badge and filters: All / Projects / Tasks / Needs you. |

First step of the build: copy this plan into a repo-tracked `BOARD_REFACTOR_PLAN.md` (the spec the code comments will reference).

---

## Backend

### 1. Data (+ one migration, `backend/migrations/2026091xxxxxxx-board-refactor.js`)

- **`forum_plans`** (`domain/forum/forum-plan.model.ts`), new fields:
  - `kind` (`'task'|'project'`, default `'project'`)
  - `name` (required after backfill)
  - `description`
  - `acceptance: string[]` (project-level criteria; for a task they seed the task)
  - `chat_session_id` (ObjectId → Session, the persistent PM conversation)
  - `goal` stays and holds the operator's original prompt verbatim. The manager still replans against it.
- **`sessions`** (`domain/sessions/session.model.ts`): add `'board'` to the `origin` enum, and a new
  `board_plan_id` field (indexed).
- **`messages`** (`domain/sessions/message.model.ts`): optional `source: 'board'` on a user message.
  It marks a brief the board wrote (a plan or replan request) so the chat draws it as a compact system line rather than
  as the operator speaking.
- **New `forum_plan_proposals`** (`domain/forum/forum-proposal.model.ts` + repository):
  - Proposal fields: `plan_id`, `session_id`, `run_id`, `summary`, `state`
    (`pending|applied|partial|rejected|superseded`), `created_at`, `decided_at`.
  - `ops[]`: `{ op_id, op: 'add_task'|'patch_task'|'cancel_task'|'patch_plan', ref?, args, status: 'pending'|'applied'|'rejected'|'failed', error, task_id }`.
  - `ref` is a temporary handle (`"new1"`) that later ops can use in `depends_on`.
  - A new proposal supersedes any earlier pending one for the same plan, so there's always one live proposal.
- Migration: backfill existing plans with `kind: 'project'`, `name: goal` truncated to 80 chars, `description: ''`,
  `acceptance: []` and `chat_session_id: null` (created lazily on first open). Create the indexes on
  `forum_plan_proposals`. Never edit existing migrations.

### 2. Analyse: `domain/forum/board-analyse.service.ts` + `POST /api/board/analyse`

- Input: `{ prompt, agentId, kind? }`. A **one-shot structured completion** on the analyser agent's resolved
  endpoint and model. Copy `domain/scoring/judge.service.ts`: `response_format: json_schema`,
  plus its fallback when the endpoint rejects `response_format`.
- Output schema: `{ kind, name, description, acceptance[], owner, reviewer }`.
- The prompt includes the fleet roster (`loadRoster()` from `domain/forum/forum-roster.ts`), so owner and reviewer
  are real names. The server then drops unknown names and a reviewer equal to the owner.
- No session is created and no plan turn is spent. It returns suggestions only.

### 3. Create: `forumPlanService.create` (`domain/forum/forum-plan.service.ts`)

- New input: `{ kind, name, description, goal, acceptance, managerAgentId?, owner?, reviewer? }`. The manager is
  `managerAgentId` if given, else `resolveManager()`.
- Steps:
  1. Hub thread (title = `name`). Unchanged otherwise.
  2. Plan document.
  3. **PM chat session**: `sessionRepository.create({ origin: 'board', board_plan_id, agent = manager, title = name })`,
     stored as `chat_session_id`, and emit `conversation:session_created`.
- `kind: 'task'` → `forumTaskService.fileTask` with goal = description (or name), plus the acceptance, owner and reviewer.
  The existing rules apply: acceptance required, reviewer ≠ owner. The plan stays `draft` and no manager turn runs.
- `kind: 'project'` → `runManager(planId, '')` right away. The plan stays `draft`.
- New helper `ensureChatSession(plan)` for legacy plans (used by `GET /plans/:id`).

### 4. Manager turns run in the chat session

- `runManager`: use `ensureChatSession(plan)` instead of creating a new session.
  - `manager_session_id` stays the in-flight marker and now holds the chat session id.
  - If `liveRuns.has(chatSessionId)` (the operator is mid-chat), return `null`. The scheduler retries on its next tick and
    the route answers 409.
  - Persist the brief with `source: 'board'`.
- `forumTaskRunner.drive` (`domain/forum/forum-task-runner.ts`) gets an optional `board` argument, passed through to `agentRunner.run`.
- Turn accounting stays as it is: `claimTurn` is still called for manager turns.

### 5. Run context: `board` on `RunInput` / `ToolContext`

- Copy the `autoLoop` precedent (`orchestrator/AgentRunner.ts` `RunInput`, `tools/types.ts` `ToolContext`):
  `board?: { planId: string; mode: 'auto' | 'chat' }`. It is only ever set by the backend.
  - `runManager` passes `mode: 'auto'`.
  - `transport/ws/socket.ts` `chat:message`: look the session up, and if `origin === 'board'` pass
    `{ planId: session.board_plan_id, mode: 'chat' }`.
- Chat turns do **not** call `claimTurn`.

### 6. `board` tool (`tools/core/board.ts`)

- `planId()` checks `ctx.board.planId` first, then `findByManagerSession` (keeps working for older runs).
- When `ctx.board.mode === 'chat'`:
  - `file_task`, `patch_task` and `finish_plan` are refused with an error that points at `propose`
    (the model can retry in the same turn).
  - `list_plan` and `read_task` still work.
- New action **`propose`** (`{ summary, changes[] }`), accepted **only** in chat mode:
  - A dry-run validator in `domain/forum/forum-proposal.service.ts` checks that owners and reviewers exist, that the reviewer
    isn't the owner, that acceptance isn't empty on `add_task`, and that `patch_task`/`cancel_task` target a task of this plan.
    It also checks that `depends_on` resolves to a plan task or an earlier `ref`, with no cycle.
  - It then saves the proposal and returns `{ ok, proposal_id, note: 'shown to the operator — end your turn' }`.
  - Validation errors come back as `ok: false` so the model fixes them in the same turn.
- `parallelSafe` stays as it is (`propose` writes).

### 7. Apply / reject: `forum-proposal.service.ts` + routes

- `POST /api/board/proposals/:id/apply { opIds? }`:
  - Runs the selected ops in order through the existing `forumTaskService.fileTask` / `patch`
    (`cancel_task` = patch `state: cancelled`) and `forumPlanRepository.update` (for `patch_plan`: name,
    description, acceptance).
  - Author is the plan's manager, and the log records the operator as approver.
  - `ref`s are mapped to real ids as tasks get created. An op whose dependency failed is marked `failed`.
  - Unselected ops become `rejected`. The proposal ends as `applied` or `partial`.
- `POST /api/board/proposals/:id/reject` and `GET /api/board/plans/:id/proposals`.
- The PM finds out what was applied through the prompt block (§8), so no message has to be injected.

### 8. Prompt block: the board module (`modules/definitions/work.ts`)

- New block `board-project`, placement `system_tail`, rendered only when `ctx.board` is set.
- `AgentRunner` prepares a plan snapshot into `PromptContext` only when the board module is enabled ("modules render,
  they never fetch"). The snapshot holds name, description, goal, state, turns, the tasks table (id, state, owner, reviewer,
  deps, blocked_on, delivered?) and the latest proposal with each op's status.
- Chat-mode text: you are this item's PM talking with the operator. Answer progress questions from the
  snapshot and `read_task`. Every change goes through **one** `propose` call per turn. Don't claim to have changed anything.
- Auto-mode keeps the existing `planBrief`.
- `prompt-usage.ts` picks up the block title from the registry automatically.

### 9. Routes (`transport/http/routes/board.routes.ts`)

- `GET /plans` adds `kind`, `name`, `description`, `pendingProposal` (boolean) and `needsYou`
  (blocked, review with no agent reviewer, or a pending proposal).
- `GET /plans/:id` adds `chatSessionId` (via `ensureChatSession`) and the manager's `agent_id`.
- `POST /plans` accepts the extended body. `PATCH /plans/:id` also accepts `name`, `description` and `acceptance`.
- The scheduler (`forum-scheduler.ts`) needs no logic change. A one-task plan finishes through the same
  "nothing pending" path. The only addition: a `runManager` that returns `null` because the chat is live is just retried on the next tick.

---

## Frontend

### 1. `lib/api.ts`

- `boardApi.analyse`, an extended `createPlan`, `proposals`, `applyProposal`, `rejectProposal`.
- Types: `BoardPlan` gains `kind`, `name`, `description`, `acceptance`, `chatSessionId`, `pendingProposal`
  and `needsYou`. New types `BoardProposal` and `BoardProposalOp`.

### 2. `views/board/BoardView.tsx`: one list

- A segmented filter: All / Projects / Tasks / Needs you (the same control as `PlanView`'s task filter).
- Each card shows a kind badge, name, a 2-line description, progress (projects), owner→reviewer (tasks),
  the state badge, a "proposal waiting" chip and the escalation text.
- "New" opens `CreateItemPanel`.

### 3. New `views/board/CreateItemPanel.tsx`

- A large prompt textarea, then a Task/Project toggle.
- A row with the **Analyser** agent select and an **Analyse** button (with a spinner). It fills the fields below, and the kind
  toggle takes the suggested kind unless the operator has already touched it.
- Editable fields: name, description, acceptance (an editable list with add/remove), and for Task only owner + reviewer selects.
- **PM** agent select, defaulting to the fleet PM setting.
- *Create* is enabled once the prompt, name and description are filled, plus (Task) an owner and ≥1 criterion.
  Filling by hand works just as well as Analyse.
- After creation, navigate to `/board/:id`.

### 4. `views/board/PlanView.tsx`: two columns

- Left column: the existing header and task cards. The header shows `name`, the description, and a collapsible "Original prompt" (`goal`).
  For `kind: task` the tasks section renders the single task open, without filters.
- Right column: `PmChatPanel`, collapsible (the collapsed state is kept in `usePrefs`). It stacks under the board below `lg`.

### 5. New `views/board/PmChatPanel.tsx`

- On mount: `sessionsApi.messages(chatSessionId)` → `useStream.hydrate(sessionId, msgs, managerAgentId)`, and
  `clearActive()` on unmount.
  - The store is a singleton with one active session. That's fine because the board page and the Workspace are never on screen together.
  - Persistence is already handled inside the stream store (`stream.ts` `addMessage` on done).
- Rendering: reuse the conversation view through `ChatLayoutContext` + `components/workspace/conversation`
  (tool cards, thinking), plus a compact composer calling `send(managerName, text, chatSessionId)` and Stop.
  If `ChatPanel.tsx`'s composer can't be reused as-is, extract its textarea/send core into a shared component rather than copying it.
- Messages with `source: 'board'` render as a one-line system note ("Board asked the PM to plan / replan: …").
- When a turn finishes, reload the plan and its proposals.

### 6. New `views/board/ProposalCard.tsx`

- Shown pinned above the composer while a proposal is pending, and inline in the chat for a `board` tool block whose
  result carries `proposal_id` (a hook in `components/ToolCall.tsx`, like `MEDIA_TOOLS`).
- Each op gets a checkbox and a readable diff:
  - add task: goal, owner→reviewer, criteria, deps (refs shown by goal)
  - patch: field old → new
  - cancel: the task's goal
- Buttons: **Apply selected**, **Apply all**, **Reject**. Per-op failures are shown after apply.

### 7. Theming

Only Tailwind tokens and the `.hairline` / `.raise-*` / `.well` classes. No hex values.

---

## Docs

- `BOARD_REFACTOR_PLAN.md` at the repo root (this plan, as the spec).
- Update the board paragraph in `CLAUDE.md`: kinds, the PM chat session, proposals, and the `board` run context.

## Verification

1. `npm run typecheck` in `backend/` and `frontend/`, then `npm run migrate:up` (and `migrate:status`). Check that
   existing plans got `kind`/`name`.
2. Rebuild and restart the backend (it runs from `dist`). Enable the Board module and `forum_board_enabled`.
3. **Task**: New → paste a prompt → pick the analyser → Analyse. Check that name, description, criteria and owner/reviewer are filled
   with real agents → edit one → Create. The plan is `draft` with one task, and the PM chat session exists.
4. **Project**: create one → the chat shows the "Board asked the PM to plan" line and the manager turn streaming live →
   tasks appear, the plan stays `draft`, `turns_spent` = 1.
5. Chat "what's the progress?" → the answer comes from the snapshot, no writes, and `turns_spent` doesn't change.
6. Chat "add a feature X and make task Y depend on it" → a proposal card with 2 ops. Apply one →
   the board shows just that change, and the proposal is `partial`. The next chat turn mentions what was applied.
7. Make the PM call `file_task` directly in chat (e.g. tell it to) → it gets refused, and it retries with `propose`.
8. Start the project and block a task → the escalation replan shows up in the same chat and writes directly.
   While typing in the chat, confirm an escalation waits instead of racing.
9. Open an old plan → a chat session is created lazily and the page works.

---

## Implementation notes (as shipped)

Where the build differs from, or adds to, the plan above:

- **Inline proposal card is read-only.** A `board` `propose` tool call renders as
  `components/BoardProposalBlock.tsx` (summary, per-line status, a *review* link while pending). The
  only live Apply/Reject is the card pinned above the PM chat composer (`views/board/ProposalCard.tsx`),
  so one proposal never shows two sets of buttons a scroll apart. Both refresh on the
  `board:proposal-changed` window event.
- **`GET /api/board/proposals/:id`** was added for that inline card.
- **Chat mode refuses more than the planning verbs**: `file_task`, `patch_task`, `finish_plan`,
  and also `submit`, `block` and `review`, since a manager's chat is not a dispatched work turn.
- **Chat collapse state** lives in `localStorage` (`pleiades.board.chatCollapsed`), not `usePrefs`:
  it is a per-browser convenience, and prefs persistence mirrors appearance to the settings doc.
- **Task items require an owner and ≥1 criterion** at create time (form and API). A task whose
  filing fails (unknown owner, owner = reviewer) removes the half-created item again.
- **Applying new work to a `done`/`cancelled` item reopens it as `draft`**, so a closed project never
  starts dispatching again without Start.
- **Operator-reviewed tasks.** "Needs you" and the Accept/Send back buttons now also cover a task
  whose reviewer *is* the operator (not only a null reviewer) — `submit` stores the resolved reviewer,
  so the old `!task.reviewer` test missed exactly those.
- New LLM call source `board-analyse` (llama-log enum + frontend type), and a `board` origin icon in
  the Workspace navigator.
