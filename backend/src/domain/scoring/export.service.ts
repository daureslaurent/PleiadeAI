import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../config/logger';
import { llamaLogRepository, type LlamaLogDoc } from '../llama-logs/llama-log.repository';
import { conversationScoreRepository } from './conversation-score.repository';

const log = createLogger('export-service');

/** Where server-side exports land (inside the container: /app/exports). Created on demand. */
const EXPORT_DIR = path.join(process.cwd(), 'exports');

export interface ExportResult {
  path: string;
  turns: number;
  bytes: number;
}

/**
 * Optional quality gate applied to the export. When set, only agent-runs whose judge verdict
 * passes are emitted — this is what turns the raw archive into a curated SFT training set.
 */
export interface ExportFilter {
  minScore?: number;
  tags?: string[];
}

/** True when the filter actually constrains anything (an empty object means "export all"). */
function isActive(filter?: ExportFilter): filter is ExportFilter {
  return !!filter && (typeof filter.minScore === 'number' || !!filter.tags?.length);
}

/**
 * Dump the archive to a JSONL file for an EXTERNAL judge/SFT pipeline — one line per **agent-run**:
 * `{ turn_id, run_id, agent, depth, session_id, messages, tools }`, where `messages` is that run's
 * full reconstructed OpenAI-format conversation and `tools` is the tool catalog offered to it. The
 * top-level agent and each delegated sub-agent are separate lines, so sub-agent training data is
 * captured too. Raw, unfiltered ("export all"); the external script does its own judging/filtering.
 */
export const exportService = {
  /**
   * Build the JSONL body (one agent-run per line) + the line count. Shared by file-write & download.
   *
   * With no `filter` this is the original raw "export all". With a filter, only runs whose judge
   * verdict passes (min score / tag allowlist) are emitted — the curated training set a fine-tune
   * should actually learn from. Unscored runs are excluded whenever a filter is active, since there
   * is no verdict to judge them by.
   */
  async buildJsonl(filter?: ExportFilter): Promise<{ body: string; turns: number }> {
    const eligible = isActive(filter) ? await conversationScoreRepository.eligibleRunIds(filter) : null;
    const runs = await llamaLogRepository.listRunIds();
    const lines: string[] = [];
    for (const { runId } of runs) {
      if (eligible && !eligible.has(runId)) continue;
      const records = await llamaLogRepository.listByRun(runId);
      const example = runToExample(runId, records);
      if (example) lines.push(JSON.stringify(example));
    }
    return { body: lines.join('\n') + (lines.length ? '\n' : ''), turns: lines.length };
  },

  /** Persist a prebuilt JSONL body to a timestamped file under {@link EXPORT_DIR}. */
  async writeFile(body: string, turns: number): Promise<ExportResult> {
    await mkdir(EXPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(EXPORT_DIR, `sft-export-${stamp}.jsonl`);
    await writeFile(filePath, body, 'utf8');
    const bytes = Buffer.byteLength(body, 'utf8');
    log.info({ filePath, turns, bytes }, 'JSONL export written');
    return { path: filePath, turns, bytes };
  },

  /** Build the JSONL dump and write it to a server file; return its path/size. */
  async exportAll(): Promise<ExportResult> {
    const { body, turns } = await this.buildJsonl();
    return this.writeFile(body, turns);
  },
};

type Msg = Record<string, unknown> & { role?: string };

interface RunExample {
  turn_id: string | null;
  run_id: string;
  agent: string | null;
  depth: number | null;
  session_id: string | null;
  messages: Msg[];
  tools: unknown[];
}

type CallResponse = {
  text?: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; argsJson: string }[];
};

/**
 * Re-inline a call's thinking as a `<think>` block ahead of its content — the format Qwen3 /
 * DeepSeek-R1 chat templates expect an assistant turn to be trained in.
 *
 * The live prompt never carries reasoning (`AgentRunner`'s message array is the very array sent to
 * llama, and the server strips `<think>` from history anyway), so it has to be stitched back in here
 * from the per-call record. Empty reasoning → content unchanged, so non-thinking models are untouched.
 */
function withThink(content: string, reasoning?: string): string {
  const think = reasoning?.trim();
  return think ? `<think>\n${think}\n</think>\n\n${content}` : content;
}

/** Reconstruct one agent-run as an OpenAI training example: full messages + the tools offered. */
function runToExample(runId: string, records: LlamaLogDoc[]): RunExample | null {
  if (records.length === 0) return null;
  // A run's records are all the same agent, oldest→newest; the final one holds the fullest context.
  const last = records[records.length - 1]!;

  const req = last.request as { messages?: Msg[]; tools?: unknown[] };
  const messages: Msg[] = Array.isArray(req.messages) ? [...req.messages] : [];

  // Restore the thinking on the tool-loop's INTERMEDIATE assistant turns. A reasoning model thinks
  // before every tool call, not just before the final answer — train those turns with an empty head
  // and you teach it to skip straight to the call. Each loop iteration pushed exactly one assistant
  // message and produced exactly one record, in order, so the run's own assistant turns are the last
  // `records.length - 1` assistant messages in the array; anything before those belongs to a PRIOR
  // conversation round and stays stripped (matching the chat templates). Counting from the end keeps
  // this correct even when the narration-retry path injects an extra `user` nudge mid-loop.
  const assistantIdx = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
  const ownTurns = assistantIdx.slice(-Math.max(records.length - 1, 0));
  ownTurns.forEach((msgIdx, k) => {
    const rec = records[k];
    if (!rec) return;
    const m = messages[msgIdx]!;
    const { reasoning } = rec.response as CallResponse;
    messages[msgIdx] = { ...m, content: withThink(String(m.content ?? ''), reasoning) };
  });

  // Append the final assistant output so the example includes the model's answer/tool call, not just
  // the context that preceded it. This is the example's actual target, thinking included.
  const resp = last.response as CallResponse;
  const assistant: Msg = { role: 'assistant', content: withThink(resp.text ?? '', resp.reasoning) };
  if (resp.toolCalls?.length) {
    assistant.tool_calls = resp.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.argsJson },
    }));
  }
  messages.push(assistant);

  return {
    turn_id: last.turn_id ?? null,
    run_id: runId,
    agent: last.agent_name ?? null,
    depth: last.depth ?? null,
    session_id: last.session_id ?? null,
    messages,
    tools: req.tools ?? [],
  };
}
