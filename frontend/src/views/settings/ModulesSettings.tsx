import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  GitFork,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Puzzle,
  Trash2,
  Wrench,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  agentsApi,
  modulesApi,
  type Agent,
  type BlockPlacement,
  type CustomModule,
  type ModuleGroup,
  type ModuleInfo,
  type ModulePreview,
  type ModuleScope,
} from '../../lib/api';
import {
  Button,
  Callout,
  Field,
  GlassCard,
  Input,
  Select,
  Spinner,
  Textarea,
  Toggle,
} from '../../components/ui';

/**
 * `/settings/modules` — what this instance is made of (`MODULES_PLAN.md` §8).
 *
 * A module owns a slice of the prompt, the tools that slice talks about, and the settings that tune
 * it, so one switch here removes all three at once. The page is a list plus a **preview**, because
 * the question an operator actually has is not "is the forum module on" but "what is my agent being
 * told" — and the only honest answer to that is the assembled prompt itself, re-rendered as each
 * switch is flipped.
 */

const GROUP_LABELS: Record<ModuleGroup, string> = {
  core: 'Core',
  operator: 'Operator-owned',
  self: 'The agent’s own state',
  work: 'Work',
  capabilities: 'Capabilities',
};

const GROUP_BLURBS: Record<ModuleGroup, string> = {
  core: 'Load-bearing. The clock the model has no other way to read, and the tool-calling contract.',
  operator: 'Standing instruction, read-only to the agent — it lands before the authored prompt.',
  self: 'What the agent wrote itself, or was reminded of. It lands after the authored prompt.',
  work: 'How the fleet coordinates: delegation, the board, and self-driving loops.',
  capabilities: 'What agents can reach. No prompt text of their own — the tools speak for themselves.',
};

const GROUP_ORDER = Object.keys(GROUP_LABELS) as ModuleGroup[];

const PLACEMENT_LABELS: Record<BlockPlacement, string> = {
  system_head: 'before the authored prompt',
  system_tail: 'after the authored prompt',
  system_suffix: 'last in the system message',
  user_suffix: 'appended to the user turn',
};

