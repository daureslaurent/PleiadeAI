import type { GlobalMode } from '../endpoints/endpoint.model';

/**
 * The inference modes that ship with the app (`MODES_PLAN.md`). Code-defined and read-only, like the
 * `managed` fallback endpoint: they are never written to the settings document, so they cannot drift
 * from this file and they improve when the app is updated rather than staying frozen at whatever the
 * seed wrote once. The operator may still switch one *off* — that is a choice about their own chip
 * row, not an edit to the mode — which is stored as a list of ids in `settings.global_modes_disabled`.
 *
 * All of them are global, and therefore `prompt`-typed: a sampler value that suits one model is not a
 * claim you can make about every model in the fleet, whereas a standing instruction travels fine.
 *
 * Ids carry the `builtin:` prefix, which is also the guard — the settings route refuses to persist
 * any mode whose id starts with it, so a client cannot smuggle a fake built-in into the document.
 */
export const BUILTIN_MODE_PREFIX = 'builtin:';

/** Whether this id names a code-defined built-in rather than an operator-authored mode. */
export function isBuiltinModeId(id: string): boolean {
  return id.startsWith(BUILTIN_MODE_PREFIX);
}

export const BUILTIN_GLOBAL_MODES: GlobalMode[] = [
  // ---- Process forcing -----------------------------------------------------------------------
  // These ride on the user turn: they must not drift as an answer gets long, and recency is what
  // keeps them in force. `todowrite` is granted to every agent, and its list is re-injected each
  // turn, so "plan first" survives even a turn that runs out of context.
  {
    id: 'builtin:plan-first',
    name: 'Plan first',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'user_suffix',
    text:
      'Before doing anything else, call `todowrite` with the full task list for this request — ' +
      'every step, including the ones you consider trivial. Then work the list top to bottom, ' +
      'marking each item in_progress before you start it and done the moment it is finished. If the ' +
      'plan turns out to be wrong, rewrite the list rather than silently diverging from it.',
  },
  {
    id: 'builtin:one-step',
    name: 'One step',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'user_suffix',
    text:
      'Do exactly one step, then stop and report what you did and what you propose next. Do not ' +
      'chain steps. Do not finish the task.',
  },
  {
    id: 'builtin:ask-first',
    name: 'Ask first',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'user_suffix',
    text:
      'If any part of this request is ambiguous, or you are about to do something you cannot undo, ' +
      'call `ask_user` before acting. One good question beats a wrong answer.',
  },
  {
    id: 'builtin:evidence',
    name: 'Evidence only',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'user_suffix',
    text:
      'Every factual claim in your answer must come from a tool result in this turn. Name the ' +
      'command or file path it came from. Anything you did not verify, mark "unverified" — or leave out.',
  },

  // ---- Voice & shape -------------------------------------------------------------------------
  // Standing style: stated once, at the end of the system prompt, where it reads as a property of
  // the conversation rather than as part of what the operator just asked for.
  {
    id: 'builtin:terse',
    name: 'Terse',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'system_suffix',
    text:
      'Answer in at most five lines. No preamble, no restating the request, no summary of what you ' +
      'just did, no offers of further help.',
  },
  {
    id: 'builtin:french',
    name: 'Français',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'system_suffix',
    text:
      'Réponds toujours en français, y compris les titres et les listes. Les noms de fichiers, ' +
      'commandes, identifiants et sorties d’outils restent tels quels.',
  },
  {
    id: 'builtin:files-touched',
    name: 'Files touched',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'system_suffix',
    text:
      'End every answer with a "Files touched" section listing each path you read or wrote, one per ' +
      'line, each with a short note on why. Write "Files touched: none" when you touched none.',
  },

  // ---- Role shims ----------------------------------------------------------------------------
  // A hat for one conversation, where creating a whole agent would be too much ceremony.
  {
    id: 'builtin:reviewer',
    name: 'Reviewer',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'system_suffix',
    text:
      'For this conversation you are reviewing, not building. Do not edit, create or delete files. ' +
      'Report what you would change and why, ranked by severity, with the file and line for each point.',
  },
  {
    id: 'builtin:rubber-duck',
    name: 'Rubber duck',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'system_suffix',
    text:
      'Do not solve this. Ask questions about it until the operator solves it themselves. One ' +
      'question at a time, and never more than three lines of framing before it.',
  },
  {
    id: 'builtin:delegate-first',
    name: 'Delegate first',
    type: 'prompt',
    enabled: true,
    params: {},
    placement: 'system_suffix',
    text:
      'You are orchestrating, not executing. Check `annuaire`, then hand each part of this task to ' +
      'the agent that owns it with `ask_agent`. Do the work yourself only if no agent fits, and say ' +
      'which one you looked for.',
  },
];
