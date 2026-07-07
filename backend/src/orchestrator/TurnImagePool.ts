import type { ImageBlock } from '../core/event-bus/events.types';

export type ImageSource = NonNullable<ImageBlock['source']>;

/**
 * Per-turn, mutable pool of the images an agent can act on. Seeded with the turn's attachments and
 * grown as tools/skills acquire more (e.g. `read` on a picture). Every image gets a stable handle
 * (`img_1`, `img_2`, …) so agents reference it by id — for `analyze_image` or `ask_agent` forwarding
 * — never by filesystem path (a path is meaningless once the image crosses a cross-agent hop).
 *
 * One pool lives for the duration of a single `AgentRunner.run` and is shared by reference across all
 * of that turn's tool calls, so an image read in one tool call is reachable by a later one.
 */
export class TurnImagePool {
  private items: ImageBlock[] = [];
  private counter = 0;

  constructor(seed: ImageBlock[] = [], source: ImageSource = 'attachment') {
    for (const block of seed) this.add(block, source);
  }

  /**
   * Register an image, returning it stamped with a handle. An image that already carries a numbered
   * handle (forwarded across a hop) keeps it — and nudges the counter past it so fresh handles don't
   * collide. Re-registering the same handle replaces the existing entry rather than duplicating it.
   */
  add(block: ImageBlock, source: ImageSource): ImageBlock {
    let id = block.id;
    if (id) {
      const m = /^img_(\d+)$/.exec(id);
      if (m) this.counter = Math.max(this.counter, Number(m[1]));
    } else {
      id = `img_${++this.counter}`;
    }
    const stamped: ImageBlock = { ...block, id, source: block.source ?? source };
    const existing = this.items.findIndex((i) => i.id === id);
    if (existing >= 0) {
      this.items[existing] = stamped;
    } else {
      this.items.push(stamped);
    }
    return stamped;
  }

  /** Register several tool-acquired images at once, returning them stamped with handles. */
  addMany(blocks: ImageBlock[], source: ImageSource): ImageBlock[] {
    return blocks.map((b) => this.add(b, source));
  }

  /** Every image in the pool, in insertion order. */
  all(): ImageBlock[] {
    return this.items;
  }

  /** Resolve a subset by handle; unknown ids are skipped. */
  byIds(ids: string[]): ImageBlock[] {
    const wanted = new Set(ids);
    return this.items.filter((i) => i.id != null && wanted.has(i.id));
  }

  get size(): number {
    return this.items.length;
  }
}
