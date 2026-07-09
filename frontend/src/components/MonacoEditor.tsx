// Isolated in its own module so React.lazy can code-split it (and the Monaco loader/worker setup it
// pulls in) into a separate chunk. Never import this directly — use ./CodeEditor.
import '../lib/monacoSetup';
import Editor from '@monaco-editor/react';

export default Editor;
