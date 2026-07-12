import type { Server } from 'socket.io';
import { eventBus } from '../../core/event-bus/EventBus';

/**
 * Maps internal EventBus events onto the frontend WebSocket schema (§6 of the plan) and emits
 * them to the socket.io room named by `sessionId`. Because every internal payload carries
 * `ctx.sessionId`, streams stay isolated to the originating client without per-listener wiring.
 *
 * The wire payloads are intentionally the narrow shapes the UI consumes — richer internal
 * fields (ids, args, timings) are dropped here.
 */
export function attachBridge(io: Server): void {
  eventBus.on('agent:stream_chunk', ({ ctx, content, isReasoning }) => {
    io.to(ctx.sessionId).emit('stream_chunk', {
      type: 'stream_chunk',
      agent: ctx.agentName,
      content,
      is_reasoning: isReasoning,
    });
  });

  eventBus.on('agent:ask_agent', (payload) => {
    io.to(payload.ctx.sessionId).emit('agent_hop', {
      type: 'agent_hop',
      from: payload.from,
      to: payload.to,
      depth: payload.depth,
      query: payload.query,
      childRunId: payload.childRunId,
    });
  });

  eventBus.on('agent:ask_agent_done', (payload) => {
    io.to(payload.ctx.sessionId).emit('agent_hop_done', {
      type: 'agent_hop_done',
      from: payload.from,
      to: payload.to,
      depth: payload.depth,
      status: payload.status,
    });
  });

  eventBus.on('agent:tool_invoke', ({ ctx, callId, tool, args }) => {
    io.to(ctx.sessionId).emit('tool_start', {
      type: 'tool_start',
      agent: ctx.agentName,
      callId,
      tool,
      args,
    });
  });

  eventBus.on('tool:output_chunk', ({ ctx, callId, chunk }) => {
    io.to(ctx.sessionId).emit('tool_output', {
      type: 'tool_output',
      callId,
      chunk,
    });
  });

  eventBus.on('tool:vision', ({ ctx, callId, image, question, answer, model, x, y, width, height, snap }) => {
    io.to(ctx.sessionId).emit('vision', {
      type: 'vision',
      callId,
      image,
      question,
      answer,
      model,
      x,
      y,
      width,
      height,
      snap,
    });
  });

  eventBus.on('tool:visual_act', ({ ctx, callId, image, width, height, action, x, y, x2, y2, snap }) => {
    io.to(ctx.sessionId).emit('visual_act', {
      type: 'visual_act',
      callId,
      agentId: ctx.agentId,
      image,
      width,
      height,
      action,
      x,
      y,
      x2,
      y2,
      snap,
    });
  });

  eventBus.on(
    'agent:image_generated',
    ({ ctx, callId, prompt, size, n, steps, guidance, seed, negativePrompt, model, count }) => {
      io.to(ctx.sessionId).emit('image_gen', {
        type: 'image_gen',
        callId,
        prompt,
        size,
        n,
        steps,
        guidance,
        seed,
        negativePrompt,
        model,
        count,
      });
    },
  );

  eventBus.on('tool:execution_complete', ({ ctx, callId, tool, status, result, images }) => {
    io.to(ctx.sessionId).emit('tool_end', {
      type: 'tool_end',
      agent: ctx.agentName,
      callId,
      tool,
      status,
      result,
      // Thumbnails of any image the tool acquired (e.g. a picture read into the turn), so the operator
      // sees what the agent pulled in. Handles ride along so the UI can label them (img_1, …). Blob
      // resources (no pixels) are excluded here — they surface in the Data tab, not as chat thumbnails.
      images: images
        ?.filter((i) => i.kind !== 'blob' && i.dataUrl)
        .map((i) => ({ id: i.id, dataUrl: i.dataUrl })),
    });
  });

  // Memories the auto-RAG step injected into this run's prompt — drives the chat's "memories" badge.
  // Depth routes it like `context_usage`: a depth-0 recall belongs to the turn, a sub-agent's to its
  // own bubble.
  eventBus.on('agent:memory_recall', ({ ctx, runId, memories }) => {
    io.to(ctx.sessionId).emit('memory_recall', {
      type: 'memory_recall',
      sessionId: ctx.sessionId,
      agent: ctx.agentName,
      depth: ctx.depth,
      runId,
      memories,
    });
  });

  eventBus.on('agent:context_usage', ({ ctx, promptTokens, completionTokens, totalTokens, contextWindow, phase }) => {
    io.to(ctx.sessionId).emit('context_usage', {
      type: 'context_usage',
      sessionId: ctx.sessionId,
      // Identity + depth so the client can route a depth-0 reading to the session header meter and a
      // sub-agent's reading to its own bubble.
      agent: ctx.agentName,
      depth: ctx.depth,
      promptTokens,
      completionTokens,
      totalTokens,
      contextWindow,
      phase,
    });
  });

  eventBus.on('agent:turn_truncated', ({ ctx }) => {
    io.to(ctx.sessionId).emit('truncated', {
      type: 'truncated',
      sessionId: ctx.sessionId,
      agent: ctx.agentName,
    });
  });

  eventBus.on('agent:ask_user', ({ ctx, requestId, question }) => {
    io.to(ctx.sessionId).emit('ask_user', {
      type: 'ask_user',
      sessionId: ctx.sessionId,
      requestId,
      agent: ctx.agentName,
      question,
    });
  });

  eventBus.on('system:alert', ({ ctx, level, message }) => {
    const emitter = ctx?.sessionId ? io.to(ctx.sessionId) : io;
    emitter.emit('system_alert', { type: 'system_alert', level, message });
  });

  // LLM Debug feed — a *global* stream (not session-scoped), so it goes to a dedicated `llama-log`
  // room the debug page joins via `llama:subscribe`. Heavy request/response bodies are deliberately
  // dropped here (the full record is persisted and fetched over REST); only the truncated request
  // and streaming deltas ride the socket.
  eventBus.on('llama:call_start', ({ id, source, model, endpoint, requestPreview, ctx }) => {
    io.to('llama-log').emit('llama_call_start', {
      type: 'llama_call_start',
      id,
      source,
      agent: ctx?.agentName ?? null,
      model,
      endpoint,
      request: requestPreview,
      at: Date.now(),
    });
  });

  eventBus.on('llama:call_delta', ({ id, delta, isReasoning }) => {
    io.to('llama-log').emit('llama_call_delta', {
      type: 'llama_call_delta',
      id,
      delta,
      is_reasoning: isReasoning,
    });
  });

  eventBus.on('llama:call_end', ({ id, status, durationMs, usage }) => {
    io.to('llama-log').emit('llama_call_end', {
      type: 'llama_call_end',
      id,
      status,
      duration_ms: durationMs,
      usage,
    });
  });

  // Conversation Quality Scorer → the turn's chat, so a live badge appears on the scored bubble
  // (top-level turn or a sub-agent bubble, matched by runId). Also broadcast to the llama-log room so
  // the LLM Debug page can update its per-record badges live.
  eventBus.on('scoring:turn_scored', ({ sessionId, runId, turnId, agentName, depth, score, tag, explanation }) => {
    const wire = { type: 'turn_scored', sessionId, runId, turnId, agentName, depth, score, tag, explanation };
    if (sessionId) io.to(sessionId).emit('turn_scored', wire);
    io.to('llama-log').emit('turn_scored', wire);
  });

  // Fine-tune job progress → the `finetune` room the Fine-Tuning page joins via `finetune:subscribe`.
  // Only the newly-observed metric datapoints ride the wire; the client appends them to its curve.
  eventBus.on('finetune:job_update', (p) => {
    io.to('finetune').emit('finetune_job_update', {
      type: 'finetune_job_update',
      jobId: p.jobId,
      serverId: p.serverId,
      runName: p.runName,
      status: p.status,
      progress: p.progress,
      newMetrics: p.newMetrics,
      ggufFilename: p.ggufFilename,
      error: p.error,
    });
  });
}
