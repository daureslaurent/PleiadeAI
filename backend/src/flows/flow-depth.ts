/**
 * Nesting depth of the flow a session is executing inside (flows spec §4).
 *
 * A flow's `ask_agent` node runs its agent under the *flow run's* session id, so if that agent calls
 * `run_flow` the nesting is invisible from the tool's arguments — the only trace is the session it
 * inherited. Recording depth against the session is what lets the guard (mirroring `HopGuard`) stop a
 * flow that, directly or by way of an agent, runs itself forever.
 *
 * Its own module so `run_flow` and `FlowRunner` can both reach it without importing each other.
 */
const depthBySession = new Map<string, number>();

export function flowDepthOf(sessionId: string): number {
  return depthBySession.get(sessionId) ?? 0;
}

export function setFlowDepth(sessionId: string, depth: number): void {
  if (depth > 0) depthBySession.set(sessionId, depth);
}

export function clearFlowDepth(sessionId: string): void {
  depthBySession.delete(sessionId);
}
