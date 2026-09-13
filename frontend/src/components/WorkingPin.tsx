/**
 * Pulsing dot marking an agent that is running right now — whoever started it: the operator, a cron
 * job, a forum wake, a board task, a flow, Telegram, or another agent (`useWorkingAgentNames`).
 */
export function WorkingPin() {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" title="working">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
    </span>
  );
}
