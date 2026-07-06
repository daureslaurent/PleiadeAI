import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Cpu, NotebookPen, Save, Sparkles, Trash2, Loader2 } from 'lucide-react';
import { agentsApi, skillsApi, toolsApi, type Agent, type Skill, type ToolInfo } from '../lib/api';
import { MasterDetail, ListRow } from '../components/MasterDetail';
import { AgentIsolationSelect } from './AgentIsolationSelect';
import { AgentModelSelect } from './AgentModelSelect';
import { agentColor, agentInitial, registerAgentIdentities } from '../lib/agentColor';
import { AGENT_ICONS, ICON_KEYS, PRESET_HUES, iconFor } from '../lib/agentIcons';

/** Avatar chip in the agent's chosen (or hashed) color, showing its icon or initial. */
function AgentAvatar({
  name,
  color,
  icon,
  size = 20,
}: {
  name: string;
  color: number | null;
  icon: string;
  size?: number;
}) {
  const c = agentColor(name, color);
  const Icon = iconFor(icon);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md font-bold text-slate-950"
      style={{ background: c.accent, width: size, height: size, fontSize: size * 0.55 }}
    >
      {Icon ? <Icon size={size * 0.6} /> : agentInitial(name)}
    </span>
  );
}

interface Draft {
  _id?: string;
  name: string;
  description: string;
  subagent: boolean;
  system_prompt: string;
  tools_allowed: string[];
  qdrant_namespace: string;
  parameters: Record<string, string>;
  agents_md: string;
  isolation_id: string | null;
  isolation_volume_mode: 'individual' | 'shared';
  endpoint_id: string | null;
  model: string;
  /** Max tool round-trips per turn (`null` = global default). Empty input in the form → null. */
  max_tool_iterations: number | null;
  color: number | null;
  icon: string;
  /** Server-computed: agent's isolation image has the visual layer. Drives the vision-endpoint warning. */
  visual: boolean;
}

const blank = (): Draft => ({
  name: '',
  description: '',
  subagent: true,
  system_prompt: '',
  tools_allowed: [],
  qdrant_namespace: '',
  parameters: {},
  agents_md: '',
  isolation_id: null,
  isolation_volume_mode: 'individual',
  endpoint_id: null,
  model: '',
  max_tool_iterations: null,
  color: null,
  icon: '',
  visual: false,
});

