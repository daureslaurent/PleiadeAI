import { useState } from 'react';
import { AlertTriangle, ChevronRight, Eye, ImagePlus, Loader2, Magnet, MousePointerClick, TerminalSquare, Check, X } from 'lucide-react';
import type { Block } from '../store/stream';
import { describeTool, visualActDetail } from '../lib/toolSummary';

type ToolBlock = Extract<Block, { kind: 'tool' }>;

/** Renders one tool invocation inline. bash → terminal; visual_screenshot → vision card; else card. */
export function ToolCall({ block }: { block: ToolBlock }) {
  if (block.tool === 'bash') return <BashBlock block={block} />;
  if (block.tool === 'visual_act' || block.visualAct) return <VisualActBlock block={block} />;
  if (block.tool === 'visual_screenshot' || block.tool === 'analyze_image' || block.vision)
    return <VisionBlock block={block} />;
  if (block.tool === 'generate_image' || block.imageGen) return <ImageGenBlock block={block} />;
  return <GenericToolBlock block={block} />;
}

/**
 * Action-marker card for `visual_act`: shows the screenshot the action landed on with a marker at the
 * acted pixel (a line + endpoints for a drag). Lets the operator see *where* the agent clicked/typed.
 */
function VisualActBlock({ block }: { block: ToolBlock }) {
  const [zoom, setZoom] = useState(false);
  const v = block.visualAct;
  const action = String(v?.action ?? block.args?.action ?? 'act');
  const detail = visualActDetail(block.args ?? {});
  const isDrag = v?.x2 != null && v?.y2 != null;

  return (
    <div className="my-2 animate-fade-up overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03] text-xs backdrop-blur-sm transition-shadow hover:border-white/[0.12]">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <MousePointerClick size={13} className="shrink-0 text-accent" />
        <span className="font-medium text-slate-200">{block.tool}</span>
        <span className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
          {action}
        </span>
        {detail && (
          <span className="truncate rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">
            {detail}
          </span>
        )}
        {v?.snap && <OcrChip snap={v.snap} />}
        <span className="ml-auto">
          <StatusIcon status={block.status} />
        </span>
      </div>

      <div className="space-y-2 border-t border-white/[0.06] p-3">
        {v?.image ? (
          <button onClick={() => setZoom((z) => !z)} className="block" title="Click to zoom">
            <span className="relative inline-block">
              <img
                src={v.image}
                alt="agent desktop action"
                className={`block rounded border border-border object-contain ${zoom ? 'w-full' : 'max-h-52'}`}
              />
              {v.x != null && v.y != null && (
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${v.width} ${v.height}`}
                  preserveAspectRatio="none"
                >
                  {isDrag && (
                    <line
                      x1={v.x}
                      y1={v.y}
                      x2={v.x2!}
                      y2={v.y2!}
                      stroke="#f43f5e"
                      strokeWidth={Math.max(2, v.width / 240)}
                      strokeDasharray={`${v.width / 90} ${v.width / 120}`}
                    />
                  )}
                  <ActMarker cx={v.x} cy={v.y} r={v.width} />
                  {isDrag && <ActMarker cx={v.x2!} cy={v.y2!} r={v.width} />}
                </svg>
              )}
            </span>
          </button>
        ) : (
          <div className="text-slate-500">
            {block.status === 'running' ? 'Acting on the desktop…' : 'No screenshot captured.'}
          </div>
        )}
      </div>
    </div>
  );
}

/** A crosshair-style marker: an outer ring + a filled centre, sized relative to the screen width. */
function ActMarker({ cx, cy, r, color = '#f43f5e' }: { cx: number; cy: number; r: number; color?: string }) {
  const ring = Math.max(8, r / 55);
  return (
    <g>
      <circle cx={cx} cy={cy} r={ring} fill="none" stroke={color} strokeWidth={Math.max(2, r / 300)} />
      <circle cx={cx} cy={cy} r={Math.max(2, r / 260)} fill={color} />
    </g>
  );
}

/**
 * "OCR" chip shown when a located/clicked point was snapped to an OCR-detected text box (pixel-exact
 * text targeting). The magnet reads as "snap"; hover reveals the matched text + snapped coordinate.
 */
function OcrChip({ snap }: { snap: { text: string; x: number; y: number } }) {
  return (
    <span
      className="flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
      title={`Snapped to OCR text "${snap.text}" at (${snap.x}, ${snap.y})`}
    >
      <Magnet size={10} className="text-accent" />
      OCR
    </span>
  );
}

function StatusIcon({ status }: { status: ToolBlock['status'] }) {
  if (status === 'running') return <Loader2 size={13} className="animate-spin text-slate-400" />;
  if (status === 'error') return <X size={13} className="text-red-400" />;
  return <Check size={13} className="text-emerald-400" />;
}

/** OpenCode-style terminal block for bash: `$ command`, collapsible live output, exit code. */
function BashBlock({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const command = String(block.args?.command ?? '');
  const exit =
    block.result && typeof block.result === 'object' && 'exit_code' in block.result
      ? (block.result as { exit_code: number }).exit_code
      : undefined;

  return (
    <div className="my-2 animate-fade-up overflow-hidden rounded-xl border border-white/[0.07] bg-black/40 font-mono text-xs backdrop-blur-sm transition-shadow hover:border-white/[0.12]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <TerminalSquare size={13} className="shrink-0 text-slate-400" />
        <span className="truncate text-slate-200">
          <span className="text-emerald-400">$</span> {command}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {exit !== undefined && (
            <span className={exit === 0 ? 'text-slate-500' : 'text-red-400'}>exit {exit}</span>
          )}
          <StatusIcon status={block.status} />
        </span>
      </button>
      {(open || block.status === 'running') && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-white/[0.06] px-3 py-2 text-slate-300">
          {block.output || (block.status === 'running' ? '…' : '(no output)')}
        </pre>
      )}
    </div>
  );
}

/**
 * Vision card for `visual_screenshot`: shows the screenshot the vision model saw and the analysis it
 * returned (the "input/output" of the vision model, inline in the chat). Click the image to zoom.
 */
function VisionBlock({ block }: { block: ToolBlock }) {
  const [zoom, setZoom] = useState(false);
  const v = block.vision;
  const question = String(block.args?.question ?? v?.question ?? '').trim();

  return (
    <div className="my-2 animate-fade-up overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03] text-xs backdrop-blur-sm transition-shadow hover:border-white/[0.12]">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Eye size={13} className="shrink-0 text-accent" />
        <span className="font-medium text-slate-200">{block.tool}</span>
        {v?.model && (
          <span className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
            {v.model}
          </span>
        )}
        {v?.snap && <OcrChip snap={v.snap} />}
        <span className="ml-auto">
          <StatusIcon status={block.status} />
        </span>
      </div>

      <div className="space-y-2 border-t border-white/[0.06] p-3">
        {question && (
          <div className="text-slate-300">
            <span className="text-slate-500">Q: </span>
            {question}
          </div>
        )}

        {v?.image ? (
          <button onClick={() => setZoom((z) => !z)} className="block" title="Click to zoom">
            <span className="relative inline-block">
              <img
                src={v.image}
                alt="agent desktop screenshot"
                className={`block rounded border border-border object-contain ${zoom ? 'w-full' : 'max-h-52'}`}
              />
              {v.x != null && v.y != null && v.width && v.height && (
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${v.width} ${v.height}`}
                  preserveAspectRatio="none"
                >
                  {/* Cyan for contrast against the red coordinate grid in the preview. */}
                  <ActMarker cx={v.x} cy={v.y} r={v.width} color="#22d3ee" />
                </svg>
              )}
            </span>
          </button>
        ) : (
          <div className="text-slate-500">
            {block.status === 'running' ? 'Capturing & analysing the screen…' : 'No screenshot captured.'}
          </div>
        )}

        {v?.answer && (
          <div>
            <div className="mb-0.5 flex items-center gap-1 text-[10px] uppercase text-slate-500">
              <Eye size={11} /> vision
            </div>
            <div className="whitespace-pre-wrap leading-relaxed text-slate-300">{v.answer}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Generation card for `generate_image`: the prompt + the effective sampling params + the produced
 * image(s), inline in the chat. Prompt/params come from the live `imageGen` event when present, else
 * fall back to the tool call `args` (which persist across a reload). Click an image to open full-size.
 */
function ImageGenBlock({ block }: { block: ToolBlock }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const g = block.imageGen;
  const args = block.args ?? {};
  // Prefer the resolved live values; fall back to the persisted args so a reloaded turn still reads.
  const prompt = String(g?.prompt ?? args.prompt ?? '').trim();
  const size = g?.size ?? (args.size ? String(args.size) : undefined);
  const steps = g?.steps ?? (args.steps != null ? Number(args.steps) : undefined);
  const guidance = g?.guidance ?? (args.guidance != null ? Number(args.guidance) : undefined);
  const seed = g?.seed ?? (args.seed != null ? Number(args.seed) : null);
  const model = g?.model ?? '';
  const images = block.images ?? [];
  const error =
    block.status === 'error' && block.result && typeof block.result === 'object' && 'error' in block.result
      ? String((block.result as { error: unknown }).error)
      : null;

  // Compact "768x768 · 20 steps · cfg 3.5 · seed 42" chip line — only the parts we actually know.
  const meta = [
    size,
    steps != null ? `${steps} steps` : null,
    guidance != null ? `cfg ${guidance}` : null,
    seed != null ? `seed ${seed}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className="my-2 animate-fade-up overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03] text-xs backdrop-blur-sm transition-shadow hover:border-white/[0.12]">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <ImagePlus size={13} className="shrink-0 text-accent" />
        <span className="font-medium text-slate-200">{block.tool}</span>
        {model && (
          <span className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
            {model}
          </span>
        )}
        <span className="ml-auto">
          <StatusIcon status={block.status} />
        </span>
      </div>

      <div className="space-y-2 border-t border-white/[0.06] p-3">
        {prompt && (
          <div className="text-slate-300">
            <span className="text-slate-500">Prompt: </span>
            {prompt}
          </div>
        )}
        {meta.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {meta.map((m) => (
              <span key={m} className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                {m}
              </span>
            ))}
          </div>
        )}

        {images.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <button
                key={img.id ?? i}
                onClick={() => setZoom((z) => (z === i ? null : i))}
                className="block"
                title={img.id ? `${img.id} — click to ${zoom === i ? 'shrink' : 'enlarge'}` : 'click to enlarge'}
              >
                <span className="relative inline-block">
                  <img
                    src={img.dataUrl}
                    alt={img.id ?? `generated image ${i}`}
                    className={`block rounded border border-border object-contain ${zoom === i ? 'w-full' : 'max-h-52'}`}
                  />
                  {img.id && (
                    <span className="absolute bottom-0 left-0 right-0 rounded-b bg-black/60 px-1 py-px text-center text-[9px] font-mono text-slate-200">
                      {img.id}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        ) : error ? (
          <div className="flex items-start gap-1.5 text-[11px] text-amber-400">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : (
          <div className="text-slate-500">
            {block.status === 'running' ? 'Generating image… (can take a while on CPU)' : 'No image produced.'}
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact card for non-terminal tools: icon + name + at-a-glance action summary, expandable args/result. */
function GenericToolBlock({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const { Icon, value, title, hint } = describeTool(block.tool, block.args ?? {}, block.result, block.status);
  // A tool that had to shrink its output (e.g. webfetch truncating a long page, or storing a binary
  // body as a blob instead of inlining it) flags the result — surface an amber warning so the operator
  // knows the agent saw a reduced payload without having to expand the card.
  const r = block.result as { reduced?: unknown; binary?: unknown } | undefined;
  const warn =
    !!r && typeof r === 'object' && (Boolean(r.reduced) || Boolean(r.binary))
      ? Boolean(r.binary)
        ? 'Binary response stored as a blob — not shown inline'
        : 'Response truncated to fit the token budget'
      : null;
  return (
    <div className="my-2 animate-fade-up overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03] text-xs backdrop-blur-sm transition-shadow hover:border-white/[0.12]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Icon size={13} className="shrink-0 text-accent" />
        <span className="shrink-0 font-medium text-slate-200">{block.tool}</span>
        {value && (
          <span
            title={title ?? value}
            className="min-w-0 truncate rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
          >
            {value}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {hint && <span className="text-[10px] text-slate-500">{hint}</span>}
          {warn && (
            <span title={warn} className="flex items-center">
              <AlertTriangle size={13} className="text-amber-400" />
            </span>
          )}
          <StatusIcon status={block.status} />
        </span>
      </button>
      {block.images && block.images.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-white/[0.06] px-3 py-2">
          {block.images.map((img, i) => (
            <a
              key={img.id ?? i}
              href={img.dataUrl}
              target="_blank"
              rel="noreferrer"
              className="group relative block"
              title={img.id ? `${img.id} — click to open` : 'click to open'}
            >
              <img
                src={img.dataUrl}
                alt={img.id ?? `image ${i}`}
                className="h-16 w-16 rounded border border-border object-cover"
              />
              {img.id && (
                <span className="absolute bottom-0 left-0 right-0 rounded-b bg-black/60 px-1 py-px text-center text-[9px] font-mono text-slate-200">
                  {img.id}
                </span>
              )}
            </a>
          ))}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-white/[0.06] px-3 py-2 font-mono">
          <div>
            <div className="mb-0.5 text-[10px] uppercase text-slate-500">args</div>
            <pre className="whitespace-pre-wrap text-slate-300">
              {JSON.stringify(block.args, null, 2)}
            </pre>
          </div>
          {block.result !== undefined && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase text-slate-500">result</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-slate-300">
                {typeof block.result === 'string'
                  ? block.result
                  : JSON.stringify(block.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
