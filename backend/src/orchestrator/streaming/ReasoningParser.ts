/**
 * Streaming `<think>` reasoning splitter.
 *
 * Local models (and llama.cpp) emit chain-of-thought wrapped in `<think>...</think>`. The
 * frontend needs each streamed chunk tagged as reasoning or normal output (the WS
 * `is_reasoning` flag) so the debugger drawer can render reasoning distinctly from the answer.
 *
 * Tags can straddle token boundaries (`<th` | `ink>`), so a tail that *might* be the start of
 * a tag is held back until the next `push` disambiguates it. Call `flush()` at stream end to
 * release any held tail.
 */
export interface ReasoningSegment {
  content: string;
  isReasoning: boolean;
}

const OPEN = '<think>';
const CLOSE = '</think>';

export class ReasoningParser {
  private inThink = false;
  /** Held-back tail that could be the prefix of an OPEN/CLOSE tag. */
  private pending = '';

  push(delta: string): ReasoningSegment[] {
    this.pending += delta;
    const out: ReasoningSegment[] = [];

    // Loop consuming whole tags until only a (possibly partial-tag) tail remains.
    for (;;) {
      const tag = this.inThink ? CLOSE : OPEN;
      const idx = this.pending.indexOf(tag);

      if (idx !== -1) {
        const before = this.pending.slice(0, idx);
        if (before) out.push({ content: before, isReasoning: this.inThink });
        this.pending = this.pending.slice(idx + tag.length);
        this.inThink = !this.inThink;
        continue;
      }

      // No complete tag. Emit everything except a suffix that could still become a tag.
      const safeLen = this.pending.length - this.longestTagPrefixSuffix(this.pending, tag);
      if (safeLen > 0) {
        out.push({ content: this.pending.slice(0, safeLen), isReasoning: this.inThink });
        this.pending = this.pending.slice(safeLen);
      }
      break;
    }

    return out.filter((s) => s.content.length > 0);
  }

  /** Emit any remaining buffered text (called once the stream completes). */
  flush(): ReasoningSegment[] {
    if (!this.pending) return [];
    const seg = { content: this.pending, isReasoning: this.inThink };
    this.pending = '';
    return seg.content ? [seg] : [];
  }

  /**
   * Length of the longest suffix of `text` that is a proper prefix of `tag`
   * (e.g. text ends with "<thi", tag is "<think>" → 4). That suffix is withheld so a tag
   * split across chunks isn't emitted as literal text.
   */
  private longestTagPrefixSuffix(text: string, tag: string): number {
    const max = Math.min(text.length, tag.length - 1);
    for (let len = max; len > 0; len--) {
      if (tag.startsWith(text.slice(text.length - len))) return len;
    }
    return 0;
  }
}