export function ModulesSettings() {
  const [modules, setModules] = useState<ModuleInfo[] | null>(null);
  const [custom, setCustom] = useState<CustomModule[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [preview, setPreview] = useState<ModulePreview | null>(null);
  // Which run the preview assembles: an ordinary turn, or what a `task` subagent of the agent gets.
  const [scope, setScope] = useState<ModuleScope>('turn');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomModule | null>(null);

  const load = useCallback(async () => {
    const { modules: list, custom: authored } = await modulesApi.list();
    setModules(list);
    setCustom(authored);
  }, []);

  useEffect(() => {
    load().catch(() => setError('Failed to load modules. The backend may be down.'));
    agentsApi
      .list()
      .then((list) => {
        setAgents(list);
        // Default the preview to the first top-level agent — a subagent's prompt is missing the
        // orchestration block, which is the one most operators come here to look at.
        setAgentId((id) => id || (list.find((a) => !a.subagent) ?? list[0])?._id || '');
      })
      .catch(() => undefined);
  }, [load]);

  // The preview is the whole point of the page, so it re-renders on every change to the switches —
  // it costs one request and no inference (see `previewContext` on the backend).
  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    modulesApi
      .preview(agentId, scope)
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setPreview(null));
    return () => {
      alive = false;
    };
  }, [agentId, scope, modules, custom]);

  const groups = useMemo(() => {
    if (!modules) return [];
    return GROUP_ORDER.flatMap((group) => {
      const items = modules.filter((m) => m.group === group);
      return items.length ? [{ group, items }] : [];
    });
  }, [modules]);

  async function toggle(m: ModuleInfo, enabled: boolean) {
    setError(null);
    try {
      await modulesApi.update(m.id, { enabled });
      await load();
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(message ?? `Could not switch ${m.name} ${enabled ? 'on' : 'off'}.`);
    }
  }

  /** Put a module (built-in or custom) in or out of the subagent profile. */
  async function toggleSubagent(id: string, name: string, subagent: boolean) {
    setError(null);
    try {
      await modulesApi.update(id, { subagent });
      await load();
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(message ?? `Could not change whether ${name} applies to subagent runs.`);
    }
  }

  async function saveOverride(m: ModuleInfo, title: string, text: string | null) {
    await modulesApi.update(m.id, { overrides: { [title]: text } });
    await load();
  }

  async function saveCustom(draft: Partial<CustomModule>) {
    await modulesApi.saveCustom(draft);
    setEditing(null);
    await load();
  }

  async function removeCustom(id: string) {
    await modulesApi.removeCustom(id);
    await load();
  }

  if (!modules) return <Spinner />;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <div className="animate-fade-up">
          <Link
            to="/settings"
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300"
          >
            <ArrowLeft size={13} /> Settings
          </Link>
          <div className="mt-3 flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/20">
              <Puzzle size={17} />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-slate-100">Modules</h2>
              <p className="text-[11px] text-slate-500">
                What this instance is made of. A module owns its prompt blocks and the tools they talk
                about — switching it off removes both.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <Callout tone="error" icon={<AlertTriangle size={14} />}>
            {error}
          </Callout>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="space-y-5">
            {groups.map(({ group, items }) => (
              <section key={group} className="space-y-2">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {GROUP_LABELS[group]}
                  </h3>
                  <p className="text-[11px] text-slate-500">{GROUP_BLURBS[group]}</p>
                </div>
                <GlassCard className="divide-y divide-hairline p-0">
                  {items.map((m) => (
                    <ModuleRow
                      key={m.id}
                      module={m}
                      open={open === m.id}
                      onOpen={() => setOpen(open === m.id ? null : m.id)}
                      onToggle={(v) => toggle(m, v)}
                      onToggleSubagent={(v) => toggleSubagent(m.id, m.name, v)}
                      onOverride={(title, text) => saveOverride(m, title, text)}
                    />
                  ))}
                </GlassCard>
              </section>
            ))}

            <section className="space-y-2">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Your own</h3>
                  <p className="text-[11px] text-slate-500">
                    Standing text of your own, placed where you choose. A mode is picked per
                    conversation; a module like this is always there.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setEditing({
                      id: '',
                      name: '',
                      description: '',
                      text: '',
                      placement: 'system_tail',
                      order: 500,
                      enabled: true,
                    })
                  }
                >
                  <Plus size={13} /> New module
                </Button>
              </div>
              <GlassCard className="divide-y divide-hairline p-0">
                {custom.length === 0 && (
                  <div className="px-4 py-3 text-[11px] text-slate-500">
                    None yet. Everything above is code-defined and improves when the app updates.
                  </div>
                )}
                {custom.map((m) => (
                  <div key={m.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-slate-200">{m.name}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {m.description || PLACEMENT_LABELS[m.placement]}
                      </div>
                    </div>
                    <button
                      className="mt-0.5 text-slate-500 transition-colors hover:text-slate-300"
                      title="Edit"
                      onClick={() => setEditing(m)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="mt-0.5 text-slate-500 transition-colors hover:text-red-400"
                      title="Delete"
                      onClick={() => removeCustom(m.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                    <SubagentChip
                      checked={m.subagentEnabled !== false}
                      disabled={!m.enabled}
                      onChange={(v) => toggleSubagent(m.id, m.name, v)}
                    />
                    <div className="mt-0.5">
                      <Toggle
                        checked={m.enabled}
                        onChange={(v) => saveCustom({ ...m, enabled: v })}
                      />
                    </div>
                  </div>
                ))}
              </GlassCard>
            </section>
          </div>

          <PreviewPane
            agents={agents}
            agentId={agentId}
            onAgent={setAgentId}
            preview={preview}
            scope={scope}
            onScope={setScope}
            blocks={modules
              .filter((m) => m.enabled && (scope === 'turn' || m.subagentEnabled))
              .reduce((n, m) => n + m.blocks.length, 0)}
          />
        </div>

        {editing && (
          <CustomEditor
            draft={editing}
            onCancel={() => setEditing(null)}
            onSave={(d) => saveCustom(d)}
          />
        )}
      </div>
    </div>
  );
}

/** One module: the switch, and — expanded — the blocks and tools it takes with it. */
function ModuleRow({
  module: m,
  open,
  onOpen,
  onToggle,
  onToggleSubagent,
  onOverride,
}: {
  module: ModuleInfo;
  open: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onToggleSubagent: (enabled: boolean) => void;
  onOverride: (title: string, text: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  return (
    <div className={m.enabled ? '' : 'opacity-60'}>
      <div className="flex items-start gap-3 px-4 py-3">
        <button className="mt-0.5 text-slate-500 hover:text-slate-300" onClick={onOpen}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-200">{m.name}</span>
            {m.mandatory && (
              <span
                className="inline-flex items-center gap-1 text-[10px] text-slate-500"
                title="Load-bearing — this one cannot be switched off."
              >
                <Lock size={10} /> always on
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{m.description}</div>
        </div>
        <SubagentChip
          checked={m.subagentEnabled}
          disabled={m.mandatory || !m.enabled}
          locked={m.mandatory}
          onChange={onToggleSubagent}
        />
        <div className="mt-0.5">
          <Toggle checked={m.enabled} disabled={m.mandatory} onChange={onToggle} />
        </div>
      </div>

      {open && (
        <div className="space-y-3 border-t border-hairline px-4 py-3">
          {m.blocks.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Prompt blocks
              </div>
              {m.blocks.map((b) => (
                <div key={b.title} className="well rounded-lg p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-300">{b.title}</span>
                    <span className="text-[10px] text-slate-500">{PLACEMENT_LABELS[b.placement]}</span>
                    {b.override && (
                      <span className="text-[10px] text-accent" title="You rewrote this block">
                        rewritten
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      {b.overridable && (
                        <button
                          className="text-slate-500 transition-colors hover:text-slate-300"
                          title="Rewrite this block"
                          onClick={() => {
                            setEditing(editing === b.title ? null : b.title);
                            setDraft(b.override ?? '');
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                      {b.override && (
                        <button
                          className="text-slate-500 transition-colors hover:text-slate-300"
                          title="Revert to the wording that ships with the app"
                          onClick={() => onOverride(b.title, null)}
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  {!b.overridable && (
                    <div className="mt-1 text-[10px] text-slate-500">
                      Renders live data — there is nothing to rewrite.
                    </div>
                  )}
                  {editing === b.title && (
                    <div className="mt-2 space-y-2">
                      <Textarea
                        rows={6}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Leave empty to keep the wording that ships with the app."
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                        <Button
                          onClick={async () => {
                            await onOverride(b.title, draft.trim() ? draft : null);
                            setEditing(null);
                          }}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {m.tools.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Tools it owns
              </div>
              <div className="flex flex-wrap gap-1.5">
                {m.tools.map((t) => (
                  <Link
                    key={t.name}
                    to={`/settings/tools/${encodeURIComponent(t.name)}`}
                    title={`${t.description}${t.enabled ? '' : ' — switched off individually on the Tools page'}`}
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] ring-1 transition-colors ${
                      t.enabled
                        ? 'text-slate-300 ring-hairline hover:text-slate-100'
                        : 'text-slate-500 line-through ring-hairline'
                    }`}
                  >
                    <Wrench size={9} /> {t.name}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {m.settingsKeys.length > 0 && (
            <div className="text-[10px] text-slate-500">
              Tuned by: <span className="font-mono">{m.settingsKeys.join(', ')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The subagent-profile switch on a row (`SUBAGENT_PLAN.md` §3): whether the module also applies
 * inside a `task` subagent run. Narrows only — a module that is off is off in a child too, so the
 * chip is inert until the row's own switch is on.
 */
function SubagentChip({
  checked,
  disabled,
  locked = false,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  locked?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const title = locked
    ? 'Always applies to subagent runs.'
    : disabled
      ? 'Switched off — so it is off in subagent runs too.'
      : checked
        ? 'Applies in subagent runs. Click to leave it out of what a task subagent is given.'
        : 'Left out of subagent runs. Click to give it to task subagents too.';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] ring-1 ring-hairline transition-colors disabled:cursor-default ${
        checked && !(disabled && !locked)
          ? 'text-accent hover:text-slate-100'
          : 'text-slate-600 line-through hover:text-slate-400'
      }`}
    >
      <GitFork size={10} /> subagents
    </button>
  );
}

/** The assembled prompt for one agent, under the switches as they currently stand. */
function PreviewPane({
  agents,
  agentId,
  onAgent,
  preview,
  scope,
  onScope,
  blocks,
}: {
  agents: Agent[];
  agentId: string;
  onAgent: (id: string) => void;
  preview: ModulePreview | null;
  scope: ModuleScope;
  onScope: (scope: ModuleScope) => void;
  blocks: number;
}) {
  return (
    <GlassCard className="sticky top-6 max-h-[calc(100vh-6rem)] space-y-3 self-start overflow-hidden">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Prompt preview</h3>
        <span className="ml-auto text-[10px] text-slate-500">{blocks} blocks</span>
      </div>
      <Field label="Agent">
        <Select value={agentId} onChange={(e) => onAgent(e.target.value)}>
          {agents.map((a) => (
            <option key={a._id} value={a._id}>
              {a.name}
              {a.subagent ? ' (subagent)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex gap-1 rounded-lg p-0.5 ring-1 ring-hairline">
        {(
          [
            ['turn', 'Its own turn'],
            ['subagent', 'Its subagent'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onScope(value)}
            className={`flex-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              scope === value ? 'raise-1 text-slate-100' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        {scope === 'subagent' &&
          'What a task subagent of this agent is given: only the modules marked "subagents", plus its task contract. '}
        The real charter, parameters and house rules. Anything that would cost a retrieval — recalled
        memories, forum pointers, board items — is sample text, so flipping a switch costs nothing.
      </p>
      <pre className="well max-h-[52vh] overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-[10px] leading-relaxed text-slate-300">
        {preview ? preview.system : 'Pick an agent to see its prompt.'}
      </pre>
      {preview?.userSuffix && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Appended to the user turn
          </div>
          <pre className="well overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-[10px] leading-relaxed text-slate-300">
            {preview.userSuffix}
          </pre>
        </div>
      )}
    </GlassCard>
  );
}

/** Create or edit an operator-authored module. */
function CustomEditor({
  draft,
  onCancel,
  onSave,
}: {
  draft: CustomModule;
  onCancel: () => void;
  onSave: (draft: Partial<CustomModule>) => Promise<void>;
}) {
  const [form, setForm] = useState(draft);
  const set = <K extends keyof CustomModule>(key: K, value: CustomModule[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <GlassCard className="w-full max-w-xl space-y-3">
        <h3 className="text-sm font-semibold text-slate-100">
          {form.id ? 'Edit module' : 'New module'}
        </h3>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Escalation policy" />
        </Field>
        <Field label="Description" hint="One line, for the row on this page.">
          <Input
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="When to stop and ask instead of deciding."
          />
        </Field>
        <Field label="Text" hint="Markdown. A heading is added for you if you don’t write one.">
          <Textarea rows={8} value={form.text} onChange={(e) => set('text', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Placement">
            <Select
              value={form.placement}
              onChange={(e) => set('placement', e.target.value as BlockPlacement)}
            >
              {(Object.keys(PLACEMENT_LABELS) as BlockPlacement[]).map((p) => (
                <option key={p} value={p}>
                  {PLACEMENT_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Order" hint="Lower renders earlier, among the blocks at that placement.">
            <Input
              type="number"
              value={String(form.order)}
              onChange={(e) => set('order', Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onSave({ ...form, id: form.id || undefined })}>Save</Button>
        </div>
      </GlassCard>
    </div>
  );
}
