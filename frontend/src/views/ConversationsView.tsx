import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Mic, Play, Save, Trash2, X } from 'lucide-react';
import {
  agentsApi,
  conversationGenApi,
  sessionsApi,
  type Agent,
  type ConversationGenerator,
  type Session,
  type StoredMessage,
} from '../lib/api';
import { MasterDetail, ListRow } from '../components/MasterDetail';
import { Markdown } from '../components/Markdown';
import {
  Button,
  Callout,
  Dot,
  EmptyState,
  Field,
  GlassCard,
  Hint,
  Input,
  Row,
  RowGroup,
  Section,
  Select,
  Textarea,
  Toggle,
  useConfirm,
} from '../components/ui';

/** The generator being edited. `_id` absent → a row that hasn't been created yet. */
interface Draft {
  _id?: string;
  target_agent_id: string;
  interviewer_agent_id: string;
  enabled: boolean;
  interval_minutes: number;
  turns: number;
  /** Edited as free text (one topic per line); split on save. */
  topicsText: string;
}

/** Generators run on their own clock, so the page refreshes itself to show conversations landing. */
const POLL_MS = 15_000;

function toDraft(g: ConversationGenerator): Draft {
  return {
    _id: g._id,
    target_agent_id: g.target_agent_id,
    interviewer_agent_id: g.interviewer_agent_id,
    enabled: g.enabled,
    interval_minutes: g.interval_minutes,
    turns: g.turns,
    topicsText: g.topics.join('\n'),
  };
}

