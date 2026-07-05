import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Save, Trash2, Wrench } from 'lucide-react';
import { skillsApi, type Skill } from '../lib/api';
import { MasterDetail, ListRow } from '../components/MasterDetail';

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

    if (isNew) {
      const created = await skillsApi.create(body);
      await refresh();
      setDraft(toDraft(created));
    } else {
      const saved = await skillsApi.save(draft._id!, body);
      await refresh();
      setDraft(toDraft(saved));
    }
  }

  async function remove() {
    if (!draft?._id) return;
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
          <Wrench size={15} />
          <span className="flex-1 truncate">{s.name}</span>
          {!s.enabled && <span className="text-red-400" title="disabled">●</span>}
        </ListRow>
      ))}
    >
      {!draft ? (
        <div className="flex h-full items-center justify-center text-sm text-slate-600">
          Select a skill or create a new one.
        </div>
      ) : (
        <div className="flex h-full flex-col">
          {/* Header row */}
          <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="skill_name"
              className="w-48 rounded-md border border-border bg-panel px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <select
              value={draft.language}
              onChange={(e) => setDraft({ ...draft, language: e.target.value as 'ts' | 'py' })}
              className="rounded-md border border-border bg-panel px-2 py-1.5 text-sm"
            >
              <option value="ts">TypeScript</option>
              <option value="py">Python</option>
            </select>
            {draft._id && !draft.enabled && (
              <button onClick={reEnable} className="text-xs text-amber-400">
                Re-enable (circuit tripped)
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {!isNew && (
                <button
                  onClick={remove}
                  className="flex items-center gap-1 rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950"
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
              <button
                onClick={save}
                className="flex items-center gap-1 rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-white"
              >
                <Save size={15} /> Save
              </button>
            </div>
          </div>

          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Short description shown to the model…"
            className="border-b border-border bg-panel px-4 py-2 text-sm outline-none"
          />

          {/* Source + schema split */}
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">
              <div className="px-3 py-1 font-mono text-[10px] uppercase text-slate-500">Source</div>
              <Editor
                height="calc(100% - 24px)"
                theme="vs-dark"
                language={draft.language === 'py' ? 'python' : 'typescript'}
                value={draft.source}
                onChange={(v) => setDraft({ ...draft, source: v ?? '' })}
              />
            </div>
            <div className="flex w-96 shrink-0 flex-col border-l border-border">
              <div className="px-3 py-1 font-mono text-[10px] uppercase text-slate-500">
                Parameters schema (JSON)
              </div>
              <Editor
                height="calc(100% - 24px)"
                theme="vs-dark"
                language="json"
                value={draft.schemaText}
                onChange={(v) => setDraft({ ...draft, schemaText: v ?? '' })}
              />
              {schemaError && (
                <div className="border-t border-red-900 bg-red-950/40 px-3 py-1 text-xs text-red-400">
                  {schemaError}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </MasterDetail>
  );
}
