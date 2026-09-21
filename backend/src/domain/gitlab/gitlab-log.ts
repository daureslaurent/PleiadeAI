/**
 * Making a CI log readable by a model (`GITLAB_PLAN.md` §16).
 *
 * A GitLab job trace is a terminal recording, not a document. What arrives over the API carries
 * three layers of machinery that mean nothing once the text is going to a language model, and on a
 * modern GitLab it is most of the bytes:
 *
 * ```
 * 2026-09-21T14:28:36.108222Z 01E \u001b[0KERROR: failed to build: path "dancing-cats" not found
 * └─ trace metadata ─────────┘ └─┘ └ erase-line ┘└─ the only part anybody wants ──────────────┘
 * ```
 *
 * The first cleaner here stripped ANSI *colour* — `\u001b[…m` — and GitLab's `section_start`
 * markers, which was right when it was written and is no longer enough. `\u001b[0K` ends in `K`,
 * not `m`, so every erase-line sequence survived it, and the per-line timestamp/stream prefix is a
 * newer feature that did not exist at all. An agent reading a production log was seeing
 * `00O+[0K` in front of every line and paying context for it.
 *
 * One exported function, used by the `gitlab_ci` tool *and* the operator's log route, for the same
 * reason `api-caller.service.ts` is shared: two cleaners drift, and then the operator and the agent
 * are looking at different text while discussing the same failure.
 */

/** Any CSI escape sequence, not just the colour ones — `[0K` erase-line is the common survivor. */
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Operating-system commands (window titles): rare in CI, free to drop. */
// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** GitLab's own collapsible-section markers. */
const SECTIONS = /section_(start|end):\d+:[^\r\n]*/g;
/**
 * The per-line trace metadata GitLab prepends when job-log timestamps are on:
 * an RFC3339 timestamp, then a two-hex-digit segment counter, then `O` (stdout) or `E` (stderr),
 * optionally `+` for a continuation.
 */
const TRACE_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+[0-9A-Fa-f]{2}[OE]\+?\s?/;

/**
 * Clean one job trace.
 *
 * Carriage returns are handled rather than stripped: `docker pull` and every progress bar redraw a
 * line by returning to its start, so the *last* segment of a `\r`-separated line is the final state
 * and everything before it is a frame of an animation nobody is watching. Keeping them all turns a
 * 40-line pull into 4,000 lines of context.
 */
export function cleanJobLog(raw: string): string {
  const out: string[] = [];
  let blanks = 0;
  for (const rawLine of String(raw ?? '').split('\n')) {
    // Progress-bar redraws: keep the final frame of the line.
    const lastFrame = rawLine.split('\r').pop() ?? rawLine;
    const line = lastFrame
      .replace(CSI, '')
      .replace(OSC, '')
      .replace(SECTIONS, '')
      .replace(TRACE_PREFIX, '')
      .replace(/\s+$/, '');
    if (!line) {
      // Stripping the machinery leaves long runs of empty lines behind it; one is a paragraph
      // break, six is padding.
      blanks += 1;
      if (blanks > 1) continue;
      out.push('');
      continue;
    }
    blanks = 0;
    out.push(line);
  }
  return out.join('\n').trim();
}
