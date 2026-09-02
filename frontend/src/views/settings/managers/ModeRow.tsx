import { ChevronDown, Eye, EyeOff, SlidersHorizontal, Trash2, Type } from 'lucide-react';
import { Button, Input, Select, Textarea } from '../../../components/ui';
import { MODE_SAMPLERS, type EndpointMode } from '../../../lib/api';
import { modeTone } from '../../../lib/modeTone';

/**
 * One mode: a compact identity row that unfolds into the fields its type actually uses. Shared by
 * the per-model editor on each endpoint and the fleet-wide global list, which differ only in whether
 * a mode is bound to a model — `models: null` says "this one applies everywhere", so the row drops
 * the model picker instead of showing an empty one.
 */
export function ModeRow({
  mode,
  models,
  open,
  readOnly = false,
  onToggleOpen,
  onChange,
  onDelete,
}: {
  mode: EndpointMode;
  models: string[] | null;
  open: boolean;
  /** A built-in: its wording ships with the app, so every field is shown but frozen. The on/off
   *  switch stays live — which chips your composer offers is your call, not an edit to the mode. */
  readOnly?: boolean;
  onToggleOpen: () => void;
  onChange: (next: EndpointMode) => void;
  onDelete: () => void;
}) {
  const tone = modeTone(mode.type);

  return (
    <div className="rounded-lg border border-white/[0.06] bg-black/20">
      {/* The name is what the operator reads on the chat chip, so it gets the whole first line and a
          real text size; the model it is bound to is secondary metadata and sits on its own line.
          (The shared control class carries `w-full`, which beats any width passed in — so a select
          and an input cannot share a line without the input collapsing to a sliver.) */}
      <div className="space-y-2 p-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone.border} ${tone.text}`}
            title={mode.type === 'sampling' ? 'Overrides the samplers it sets' : 'Appends text to the turn'}
          >
            {mode.type === 'sampling' ? <SlidersHorizontal size={10} /> : <Type size={10} />}
            {mode.type}
          </span>
          <Input
            defaultValue={mode.name}
            readOnly={readOnly}
            placeholder="Name — this is the label you'll click in chat"
            title={readOnly ? 'Built-in: its wording ships with the app' : "Shown on the mode's chip in the chat composer"}
            onBlur={(ev) =>
              !readOnly && ev.target.value !== mode.name && onChange({ ...mode, name: ev.target.value })
            }
            className={`min-w-0 flex-1 py-1.5 font-medium ${readOnly ? 'cursor-default text-slate-300' : ''}`}
          />
          {readOnly && (
            <span
              className="shrink-0 rounded-md border border-white/[0.12] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500"
              title="Ships with the app — edit-proof, and it improves when PleiadesAI is updated"
            >
              built-in
            </span>
          )}
          <button
            onClick={() => onChange({ ...mode, enabled: !mode.enabled })}
            title={mode.enabled ? 'Enabled — offered in chat' : 'Disabled — kept, but not offered'}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06] ${mode.enabled ? tone.text : 'text-slate-600'}`}
          >
            {mode.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          <button
            onClick={onToggleOpen}
            title={open ? 'Collapse' : 'Edit'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            <ChevronDown size={14} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {!readOnly && (
            <Button variant="danger" onClick={onDelete} title="Delete mode" className="shrink-0 px-2 py-1">
              <Trash2 size={12} />
            </Button>
          )}
        </div>

        {models === null ? (
          <p className="text-[11px] text-slate-500">
            Offered on <span className="text-slate-300">every model</span>, in every conversation.
          </p>
        ) : (
        <label className="flex items-center gap-2">
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Model
          </span>
          <Select
            value={mode.model}
            title="The model this mode belongs to — it is only offered when that model is the one running"
            onChange={(ev) => onChange({ ...mode, model: ev.target.value })}
            className="min-w-0 flex-1 py-1 text-[11px]"
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {mode.model && !models.includes(mode.model) && (
              <option value={mode.model}>{mode.model} (unknown)</option>
            )}
          </Select>
        </label>
        )}
      </div>

      {open && mode.type === 'sampling' && (
        <div className="grid grid-cols-3 gap-2 border-t border-white/[0.06] p-2">
          {MODE_SAMPLERS.map((sampler) => (
            <label key={sampler} className="space-y-1">
              <span className="block font-mono text-[10px] text-slate-500">{sampler}</span>
              <Input
                type="number"
                step="0.01"
                defaultValue={mode.params?.[sampler] ?? ''}
                placeholder="unset"
                title="Empty = not sent, so the global setting (or the server's own default) stands"
                onBlur={(ev) => {
                  const raw = ev.target.value.trim();
                  const params = { ...mode.params };
                  // `mode.params` can be absent on a document written before `minimize: false`.
                  if (raw === '' || !Number.isFinite(Number(raw))) delete params[sampler];
                  else params[sampler] = Number(raw);
                  onChange({ ...mode, params });
                }}
                className="w-full py-1 font-mono text-[11px]"
              />
            </label>
          ))}
          <p className="col-span-3 text-[11px] text-slate-600">
            An empty field is never put on the wire — only the samplers you fill in are overridden.
          </p>
        </div>
      )}

      {open && mode.type === 'prompt' && (
        <div className="space-y-2 border-t border-white/[0.06] p-2">
          <Textarea
            rows={3}
            defaultValue={mode.text}
            readOnly={readOnly}
            placeholder="/no_think"
            onBlur={(ev) => !readOnly && ev.target.value !== mode.text && onChange({ ...mode, text: ev.target.value })}
            className={`w-full ${readOnly ? 'cursor-default text-slate-400' : ''}`}
          />
          <label className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-slate-400">Append to</span>
            <Select
              value={mode.placement}
              disabled={readOnly}
              onChange={(ev) => onChange({ ...mode, placement: ev.target.value as EndpointMode['placement'] })}
              className="flex-1 py-1 text-[11px]"
            >
              <option value="user_suffix">The user turn — required for control tokens (/no_think)</option>
              <option value="system_suffix">The system prompt — for standing style directives</option>
            </Select>
          </label>
        </div>
      )}
    </div>
  );
}
