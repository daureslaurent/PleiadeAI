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
  // --- Conversation Generator (docs/conversation-generator.md) -------------------------------
  // A generated conversation has no client driving it, so the two halves a chat client normally
  // supplies itself — the user turn it just sent, and the terminal `chat:done` — have to come off
  // the bus instead. With these, a Workspace sitting on the session watches the interview unfold
  // live (the agent's tokens already stream: the bridge is room-scoped by sessionId).

  // The interviewer's question, as a `user` turn. Also flips the session to "working": the target
  // agent starts its run the instant the question lands.
  eventBus.on('chat:user_message', ({ ctx, content }) => {
    io.to(ctx.sessionId).emit('chat:user', { sessionId: ctx.sessionId, text: content });
    io.to(ctx.sessionId).emit('chat:running', { sessionId: ctx.sessionId });
  });

  // The target's answer, already persisted by the generator → `persisted: true` so a watching client
  // renders the rich blocks but does NOT save the turn a second time.
  eventBus.on('conversation:turn_complete', ({ ctx, answer, blocks, memories, turnId, runId }) => {
    io.to(ctx.sessionId).emit('chat:done', {
      sessionId: ctx.sessionId,
      answer,
      persisted: true,
      blocks,
      memories,
      turnId,
      runId,
    });
  });

  // Auto-loop phase changes (AUTO_AGENT_PLAN.md). Session-scoped: the Loop panel that cares about
  // this is the one open on that conversation. Everything else about a loop turn already flows
  // through the ordinary chat events above, so this carries only the loop's own bookkeeping.
  eventBus.on('autoloop:state', (payload) => {
    io.to(payload.sessionId).emit('auto_loop', { type: 'auto_loop', ...payload });
  });

  // A brand-new generated session: broadcast, since no client can be in its room yet — every open
  // Workspace adds the row to the agent's session list without a reload.
  eventBus.on('conversation:session_created', ({ sessionId, agentId, agentName, title }) => {
    io.emit('session:created', { sessionId, agentId, agentName, title, origin: 'synthetic' });
  });

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

  eventBus.on('agent:media_generated', ({ ctx, ...payload }) => {
    io.to(ctx.sessionId).emit('media_gen', {
      type: 'media_gen',
      ...payload,
      sourceId: payload.sourceId ?? null,
    });
  });

  eventBus.on('tool:progress', ({ ctx, ...payload }) => {
    io.to(ctx.sessionId).emit('tool_progress', {
      type: 'tool_progress',
      ...payload,
      etaMs: payload.etaMs ?? null,
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
      // sees what the agent pulled in. Handles ride along so the UI can label them (img_1, …). Blob
      // resources (no pixels) are excluded here — they surface in the Data tab, not as chat thumbnails.
      images: images
        ?.filter((i) => i.kind !== 'blob' && i.dataUrl)
        .map((i) => ({ id: i.id, dataUrl: i.dataUrl })),
    });
  });

  // The agent's checklist changed. Depth routes it like `memory_recall`: a depth-0 list is the turn's
  // (and drives the pinned panel), a sub-agent's belongs to its own bubble.
  eventBus.on('agent:todo_update', ({ ctx, callId, items }) => {
    io.to(ctx.sessionId).emit('todo_update', {
      type: 'todo_update',
      sessionId: ctx.sessionId,
      agent: ctx.agentName,
      agentId: ctx.agentId,
      depth: ctx.depth,
      callId,
      items,
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

  // Forum posts → the `forum` room the Forum page joins via `forum:subscribe` (FORUM_PLAN.md §6).
  // Agents post asynchronously, often while nobody is looking at their session, so the board updates
  // itself rather than waiting for a refresh. The body deliberately stays off the wire — a client
  // showing the thread refetches it, and one showing the index only needs the "last post by" line.
  eventBus.on('forum:post_created', (p) => {
    io.to('forum').emit('forum_post_created', {
      type: 'forum_post_created',
      postId: p.postId,
      threadId: p.threadId,
      categoryId: p.categoryId,
      threadTitle: p.threadTitle,
      author: p.author,
      authorKind: p.authorKind,
      snippet: p.snippet,
      attachmentCount: p.attachmentCount ?? 0,
      opening: p.opening,
      createdAt: p.createdAt,
    });
  });

  // --- Flows (FLOWS_PLAN.md §5) ---------------------------------------------------------------
  // A run's `ctx.sessionId` *is* its run id, so these relay through the same room machinery as chat —
  // and the Flow page, having joined that room, also receives the agent/tool/media events emitted by
  // the nodes executing inside the run, with no flow-specific plumbing on either side.
  eventBus.on('flow:run_start', (p) => {
    io.to(p.ctx.sessionId).emit('flow_run_start', {
      type: 'flow_run_start',
      runId: p.runId,
      flowId: p.flowId,
      flowName: p.flowName,
      trigger: p.trigger,
    });
  });

  eventBus.on('flow:node_start', (p) => {
    io.to(p.ctx.sessionId).emit('flow_node_start', {
      type: 'flow_node_start',
      runId: p.runId,
      nodeId: p.nodeId,
      nodeType: p.nodeType,
      label: p.label,
      iteration: p.iteration,
    });
  });

  eventBus.on('flow:node_progress', (p) => {
    io.to(p.ctx.sessionId).emit('flow_node_progress', {
      type: 'flow_node_progress',
      runId: p.runId,
      nodeId: p.nodeId,
      phase: p.phase,
      percent: p.percent,
      message: p.message,
      preview: p.preview,
      etaMs: p.etaMs,
      elapsedMs: p.elapsedMs,
    });
  });

  eventBus.on('flow:node_output', (p) => {
    io.to(p.ctx.sessionId).emit('flow_node_output', {
      type: 'flow_node_output',
      runId: p.runId,
      nodeId: p.nodeId,
      chunk: p.chunk,
    });
  });

  eventBus.on('flow:node_end', (p) => {
    io.to(p.ctx.sessionId).emit('flow_node_end', {
      type: 'flow_node_end',
      runId: p.runId,
      nodeId: p.nodeId,
      status: p.status,
      durationMs: p.durationMs,
      summary: p.summary,
      handles: p.handles,
      error: p.error,
    });
  });

  eventBus.on('flow:run_end', (p) => {
    io.to(p.ctx.sessionId).emit('flow_run_end', {
      type: 'flow_run_end',
      runId: p.runId,
      status: p.status,
      durationMs: p.durationMs,
      output: p.output,
      handles: p.handles,
      error: p.error,
    });
  });

  eventBus.on('flow:iteration_start', (p) => {
    io.to(p.ctx.sessionId).emit('flow_iteration_start', {
      type: 'flow_iteration_start',
      runId: p.runId,
      loopId: p.loopId,
      iteration: p.iteration,
      nodes: p.nodes,
    });
  });

  eventBus.on('flow:artifact', (p) => {
    io.to(p.ctx.sessionId).emit('flow_artifact', {
      type: 'flow_artifact',
      runId: p.runId,
      nodeId: p.nodeId,
      handle: p.handle,
      kind: p.kind,
      mime: p.mime,
      size: p.size,
      filename: p.filename,
      iteration: p.iteration,
    });
  });

  eventBus.on('flow:awaiting_approval', (p) => {
    io.to(p.ctx.sessionId).emit('flow_awaiting_approval', {
      type: 'flow_awaiting_approval',
      runId: p.runId,
      nodeId: p.nodeId,
      question: p.question,
      artifacts: p.artifacts,
    });
  });
}
