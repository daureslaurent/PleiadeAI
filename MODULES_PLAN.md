# MODULES_PLAN.md — the prompt/capability module system

## 1. Why

Today an agent's prompt is assembled by two files that know about every feature in the app.
`domain/agents/jit-builder.ts` hard-codes a dozen `renderXBlock()` functions and glues them in a
fixed order; `orchestrator/AgentRunner.ts` then string-concatenates the memory block, the forum
block and the mode suffixes onto the same message. Adding a feature means editing the orchestrator.
Turning one *off* is not possible at all — an install that never uses the forum still pays for the
roster line, and an install with no media server still tells every agent how to forward an image.

The capability half has the mirror problem: enablement is scattered across `tool_configs.enabled`
(Settings → Tools), `settings.forum_board_enabled`, `settings.forum_auto_reply`,
`settings.scoring_enabled`, `settings.memory_distill_enabled`, `settings.update_enabled`. There is
no page that answers "what is this instance actually made of".

A **module** is one answer to both. It owns a slice of the prompt, the tools that slice talks about,
and the settings that tune it. `Settings → Modules` lists every one of them with a switch.

`domain/llama-logs/prompt-usage.ts` already anticipates this: its `modules` field is documented as
*"today these are the hard-coded jit-builder renderers, tomorrow they are the enabled modules"*.
This plan is that tomorrow, and the debugger's context breakdown becomes module-accurate for free.

## 2. What a module is

```ts
export interface PromptModule {
  id: string;                       // 'forum', 'todo', 'visuals' — stable, it is the storage key
  name: string;                     // 'Forum'
  description: string;              // one line, shown on the settings row
  group: ModuleGroup;               // how the page clusters rows
  /** Cannot be switched off. The clock and the tool-calling contract are load-bearing. */
  mandatory?: boolean;
  /** Ships off; the operator opts in (the board, which is a scheduler that spends turns). */
  defaultEnabled?: boolean;         // default true
  /** Core tools this module owns. Disabling the module drops them from every agent's toolset. */
  tools?: string[];
  /** Settings keys the module's detail view surfaces (existing keys — no data migration). */
  settingsKeys?: string[];
  /** The prompt this module contributes. Absent for a tools-only module. */
  blocks?: PromptBlock[];
}

export interface PromptBlock {
  /** `## <title>` the block renders with — also how `prompt-usage` recognises it. */
  title: string;
  placement: 'system_head' | 'system_tail' | 'system_suffix' | 'user_suffix';
  order: number;                    // within the placement
  /** Static-text blocks may have their wording overridden by the operator; dynamic ones may not. */
  overridable?: boolean;
  render(ctx: PromptContext): string | null;
}
```

Two rules keep this honest:

- **Modules render, they do not fetch.** `render` is synchronous and pure over a `PromptContext`
  the runner prepares. Vector recall, forum queries and todo reads stay in `AgentRunner`, which is
  also where they can be *skipped* when the owning module is off — the real saving is the Qdrant
  round-trip that never happens, not the tokens.
- **Placement, not concatenation.** `system_head` renders before the operator's authored
  `system_prompt`, `system_tail` after it, `system_suffix` last of all. That ordering is the
  existing authority contract (operator-owned before, agent-writable after, conversation modes last)
  and it survives the refactor unchanged.

## 3. The register

`backend/src/modules/` — the user-facing name of the directory is the point.

```
modules/
  types.ts               PromptModule, PromptBlock, PromptContext, ModuleGroup
  registry.ts            MODULES[] + byId() + blocksFor(placement) + toolOwner()
  state.service.ts       enabled set / overrides / custom modules, over the settings singleton
  assemble.ts            buildSystemMessage / buildUserSuffix from the enabled registry
  definitions/
    core.ts              environment, tool-use, session
    operator.ts          house-rules, agents-md, parameters
    self.ts              notebook, todo, memory
    work.ts              orchestration, forum, board, auto-loop
    capabilities.ts      visuals, desktop, android, files, shell, web, apis, flows, automation, mail
    modes.ts             active-modes (system_suffix + user_suffix in one module)
