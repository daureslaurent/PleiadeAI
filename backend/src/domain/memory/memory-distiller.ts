import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { runWithCaptureContext } from '../../inference/capture-context';
import { resolveInference } from '../../inference/inference-resolver';
import { settingsService } from '../settings/settings.service';
import type { AgentDoc } from '../agents/agent.model';
import type { ChatMessage } from '../agents/jit-builder';
import { agentMemory } from './agent-memory.service';
import { qdrantService } from './qdrant.service';
import { MEMORY_KINDS, normalizePayload, type MemoryCandidate, type MemoryKind } from './memory.types';

const log = createLogger('memory-distiller');

/** How many existing memories the distiller is shown, so it can supersede rather than contradict. */
const CONTEXT_MEMORIES = 10;

/** Cosine floor for "already-known memories on this topic" shown to the distiller. */
const CONTEXT_THRESHOLD = 0.4;

/** Truncation of each side of the exchange fed to the distiller. Enough to judge, not a whole essay. */
const MAX_SIDE_CHARS = 4000;

/**
 * Cheap gate: a turn this trivial cannot contain a durable memory, and an inference call to prove
 * that is a waste of the remote server. ("ok", "thanks", "yes do it".)
 */
const MIN_TURN_CHARS = 40;

const DISTILL_SYSTEM_PROMPT = `You maintain your own long-term memory. You are shown one exchange you just had, plus the memories you already hold on that topic.

Your job: extract ONLY what is worth remembering weeks from now. Return JSON.

Write each memory as a standalone sentence that will still make sense with no conversation around it. Never write "as discussed", "the user's question above", "it", "that file" — name the thing. Write in the third person about the operator ("The operator prefers…", not "You prefer…").

kind:
- "fact"       — a durable truth about the world, the systems, the code ("The inference server runs at 192.168.1.23; image generation runs there too, never locally.")
- "preference" — how the operator wants things done ("The operator wants plans persisted to a repo-tracked .md file, not just an internal plan.")
- "procedure"  — a reusable how-to you learned ("Rebuilding the backend requires npm run build then a container restart; editing src alone changes nothing.")
- "episode"    — a souvenir: something that happened, worth recalling later ("On 2026-07-12 the GPU broker was fixed so a /health poll no longer forces a model load.")

importance: 1 = trivia, 3 = useful, 5 = load-bearing (would cause real harm to forget).
subject: a short lowercase key for the thing it is about ("gpu-broker", "operator", "image-gen").
supersedes: ids from EXISTING MEMORIES that this new memory makes obsolete or corrects. Use it when a fact changed — a memory that is merely *related* is not superseded. Empty array otherwise.

RULES:
- Most exchanges contain nothing durable. Returning {"memories": []} is the correct, common answer.
- Never store: greetings, acknowledgements, small talk, the fact that a question was asked, transient state, or anything already covered by an existing memory (unless you are superseding it).
- Never store the conversation itself. Store what it TAUGHT you.
- Do not invent. Only what the exchange actually establishes.`;

const DISTILL_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'memories',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        memories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              kind: { type: 'string', enum: MEMORY_KINDS },
              subject: { type: 'string' },
              importance: { type: 'integer', minimum: 1, maximum: 5 },
              supersedes: { type: 'array', items: { type: 'string' } },
            },
            required: ['text', 'kind', 'subject', 'importance', 'supersedes'],
            additionalProperties: false,
          },
        },
      },
      required: ['memories'],
      additionalProperties: false,
    },
  },
} as const;

/** The distiller wants none of the model's thinking channel — just the object. */
const NO_THINKING = { enable_thinking: false } as const;

export interface DistillInput {
  agent: AgentDoc;
  userText: string;
  agentText: string;
  sessionId?: string;
  turnId?: string;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}

/** Tolerant parse: models wrap JSON in prose or fences even under a grammar. */
function parseCandidates(raw: string): MemoryCandidate[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(list)) return null;

  const out: MemoryCandidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) continue;
    const kind = o.kind as MemoryKind;
    out.push({
      text,
      kind: MEMORY_KINDS.includes(kind) ? kind : 'episode',
      subject: typeof o.subject === 'string' ? o.subject.trim().toLowerCase() : '',
      importance:
        typeof o.importance === 'number' ? Math.min(5, Math.max(1, Math.round(o.importance))) : 2,
      supersedes: Array.isArray(o.supersedes) ? o.supersedes.map(String) : [],
    });
  }
  return out;
}

