/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_WS_URL: string;
  /** Build-time feature flags — `'0'` compiles the feature out. See `lib/features.ts`. */
  readonly VITE_FEATURE_MERMAID?: string;
  readonly VITE_FEATURE_MONACO?: string;
  readonly VITE_FEATURE_NOVNC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
