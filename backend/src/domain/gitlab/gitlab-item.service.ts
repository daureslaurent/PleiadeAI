import { request, type GitLabConnection } from './gitlab.service';

/**
 * Everything that happened on one issue or merge request, as one list (`GITLAB_PLAN.md` §14).
 *
 * The bug this fixes: `gitlab_issue({action:'get'})` returned the description and nothing else, so
 * an agent could read an issue, never see the four comments on it, and answer a question that was
 * settled two days ago. The tool surface made the conversation invisible, and no amount of prompt
 * could make an agent read what it had no call for.
 *
 * GitLab keeps that conversation in three places, and all three matter:
 *
 * - **discussions** — the comments, threaded, with `resolved` and the file/line a review comment is
 *   anchored to. Read rather than `notes` because a reply has to go *into* a thread, and only this
 *   endpoint carries the thread id that makes that possible.
 * - **resource_state_events** — closed / reopened. These stopped being system notes years ago, so
 *   an integration reading only notes cannot see that an issue was closed and reopened twice.
 * - **resource_label_events** — labels added and removed, which is how most GitLab shops encode
 *   status; `needs-review` going on and coming off is the story of the item.
 *
 * Three calls, in parallel, and they are the reason `get` is worth what it costs: an agent that
 * cannot see the answer already given writes it again.
 */

export type ItemKind = 'issues' | 'merge_requests';

export interface TimelineEntry {
  at: string;
  /**
   * `comment` is a standalone note, `review` one inside a thread (so it has a `thread_id` to reply
   * into), `system` GitLab's own narration, and the rest are structured events.
   */
  kind: 'comment' | 'review' | 'system' | 'state' | 'label';
  author: string;
  text: string;
  /** Present on threaded notes: pass it to `reply` to answer in the same thread. */
  thread_id?: string;
  /** Threads only. An unresolved review thread is an open question with somebody waiting on it. */
  resolved?: boolean;
  /** `path:line` for a review comment anchored to code. */
  anchor?: string;
}

export interface ItemStory {
  timeline: TimelineEntry[];
  /** Human comments, system narration excluded — "has anybody actually said anything". */
  comments: number;
  /** Review threads still open. The number a reviewer is answerable for. */
  unresolved: number;
  /** Entries dropped to fit the budget, oldest-middle first. */
  omitted: number;
}

/** Characters of timeline text a `get` may spend before it starts dropping the middle. */
const DEFAULT_BUDGET = 12_000;
/** A single comment longer than this is cut — one essay must not evict the whole thread. */
const MAX_ENTRY_CHARS = 2_000;

function cut(text: string): string {
  const clean = String(text ?? '').trim();
  return clean.length <= MAX_ENTRY_CHARS
    ? clean
    : `${clean.slice(0, MAX_ENTRY_CHARS)}\n…[comment cut: ${clean.length - MAX_ENTRY_CHARS} more characters]`;
}

/**
 * Assemble the story. Never throws for a missing sub-resource: a project with restricted access to
 * one of the three still has an item worth reading, and a `get` that fails entirely because the
 * label-events endpoint 403'd would be a worse tool than the one this replaces.
 */