```

`domain/agents/jit-builder.ts` keeps the message *types* (`ChatMessage`, `ContentPart`,
`buildUserMessage`) and the individual `renderXBlock` functions — they move to being the `render`
bodies of their modules, imported by `definitions/`, so the wording and its comments survive intact
and the diff stays reviewable. `buildSystemMessage` moves to `modules/assemble.ts`.

## 4. The modules

Prompt-bearing (one per block, as they exist today):

| id | block(s) | placement | tools it owns | notes |
|---|---|---|---|---|
| `environment` | Environment | head 10 | — | **mandatory** — no clock, hallucinated dates |
| `parameters` | Local Parameters | head 20 | `set_agent_parameter` | |
| `house-rules` | House rules | head 30 | — | `settings.agents_md` |
| `agents-md` | AGENTS.md | head 40 | — | per-agent charter |
| `orchestration` | Orchestration | head 50 | `annuaire`, `ask_agent`, `ask_parent` | top-level agents only |
| `tool-use` | Tool use | head 60 | — | **mandatory** — the function-calling contract |
| `notebook` | Notebook | tail 110 | `update_notebook` | |
| `todo` | Task list | tail 120 | `todowrite` | |
| `auto-loop` | Auto loop | tail 125 | `loop_done` | |
| `memory` | Memory | tail 130 | `remember`, `forget` | off ⇒ recall + embedding skipped |
| `board` | Board | tail 140 | `board` | **ships off** — see §6 |
| `forum` | Forum | tail 145 | `forum`, `forum_admin` | off ⇒ 6 recall queries skipped |
| `visuals` | image-handle note | user 10 | `generate_image`, `generate_video`, `generate_sound`, `edit_image`, `analyze_image` | |
| `modes` | Active modes | suffix 900 + user 900 | — | both placements, one module |

Tools-only (they own no prompt text but are part of what the instance is made of):

`session` (`data`, `guide`, `ask_user` — mandatory: an agent that cannot ask has to guess) · `files` · `shell` (`bash`) · `web` (`web_search`,
`webfetch`) · `apis` (`api`, `api_man`) · `flows` (`run_flow`) · `automation` (`schedule_task`) ·
`mail` · `desktop` (`visual_*`) · `android` (`android_*`).

Every core tool belongs to exactly one module, and the registry throws at import if two claim the
same one. This is *not* the same axis as `CATEGORY_BY_TOOL` in `tools/registry.ts`, which stays:
a category groups tools by the verb they perform (the rail on the Tools page), a module groups them
by the capability they belong to — which is the thing that gets switched off. `analyze_image` is
`media` by verb and `visuals` by capability, together with the prompt note that makes an image
reachable at all. `toolModuleId()` exposes the second axis, and the tools API sends both.

## 5. Storage

On the settings singleton, mirroring how built-in modes already store their off-switch as a list of
ids rather than a row per module:

```
modules_disabled:  [String]   // ids the operator switched off
module_overrides:  Mixed      // { [moduleId]: { [blockTitle]: "replacement text" } }
modules_custom:    [ { id, name, description, text, placement, order, enabled } ]
```

Custom modules carry a `custom:` id prefix, and the settings route refuses to persist any built-in
id inside `modules_custom` — the same guard `builtin:` gives the mode list. A custom module is
static text only (no `render`), which is exactly what a `global_mode` is minus the composer chip;
the difference is that a module is standing and structural, a mode is picked per conversation.

`settings.routes.ts` whitelists all three keys explicitly. (The one rule about that file.)

## 6. Subsuming the switches that already exist

- **`tool_configs.enabled`** stays as the per-tool detail level. Effective enablement becomes
  `moduleEnabled(owner(tool)) && toolConfig.enabled` — `resolveTools()` gains the first clause.
  Settings → Tools becomes the detail view reached from a module row; no data migration.
- **`forum_board_enabled`** becomes the `board` module's switch. Migration seeds
  `modules_disabled` with `board` unless the flag was already true, so an upgrade cannot start a
  scheduler that was off. The field stays on the document and is written by the module toggle, so
  `forum-scheduler.ts` needs no change.
- **`forum_auto_reply`, `forum_post_contract_enabled`, `forum_tick_interval_minutes`, …** stay
  where they are and are listed as the forum/board module's `settingsKeys`, rendered by the same
  controls the Fleet panel uses. Subsumed in the UI, untouched in the data.
- **`memory_distill_enabled`** → `memory` module's settings key. **`scoring_enabled`**,
  **`update_enabled`** stay on their own panels; they are not agent-facing capabilities.

## 7. AgentRunner after the refactor

```ts
const mods = await moduleState.resolve();            // one settings read, already fetched per turn

