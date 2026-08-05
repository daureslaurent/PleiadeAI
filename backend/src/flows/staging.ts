/**
 * A flow's **staging session** for operator-uploaded inputs (flows spec §3).
 *
 * Uploads can't be written straight into a run's session: that session *is* the run id, which does
 * not exist until the run starts. Staging per flow rather than per upload also makes a file reusable
 * — upload once, set it as an input node's default, and every later run picks it up without a
 * re-upload. `FlowRunner` imports the bytes into the run's own session at input time, so everything
 * downstream sees one uniform handle space and the run's artifact list stays self-contained.
 *
 * Its own module so the HTTP route and the `input` node agree on the name without importing each
 * other.
 */
export function stagingSessionOf(flowId: string): string {
  return `flow-${flowId}`;
}