/** Agents CRUD page (master-detail): create, edit, delete agents + their tools and parameters. */
export function AgentsView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [coreTools, setCoreTools] = useState<ToolInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [suggesting, setSuggesting] = useState(false);

  const isNew = draft && !draft._id;
  // Core tools come from the backend (`GET /tools`), never a hardcoded list, so newly-added core
  // tools appear automatically. Skills are appended after.
  const coreNames = useMemo(() => new Set(coreTools.map((t) => t.name)), [coreTools]);
  const disabledCore = useMemo(
    () => new Set(coreTools.filter((t) => !t.enabled).map((t) => t.name)),
    [coreTools],
  );
  const toolOptions = useMemo(
    () => [...coreTools.map((t) => t.name), ...skills.map((s) => s.name)],
    [coreTools, skills],
  );

  async function refresh() {
    const [a, s, t] = await Promise.all([agentsApi.list(), skillsApi.list(), toolsApi.list()]);
    registerAgentIdentities(a);
    setAgents(a);
    setSkills(s);
    setCoreTools(t);
    return a;
  }

  useEffect(() => {
    refresh();
  }, []);

  function select(a: Agent) {
    setDraft({
      _id: a._id,
      name: a.name,
      description: a.description ?? '',
      subagent: a.subagent ?? true,
      system_prompt: a.system_prompt,
      tools_allowed: a.tools_allowed ?? [],
      qdrant_namespace: a.qdrant_namespace,
      parameters: { ...(a.parameters ?? {}) },
      agents_md: a.agents_md ?? '',
      isolation_id: a.isolation_id ?? null,
      isolation_volume_mode: a.isolation_volume_mode ?? 'individual',
      endpoint_id: a.endpoint_id ?? null,
      model: a.model ?? '',
      max_tool_iterations: a.max_tool_iterations ?? null,
      color: a.color ?? null,
      icon: a.icon ?? '',
      visual: Boolean(a.visual),
    });
  }

  function toggleTool(name: string) {
    setDraft((d) =>
      d
        ? {
            ...d,
            tools_allowed: d.tools_allowed.includes(name)
              ? d.tools_allowed.filter((t) => t !== name)
              : [...d.tools_allowed, name],
          }
        : d,
    );
  }

  async function save() {
    if (!draft) return;
    if (isNew) {
      const created = await agentsApi.create({
        name: draft.name,
        description: draft.description,
        subagent: draft.subagent,
        system_prompt: draft.system_prompt,
        tools_allowed: draft.tools_allowed,
        qdrant_namespace: draft.qdrant_namespace || draft.name,
        parameters: draft.parameters,
        agents_md: draft.agents_md,
        isolation_id: draft.isolation_id,
        isolation_volume_mode: draft.isolation_volume_mode,
        endpoint_id: draft.endpoint_id,
        model: draft.model,
        max_tool_iterations: draft.max_tool_iterations,
        color: draft.color,
        icon: draft.icon,
      });
      await refresh();
      select(created);
    } else {
      await agentsApi.update(draft._id!, {
        name: draft.name,
        description: draft.description,
        subagent: draft.subagent,
        system_prompt: draft.system_prompt,
        tools_allowed: draft.tools_allowed,
        max_tool_iterations: draft.max_tool_iterations,
        color: draft.color,
        icon: draft.icon,
      });
      await agentsApi.setAgentsMd(draft._id!, draft.agents_md);
      await refresh();
    }
  }

  async function suggestIdentity() {
    if (!draft) return;
    setSuggesting(true);
    try {
      const { color, icon } = await agentsApi.suggestIdentity(draft.name, draft.description);
      setDraft((d) => (d ? { ...d, color, icon } : d));
    } finally {
      setSuggesting(false);
    }
  }

  async function remove() {
    if (!draft?._id) return;
    await agentsApi.remove(draft._id);
    setDraft(null);
    await refresh();
  }

  // Parameter grid: applies immediately for existing agents; edits the draft for new ones.
  async function setParam(key: string, value: string) {
    if (!draft) return;
    if (draft._id) await agentsApi.setParam(draft._id, key, value);
    setDraft({ ...draft, parameters: { ...draft.parameters, [key]: value } });
  }

  async function removeParam(key: string) {
    if (!draft) return;
    if (draft._id) await agentsApi.removeParam(draft._id, key);
    const next = { ...draft.parameters };
    delete next[key];
    setDraft({ ...draft, parameters: next });
  }

  function addParam() {
    if (!newKey.trim()) return;
    void setParam(newKey.trim(), newValue);
    setNewKey('');
    setNewValue('');
  }

  return (
    <MasterDetail
      newLabel="New agent"
      onNew={() => setDraft(blank())}
      list={agents.map((a) => (
        <ListRow key={a._id} active={draft?._id === a._id} onClick={() => select(a)}>
          <AgentAvatar name={a.name} color={a.color} icon={a.icon} size={18} /> {a.name}
        </ListRow>
      ))}
    >
      {!draft ? (
        <Empty />
      ) : (
        <div className="mx-auto max-w-2xl space-y-5 p-6">
          <div className="flex items-center gap-3">
            <AgentAvatar name={draft.name} color={draft.color} icon={draft.icon} size={36} />
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="agent_name"
              className="flex-1 rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
            />
            {!isNew && (
              <button
                onClick={remove}
                className="flex items-center gap-1 rounded-md border border-red-900 px-3 py-2 text-xs text-red-400 hover:bg-red-950"
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
            <button
              onClick={save}
              className="flex items-center gap-1 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              <Save size={15} /> Save
            </button>
          </div>

          <FieldLabel>
            <span className="flex items-center gap-1.5">
              Description
              <span className="normal-case text-slate-600">
                — shown to other agents in the <code>annuaire</code> directory
              </span>
            </span>
          </FieldLabel>
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="One line: what this agent does and when to delegate to it"
            className="w-full rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />

          <FieldLabel>
            <span className="flex items-center gap-1.5">
              Identity
              <span className="normal-case text-slate-600">— color &amp; logo shown in chat</span>
            </span>
          </FieldLabel>
          <div className="space-y-3 rounded-md border border-border bg-panel p-3">
            {/* Color swatches. The active swatch is ringed; a "reset" chip clears back to the hash color. */}
            <div className="flex flex-wrap items-center gap-1.5">
              {PRESET_HUES.map((hue) => {
                const active = draft.color === hue;
                return (
                  <button
                    key={hue}
                    type="button"
                    onClick={() => setDraft({ ...draft, color: hue })}
                    className={`h-6 w-6 rounded-full transition-transform hover:scale-110 ${
                      active ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-panel' : ''
                    }`}
                    style={{ background: `hsl(${hue} 72% 66%)` }}
                    title={`Hue ${hue}`}
                  />
                );
              })}
              <button
                type="button"
                onClick={() => setDraft({ ...draft, color: null })}
                className={`ml-1 rounded px-2 py-1 text-xs ${
                  draft.color === null
                    ? 'bg-accent/20 text-accent'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
                title="Use the automatic name-based color"
              >
                Auto
              </button>
              <button
                type="button"
                onClick={suggestIdentity}
                disabled={suggesting}
                className="ml-auto flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-slate-300 hover:bg-surface disabled:opacity-50"
                title="Let the model pick a color + icon from the name and description"
              >
                {suggesting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} />
                )}
                Suggest
              </button>
            </div>
            {/* Icon grid. Selecting the active icon again clears it (back to the initial letter). */}
            <div className="flex flex-wrap gap-1">
              {ICON_KEYS.map((key) => {
                const Icon = AGENT_ICONS[key]!;
                const active = draft.icon === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDraft({ ...draft, icon: active ? '' : key })}
                    className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                      active
                        ? 'border-accent bg-accent/15 text-accent'
                        : 'border-transparent text-slate-400 hover:bg-surface hover:text-slate-200'
                    }`}
                    title={key}
                  >
                    <Icon size={16} />
                  </button>
                );
              })}
            </div>
          </div>

          <FieldLabel>Role</FieldLabel>
          <label className="flex items-start gap-3 rounded-md border border-border bg-panel px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              checked={draft.subagent}
              onChange={(e) => setDraft({ ...draft, subagent: e.target.checked })}
              className="mt-0.5 accent-accent"
            />
            <span className="leading-snug text-slate-300">
              <span className="font-medium text-slate-200">Subagent</span>
              <span className="block text-xs text-slate-500">
                {draft.subagent ? (
                  <>
                    Listed in the <code>annuaire</code> and delegatable via <code>ask_agent</code>.
                  </>
                ) : (
                  <>
                    Top-level orchestrator — hidden from the <code>annuaire</code>, auto-granted the
                    delegation tools, and prompted to consult the directory and delegate to
                    subagents.
                  </>
                )}
              </span>
            </span>
          </label>

          <FieldLabel>Max tool steps per turn</FieldLabel>
          <input
            type="number"
            min={1}
            value={draft.max_tool_iterations ?? ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setDraft({ ...draft, max_tool_iterations: Number.isFinite(n) && n > 0 ? n : null });
            }}
            placeholder="default (20)"
            className="w-full rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <p className="-mt-1 mb-1 text-xs text-slate-500">
            How many tool round-trips the agent may take before a turn is cut off. Raise it for
            visual/desktop agents that take many screenshot→act steps (they otherwise stall and need a
            manual “Continue”). Blank = global default.
          </p>

          <FieldLabel>Qdrant namespace</FieldLabel>
          <input
            value={draft.qdrant_namespace}
            disabled={!isNew}
            onChange={(e) => setDraft({ ...draft, qdrant_namespace: e.target.value })}
            placeholder={isNew ? 'defaults to agent name' : ''}
            className="w-full rounded-md border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          />

          <FieldLabel>System prompt</FieldLabel>
          <textarea
            value={draft.system_prompt}
            onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
            rows={6}
            className="w-full rounded-md border border-border bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />

          <FieldLabel>Tools allowed</FieldLabel>
          <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-panel p-3">
            {toolOptions.map((name) => {
              const isCore = coreNames.has(name);
              const off = disabledCore.has(name); // globally killed on the Tools page
              return (
                <label
                  key={name}
                  className={`flex items-center gap-2 text-sm ${off ? 'text-slate-600' : 'text-slate-300'}`}
                  title={off ? 'Disabled on the Tools page' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={draft.tools_allowed.includes(name)}
                    onChange={() => toggleTool(name)}
                    disabled={off}
                    className="accent-accent disabled:opacity-40"
                  />
                  <span className={off ? '' : isCore ? 'text-slate-200' : ''}>{name}</span>
                  {isCore && (
                    <span className="text-[10px] uppercase text-slate-500">
                      {off ? 'off' : 'core'}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          <FieldLabel>Local parameters</FieldLabel>
          <div className="space-y-1 rounded-md border border-border bg-panel p-3">
            {Object.entries(draft.parameters).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-xs">
                <span className="w-32 shrink-0 truncate font-mono text-slate-400">{k}</span>
                <input
                  defaultValue={v}
                  onBlur={(e) => setParam(k, e.target.value)}
                  className="flex-1 rounded border border-border bg-surface px-2 py-1"
                />
                <button onClick={() => removeParam(k)} className="text-red-400 hover:text-red-300">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1 text-xs">
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="key"
                className="w-32 rounded border border-border bg-surface px-2 py-1 font-mono"
              />
              <input
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="value"
                className="flex-1 rounded border border-border bg-surface px-2 py-1"
              />
              <button onClick={addParam} className="rounded bg-accent/20 px-2 py-1 text-accent">
                Add
              </button>
            </div>
          </div>

          <FieldLabel>
            <span className="flex items-center gap-1.5">
              <NotebookPen size={13} /> AGENTS.md
              <span className="normal-case text-slate-600">
                — living notebook the agent edits itself via <code>update_agents_md</code>
              </span>
            </span>
          </FieldLabel>
          <textarea
            value={draft.agents_md}
            onChange={(e) => setDraft({ ...draft, agents_md: e.target.value })}
            rows={8}
            placeholder="# Notes&#10;Persistent conventions, learnings, and TODOs. Injected into the agent's prompt each turn."
            className="w-full rounded-md border border-border bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />

          {draft._id && (
            <>
              <FieldLabel>
                <span className="flex items-center gap-1.5">
                  <Cpu size={13} /> Inference
                  <span className="normal-case text-slate-600">
                    — endpoint &amp; model this agent runs on (default if unset)
                  </span>
                </span>
              </FieldLabel>
              <AgentModelSelect
                agentId={draft._id}
                endpointId={draft.endpoint_id}
                model={draft.model}
                visual={draft.visual}
              />

              <FieldLabel>
                <span className="flex items-center gap-1.5">
                  <Box size={13} /> Isolation
                  <span className="normal-case text-slate-600">
                    — assign a Docker profile so <code>bash</code> &amp; skills run in a container
                  </span>
                </span>
              </FieldLabel>
              <AgentIsolationSelect
                agentId={draft._id}
                isolationId={draft.isolation_id}
                volumeMode={draft.isolation_volume_mode}
              />
            </>
          )}
        </div>
      )}
    </MasterDetail>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{children}</div>;
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-slate-600">
      Select an agent or create a new one.
    </div>
  );
}