const recallVector = mods.enabled('memory') || mods.enabled('forum') ? await embed(q) : null;
const recalled     = mods.enabled('memory') ? await agentMemory.recall(...) : [];
const forumInput   = mods.enabled('forum')  ? await forumRecall.all(...)     : null;
const todos        = mods.enabled('todo')   ? await todoRepository.get(...)  : [];

const systemMessage = assembleSystemMessage(mods, ctx);   // head · authored · tail · suffix
const userText      = assembleUserText(mods, ctx, input.userText);
```

The three `if (block) systemMessage.content += …` concatenations disappear; so does the
`hasForum`/`hasBoard` tool-presence check, which is now the module switch plus the agent's own
`tools_allowed` as before.

## 8. HTTP + UI

- `GET /api/modules` — every module: id, name, description, group, mandatory, enabled, owned tools
  (with their individual enable state), settings keys, and each block's title/placement/order plus
  its rendered default text when the block is static.
- `PUT /api/modules/:id` — `{ enabled?, overrides?: { [blockTitle]: string | null } }`; refuses to
  disable a `mandatory` module (409).
- `POST /api/modules/custom` · `PUT` · `DELETE` — operator-authored modules.
- `POST /api/modules/preview` — `{ agentId }` → the assembled system message for that agent under
  the current switches. Uses the agent's real charter, parameters, house rules and todos; memory and
  forum blocks render from a labelled sample, since a preview must not spend an embedding.

`Settings → Modules` (`/settings/modules`, new card in `categories.ts`, icon `Puzzle`):

```
┌ Modules ──────────────────────────────┬ Prompt preview ─────────┐
│ Core                                  │ agent: [ pleiade  ▾ ]   │
│  ● Environment      locked            │                         │
│  ● Tool use         locked            │ ## Environment          │
│ Operator                              │ - Current date & time…  │
│  ● House rules                    [x] │ ## Local Parameters     │
│  ● AGENTS.md                      [x] │ …                       │
│ Self                                  │ ---                     │
│  ● Notebook   update_notebook     [x] │ <authored prompt>       │
│  ● Task list  todowrite           [x] │ ---                     │
│  ● Memory     remember, forget    [x] │ ## Notebook             │
│ Work                                  │ …                       │
│  ● Forum      forum, forum_admin  [x] │                         │
│  ○ Board      board               [ ] │  4 210 tok · 14 blocks  │
└───────────────────────────────────────┴─────────────────────────┘
```

Expanding a row shows its blocks (with an **Edit text** affordance on the overridable ones and a
Revert next to any override), its tools (each with the existing per-tool switch and a link to its
options), and its settings keys. The preview pane re-renders on every toggle, so the effect of a
switch is visible before it is saved.

## 9. Migration

`backend/migrations/<ts>-prompt-modules.js`

- `up`: add `modules_disabled: []`, `module_overrides: {}`, `modules_custom: []`; push `'board'`
  into `modules_disabled` when `forum_board_enabled` is not `true`.
- `down`: `$unset` the three fields.

## 10. Out of scope

Per-agent and per-conversation module overrides (global only, this pass). Skills are not modules —
they are already user-authored and individually switchable. Non-agent-facing switches (scoring,
host updates) keep their own panels.
