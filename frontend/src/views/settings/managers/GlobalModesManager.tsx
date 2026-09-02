import { useState } from 'react';
import { Type } from 'lucide-react';
import { Button } from '../../../components/ui';
import type { EndpointMode, GlobalMode } from '../../../lib/api';
import { useSettings } from '../context';
import { ModeRow } from './ModeRow';

/**
 * Fleet-wide inference modes (`MODES_PLAN.md`): prompt snippets offered in *every* conversation,
 * whatever endpoint and model it runs on, alongside the per-model modes defined on each endpoint.
 *
 * Prompt-only by construction, and there is no toggle to make one sampling: a temperature that suits
 * one model says nothing about the next one, so a fleet-wide sampler would be a claim we can't make.
 * A standing instruction ("answer in French") travels across models perfectly well.
 *
 * Two lists: the app's own built-ins (code-defined, so their wording is frozen — but switching one
 * off is still the operator's call, and is stored as an id in `global_modes_disabled`), then the
 * operator's own, which behave exactly like the per-model ones on an endpoint.
 */
export function GlobalModesManager() {
  const { form, commit } = useSettings();
  const all = form.global_modes ?? [];
  const builtins = all.filter((m) => m.builtin);
  const custom = all.filter((m) => !m.builtin);
  const disabled = form.global_modes_disabled ?? [];
  const [openId, setOpenId] = useState<string | null>(null);

  /** Replace one of the operator's own modes (by index within `custom`) and save; `null` deletes it. */
  function save(index: number, next: GlobalMode | null) {
    const list = custom.slice();
    if (next) list[index] = next;
    else list.splice(index, 1);
    commit({ global_modes: list });
  }

  /**
   * Switch a built-in on or off. Not an edit — the wording is still the app's — so it is stored as an
   * id in `global_modes_disabled` rather than on the mode, which does not exist in the database.
   */
  function toggleBuiltin(id: string) {
    const next = disabled.includes(id) ? disabled.filter((d) => d !== id) : [...disabled, id];
    commit({ global_modes_disabled: next });
  }

  function add() {
    const mode: GlobalMode = {
      // Minted here so the row keeps its identity across the debounced save; the backend preserves
      // an id it is given, and a conversation references it from the moment it is selected.
      id: crypto.randomUUID(),
      name: 'New snippet',
      type: 'prompt',
      enabled: true,
      params: {},
      text: '',
      placement: 'user_suffix',
    };
    setOpenId(mode.id);
    commit({ global_modes: [...custom, mode] });
  }

  /** The row speaks the endpoint-mode shape; `model: '*'` is what a global mode carries there. */
  const asRow = (m: GlobalMode) => ({ ...m, model: '*' }) as EndpointMode;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Built in — {builtins.length - disabled.length} of {builtins.length} offered
        </p>
        {builtins.map((m) => (
          <ModeRow
            key={m.id}
            mode={asRow(m)}
            models={null}
            readOnly
            open={openId === m.id}
            onToggleOpen={() => setOpenId(openId === m.id ? null : m.id)}
            // The only live control on a built-in row: whether it appears in the composer.
            onChange={() => toggleBuiltin(m.id)}
            onDelete={() => undefined}
          />
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Yours</p>
        {custom.map((m, i) => (
          <ModeRow
            key={m.id}
            mode={asRow(m)}
            models={null}
            open={openId === m.id}
            onToggleOpen={() => setOpenId(openId === m.id ? null : m.id)}
            onChange={(next) =>
              save(i, {
                id: next.id,
                name: next.name,
                type: 'prompt',
                enabled: next.enabled,
                params: {},
                text: next.text,
                placement: next.placement,
              })
            }
            onDelete={() => save(i, null)}
          />
        ))}

        <Button onClick={add} icon={<Type size={12} />} className="w-full justify-center py-1.5 text-xs">
          Add global mode
        </Button>
      </div>
    </div>
  );
}
