import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Paperclip, Upload, X } from 'lucide-react';
import { flowsApi, type FlowUpload, type PortType } from '../../lib/api';
import { ArtifactPreview } from './ArtifactPreview';

/** MIME filter per port type, so the file picker offers the right things by default. */
const ACCEPT: Partial<Record<PortType, string>> = {
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
};

/**
 * The value control for a binary `input` (image / video / audio / file): drop or pick a file, and it
 * is uploaded to the flow's staging session and named by the handle it comes back with.
 *
 * The stored value is only ever that handle. Bytes live in the resource store, so the same upload can
 * be a node's default *and* a per-run override, and re-running a flow costs no re-upload.
 */
export function ResourceInput({
  flowId,
  type,
  value,
  onChange,
}: {
  flowId: string;
  type: PortType;
  value: string;
  onChange: (handle: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<FlowUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessionId = `flow-${flowId}`;

  const refresh = useCallback(() => {
    flowsApi
      .uploads(flowId)
      .then((r) => setStaged(r.files))
      .catch(() => undefined);
  }, [flowId]);

  useEffect(refresh, [refresh]);

  const send = async (file: File) => {
    setBusy(true);
    setPercent(0);
    setError(null);
    try {
      const uploaded = await flowsApi.upload(flowId, file, setPercent);
      onChange(uploaded.handle);
      refresh();
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } }; message?: string };
      setError(anyErr?.response?.data?.error ?? anyErr?.message ?? 'upload failed');
    } finally {
      setBusy(false);
    }
  };

  const current = staged.find((f) => f.handle === value);

  return (
    <div className="space-y-1.5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void send(file);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-3 text-xs transition-colors ${
          dragging
            ? 'border-accent/60 bg-accent/[0.08] text-accent'
            : 'border-white/[0.12] text-slate-500 hover:border-accent/50 hover:text-accent'
        }`}
      >
        {busy ? (
          <>
            <Loader2 size={13} className="animate-spin" />
            {percent > 0 && percent < 100 ? `${percent}%` : 'uploading…'}
          </>
        ) : (
          <>
            <Upload size={13} />
            {value ? 'Replace file' : 'Drop a file or click to choose'}
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT[type]}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
          // Reset so picking the same file twice still fires a change.
          e.target.value = '';
        }}
      />

      {value && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
            <Paperclip size={10} className="shrink-0" />
            <span className="truncate font-mono">{value}</span>
            {current?.filename && <span className="truncate">· {current.filename}</span>}
            <button
              onClick={() => onChange('')}
              title="Clear"
              className="ml-auto shrink-0 transition-colors hover:text-red-400"
            >
              <X size={11} />
            </button>
          </div>
          <ArtifactPreview
            sessionId={sessionId}
            handle={value}
            mime={current?.mime}
            filename={current?.filename}
          />
        </div>
      )}

      {/* Anything already uploaded to this flow, so a re-run doesn't mean a re-upload. */}
      {staged.length > 0 && (
        <details className="text-[10px] text-slate-600">
          <summary className="cursor-pointer select-none hover:text-slate-400">
            Previously uploaded ({staged.length})
          </summary>
          <div className="mt-1 space-y-0.5">
            {staged.map((f) => (
              <button
                key={f.handle}
                onClick={() => onChange(f.handle)}
                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors ${
                  f.handle === value ? 'bg-accent/15 text-accent' : 'hover:bg-white/[0.05] hover:text-slate-300'
                }`}
              >
                <span className="font-mono">{f.handle}</span>
                <span className="truncate">{f.filename}</span>
                <span className="ml-auto shrink-0">{formatBytes(f.size)}</span>
              </button>
            ))}
          </div>
        </details>
      )}

      {error && <div className="text-[10px] text-red-400">{error}</div>}
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
