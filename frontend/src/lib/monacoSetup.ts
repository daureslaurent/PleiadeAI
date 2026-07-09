// Serve Monaco from the locally bundled `monaco-editor` package instead of the default CDN
// (jsdelivr). @monaco-editor/react otherwise fetches the editor at runtime, which leaves the editor
// stuck on "Loading…" on any machine that can't reach the CDN (offline, corporate proxy, Windows
// hosts behind a firewall). Importing this module once at app entry wires the loader + web workers.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';

// Vite bundles each worker locally via the `?worker` suffix.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    // dockerfile, python, etc. are tokenised on the main editor worker.
    return new editorWorker();
  },
};

loader.config({ monaco });