export async function itemStory(opts: {
  conn: GitLabConnection;
  /** Percent-encoded project id, as `projectPath()` returns it. */
  id: string;
  kind: ItemKind;
  iid: number;
  budget?: number;
}): Promise<ItemStory> {
  const { conn, id, kind, iid } = opts;
  const base = `projects/${id}/${kind}/${iid}`;

  const [discussions, states, labels] = await Promise.all([
    request<Record<string, any>[]>(`${base}/discussions`, { conn, paginate: 100 }).catch(() => []),
    request<Record<string, any>[]>(`${base}/resource_state_events`, { conn, paginate: 100 }).catch(() => []),
    request<Record<string, any>[]>(`${base}/resource_label_events`, { conn, paginate: 100 }).catch(() => []),
  ]);

  const entries: TimelineEntry[] = [];
  let comments = 0;
  let unresolved = 0;

  for (const d of discussions) {
    const notes: Record<string, any>[] = d.notes ?? [];
    // A one-note discussion is a plain comment; GitLab still gives it an id, but replying "into" it
    // creates a thread the author never opened, so the id is only offered for real threads.
    const threaded = d.individual_note === false && notes.length > 0;
    const first = notes[0];
    const anchor = first?.position
      ? `${first.position.new_path ?? first.position.old_path}:${first.position.new_line ?? first.position.old_line}`
      : undefined;
    if (threaded && notes.some((n) => n.resolvable && !n.resolved)) unresolved += 1;

    for (const n of notes) {
      if (!n.system) comments += 1;
      entries.push({
        at: String(n.created_at ?? ''),
        kind: n.system ? 'system' : threaded ? 'review' : 'comment',
        author: String(n.author?.username ?? 'unknown'),
        text: cut(n.body),
        ...(threaded ? { thread_id: String(d.id), resolved: !!n.resolved } : {}),
        ...(anchor ? { anchor } : {}),
      });
    }
  }

  for (const e of states) {
    // `merged` is a state event too, and on a merge request it is the one that matters most — the
    // naive "closed or reopened" reading would report a merge as a close.
    const what =
      e.state === 'closed' ? 'closed it' : e.state === 'merged' ? 'merged it' : 'reopened it';
    entries.push({
      at: String(e.created_at ?? ''),
      kind: 'state',
      author: String(e.user?.username ?? 'unknown'),
      text: what,
    });
  }

  // Label churn is the noisiest signal here, so several changes by one person at one moment are one
  // line: "added ~bug, removed ~needs-triage" rather than four entries that push a comment out of
  // the budget.
  const grouped = new Map<string, { at: string; author: string; added: string[]; removed: string[] }>();
  for (const e of labels) {
    const author = String(e.user?.username ?? 'unknown');
    const at = String(e.created_at ?? '');
    const key = `${author}|${at.slice(0, 16)}`;
    const row = grouped.get(key) ?? { at, author, added: [], removed: [] };
    const name = String(e.label?.name ?? '');
    if (name) (e.action === 'remove' ? row.removed : row.added).push(name);
    grouped.set(key, row);
  }
  for (const row of grouped.values()) {
    const parts = [
      row.added.length ? `added ${row.added.map((l) => `~${l}`).join(', ')}` : '',
      row.removed.length ? `removed ${row.removed.map((l) => `~${l}`).join(', ')}` : '',
    ].filter(Boolean);
    if (parts.length) entries.push({ at: row.at, kind: 'label', author: row.author, text: parts.join('; ') });
  }

  entries.sort((a, b) => a.at.localeCompare(b.at));

  // Over budget, the *middle* goes: the opening exchange says what this is for and the last few say
  // where it stands, while the sixty messages in between are the part an agent can ask about.
  const budget = opts.budget ?? DEFAULT_BUDGET;
  let omitted = 0;
  const total = entries.reduce((sum, e) => sum + e.text.length + 40, 0);
  if (total > budget) {
    const head = entries.slice(0, 2);
    const tail: TimelineEntry[] = [];
    let spent = head.reduce((sum, e) => sum + e.text.length + 40, 0);
    for (let i = entries.length - 1; i >= head.length; i -= 1) {
      const e = entries[i]!;
      const cost = e.text.length + 40;
      if (spent + cost > budget) break;
      tail.unshift(e);
      spent += cost;
    }
    omitted = entries.length - head.length - tail.length;
    if (omitted > 0) {
      return {
        timeline: [
          ...head,
          {
            at: head[head.length - 1]?.at ?? '',
            kind: 'system',
            author: 'gitlab',
            text: `…[${omitted} earlier entries omitted to fit — read them on GitLab if the middle matters]`,
          },
          ...tail,
        ],
        comments,
        unresolved,
        omitted,
      };
    }
  }

  return { timeline: entries, comments, unresolved, omitted };
}

