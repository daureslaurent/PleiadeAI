import { Router } from 'express';
import { llamaLogRepository, type LlamaLogDoc } from '../../../domain/llama-logs/llama-log.repository';
import { conversationScoreRepository } from '../../../domain/scoring/conversation-score.repository';
import { truncateRequestImages } from '../../../inference/truncate-images';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { resolveInference } from '../../../inference/inference-resolver';
import { llamaClient } from '../../../inference/LlamaClient';
import type { ChatMessage } from '../../../domain/agents/jit-builder';
import {
  foldSegments,
  groupByModule,
  messageText,
  planUsagePieces,
  promptModules,
} from '../../../domain/llama-logs/prompt-usage';
import type { LlamaRequestCapture } from '../../../core/event-bus/events.types';

/** LLM Debug page — raw llama call inspector + DB size readout + archive purge. */
export const llamaLogsRouter = Router();

/** Below this the fast capped debug buffer is authoritative; above it we page the durable archive. */
const DEBUG_TIER_MAX = 50;

/** Re-shape a stored doc to the camelCase wire record; images truncated (list = never ship base64). */
function toListRecord(doc: LlamaLogDoc) {
  const d = doc.toObject();
  return {
    id: d.call_id,
    turnId: d.turn_id ?? null,
    runId: d.run_id ?? null,
    source: d.source,
    endpoint: d.endpoint,
    model: d.model,
    sessionId: d.session_id,
    agentId: d.agent_id,
    agentName: d.agent_name,
    depth: d.depth,
    status: d.status,
    request: truncateRequestImages(d.request as LlamaRequestCapture),
    response: d.response,
    tools: d.tools,
    usage: d.usage,
    durationMs: d.duration_ms,
    firstTokenMs: d.first_token_ms,
    error: d.error,
    createdAt: d.created_at,
  };
}

/** Full detail from the archive: untruncated images + raw streamed chunks. */
function toDetailRecord(doc: LlamaLogDoc) {
  const d = doc.toObject();
  return {
    id: d.call_id,
    source: d.source,
    endpoint: d.endpoint,
    model: d.model,
    sessionId: d.session_id,
    agentId: d.agent_id,
    agentName: d.agent_name,
    depth: d.depth,
    status: d.status,
    request: d.request,
    response: d.response,
    rawChunks: d.raw_chunks,
    tools: d.tools,
    usage: d.usage,
    durationMs: d.duration_ms,
    firstTokenMs: d.first_token_ms,
    error: d.error,
    createdAt: d.created_at,
  };
}

/** Storage sizes + counts for the DB size pills. */
llamaLogsRouter.get('/stats', async (_req, res) => {
  res.json(await llamaLogRepository.stats());
});

/**
 * Wipe the durable archive (guarded by a UI confirm dialog). Capped debug buffer is untouched.
 * Also drops every Conversation Quality score: they derive from the archive transcripts, so once
 * those are gone the verdicts can't be inspected/re-scored/exported and would only linger as orphans.
 */
llamaLogsRouter.delete('/archive', async (_req, res) => {
  const deleted = await llamaLogRepository.purgeArchive();
  const scoresDeleted = await conversationScoreRepository.deleteByRunIds();
  res.json({ deleted, scoresDeleted });
});

/**
 * Every chat-turn call of one session, oldest first — the chat page's **Prompt** view. Each record
 * carries the exact `request.messages` that pass sent to the model, so the operator sees the
 * conversation as the LLM saw it (system prompt, injected memories, tool results) at every iteration
 * of every turn. Images are already placeholders in the debug copy; `truncateRequestImages` covers
 * the archive copy too so a base64 attachment never rides this response.
 */
llamaLogsRouter.get('/session/:sessionId', async (req, res) => {
  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 500) : 60;
  const docs = await llamaLogRepository.listBySession(req.params.sessionId, limit);
  res.json(docs.map(toListRecord));
});

/**
 * Size a captured message array: a per-message breakdown (raw `/tokenize`, no chat template) plus
 * the exact templated `total`. The two disagree by the template's per-message scaffolding — that is
 * expected and the UI labels them accordingly. Both are best-effort `null` on a non-llama.cpp server.
 */
llamaLogsRouter.post('/tokenize', async (req, res) => {
  const body = req.body as { agentId?: string | null; messages?: unknown[] };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    res.json({ perMessage: [], total: 0 });
    return;
  }
  const agent = body.agentId ? await agentRepository.findById(body.agentId) : null;
  const target = await resolveInference(agent ?? {});
  const [perMessage, total] = await Promise.all([
    llamaClient.tokenizeTexts(target, messages.map(messageText)),
    llamaClient.tokenizeMessages(target, messages as ChatMessage[]).catch(() => null),
  ]);
  res.json({ perMessage, total, contextWindow: target.contextWindow });
});

/**
 * **Prompt usage** — the same prompt sized by *what each part of it is* rather than by message.
 *
 * `/tokenize` answers "which message is big"; this answers "which part of the agent's configuration
 * is big", which is the question you can actually act on. The assembled system message is cut back
 * into the `jit-builder` blocks it was glued from (Environment, AGENTS.md, Notebook, Task list…),
 * the operator-authored `system_prompt` gets its own row, the toolset's JSON schemas — billed on
 * every call and present in no message — get theirs, and the conversation folds into user /
 * assistant / tool-result rows. One bounded-concurrency tokenize pass sizes them all.
 */
llamaLogsRouter.post('/usage-breakdown', async (req, res) => {
  const body = req.body as { agentId?: string | null; messages?: unknown[]; tools?: unknown[] };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const agent = body.agentId ? await agentRepository.findById(body.agentId) : null;
  const target = await resolveInference(agent ?? {});
  if (!messages.length) {
    res.json({
      segments: [],
      moduleGroups: [],
      sum: 0,
      total: 0,
      contextWindow: target.contextWindow,
      modules: [],
    });
    return;
  }

  const pieces = planUsagePieces(messages, body.tools);
  const [counts, total] = await Promise.all([
    llamaClient.tokenizeTexts(target, pieces.map((p) => p.text)),
    llamaClient.tokenizeMessages(target, messages as ChatMessage[]).catch(() => null),
  ]);
  const segments = foldSegments(pieces, counts);
  res.json({
    segments,
    moduleGroups: groupByModule(segments),
    sum: segments.reduce((a, s) => a + (s.tokens ?? 0), 0),
    total,
    contextWindow: target.contextWindow,
    modules: promptModules(messages),
  });
});

/** Full archive detail for one call (raw chunks + full images). */
llamaLogsRouter.get('/:callId', async (req, res) => {
  const doc = await llamaLogRepository.getArchive(req.params.callId);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(toDetailRecord(doc));
});

/** Last N calls, newest first. N≤50 reads the fast capped buffer; larger pages the archive. */
llamaLogsRouter.get('/', async (req, res) => {
  const raw = Number(req.query.limit);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 1000) : 10;
  const docs =
    limit <= DEBUG_TIER_MAX
      ? await llamaLogRepository.listDebug(limit)
      : await llamaLogRepository.listArchive(limit);
  res.json(docs.map(toListRecord));
});
