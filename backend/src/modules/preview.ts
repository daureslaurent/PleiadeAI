import type { AgentDoc } from '../domain/agents/agent.model';
import { assembleSystemMessage, assembleUserSuffix } from './assemble';
import type { ModuleState } from './state.service';
import type { PromptContext } from './types';

/**
 * A `PromptContext` for the settings page's preview pane.
 *
 * The agent's own half is real — its charter, its parameters, the fleet's house rules — because
 * that is what the operator is trying to see. The retrieved half is *sample* data, labelled as
 * such: a preview must not spend an embedding or six forum finds every time a switch is flipped,
 * and a block rendered from an empty result would show as absent, which reads as "this module does
 * nothing" rather than "there was nothing to recall just now".
 */
export function previewContext(agent: AgentDoc, houseRules: string): PromptContext {
  return {
    agent,
    houseRules,
    todos: [
      { content: '(sample) work out what the request needs', status: 'completed' },
      { content: '(sample) make the change', status: 'in_progress' },
      { content: '(sample) check it', status: 'pending' },
    ] as PromptContext['todos'],
    autoLoop: null,
    memories: [
      {
        score: 0.81,
        similarity: 0.81,
        payload: {
          kind: 'fact',
          text: '(sample recalled memory — the real block is filled from this agent’s own vault)',
          created_at: new Date().toISOString(),
          importance: 3,
          source: 'auto',
          subject: '',
        },
      },
    ] as unknown as PromptContext['memories'],
    forum: {
      related: [{ threadId: 'th_sample', title: '(sample) a thread that looked related' }],
      replies: [],
      mentions: [],
      assigned: [],
      digest: [],
      roster: ['@sample — another agent'],
      autoReply: false,
    },
    board: {
      tasks: [{ taskId: 'tk_sample', goal: '(sample) a task you own', state: 'ready' }],
      reviews: [],
    },
    images: { supportsVision: false, current: [], session: [], pooled: [] },
    modes: { system: ['(sample) an active mode'], user: ['(sample) an active mode'] },
    // The preview shows the block in its on-shape; the wording it takes from the live setting is a
    // sentence, and reading the settings doc to render a preview is exactly what this avoids.
    toolParallel: { enabled: true, max: 4 },
  };
}

/** The assembled prompt for one agent under the current switches, system and user halves both. */
export function previewPrompt(state: ModuleState, agent: AgentDoc, houseRules: string) {
  const ctx = previewContext(agent, houseRules);
  const system = assembleSystemMessage(state, ctx);
  return {
    system: typeof system.content === 'string' ? system.content : '',
    userSuffix: assembleUserSuffix(state, ctx),
  };
}
