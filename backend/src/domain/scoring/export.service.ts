import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../config/logger';
import { llamaLogRepository, type LlamaLogDoc } from '../llama-logs/llama-log.repository';

const log = createLogger('export-service');

/** Where server-side exports land (inside the container: /app/exports). Created on demand. */
const EXPORT_DIR = path.join(process.cwd(), 'exports');

export interface ExportResult {
  path: string;
  turns: number;
  bytes: number;
}

/**
 * Dump the archive to a JSONL file for an EXTERNAL judge/SFT pipeline — one line per turn:
 * `{ turn_id, session_id, messages, tools }`, where `messages` is the turn's full reconstructed
 * OpenAI-format conversation (the accumulated depth-0 context plus the final assistant output) and
 * `tools` is the tool catalog offered that turn. This is a raw, unfiltered dump ("export all"); the
 * external script does its own judging/filtering.
 */
export const exportService = {
  async exportAll(): Promise<ExportResult> {
    const turnIds = await llamaLogRepository.listTurnIds();
    await mkdir(EXPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(EXPORT_DIR, `sft-export-${stamp}.jsonl`);

    const lines: string[] = [];
    for (const turnId of turnIds) {
      const records = await llamaLogRepository.listByTurn(turnId);
      const example = turnToExample(turnId, records);
      if (example) lines.push(JSON.stringify(example));
    }
    const body = lines.join('\n') + (lines.length ? '\n' : '');
    await writeFile(filePath, body, 'utf8');
    const bytes = Buffer.byteLength(body, 'utf8');
    log.info({ filePath, turns: lines.length, bytes }, 'JSONL export written');
    return { path: filePath, turns: lines.length, bytes };
  },
};

type Msg = Record<string, unknown> & { role?: string };

/** Reconstruct one turn as an OpenAI training example: full messages + the tools offered. */
function turnToExample(
  turnId: string,
  records: LlamaLogDoc[],
): { turn_id: string; session_id: string | null; messages: Msg[]; tools: unknown[] } | null {
  if (records.length === 0) return null;
  // Prefer the depth-0 thread (the user-facing conversation); its final record holds the fullest
  // accumulated context. Sub-agent hops live in their own records and are out of scope for one line.
  const depth0 = records.filter((r) => (r.depth ?? 0) === 0);
  const chain = depth0.length ? depth0 : records;
  const last = chain[chain.length - 1]!;

  const req = last.request as { messages?: Msg[]; tools?: unknown[] };
  const messages: Msg[] = Array.isArray(req.messages) ? [...req.messages] : [];

  // Append the final assistant output so the example includes the model's answer/tool call, not just
  // the context that preceded it.
  const resp = last.response as {
    text?: string;
    toolCalls?: { id: string; name: string; argsJson: string }[];
  };
  const assistant: Msg = { role: 'assistant', content: resp.text ?? '' };
  if (resp.toolCalls?.length) {
    assistant.tool_calls = resp.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.argsJson },
    }));
  }
  messages.push(assistant);

  return { turn_id: turnId, session_id: last.session_id ?? null, messages, tools: req.tools ?? [] };
}
