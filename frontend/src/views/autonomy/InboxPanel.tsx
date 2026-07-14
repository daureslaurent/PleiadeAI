import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCheck, Inbox, Trash2, X } from 'lucide-react';
import { inboxApi, type Agent, type Notification } from '../../lib/api';
import { agentColor } from '../../lib/agentColor';
import { EmptyState, Section, useConfirm } from '../../components/ui';
import { fmtDateTime, relativeTime } from './time';

/**
 * Notifications inbox rail (the persistent Mongo leg of the dual-alert pipeline). Self-refreshing;
 * clicking a notification expands it and marks it read. `onUnreadChange` lets the parent (and the
 * sidebar badge) stay honest without a second endpoint hit.
 */
export function InboxPanel({
  agents,
  onUnreadChange,
}: {
  agents: Agent[];
  onUnreadChange?: (count: number) => void;
}) {
  const confirm = useConfirm();
  const [notes, setNotes] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const agentById = useMemo(() => new Map(agents.map((a) => [a._id, a])), [agents]);
  const unread = notes.filter((n) => n.status === 'unread').length;

  useEffect(() => {
    onUnreadChange?.(unread);
  }, [unread, onUnreadChange]);

  const refresh = useCallback(() => {
    inboxApi.list().then(setNotes).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  function open(n: Notification) {
    setExpanded((cur) => (cur === n._id ? null : n._id));
    if (n.status === 'unread') {
      setNotes((all) => all.map((x) => (x._id === n._id ? { ...x, status: 'read' } : x)));
      inboxApi.markRead(n._id).catch(() => refresh());
    }
  }

  async function readAll() {
    setNotes((all) => all.map((n) => ({ ...n, status: 'read' })));
    await inboxApi.readAll().catch(() => undefined);
    refresh();
  }

  async function clearRead() {
    const count = notes.filter((n) => n.status === 'read').length;
    if (!count) return;
    const ok = await confirm({
      title: 'Clear read notifications?',
      body: `${count} read notification${count === 1 ? '' : 's'} will be permanently deleted.`,
      danger: true,
      confirmLabel: 'Clear',
    });
    if (!ok) return;
    await inboxApi.clearRead().catch(() => undefined);
    refresh();
  }

  async function remove(id: string) {
    setNotes((all) => all.filter((n) => n._id !== id));
    await inboxApi.remove(id).catch(() => refresh());
  }

  const visible = unreadOnly ? notes.filter((n) => n.status === 'unread') : notes;

  return (
    <Section
      title="Inbox"
      icon={<Inbox size={13} />}
      className="flex min-h-0 flex-1 flex-col"
      right={
        <>
          {unread > 0 && (
            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              {unread}
            </span>
          )}
          <button
            onClick={() => setUnreadOnly((v) => !v)}
            className={`rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
              unreadOnly
                ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
                : 'text-slate-500 hover:bg-white/[0.06] hover:text-slate-300'
            }`}
            title="Show unread only"
          >
            unread
          </button>
          <button
            onClick={readAll}
            disabled={!unread}
            title="Mark all read"
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200 disabled:pointer-events-none disabled:opacity-40"
          >
            <CheckCheck size={13} />
          </button>
          <button
            onClick={clearRead}
            disabled={!notes.some((n) => n.status === 'read')}
            title="Delete all read notifications"
            className="rounded-md p-1 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:pointer-events-none disabled:opacity-40"
          >
            <Trash2 size={13} />
          </button>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {visible.map((n) => {
          const agent = n.agent_id ? agentById.get(n.agent_id) : undefined;
          const color = agent ? agentColor(agent.name, agent.color) : null;
          const isUnread = n.status === 'unread';
          const isOpen = expanded === n._id;
          return (
            <div
              key={n._id}
              onClick={() => open(n)}
              className={`group cursor-pointer rounded-xl border px-2.5 py-2 text-xs transition-colors ${
                isUnread
                  ? 'border-white/[0.09] bg-white/[0.04] hover:border-white/[0.14]'
                  : 'border-white/[0.05] bg-black/20 opacity-75 hover:opacity-100'
              }`}
            >
              <div className="flex items-center gap-1.5">
                {isUnread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                <span className={`truncate ${isUnread ? 'font-medium text-slate-100' : 'text-slate-300'}`}>
                  {n.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(n._id);
                  }}
                  title="Delete"
                  className="ml-auto shrink-0 rounded p-0.5 text-slate-600 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>
              <div className={`mt-1 text-slate-500 ${isOpen ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
                {n.content}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-600">
                {agent && color && (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color.accent }} />
                    <span style={{ color: color.accent }}>{agent.name}</span>
                    <span>·</span>
                  </>
                )}
                <span title={fmtDateTime(n.created_at)}>{relativeTime(n.created_at)}</span>
              </div>
            </div>
          );
        })}
        {!visible.length && (
          <EmptyState icon={<Inbox size={22} />}>
            {unreadOnly ? 'No unread notifications.' : 'Inbox empty.'}
          </EmptyState>
        )}
      </div>
    </Section>
  );
}
