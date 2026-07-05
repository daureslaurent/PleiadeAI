import type { ToolContext, Tool } from '../../types';
import { fileExists, readFileBytes, writeFileBytes, runInEnv, shq, toErrorResult } from './env-fs';

/**
 * `patch` — apply a multi-file patch in the OpenCode / apply-patch envelope format, matching
 * OpenCode's tool name and `patchText` argument so tuned models can edit several files at once:
 *
 *   *** Begin Patch
 *   *** Update File: path
 *   @@ optional locator
 *    context line
 *   -removed line
 *   +added line
 *   *** Add File: path
 *   +new content
 *   *** Delete File: path
 *   *** End Patch
 */
export const patch: Tool = {
  name: 'patch',
  description:
    'Applies a patch to one or more files using the apply-patch envelope format (*** Begin Patch / ' +
    '*** Update File: / *** Add File: / *** Delete File: / *** End Patch). Context lines start with a ' +
    'space, removed lines with "-", added lines with "+".',
  parameters: {
    type: 'object',
    properties: {
      patchText: { type: 'string', description: 'The full patch document in apply-patch format.' },
    },
    required: ['patchText'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const patchText = String(args.patchText ?? '');
    if (!patchText.trim()) return { result: { ok: false, error: 'patchText is required' } };

    try {
      const ops = parsePatch(patchText);
      if (!ops.length) return { result: { ok: false, error: 'no file operations found in patch' } };

      const applied: string[] = [];
      for (const op of ops) {
        await applyOp(ctx, op);
        applied.push(`${op.kind} ${op.path}`);
      }
      return { result: { ok: true, files: applied.length, changes: applied } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

type Op =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; hunks: string[][] };

/** Parse the apply-patch envelope into a flat list of per-file operations. */
function parsePatch(text: string): Op[] {
  const lines = text.split('\n');
  const ops: Op[] = [];
  let i = 0;

  // Skip to the envelope start if present; tolerate its absence.
  while (i < lines.length && !(lines[i] ?? '').startsWith('*** Begin Patch')) i++;
  if (i < lines.length) i++;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('*** End Patch')) break;

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !(lines[i] ?? '').startsWith('*** ')) {
        const l = lines[i] ?? '';
        body.push(l.startsWith('+') ? l.slice(1) : l);
        i++;
      }
      ops.push({ kind: 'add', path, content: body.join('\n') });
    } else if (line.startsWith('*** Delete File: ')) {
      ops.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim() });
      i++;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      const hunks: string[][] = [];
      let current: string[] = [];
      while (i < lines.length && !(lines[i] ?? '').startsWith('*** ')) {
        const l = lines[i] ?? '';
        if (l.startsWith('@@')) {
          if (current.length) hunks.push(current);
          current = [];
        } else {
          current.push(l);
        }
        i++;
      }
      if (current.length) hunks.push(current);
      ops.push({ kind: 'update', path, hunks });
    } else {
      i++; // stray line between sections
    }
  }
  return ops;
}

async function applyOp(ctx: ToolContext, op: Op): Promise<void> {
  if (op.kind === 'add') {
    if (await fileExists(ctx, op.path)) throw new Error(`Add File: ${op.path} already exists`);
    await writeFileBytes(ctx, op.path, Buffer.from(op.content, 'utf8'));
    return;
  }
  if (op.kind === 'delete') {
    const r = await runInEnv(ctx, `rm -f -- ${shq(op.path)}`);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot delete ${op.path}`);
    return;
  }

  // update
  const original = (await readFileBytes(ctx, op.path)).toString('utf8');
  const lines = original.split('\n');
  let cursor = 0;

  for (const hunk of op.hunks) {
    const oldBlock: string[] = [];
    const newBlock: string[] = [];
    for (const l of hunk) {
      if (l === '') {
        oldBlock.push('');
        newBlock.push('');
      } else if (l[0] === ' ') {
        oldBlock.push(l.slice(1));
        newBlock.push(l.slice(1));
      } else if (l[0] === '-') {
        oldBlock.push(l.slice(1));
      } else if (l[0] === '+') {
        newBlock.push(l.slice(1));
      } else {
        oldBlock.push(l);
        newBlock.push(l);
      }
    }

    const at = indexOfBlock(lines, oldBlock, cursor);
    if (at === -1) {
      throw new Error(`Update File: ${op.path} — hunk context not found`);
    }
    lines.splice(at, oldBlock.length, ...newBlock);
    cursor = at + newBlock.length;
  }

  await writeFileBytes(ctx, op.path, Buffer.from(lines.join('\n'), 'utf8'));
}

/** Find `block` as a contiguous run of lines in `hay`, at or after `from`. */
function indexOfBlock(hay: string[], block: string[], from: number): number {
  if (!block.length) return from;
  for (let i = from; i <= hay.length - block.length; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) {
      if (hay[i + j] !== block[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
