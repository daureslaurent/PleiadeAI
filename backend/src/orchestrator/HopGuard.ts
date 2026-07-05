import { env } from '../config/env';

/**
 * Multi-agent recursion guard (spec §4). Enforces a hard ceiling of `MAX_AGENT_HOPS`
 * agent-to-agent hops to prevent token exhaustion / runaway recursion.
 *
 * Depth convention: the directly-addressed agent runs at depth 0; each `ask_agent` delegation
 * increments depth. `canHop(nextDepth)` answers whether a delegation *to* that depth is allowed.
 */
export class HopGuard {
  constructor(private readonly maxHops: number = env.MAX_AGENT_HOPS) {}

  /** True if an agent at `nextDepth` may still be invoked. */
  canHop(nextDepth: number): boolean {
    return nextDepth <= this.maxHops;
  }

  get max(): number {
    return this.maxHops;
  }
}

export const hopGuard = new HopGuard();
