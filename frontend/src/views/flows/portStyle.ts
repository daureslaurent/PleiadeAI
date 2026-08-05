import type { PortType } from '../../lib/api';

/**
 * One colour per port type (FLOWS_PLAN.md §2). The canvas is a wiring diagram, and the single most
 * useful thing it can tell you at a glance is *what kind of thing* runs down each wire — so the
 * handle, the edge and the legend all read from here.
 *
 * Hues are picked to stay distinguishable against the starfield and from each other: text is the
 * neutral slate the UI already uses for prose, media each get their own saturated hue, and `signal`
 * is deliberately desaturated because it carries no data at all.
 */
export const PORT_COLORS: Record<PortType, string> = {
  text: '#94a3b8', // slate-400
  image: '#38bdf8', // sky-400
  video: '#a78bfa', // violet-400
  audio: '#34d399', // emerald-400
  file: '#fbbf24', // amber-400
  json: '#f472b6', // pink-400
  signal: '#64748b', // slate-500
};

export const PORT_LABELS: Record<PortType, string> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  file: 'File',
  json: 'Data',
  signal: 'Action',
};

export function portColor(type: PortType | undefined): string {
  return PORT_COLORS[type ?? 'text'] ?? PORT_COLORS.text;
}

/**
 * Mirror of the backend's `canConnect` (flows spec §2). Duplicated deliberately: the operator should
 * learn a video can't be a prompt while *dragging* the wire, not ten minutes into a run. The server
 * still enforces it — this copy is an affordance, not the authority.
 */
export function canConnect(source: PortType, target: PortType): boolean {
  if (source === target) return true;
  if (source === 'signal' || target === 'signal') return false;
  if (target === 'file' && ['image', 'video', 'audio', 'file'].includes(source)) return true;
  if (target === 'text') return true;
  if (target === 'json' && source === 'text') return true;
  return false;
}

/** Colour per node group, used for the node header accent and the palette. */
export const GROUP_COLORS: Record<string, string> = {
  io: '#94a3b8',
  agent: '#60a5fa',
  media: '#c084fc',
  tool: '#fbbf24',
  control: '#f87171',
};

export const GROUP_LABELS: Record<string, string> = {
  io: 'Input / Output',
  agent: 'Agents',
  media: 'Media',
  tool: 'Tools',
  control: 'Control flow',
};
