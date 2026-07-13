import { useRef, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Field, Input, Select, Textarea, Toggle } from '../../components/ui';
import { useSettings } from './context';
import type { InferenceSettings } from '../../lib/api';

/**
 * Self-saving settings fields (DIRECT_ART §2/§3 — inset wells on glass, no legacy greys).
 *
 * Each control is bound to one key of `InferenceSettings` and owns its own persistence: text and
 * number boxes edit locally and commit on blur, switches and selects commit on change, sliders
 * commit on every change (the provider's debounce coalesces the drag into one PUT). Nothing here
 * needs a Save button.
 */

type S = InferenceSettings;
/** Keys whose value is exactly T — `number | null` keys are excluded from `Of<number>` by construction. */
type Of<T> = { [K in keyof S]: S[K] extends T ? K : never }[keyof S];
/** Keys that accept `null` (the vision sampling params: null = "don't send this parameter"). */
type Nullable = { [K in keyof S]: null extends S[K] ? K : never }[keyof S];

/**
 * Handlers for a typed-into control: remember the value at focus, and persist on blur only if it
 * actually changed — so tabbing through a form doesn't fire a PUT per field.
 */
function useCommitOnBlur<K extends keyof S>(field: K, value: S[K]) {
  const { commit } = useSettings();
  const atFocus = useRef(value);
  return {
    onFocus: () => {
      atFocus.current = value;
    },
    onBlur: () => {
      if (value !== atFocus.current) commit({ [field]: value } as Partial<S>);
    },
  };
}

/** Label + hint + switch on one row — the shape every boolean setting takes. */
export function SettingToggle({
  field,
  label,
  hint,
}: {
  field: Of<boolean>;
  label: string;
  hint?: ReactNode;
}) {
  const { form, commit } = useSettings();
  const checked = form[field];
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-slate-200">{label}</div>
        {hint && <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{hint}</div>}
      </div>
      <div className="mt-0.5">
        <Toggle checked={checked} onChange={(v) => commit({ [field]: v } as Partial<S>)} />
      </div>
    </div>
  );
}

export function SettingText({
  field,
  label,
  hint,
  password,
  placeholder,
}: {
  field: Of<string>;
  label: string;
  hint?: ReactNode;
  password?: boolean;
  placeholder?: string;
}) {
  const { form, edit } = useSettings();
  const value = form[field];
  const persist = useCommitOnBlur(field, value);
  return (
    <Field label={label} hint={hint}>
      <Input
        type={password ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => edit({ [field]: e.target.value } as Partial<S>)}
        {...persist}
      />
    </Field>
  );
}

export function SettingNumber({
  field,
  label,
  hint,
  min,
  step = 1,
}: {
  field: Of<number>;
  label: string;
  hint?: ReactNode;
  min?: number;
  step?: number;
}) {
  const { form, edit } = useSettings();
  const value = form[field];
  const persist = useCommitOnBlur(field, value);
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => edit({ [field]: Number(e.target.value) } as Partial<S>)}
        {...persist}
        className="w-44"
      />
    </Field>
  );
}

export function SettingTextarea({
  field,
  label,
  hint,
  rows = 10,
  placeholder,
}: {
  field: Of<string>;
  label: string;
  hint?: ReactNode;
  rows?: number;
  placeholder?: string;
}) {
  const { form, edit } = useSettings();
  const value = form[field];
  const persist = useCommitOnBlur(field, value);
  return (
    <Field label={label} hint={hint}>
      <Textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => edit({ [field]: e.target.value } as Partial<S>)}
        {...persist}
      />
    </Field>
  );
}

export function SettingSlider({
  field,
  label,
  min,
  max,
  step,
}: {
  field: Of<number>;
  label: string;
  min: number;
  max: number;
  step: number;
}) {
  const { form, commit } = useSettings();
  const value = form[field];
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</span>
        <span className="font-mono text-xs text-slate-300">{value}</span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => commit({ [field]: Number(e.target.value) } as Partial<S>)}
        className="w-full accent-accent"
      />
    </div>
  );
}

/**
 * A number box that models a nullable parameter: an empty box means `null` — the parameter is not
 * sent to the model server at all, so its own default applies.
 */
export function SettingNullableNumber({
  field,
  label,
  min,
  max,
  step,
}: {
  field: Nullable;
  label: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const { form, edit } = useSettings();
  const value = form[field] as number | null;
  const persist = useCommitOnBlur(field, form[field]);
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[11px] text-slate-400">{label}</span>
      <Input
        type="number"
        value={value ?? ''}
        placeholder="off"
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const t = e.target.value.trim();
          edit({ [field]: t === '' ? null : Number(t) } as Partial<S>);
        }}
        {...persist}
        className="px-2 py-1.5"
      />
    </label>
  );
}

/**
 * The endpoint + model pair used by every delegated call (titles, vision, image, the scoring judge).
 * Picking an endpoint resets the model to that endpoint's default, since the model list is
 * endpoint-scoped; the model select only appears once an endpoint is chosen.
 */
export function EndpointModelPicker({
  endpointField,
  modelField,
  label,
  hint,
  noneLabel,
  warnUnlessVision,
}: {
  endpointField: Of<string>;
  modelField: Of<string>;
  label: string;
  hint?: ReactNode;
  /** Copy for the empty option — says what happens when no endpoint is picked. */
  noneLabel: string;
  /** Vision picker only: flag an endpoint the operator hasn't marked multimodal. */
  warnUnlessVision?: boolean;
}) {
  const { form, commit, endpoints } = useSettings();
  const endpointId = form[endpointField];
  const selected = endpoints.find((e) => e._id === endpointId);

  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Select
          value={endpointId}
          onChange={(e) => commit({ [endpointField]: e.target.value, [modelField]: '' } as Partial<S>)}
          className="flex-1"
        >
          <option value="">{noneLabel}</option>
          {endpoints.map((e) => (
            <option key={e._id} value={e._id}>
              {e.name}
              {warnUnlessVision && !e.supports_vision ? ' — not marked vision' : ''}
            </option>
          ))}
        </Select>
        {endpointId && (
          <Select
            value={form[modelField]}
            onChange={(e) => commit({ [modelField]: e.target.value } as Partial<S>)}
            className="flex-1"
          >
            <option value="">Endpoint default</option>
            {(selected?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        )}
      </div>
      {warnUnlessVision && selected && !selected.supports_vision && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            This endpoint isn't marked <span className="font-medium">Model supports vision</span> on the
            Endpoints card — screenshots may not be interpreted. Tick it once you've launched the server
            with a vision model + <code>--mmproj</code>.
          </span>
        </p>
      )}
    </Field>
  );
}