function blank(agents: Agent[]): Draft {
  const interviewer = agents.find((a) => a.name === 'Interviewer');
  return {
    target_agent_id: agents[0]?._id ?? '',
    interviewer_agent_id: interviewer?._id ?? agents[0]?._id ?? '',
    enabled: false,
    interval_minutes: 60,
    turns: 3,
    topicsText: '',
  };
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Conversation Generator (docs/conversation-generator.md): an interviewer agent chats up selected
 * agents on a schedule, so their answers pile up as training data. One row per target agent; the
 * conversations it produced are listed underneath and can be read back turn by turn.
 */
export function ConversationsView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [generators, setGenerators] = useState<ConversationGenerator[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [transcript, setTranscript] = useState<{ session: Session; messages: StoredMessage[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const isNew = Boolean(draft && !draft._id);
  const selected = generators.find((g) => g._id === draft?._id) ?? null;

  const refresh = useCallback(async () => {
    const list = await conversationGenApi.list();
    setGenerators(list);
    return list;
  }, []);

  const loadSessions = useCallback(async (generatorId?: string) => {
    const { sessions: list, total: count } = await conversationGenApi.sessions(generatorId);
    setSessions(list);
    setTotal(count);
  }, []);

  useEffect(() => {
    void agentsApi.list().then(setAgents);
    void refresh();
    void loadSessions();
  }, [refresh, loadSessions]);

  // Conversations land on the generator's own schedule (and "Run now" is fire-and-forget), so poll
  // rather than leaving the page showing a stale count.
  useEffect(() => {
    const id = setInterval(() => {
      void refresh();
      void loadSessions(draft?._id);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, loadSessions, draft?._id]);

  function select(g: ConversationGenerator) {
    setError(null);
    setDraft(toDraft(g));
    void loadSessions(g._id);
  }

  async function save() {
    if (!draft) return;
    const body = {
      target_agent_id: draft.target_agent_id,
      interviewer_agent_id: draft.interviewer_agent_id,
      enabled: draft.enabled,
      interval_minutes: draft.interval_minutes,
      turns: draft.turns,
      topics: draft.topicsText.split('\n').map((t) => t.trim()).filter(Boolean),
    };
    setSaving(true);
    setError(null);
    try {
      const saved = draft._id
        ? await conversationGenApi.update(draft._id, body)
        : await conversationGenApi.create(body);
      await refresh();
      setDraft(toDraft(saved));
      void loadSessions(saved._id);
    } catch (e) {
      const res = (e as { response?: { data?: { error?: string } } }).response;
      setError(res?.data?.error ?? (e instanceof Error ? e.message : 'save failed'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft?._id || !selected) return;
    const ok = await confirm({
      title: `Delete the generator for “${selected.target_agent_name}”?`,
      body: 'The schedule stops. The conversations it already produced are kept — they are training data.',
      danger: true,
    });
    if (!ok) return;
    await conversationGenApi.remove(draft._id);
    setDraft(null);
    await refresh();
    void loadSessions();
  }

  async function runNow() {
    if (!draft?._id) return;
    await conversationGenApi.runNow(draft._id);
    // The conversation is several full agent turns — it lands on a later poll, not on this click.
    setError(null);
  }

  async function openTranscript(session: Session) {
    const messages = await sessionsApi.messages(session._id);
    setTranscript({ session, messages });
  }

  return (
    <>
      <MasterDetail
        newLabel="New generator"
        onNew={() => {
          setError(null);
          setDraft(blank(agents));
        }}
        list={generators.map((g) => (
          <ListRow key={g._id} active={draft?._id === g._id} onClick={() => select(g)}>
            <Mic size={15} className="shrink-0" />
            <span className="flex-1 truncate">{g.target_agent_name}</span>
            <span className="shrink-0 font-mono text-[10px] text-slate-500">{g.conversations_count}</span>
            <Dot
              tone={g.enabled ? 'ok' : 'idle'}
              pulse={g.enabled}
              title={g.enabled ? `every ${g.interval_minutes}m` : 'paused'}
            />
          </ListRow>
        ))}
      >
        {!draft ? (
          <EmptyState icon={<Mic size={28} />}>
            Pick a generator, or create one to have an interviewer agent chat up an agent on a timer.
          </EmptyState>
        ) : (
          <div className="flex h-full flex-col gap-4 overflow-auto p-4">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-medium text-slate-200">
                {selected ? selected.target_agent_name : 'New generator'}
              </h1>
              <div className="ml-auto flex items-center gap-2">
                {!isNew && (
                  <>
                    <Button variant="danger" icon={<Trash2 size={13} />} onClick={remove}>
                      Delete
                    </Button>
                    <Button variant="accentSoft" icon={<Play size={13} />} onClick={runNow}>
                      Run now
                    </Button>
                  </>
                )}
                <Button variant="primary" icon={<Save size={13} />} onClick={save} loading={saving}>
                  Save
                </Button>
              </div>
            </div>

            {error && (
              <Callout tone="error" icon={<AlertTriangle size={13} />}>
                {error}
              </Callout>
            )}

            <Section title="Schedule">
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Target agent"
                  hint="The agent being interviewed — its answers are the training data."
                >
                  <Select
                    value={draft.target_agent_id}
                    onChange={(e) => setDraft({ ...draft, target_agent_id: e.target.value })}
                  >
                    {agents.map((a) => (
                      <option key={a._id} value={a._id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Interviewer"
                  hint="Asks the questions. Always runs on the fleet default model, whatever model its own agent is set to."
                >
                  <Select
                    value={draft.interviewer_agent_id}
                    onChange={(e) => setDraft({ ...draft, interviewer_agent_id: e.target.value })}
                  >
                    {agents.map((a) => (
                      <option key={a._id} value={a._id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Every (minutes)" hint="How often a new conversation starts.">
                  <Input
                    type="number"
                    min={1}
                    value={draft.interval_minutes}
                    onChange={(e) =>
                      setDraft({ ...draft, interval_minutes: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                </Field>
                <Field
                  label="Exchanges per conversation"
                  hint="Question → answer rounds. The interviewer reads each reply and follows up."
                >
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={draft.turns}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        turns: Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                      })
                    }
                  />
                </Field>
              </div>

              <div className="mt-4 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-black/25 px-3 py-2.5">
                <Toggle
                  checked={draft.enabled}
                  onChange={(enabled) => setDraft({ ...draft, enabled })}
                />
                <div className="min-w-0">
                  <div className="text-xs text-slate-300">
                    {draft.enabled ? 'Running on schedule' : 'Paused'}
                  </div>
                  <Hint>
                    A live chat of yours always wins: a conversation waits for the agent to be free.
                  </Hint>
                </div>
              </div>
            </Section>

            <Section title="Topics">
              <Field
                label="Subjects (one per line)"
                hint="One is drawn at random per conversation. Leave empty and the interviewer picks its own from the agent's charter."
              >
                <Textarea
                  rows={5}
                  value={draft.topicsText}
                  onChange={(e) => setDraft({ ...draft, topicsText: e.target.value })}
                  placeholder={'debugging a failing deploy\nchoosing between two designs\n…'}
                />
              </Field>
            </Section>

            {selected && (
              <Section
                title="Conversations"
                right={
                  <span className="font-mono text-[10px] text-slate-500">
                    {selected.conversations_count} generated · last run {ago(selected.last_run_at)}
                  </span>
                }
              >
                {selected.last_error && (
                  <div className="mb-3">
                    <Callout tone="warn" icon={<AlertTriangle size={13} />}>
                      Last run: {selected.last_error}
                    </Callout>
                  </div>
                )}
                {sessions.length === 0 ? (
                  <Hint>
                    Nothing yet. Enable the schedule, or hit “Run now” — a conversation takes a few
                    minutes of real agent turns.
                  </Hint>
                ) : (
                  <RowGroup>
                    {sessions.map((s) => (
                      <Row key={s._id} onClick={() => void openTranscript(s)} className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="flex-1 truncate text-xs text-slate-300">{s.title}</span>
                          <span className="shrink-0 font-mono text-[10px] text-slate-500">
                            {ago(s.created_at)}
                          </span>
                        </div>
                      </Row>
                    ))}
                  </RowGroup>
                )}
              </Section>
            )}
          </div>
        )}
      </MasterDetail>

      {transcript && (
        <TranscriptOverlay
          session={transcript.session}
          messages={transcript.messages}
          onClose={() => setTranscript(null)}
        />
      )}

      {/* Fleet-wide count, so the pool's size is visible without adding up the rows. */}
      {total > 0 && (
        <div className="pointer-events-none fixed bottom-3 right-4 font-mono text-[10px] text-slate-600">
          {total} generated conversation{total === 1 ? '' : 's'}
        </div>
      )}
    </>
  );
}

/** Read-back of one generated conversation: the interviewer's questions and the agent's answers. */
function TranscriptOverlay({
  session,
  messages,
  onClose,
}: {
  session: Session;
  messages: StoredMessage[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Clicks inside the card must not dismiss it. */}
      <div
        className="flex h-full max-h-[80vh] w-full max-w-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <GlassCard className="flex min-h-0 w-full flex-col">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
            <Mic size={14} className="shrink-0 text-slate-500" />
            <h2 className="min-w-0 flex-1 truncate text-sm text-slate-200">{session.title}</h2>
            <span className="shrink-0 font-mono text-[10px] text-slate-500">{session.agent_name}</span>
            <Button variant="ghost" icon={<X size={13} />} onClick={onClose} className="ml-2" />
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
            {messages.map((m) => (
              <div
                key={m._id}
                className={`rounded-xl border px-3 py-2 ${
                  m.role === 'user'
                    ? 'border-fuchsia-400/20 bg-fuchsia-400/[0.06]'
                    : 'border-white/[0.06] bg-black/25'
                }`}
              >
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  {m.role === 'user' ? 'Interviewer' : session.agent_name}
                </div>
                <Markdown>{m.text}</Markdown>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
