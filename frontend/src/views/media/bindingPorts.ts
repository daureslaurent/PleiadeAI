import type { BindingMeta, WorkflowBinding, WorkflowNodeInput } from '../../lib/api';

/**
 * Port colours for the mapping canvas.
 *
 * Deliberately the same hues as the Flows canvas (`views/flows/portStyle.ts`), because they mean the
 * same thing on both pages: a blue wire carries an image whether it runs between two flow nodes or
 * from the app into a `LoadImage`. `number` is the one type flows has no equivalent for — width,
 * seed, fps — and takes amber, the palette's remaining free hue.
 */
export const BINDING_PORT_COLORS: Record<BindingMeta['port'], string> = {
  text: '#94a3b8', // slate-400
  number: '#fbbf24', // amber-400
  image: '#38bdf8', // sky-400
  audio: '#34d399', // emerald-400
  video: '#a78bfa', // violet-400
};

export function bindingPortColor(port: BindingMeta['port'] | undefined): string {
  return BINDING_PORT_COLORS[port ?? 'text'];
}

/** Prefix marking an operator-invented parameter. Mirrors `CUSTOM_PREFIX` in the backend's model. */
export const CUSTOM_PREFIX = 'custom:';

export function isCustomKey(key: string): boolean {
  return key.startsWith(CUSTOM_PREFIX);
}

/** `custom:category` → `category`: the name a flow port and a tool argument use. */
export function customName(key: string): string {
  return key.slice(CUSTOM_PREFIX.length);
}

/**
 * The catalog entries for the parameters this workflow invents.
 *
 * Derived from the *draft* bindings rather than taken from the server's `custom_catalog`, because the
 * operator declares a custom input and wires it in the same unsaved edit — the port has to exist on
 * the canvas before there is anything to save.
 */
export function customCatalog(bindings: Record<string, WorkflowBinding>): BindingMeta[] {
  return Object.entries(bindings)
    .filter(([key, binding]) => isCustomKey(key) && binding)
    .map(([key, binding]) => ({
      key,
      label: binding.label || customName(key),
      port: (binding.spec?.type === 'INT' || binding.spec?.type === 'FLOAT' ? 'number' : 'text') as
        BindingMeta['port'],
      description: binding.description || `Custom parameter → ${binding.node_id}.${binding.input}.`,
      source: binding.agent_editable
        ? 'This workflow\'s default, a flow node, or the agent on a tool call.'
        : 'This workflow\'s default, or the flow node driving it.',
      kinds: [],
      expected: false,
      custom: true as const,
      ...(binding.choices?.length ? { choices: binding.choices } : {}),
      ...(binding.default !== undefined ? { default: binding.default } : {}),
      ...(binding.agent_editable !== undefined ? { agent_editable: binding.agent_editable } : {}),
    }));
}

/**
 * Colour for a workflow node, by the job its class does.
 *
 * A ComfyUI graph is a wall of near-identical boxes; what an operator is actually looking for is "the
 * sampler", "the thing that loads a picture", "the thing that saves the result". Tinting by role is
 * the cheapest way to make those findable without reading forty titles.
 */
export function nodeRoleColor(classType: string, isOutput: boolean): string {
  if (isOutput || /^(Save|Preview)/.test(classType)) return '#34d399'; // emerald — the result
  if (/^(Load|VHS_Load)/.test(classType)) return '#38bdf8'; // sky — inputs from disk
  if (/Sampler|Guider|Noise/.test(classType)) return '#60a5fa'; // blue — the engine
  if (/TextEncode|Prompt|String|Text/.test(classType)) return '#c084fc'; // purple — words
  if (/Loader|Lora|Checkpoint|Unet|Vae|Clip/i.test(classType)) return '#fbbf24'; // amber — weights
  return '#64748b'; // slate — plumbing
}

/** A short, safe rendering of whatever literal an input currently holds. */
export function inputValueLabel(input: WorkflowNodeInput): string {
  if (input.is_link) return '← linked';
  if (input.value === null || input.value === undefined || input.value === '') return '—';
  const text = String(input.value).replace(/\s+/g, ' ').trim();
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

/** `INT 1–1000 step 17` — the constraint line under a selected input. */
export function specLabel(input: WorkflowNodeInput): string {
  const parts: string[] = [input.type];
  if (input.min !== undefined || input.max !== undefined) {
    parts.push(`${input.min ?? '−∞'}–${input.max ?? '∞'}`);
  }
  if (input.step !== undefined && input.step !== 1) parts.push(`step ${input.step}`);
  if (input.options?.length) parts.push(`${input.options.length} choices`);
  return parts.join(' · ');
}
