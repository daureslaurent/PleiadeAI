import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { runWithCaptureContext } from '../../inference/capture-context';
import { resolveInference } from '../../inference/inference-resolver';
import { agentRepository } from '../agents/agent.repository';
import type { ChatMessage } from '../agents/jit-builder';
import { extractJsonObjects, stripReasoning } from '../scoring/judge.service';
import { ForumRuleError } from './forum.service';
import { loadRoster } from './forum-roster';

const log = createLogger('board-analyse');

const MAX_TOKENS = 1500;

/** What the create form is filled with. Every field is a suggestion the operator edits. */
export interface BoardAnalysis {
  kind: 'task' | 'project';
  name: string;
  description: string;
  acceptance: string[];
  owner: string;
  reviewer: string;
}

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'board_item',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['task', 'project'] },
        name: { type: 'string' },
        description: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' } },
        owner: { type: 'string' },
        reviewer: { type: 'string' },
      },
      required: ['kind', 'name', 'description', 'acceptance', 'owner', 'reviewer'],
      additionalProperties: false,
    },
  },
} as const;

function systemPrompt(roster: string): string {
  return [
    'You turn an operator\'s request into a board item for a team of AI agents. Reply with ONE JSON ' +
      'object and nothing else.',
    '',
    'Fields:',
    '- `kind`: "task" when one agent can finish it in one sitting and a reviewer can check it in one ' +
      'look; "project" when it needs several pieces of work, possibly by different agents.',
    '- `name`: a short title, at most 8 words, no trailing punctuation.',
    '- `description`: 2–5 sentences a person who never saw the request could act on. Keep every ' +
      'concrete detail the operator gave (names, paths, numbers, constraints); add none they did not.',
    '- `acceptance`: 2–6 criteria a *different* agent could check without asking anybody. ' +
      '"Implement the parser" is a wish; "parses the three files in fixtures/ and rejects the ' +
      'malformed fourth" is a criterion.',
    '- `owner`: for a task, the agent best suited to do it, by exact name from the roster. Empty for ' +
      'a project.',
    '- `reviewer`: for a task, a different agent from the roster to sign it off, or empty. Never the ' +
      'owner. Empty for a project.',
    '',
    'Answer in the language the request is written in.',
    '',
    'Roster:',
    roster || '(no agents)',
  ].join('\n');
}

function toAnalysis(json: string): BoardAnalysis | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.name !== 'string' && typeof obj.description !== 'string') return null;
  return {
    kind: obj.kind === 'task' ? 'task' : 'project',
    name: String(obj.name ?? '').trim().slice(0, 120),
    description: String(obj.description ?? '').trim(),
    acceptance: Array.isArray(obj.acceptance) ? obj.acceptance.map((a) => String(a).trim()).filter(Boolean) : [],
    owner: String(obj.owner ?? '').trim(),
    reviewer: String(obj.reviewer ?? '').trim(),
  };
}

export const boardAnalyseService = {
  /**
   * Fill the create form from a prompt (`BOARD_REFACTOR_PLAN.md` §2).
   *
   * One completion on the picked agent's own endpoint and model, not an agent turn: no session, no
   * tools, no memory, no turn spent against anything. It returns suggestions and the operator
   * decides. Owner and reviewer are re-checked against the live roster afterwards, because a name a
   * model half-remembers is exactly the one `fileTask` would refuse after the operator pressed Create.
   */
  async analyse(input: { prompt: string; agentId: string; kind?: 'task' | 'project' }): Promise<BoardAnalysis> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new ForumRuleError('write the request first — there is nothing to analyse', 400);
    const agent = await agentRepository.findById(input.agentId).catch(() => null);
    if (!agent) throw new ForumRuleError('pick an agent to analyse the request', 404);

    const roster = await loadRoster();
    const agents = [...roster.byName.values()].filter((r) => r.kind === 'agent');
    const rosterText = agents.map((a) => `- ${a.name}${a.description ? ` — ${a.description}` : ''}`).join('\n');

    const target = await resolveInference(agent);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(rosterText) },
      {
        role: 'user',
        content: input.kind
          ? `The operator already chose kind "${input.kind}".\n\nRequest:\n${prompt}`
          : `Request:\n${prompt}`,
      },
    ];
    const complete = (constrained: boolean): Promise<string> =>
      runWithCaptureContext({ source: 'board-analyse' }, () =>
        llamaClient.complete(target, messages, {
          temperature: 0.2,
          maxTokens: MAX_TOKENS,
          responseFormat: constrained ? RESPONSE_FORMAT : undefined,
          chatTemplateKwargs: constrained ? { enable_thinking: false } : undefined,
        }),
      );

    let raw: string;
    try {
      raw = await complete(true);
    } catch (err) {
      // Not every endpoint takes `response_format` — same fallback as the judge.
      log.debug({ err: err instanceof Error ? err.message : String(err) }, 'constrained analyse rejected — retrying unconstrained');
      raw = await complete(false);
    }

    let analysis: BoardAnalysis | null = null;
    for (const json of extractJsonObjects(stripReasoning(raw))) analysis = toAnalysis(json) ?? analysis;
    if (!analysis) {
      log.warn({ agent: agent.name, preview: raw.slice(0, 200) }, 'analyse returned no usable object');
      throw new ForumRuleError(`${agent.name} did not return a usable answer — try again or fill the form by hand`, 502);
    }

    if (input.kind) analysis.kind = input.kind;
    const canonical = (name: string): string => {
      const hit = roster.byName.get(name.toLowerCase());
      return hit && hit.kind === 'agent' ? hit.name : '';
    };
    analysis.owner = canonical(analysis.owner);
    analysis.reviewer = canonical(analysis.reviewer);
    if (analysis.reviewer && analysis.reviewer === analysis.owner) analysis.reviewer = '';
    if (analysis.kind === 'project') {
      analysis.owner = '';
      analysis.reviewer = '';
    }
    log.info({ agent: agent.name, kind: analysis.kind, name: analysis.name }, 'board item analysed');
    return analysis;
  },
};