/**
 * Turn one exchange into zero or more distilled memories (see `docs/memory-souvenirs.md`).
 *
 * This replaces the old post-turn behaviour, which embedded the raw `"User: …\nAgent: …"`
 * transcript as a single point: one vector averaging a question, an answer and two speakers points
 * nowhere in particular, matches everything weakly, and injects the agent's own past prose back at
 * it as if it were fact.
 *
 * The call runs on **the agent's own endpoint** — the same model with the same voice writes its own
 * memories. It is shown what it already knows on the topic, so it can *correct* itself (supersede)
 * rather than pile a contradiction on top of the old belief.
 */
export const memoryDistiller = {
  /** Fire-and-forget entry point called from AgentRunner after a turn settles. Never throws. */
  distillTurn(input: DistillInput): void {
    void this.run(input).catch((err) => {
      log.warn(
        { agent: input.agent.name, err: err instanceof Error ? err.message : String(err) },
        'distillation failed — turn not remembered',
      );
    });
  },

  async run(input: DistillInput): Promise<number> {
    const { agent, userText, agentText } = input;
    const settings = await settingsService.get();
    if (!settings.memory_distill_enabled) return 0;

    const exchange = `${userText}\n${agentText}`;
    if (exchange.trim().length < MIN_TURN_CHARS) return 0;

    const namespace = agent.qdrant_namespace;

    // What does this agent already know about what was just said? Shown to the distiller so a new
    // memory can retire an outdated one by id instead of silently contradicting it.
    let existing: Array<{ id: string; text: string }> = [];
    try {
      const vector = await llamaClient.embed(truncate(exchange, MAX_SIDE_CHARS));
      const near = await qdrantService.search(namespace, vector, {
        limit: CONTEXT_MEMORIES,
        scoreThreshold: CONTEXT_THRESHOLD,
        mustNot: { status: 'superseded' },
      });
      existing = near
        .map((p) => ({ id: String(p.id), text: normalizePayload(p.payload).text }))
        .filter((m) => m.text);
    } catch (err) {
      // Embeddings down: distil anyway, just without the supersede context.
      log.debug({ namespace, err: String(err) }, 'could not load existing memories for distillation');
    }

    const target = await resolveInference(agent);
    if (!target) {
      log.warn({ agent: agent.name }, 'no inference target — turn not distilled');
      return 0;
    }

    const known = existing.length
      ? existing.map((m) => `- [${m.id}] ${m.text}`).join('\n')
      : '(none)';
    const messages: ChatMessage[] = [
      { role: 'system', content: DISTILL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `EXISTING MEMORIES (candidates for supersedes):\n${known}\n\n--- EXCHANGE ---\nOperator: ${truncate(
          userText,
          MAX_SIDE_CHARS,
        )}\n\n${agent.name}: ${truncate(agentText, MAX_SIDE_CHARS)}\n--- END ---\n\nExtract the durable memories. Return {"memories": []} if there are none.`,
      },
    ];

    const complete = (constrained: boolean): Promise<string> =>
      runWithCaptureContext(
        { source: 'memory', agentId: String(agent._id), agentName: agent.name, sessionId: input.sessionId, turnId: input.turnId },
        () =>
          llamaClient.complete(target, messages, {
            temperature: 0,
            maxTokens: settings.memory_max_tokens,
            responseFormat: constrained ? DISTILL_RESPONSE_FORMAT : undefined,
            chatTemplateKwargs: constrained ? NO_THINKING : undefined,
          }),
      );

    let raw: string;
    try {
      raw = await complete(true);
    } catch (err) {
      // Not every OpenAI-ish backend accepts `response_format` / `chat_template_kwargs` (same
      // caveat the judge handles) — retry unconstrained and lean on tolerant parsing.
      log.debug({ agent: agent.name, err: String(err) }, 'constrained distill rejected — retrying unconstrained');
      raw = await complete(false);
    }

    const candidates = parseCandidates(raw);
    if (!candidates) {
      log.warn({ agent: agent.name, preview: raw.slice(0, 200) }, 'distiller returned unparseable JSON');
      return 0;
    }
    if (!candidates.length) {
      log.debug({ agent: agent.name }, 'nothing durable in this turn');
      return 0;
    }

    const knownIds = new Set(existing.map((m) => m.id));
    let stored = 0;
    for (const cand of candidates) {
      const id = await agentMemory.remember(namespace, {
        text: cand.text,
        kind: cand.kind,
        subject: cand.subject,
        importance: cand.importance,
        source: 'distiller',
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      if (!id) continue;
      stored += 1;

      // Retire what this memory replaces. Guarded against a hallucinated id: only ids we actually
      // showed the model can be superseded, and never the point we just wrote.
      for (const old of cand.supersedes) {
        if (!knownIds.has(old) || old === id) continue;
        await agentMemory.supersede(namespace, old, id);
        log.info({ agent: agent.name, old, replacedBy: id }, 'memory superseded');
      }
    }

    log.info({ agent: agent.name, stored, proposed: candidates.length }, 'turn distilled');
    return stored;
  },
};
