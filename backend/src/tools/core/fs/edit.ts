import type { Tool } from '../../types';
import { fileExists, readFileBytes, writeFileBytes, toErrorResult } from './env-fs';

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * `edit` — replace an exact substring in a file, matching OpenCode's tool name and argument schema
 * (`filePath`, `oldString`, `newString`, `replaceAll`). `oldString` must match uniquely unless
 * `replaceAll` is set. An empty `oldString` creates the file with `newString` as its contents.
 */
export const edit: Tool = {
  name: 'edit',
  description:
    'Performs an exact string replacement in a file. `oldString` must match the file content ' +
    'exactly (including whitespace) and be unique, unless `replaceAll` is true. Use an empty ' +
    '`oldString` to create a new file whose contents are `newString`.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'The path of the file to edit.' },
      oldString: { type: 'string', description: 'The text to replace (empty to create a new file).' },
      newString: { type: 'string', description: 'The text to replace it with.' },
      replaceAll: {
        type: 'boolean',
        description: 'Replace every occurrence of `oldString` (default false).',
      },
    },
    required: ['filePath', 'oldString', 'newString'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const filePath = String(args.filePath ?? '').trim();
    if (!filePath) return { result: { ok: false, error: 'filePath is required' } };
    const oldString = typeof args.oldString === 'string' ? args.oldString : '';
    const newString = typeof args.newString === 'string' ? args.newString : '';
    const replaceAll = Boolean(args.replaceAll);

    try {
      // Empty oldString → create a fresh file with newString as its content.
      if (oldString === '') {
        if (await fileExists(ctx, filePath)) {
          return {
            result: {
              ok: false,
              error: `file already exists: ${filePath} — provide a non-empty oldString to edit it`,
            },
          };
        }
        await writeFileBytes(ctx, filePath, Buffer.from(newString, 'utf8'));
        return { result: { ok: true, path: filePath, action: 'created' } };
      }

      const original = (await readFileBytes(ctx, filePath)).toString('utf8');
      const occurrences = countOccurrences(original, oldString);
      if (occurrences === 0) {
        return { result: { ok: false, error: 'oldString not found in file' } };
      }
      if (occurrences > 1 && !replaceAll) {
        return {
          result: {
            ok: false,
            error: `oldString is not unique (${occurrences} matches) — add context or set replaceAll`,
          },
        };
      }

      const updated = replaceAll
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString);
      await writeFileBytes(ctx, filePath, Buffer.from(updated, 'utf8'));

      return {
        result: {
          ok: true,
          path: filePath,
          action: 'edited',
          replacements: replaceAll ? occurrences : 1,
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
