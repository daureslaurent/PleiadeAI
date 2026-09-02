import type { EndpointMode } from './api';

/**
 * The identity colour of an inference mode (`MODES_PLAN.md`), shared by the Settings editor and the
 * chat composer's chips so the same mode reads as the same thing in both places. Per DIRECT_ART the
 * split is semantic, not decorative: a **sampling** mode is a knob on the machine (accent blue, the
 * colour of controls), a **prompt** mode is words entering the model's head (reasoning purple —
 * cognition is always purple).
 */
export function modeTone(type: EndpointMode['type']) {
  return type === 'sampling'
    ? { text: 'text-accent', border: 'border-accent/30', bg: 'bg-accent/15', hover: 'hover:bg-accent/25' }
    : {
        text: 'text-reasoning',
        border: 'border-reasoning/30',
        bg: 'bg-reasoning/15',
        hover: 'hover:bg-reasoning/25',
      };
}
