import { settingsService } from '../domain/settings/settings.service';

/**
 * Multi-agent recursion guard (spec §4). Enforces a ceiling on agent-to-agent hops to prevent token
 * exhaustion / runaway recursion.
 *
 * Depth convention: the directly-addressed agent runs at depth 0; each `ask_agent` delegation
 * increments depth. `canHop(nextDepth)` answers whether a delegation *to* that depth is allowed.
 *
 * The ceiling is the `max_agent_hops` runtime setting (Settings → Inference), falling back to the
 * `MAX_AGENT_HOPS` env var. It is read per check rather than cached so an operator raising the limit
 * mid-flight takes effect on the next delegation, with no restart — the read is one indexed findOne
 * against the settings singleton, on a path that is about to spend an entire inference call anyway.
 */
export class HopGuard {
  /** The current ceiling. */
  async max(): Promise<number> {
    const { max_agent_hops } = await settingsService.get();
    return max_agent_hops;
  }

  /** True if an agent at `nextDepth` may still be invoked. */
  async canHop(nextDepth: number): Promise<boolean> {
    return nextDepth <= (await this.max());
  }
}

export const hopGuard = new HopGuard();
