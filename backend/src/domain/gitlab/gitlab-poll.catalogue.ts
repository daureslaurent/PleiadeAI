/**
 * The events a poll may wake an agent on (`GITLAB_PLAN.md` §13.2).
 *
 * One table, read by three things: the poller matching a GitLab object, the settings page rendering
 * its checkboxes, and the brief telling the agent what happened. That is deliberate and it is the
 * same argument as `flows/nodes/index.ts` — a catalogue the UI re-declares drifts from the one the
 * runner matches against, and the drift shows up as a checkbox that silently does nothing.
 *
 * Every kind ships off. Polling that is switched on with nothing armed makes no calls at all.
 */

/** Where the kind is found. A source with no armed kind is never polled. */
export type PollSource = 'todo' | 'event' | 'pipeline';

/**
 * Which brief the woken agent reads. Several kinds share one: being assigned an issue and being
 * mentioned on one end in the same place — a comment on the issue.
 */
export type WakeFamily = 'issue' | 'merge_request' | 'note' | 'pipeline';

export interface PollEventKind {
  id: string;
  /** The checkbox label, phrased as the thing that happens. */
  label: string;
  hint: string;
  source: PollSource;
  family: WakeFamily;
  /**
   * Todo kinds: the `action_name` values GitLab uses. Event kinds: the `action_name` prefixes an
   * event may carry (`pushed to` / `pushed new` both start "pushed"), paired with `targetType`.
   */
  match?: string[];
  targetType?: 'Issue' | 'MergeRequest';
}

export const POLL_EVENT_KINDS: PollEventKind[] = [
  // ——— Todos: GitLab's own per-account inbox. No routing to invent — the account *is* the agent.
  {
    id: 'issue_assigned',
    label: 'An issue is assigned to an agent',
    hint: 'The work board handing something over. The agent wakes, reads the issue and works it.',
    source: 'todo',
    family: 'issue',
    match: ['assigned'],
    targetType: 'Issue',
  },
  {
    id: 'mr_assigned',
    label: 'A merge request is assigned to an agent',
    hint: 'Assigned, not review-requested — on GitLab that means the MR is now theirs to land.',
    source: 'todo',
    family: 'merge_request',
    match: ['assigned'],
    targetType: 'MergeRequest',
  },
  {
    id: 'mr_review_requested',
    label: 'A review is requested from an agent',
    hint: 'The agent reads the whole diff and reviews on the merge request itself.',
    source: 'todo',
    family: 'merge_request',
    match: ['review_requested'],
    targetType: 'MergeRequest',
  },
  {
    id: 'mr_approval_required',
    label: 'An agent’s approval is required',
    hint: 'An approval rule names the agent. Same work as a review, with a decision at the end.',
    source: 'todo',
    family: 'merge_request',
    match: ['approval_required'],
  },
  {
    id: 'mentioned',
    label: 'An agent is named in an issue, a merge request or a comment',
    hint:
      'The closest thing to being spoken to. Mentions written by the fleet’s own accounts are ' +
      'ignored — that is the comment-answers-comment loop, and it is the one kind where it exists.',
    source: 'todo',
    family: 'note',
    match: ['mentioned', 'directly_addressed'],
  },
  {
    id: 'mr_build_failed',
    label: 'The pipeline of an agent’s merge request failed',
    hint: 'Only reaches the MR’s own author — GitLab tells nobody else.',
    source: 'todo',
    family: 'merge_request',
    match: ['build_failed'],
  },
  {
    id: 'mr_unmergeable',
    label: 'An agent’s merge request can no longer be merged',
    hint: 'Usually a conflict with the target branch that appeared after the MR was opened.',
    source: 'todo',
    family: 'merge_request',
    match: ['unmergeable'],
  },

  // ——— Project events: state changes GitLab notifies nobody about.
  {
    id: 'mr_merged',
    label: 'A merge request was merged',
    hint: 'The “it was accepted, do the follow-up” wake. Merges the fleet performed are skipped.',
    source: 'event',
    family: 'merge_request',
    match: ['merged', 'accepted'],
    targetType: 'MergeRequest',
  },
  {
    id: 'mr_opened',
    label: 'A merge request was opened',
    hint: 'Wakes the project’s agent on every new MR, whether or not it was asked to review.',
    source: 'event',
    family: 'merge_request',
    match: ['opened', 'created'],
    targetType: 'MergeRequest',
  },
  {
    id: 'mr_closed',
    label: 'A merge request was closed without merging',
    hint: 'Someone rejected the work. Usually worth reading why.',
    source: 'event',
    family: 'merge_request',
    match: ['closed'],
    targetType: 'MergeRequest',
  },
  {
    id: 'issue_opened',
    label: 'An issue was opened',
    hint: 'Triage on arrival — noisy on a project humans file into. Consider assignment instead.',
    source: 'event',
    family: 'issue',
    match: ['opened', 'created'],
    targetType: 'Issue',
  },
  {
    id: 'issue_closed',
    label: 'An issue was closed',
    hint: 'The end of a piece of work, which is where a follow-up or a changelog belongs.',
    source: 'event',
    family: 'issue',
    match: ['closed'],
    targetType: 'Issue',
  },
  {
    id: 'pushed',
    label: 'Someone pushed to the default branch',
    hint: 'The loudest kind on an active repository. Pushes by the fleet itself are skipped.',
    source: 'event',
    family: 'issue',
    match: ['pushed'],
  },

  // ——— Pipelines: nobody owns the default branch, so nobody gets a todo when it goes red.
  {
    id: 'pipeline_failed',
    label: 'The default branch’s pipeline went red',
    hint: 'Costs one extra call per polled project, and only while this is on.',
    source: 'pipeline',
    family: 'pipeline',
  },
];

const BY_ID = new Map(POLL_EVENT_KINDS.map((k) => [k.id, k]));

export function pollKind(id: string): PollEventKind | undefined {
  return BY_ID.get(id);
}

/** The armed kinds of one source — and, when empty, the reason that source is not polled at all. */
export function armedKinds(enabled: string[], source: PollSource): PollEventKind[] {
  return POLL_EVENT_KINDS.filter((k) => k.source === source && enabled.includes(k.id));
}
