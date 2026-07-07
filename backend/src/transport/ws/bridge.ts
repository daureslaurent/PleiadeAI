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

  eventBus.on('tool:execution_complete', ({ ctx, callId, tool, status, result, images }) => {
    io.to(ctx.sessionId).emit('tool_end', {
      type: 'tool_end',
      agent: ctx.agentName,
      callId,
      tool,
      status,
      result,
      // Thumbnails of any image the tool acquired (e.g. a picture read into the turn), so the operator
      // sees what the agent pulled in. Handles ride along so the UI can label them (img_1, …).
      images: images?.map((i) => ({ id: i.id, dataUrl: i.dataUrl })),
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
}
