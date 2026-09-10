/**
 * Build-time feature flags (spec `FRONTEND_BUILD_WEIGHT_PLAN.md`).
 *
 * A handful of dependencies dominate the frontend build: mermaid drags in cytoscape/dagre/katex/elkjs,
 * monaco is a whole editor plus three worker bundles. Both are already `React.lazy`/`import()`-split,
 * which defers the *download* — but Rollup still compiles them, so neither split does anything for
 * peak build memory. On a small VPS that is the difference between a build and a reboot.
 *
 * Setting `VITE_FEATURE_MERMAID=0` (etc.) at build time does two things at once:
 *
 *  1. `vite.config.ts`'s `stubHeavyDeps` plugin resolves the package to a tiny local stub, so the
 *     real dependency never enters the module graph;
 *  2. the constant below becomes a literal `false`, so every UI branch that would have used it is
 *     dead code and tree-shaken away.
 *
 * Both halves are needed. (1) alone would leave the UI calling a stub that can't do anything; (2)
 * alone would still compile the dependency. Anything that reads a flag must therefore also render a
 * usable fallback — a compiled-out feature degrades, it never blanks.
 *
 * Flags default **on**: a missing env var means a full-fat build, so a fresh checkout and a dev
 * server behave the way the code reads.
 */

/** `'0'` disables; unset or anything else enables. */
function enabled(value: string | undefined): boolean {
  return value !== '0';
}

/** Mermaid diagram rendering in markdown. Off → ```mermaid fences render as plain code blocks. */
export const MERMAID_ENABLED = enabled(import.meta.env.VITE_FEATURE_MERMAID);

/** The Monaco code editor. Off → `CodeEditor` renders a plain textarea. */
export const MONACO_ENABLED = enabled(import.meta.env.VITE_FEATURE_MONACO);

/** The noVNC live-desktop client. Off → the Visual/Android panels report the feature as unavailable. */
export const NOVNC_ENABLED = enabled(import.meta.env.VITE_FEATURE_NOVNC);
