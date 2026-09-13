import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListChecks, Plus, Sparkles, SquareCheckBig, X } from 'lucide-react';
import {
  agentsApi,
  boardApi,
  settingsApi,
  type Agent,
  type BoardPlanKind,
} from '../../lib/api';
import { Button, Callout, Field, Input, Label, Select, Textarea } from '../../components/ui';

/**
 * Open a board item (`BOARD_REFACTOR_PLAN.md` §3 of the frontend).
 *
 * The operator writes the request the way they would to a person, then either presses **Analyse**
 * — an agent reads it and fills everything below — or fills the fields by hand. Both land in the
 * same editable form, because the analyser is a suggestion: the operator is the one who knows what
 * "done" means, and the form is where they get to say so before a turn is spent on it.
 *
 * Two agent pickers on purpose. The analyser only reads one prompt, so a quick model is the right
 * choice; the PM holds the item's whole conversation and plans it, so it usually wants the best
 * model the fleet has.
 */
export function CreateItemPanel({ onCancel }: { onCancel: () => void }) {
  const nav = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<BoardPlanKind>('project');
  // Set once the operator picks a kind themselves, so an analysis never flips it back under them.
  const [kindTouched, setKindTouched] = useState(false);
  const [analyserId, setAnalyserId] = useState('');
  const [managerId, setManagerId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState<string[]>([]);
  const [owner, setOwner] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [analysing, setAnalysing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([agentsApi.list(), settingsApi.get().catch(() => null)])
      .then(([list, settings]) => {
        const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
        setAgents(sorted);
        // The fleet's PM setting is the default manager, and the analyser's too until changed.
        const wanted = (settings?.forum_project_manager_agent || 'project_manager').toLowerCase();
        const pm = sorted.find((a) => a.name.toLowerCase() === wanted) ?? sorted[0];
        if (pm) {
          setManagerId(pm._id);
          setAnalyserId(pm._id);
        }
      })
      .catch((err) => setError(message(err)));
  }, []);

  const analyse = async () => {
    if (!prompt.trim() || !analyserId) return;
    setAnalysing(true);
    setError('');
    try {
      const a = await boardApi.analyse({
        prompt: prompt.trim(),
        agentId: analyserId,
        kind: kindTouched ? kind : undefined,
      });
      if (!kindTouched) setKind(a.kind);
      setName(a.name);
      setDescription(a.description);
      setAcceptance(a.acceptance.length ? a.acceptance : acceptance);
      if (a.owner) setOwner(a.owner);
      if (a.reviewer) setReviewer(a.reviewer);
    } catch (err) {
      setError(message(err));
    } finally {
      setAnalysing(false);
    }
  };

  const criteria = acceptance.map((a) => a.trim()).filter(Boolean);
  const missing = useMemo(() => {
    const out: string[] = [];
    if (!prompt.trim()) out.push('the request');
    if (!name.trim()) out.push('a name');
    if (!description.trim()) out.push('a description');
    if (kind === 'task' && !owner) out.push('an owner');
    if (kind === 'task' && !criteria.length) out.push('at least one criterion');
    if (!managerId) out.push('a project manager');
    return out;
  }, [prompt, name, description, kind, owner, criteria.length, managerId]);

  const create = async () => {
    if (missing.length) return;
    setCreating(true);
    setError('');
    try {
      const plan = await boardApi.createPlan({
        goal: prompt.trim(),
        kind,
        name: name.trim(),
        description: description.trim(),
        acceptance: criteria,
        managerAgentId: managerId,
        owner: kind === 'task' ? owner : null,
        reviewer: kind === 'task' ? reviewer || null : null,
      });
      nav(`/board/${plan.id}`);
    } catch (err) {
      setError(message(err));
      setCreating(false);
    }
  };

  const setCriterion = (i: number, v: string) => setAcceptance((list) => list.map((x, j) => (j === i ? v : x)));

  return (
    <div className="space-y-4 rounded-xl hairline p-3 sm:p-4">
      <Field
        label="What do you want done?"
        hint="Write it the way you would to a person — context, constraints, what good looks like. It is kept verbatim as the item's original request."
      >
        <Textarea
          rows={7}
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="font-sans text-sm"
          placeholder="e.g. Add CSV export to the scoring page: every column currently shown, respects the active filters, file named after the date range…"
        />
      </Field>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>Kind</Label>
          <div className="flex rounded-lg raise-1 p-0.5">
            {(
              [
                { id: 'task', label: 'Task', Icon: SquareCheckBig },
                { id: 'project', label: 'Project', Icon: ListChecks },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setKind(id);
                  setKindTouched(true);
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  kind === id ? 'raise-3 text-slate-100' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-xs">
          <Label>Analyse with</Label>
          <Select value={analyserId} onChange={(e) => setAnalyserId(e.target.value)} className="py-1.5">
            {agents.map((a) => (
              <option key={a._id} value={a._id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          variant="accentSoft"
          icon={<Sparkles size={13} />}
          loading={analysing}
          disabled={!prompt.trim() || !analyserId}
          onClick={analyse}
          title="The agent reads the request and fills in the fields below — you can edit all of them"
        >
          Analyse
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        {kind === 'task'
          ? 'A task is one piece of work for one agent, checked by a reviewer. It is filed as soon as you create it.'
          : 'A project is broken into tasks by its manager straight after you create it. Nothing runs until you press Start.'}
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Short title" />
        </Field>
        <Field label="Project manager" hint="Plans the item and answers you in its chat.">
          <Select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            {agents.map((a) => (
              <option key={a._id} value={a._id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Description">
        <Textarea
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="font-sans text-sm"
          placeholder="What this is, for somebody who never read the request"
        />
      </Field>

      <div className="space-y-1.5">
        <Label>Done when</Label>
        <div className="space-y-1.5">
          {acceptance.map((a, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-4 shrink-0 text-right font-mono text-[10px] text-slate-600">{i + 1}</span>
              <Input value={a} onChange={(e) => setCriterion(i, e.target.value)} className="py-1.5" />
              <button
                type="button"
                onClick={() => setAcceptance((list) => list.filter((_, j) => j !== i))}
                className="shrink-0 rounded-md p-1 text-slate-500 transition-colors hover:raise-2 hover:text-slate-200"
                aria-label="Remove criterion"
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <Button icon={<Plus size={13} />} onClick={() => setAcceptance((list) => [...list, ''])}>
            Add criterion
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-500">
          Checks a different agent could make without asking anybody.
          {kind === 'project' ? ' Optional for a project — each of its tasks gets its own.' : ''}
        </p>
      </div>

      {kind === 'task' ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Owner" hint="The agent that does the work.">
            <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Pick an agent…</option>
              {agents.map((a) => (
                <option key={a._id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reviewer" hint="Signs it off. Empty leaves it to the manager, or to you.">
            <Select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
              <option value="">Manager / you</option>
              {agents
                .filter((a) => a.name !== owner)
                .map((a) => (
                  <option key={a._id} value={a.name}>
                    {a.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
      ) : null}

      {error ? <Callout tone="error">{error}</Callout> : null}

      <div className="flex flex-wrap items-center gap-2 border-t hairline pt-3">
        <Button variant="primary" loading={creating} disabled={missing.length > 0} onClick={create}>
          Create {kind}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        {missing.length ? (
          <span className="text-[11px] text-slate-500">Still needs {missing.join(', ')}.</span>
        ) : null}
      </div>
    </div>
  );
}

function message(err: unknown): string {
  return String((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? err);
}