/**
 * What else points at this issue: the merge requests that mention it, the ones that will close it,
 * and its related issues.
 *
 * All three are Free-tier, all three are one call, and together they answer the question an agent
 * asks before touching anything — "is somebody already doing this?" A branch open against an issue
 * is the most reliable answer there is, and it was invisible.
 */
export async function issueLinks(opts: {
  conn: GitLabConnection;
  id: string;
  iid: number;
}): Promise<{
  merge_requests: { iid: number; title: string; state: string; url: string; project_id: number }[];
  closed_by: number[];
  related: { iid: number; title: string; state: string; link_type: string; url: string }[];
}> {
  const { conn, id, iid } = opts;
  const [mrs, closedBy, related] = await Promise.all([
    request<Record<string, any>[]>(`projects/${id}/issues/${iid}/related_merge_requests`, {
      conn,
      paginate: 20,
    }).catch(() => []),
    request<Record<string, any>[]>(`projects/${id}/issues/${iid}/closed_by`, { conn, paginate: 20 }).catch(
      () => [],
    ),
    request<Record<string, any>[]>(`projects/${id}/issues/${iid}/links`, { conn, paginate: 20 }).catch(
      () => [],
    ),
  ]);
  return {
    merge_requests: mrs.map((m) => ({
      iid: Number(m.iid),
      title: String(m.title ?? ''),
      state: String(m.state ?? ''),
      url: String(m.web_url ?? ''),
      project_id: Number(m.project_id),
    })),
    closed_by: closedBy.map((m) => Number(m.iid)),
    related: related.map((i) => ({
      iid: Number(i.iid),
      title: String(i.title ?? ''),
      state: String(i.state ?? ''),
      link_type: String(i.link_type ?? 'relates_to'),
      url: String(i.web_url ?? ''),
    })),
  };
}

/**
 * Who has approved a merge request, and who still has to.
 *
 * Free tier, despite approval *rules* being Premium — the four endpoints that matter (approve,
 * unapprove, reset, approval state) are available on every tier, and without the last of them an
 * agent cannot tell "nobody has looked at this" from "two people approved it an hour ago".
 */
export async function mrApprovals(opts: {
  conn: GitLabConnection;
  id: string;
  iid: number;
}): Promise<{ approved_by: string[]; approvals_required: number | null; approvals_left: number | null } | null> {
  try {
    const state = await request<Record<string, any>>(
      `projects/${opts.id}/merge_requests/${opts.iid}/approval_state`,
      { conn: opts.conn },
    );
    const rules: Record<string, any>[] = state.rules ?? [];
    const approvedBy = new Set<string>();
    let required: number | null = null;
    let left: number | null = null;
    for (const rule of rules) {
      for (const user of rule.approved_by ?? []) approvedBy.add(String(user.username));
      if (typeof rule.approvals_required === 'number') {
        required = (required ?? 0) + rule.approvals_required;
      }
    }
    if (required !== null) left = Math.max(0, required - approvedBy.size);
    if (!approvedBy.size) {
      // A Free-tier project with no approval rules configured can answer `approval_state` with an
      // empty rule list even when somebody has approved, and then the only honest source left is
      // the merge request's own approvals object. Second call only when the first said nothing.
      const fallback = await request<Record<string, any>>(
        `projects/${opts.id}/merge_requests/${opts.iid}/approvals`,
        { conn: opts.conn },
      ).catch(() => null);
      for (const user of fallback?.approved_by ?? []) approvedBy.add(String(user.user?.username ?? user.username));
    }
    return { approved_by: [...approvedBy].filter(Boolean), approvals_required: required, approvals_left: left };
  } catch {
    // An instance or project with approvals switched off answers 404 here, and that is not an error
    // about the merge request.
    return null;
  }
}
