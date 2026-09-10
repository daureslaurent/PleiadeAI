/**
 * Stand-in for `mermaid` when `VITE_FEATURE_MERMAID=0` (see `lib/features.ts`).
 *
 * `vite.config.ts` resolves the package specifier here, so the real library — and the cytoscape /
 * dagre / katex / elkjs graph behind it — is never compiled. Nothing should ever call this: the one
 * import site is guarded by `MERMAID_ENABLED`, and the stub only exists to keep the module graph
 * resolvable. `parse` reports every diagram as invalid so that even a mistaken call degrades into
 * the plain-code-block fallback rather than throwing.
 */
const stub = {
  initialize(_config: unknown): void {},
  async parse(_text: string, _options?: unknown): Promise<boolean> {
    return false;
  },
  async render(_id: string, _text: string): Promise<{ svg: string }> {
    return { svg: '' };
  },
};

export default stub;
