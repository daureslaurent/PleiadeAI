import { useEffect, useState } from 'react';
import Editor from '../components/CodeEditor';
import { AlertTriangle, Save, Trash2, Wrench, Zap } from 'lucide-react';
import { skillsApi, type Skill } from '../lib/api';
import { MasterDetail, ListRow } from '../components/MasterDetail';
import { Button, Dot, EmptyState, Input, Select, useConfirm } from '../components/ui';
import { MONACO_OPTIONS, PLEIADES_THEME, registerPleiadesTheme } from '../lib/monacoTheme';

interface Draft {
  _id?: string;
  name: string;
  description: string;
  language: 'ts' | 'py';
  source: string;
  enabled: boolean;
  schemaText: string;
}

const DEFAULT_SCHEMA = `{
  "type": "object",
  "properties": {},
  "required": []
}`;

const blank = (): Draft => ({
  name: '',
  description: '',
  language: 'ts',
  source:
    'export default async function run(args: Record<string, unknown>) {\n  return { ok: true };\n}\n',
  enabled: true,
  schemaText: DEFAULT_SCHEMA,
});

function toDraft(s: Skill): Draft {
  return {
    _id: s._id,
    name: s.name,
    description: s.description,
    language: s.language,
    source: s.source,
    enabled: s.enabled,
    schemaText: JSON.stringify(s.parameters_schema ?? {}, null, 2),
  };
}

/** Skills CRUD page (master-detail): Monaco source editor + raw JSON-Schema editor. */
export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();

  const isNew = draft && !draft._id;

  async function refresh() {
    const s = await skillsApi.list();
    setSkills(s);
    return s;
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save() {
    if (!draft) return;
    let parameters_schema: unknown;
    try {
      parameters_schema = draft.schemaText.trim() ? JSON.parse(draft.schemaText) : {};
      setSchemaError(null);
    } catch (e) {
      setSchemaError(e instanceof Error ? e.message : 'invalid JSON');
      return;
    }

    const body = {
      name: draft.name,
      description: draft.description,
      language: draft.language,
      source: draft.source,
      enabled: draft.enabled,
      parameters_schema,
    };

    setSaving(true);
    try {
      if (isNew) {
        const created = await skillsApi.create(body);
        await refresh();
        setDraft(toDraft(created));
      } else {
        const saved = await skillsApi.save(draft._id!, body);
        await refresh();
        setDraft(toDraft(saved));
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft?._id) return;
    const ok = await confirm({
      title: `Delete skill “${draft.name}”?`,
      body: 'Agents that list this skill in tools_allowed will silently lose it on their next turn. This cannot be undone.',
      danger: true,
    });
    if (!ok) return;
    await skillsApi.remove(draft._id);
    setDraft(null);
    await refresh();
  }

  async function reEnable() {
    if (!draft?._id) return;
    await skillsApi.enable(draft._id);
    const s = await refresh();
    const found = s.find((x) => x._id === draft._id);
    if (found) setDraft(toDraft(found));
  }

  return (
    <MasterDetail
      newLabel="New skill"
      onNew={() => setDraft(blank())}
      list={skills.map((s) => (
        <ListRow key={s._id} active={draft?._id === s._id} onClick={() => setDraft(toDraft(s))}>
          <Wrench size={15} className="shrink-0" />
          <span className="flex-1 truncate">{s.name}</span>
          {!s.enabled && <Dot tone="error" title="disabled — circuit breaker tripped" />}
        </ListRow>
      ))}
    >
      {!draft ? (
        <EmptyState icon={<Wrench size={28} />}>Select a skill or create a new one.</EmptyState>
      ) : (
        <div className="flex h-full flex-col">
          {/* Header row */}
          <div className="glass flex items-center gap-2 border-b px-4 py-2.5">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="skill_name"
              className="w-48 font-mono"
            />
            <Select
              value={draft.language}
              onChange={(e) => setDraft({ ...draft, language: e.target.value as 'ts' | 'py' })}
              className="w-40"
            >
              <option value="ts">TypeScript</option>
              <option value="py">Python</option>
            </Select>
            {draft._id && !draft.enabled && (
              <Button variant="ghost" icon={<Zap size={13} />} onClick={reEnable} className="text-amber-400 ring-amber-500/30 hover:bg-amber-500/10">
                Re-enable (circuit tripped)
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {!isNew && (
                <Button variant="danger" icon={<Trash2 size={13} />} onClick={remove}>
                  Delete
                </Button>
              )}
              <Button variant="primary" icon={<Save size={13} />} onClick={save} loading={saving}>
                Save
              </Button>
            </div>
          </div>

          <div className="border-b border-white/[0.06] px-4 py-2.5">
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Short description shown to the model…"
            />
          </div>

          {/* Source + schema split — both editors sit in inset wells so the glass reads through. */}
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col bg-black/25">
              <div className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                Source
              </div>
              <div className="min-h-0 flex-1">
                <Editor
                  height="100%"
                  theme={PLEIADES_THEME}
                  beforeMount={registerPleiadesTheme}
                  language={draft.language === 'py' ? 'python' : 'typescript'}
                  value={draft.source}
                  onChange={(v) => setDraft({ ...draft, source: v ?? '' })}
                  options={MONACO_OPTIONS}
                />
              </div>
            </div>
            <div className="flex w-96 shrink-0 flex-col border-l border-white/[0.06] bg-black/25">
              <div className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                Parameters schema (JSON)
              </div>
              <div className="min-h-0 flex-1">
                <Editor
                  height="100%"
                  theme={PLEIADES_THEME}
                  beforeMount={registerPleiadesTheme}
                  language="json"
                  value={draft.schemaText}
                  onChange={(v) => setDraft({ ...draft, schemaText: v ?? '' })}
                  options={MONACO_OPTIONS}
                />
              </div>
              {schemaError && (
                <div className="flex items-start gap-1.5 border-t border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-xs text-red-300">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">{schemaError}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </MasterDetail>
  );
}
