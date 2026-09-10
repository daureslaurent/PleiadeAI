/**
 * Stand-in for `lib/monacoSetup` when `VITE_FEATURE_MONACO=0` (see `lib/features.ts`).
 *
 * The real module is a side-effect import that pulls in `monaco-editor` itself plus three
 * `?worker` bundles. Stubbing *it* rather than the package keeps the worker query suffixes out of
 * the alias rules entirely — it is the only importer of any of them.
 */
export {};
