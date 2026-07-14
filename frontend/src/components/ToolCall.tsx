import { useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Clock, Eye, ImagePlus, Loader2, Magnet, MapPin, MousePointerClick, Navigation, Search, Star, TerminalSquare, ThumbsUp, Youtube, Check, X } from 'lucide-react';
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
  if (block.tool === 'web_search') return <WebSearchBlock block={block} />;
  if (block.tool === 'youtube') return <YouTubeBlock block={block} />;
  if (block.tool === 'google_maps') return <MapsBlock block={block} />;
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

/* ------------------------------------------------------------------------------------------------
 * Rich cards for the Google-backed tools (web_search / youtube / google_maps): render the tool's
 * structured result as scannable content — result lists, video thumbnails, place cards — instead of
 * raw JSON. Errors and odd payloads fall back to GenericToolBlock so nothing is ever hidden.
 * ------------------------------------------------------------------------------------------------ */

/** Shared card shell: header row (icon, tool name, chips, status) + a bordered content area. */
function RichToolCard({
  block,
  icon,
  chips,
  children,
  runningLabel,
}: {
  block: ToolBlock;
  icon: ReactNode;
  chips?: ReactNode;
  children: ReactNode;
  runningLabel: string;
}) {
  return (
    <div className="my-2 animate-fade-up overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03] text-xs backdrop-blur-sm transition-shadow hover:border-white/[0.12]">
      <div className="flex items-center gap-2 px-3 py-1.5">
        {icon}
        <span className="shrink-0 font-medium text-slate-200">{block.tool}</span>
        {chips}
        <span className="ml-auto">
          <StatusIcon status={block.status} />
        </span>
      </div>
      <div className="border-t border-white/[0.06] p-3">
        {block.status === 'running' ? <div className="text-shimmer text-slate-400">{runningLabel}</div> : children}
      </div>
    </div>
  );
}

/** Faint monospace header chip (query, provider, action…). */
function HeaderChip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="min-w-0 truncate rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
      {children}
    </span>
  );
}

/** The `{ ok, … }` result payload of a Google-backed tool, or null when it isn't one. */
function okResult(block: ToolBlock): Record<string, unknown> | null {
  const r = block.result;
  if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === true) return r as Record<string, unknown>;
  return null;
}

/** Compact count: 1234 → 1.2k, 4567890 → 4.6M. */
function fmtCount(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}

/** Search-result list for `web_search`: linked titles, host, snippet — instead of a JSON dump. */
function WebSearchBlock({ block }: { block: ToolBlock }) {
  const r = okResult(block);
  const results = (r?.results ?? null) as Array<{ title?: string; url?: string; snippet?: string }> | null;
  if (block.status !== 'running' && !results) return <GenericToolBlock block={block} />;

  const provider = r ? String(r.provider ?? '') : '';
  const query = String(block.args?.query ?? '');
  const host = (url: string) => {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch {
      return url;
    }
  };

  return (
    <RichToolCard
      block={block}
      icon={<Search size={13} className="shrink-0 text-accent" />}
      runningLabel={`Searching the web for “${query}”…`}
      chips={
        <>
          {query && <HeaderChip title={query}>“{query}”</HeaderChip>}
          {provider && <HeaderChip>{provider}</HeaderChip>}
        </>
      }
    >
      {results && results.length > 0 ? (
        <ol className="space-y-2">
          {results.map((hit, i) => (
            <li key={i} className="min-w-0">
              <a
                href={hit.url}
                target="_blank"
                rel="noreferrer"
                className="block truncate font-medium text-accent hover:underline"
                title={hit.url}
              >
                {hit.title || hit.url}
              </a>
              <div className="truncate font-mono text-[10px] text-slate-500">{host(hit.url ?? '')}</div>
              {hit.snippet && <p className="mt-0.5 line-clamp-2 leading-snug text-slate-400">{hit.snippet}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <div className="text-slate-500">No results.</div>
      )}
    </RichToolCard>
  );
}

interface VideoHit {
  video_id?: string;
  url?: string;
  title?: string;
  channel?: string;
  published_at?: string;
  description?: string;
  thumbnail?: string;
  duration?: string;
  views?: number;
  likes?: number;
  tags?: string[];
}

/** One YouTube video row: thumbnail + linked title + channel/date (+ stats chips for details). */
function VideoRow({ v, detailed }: { v: VideoHit; detailed?: boolean }) {
  const date = v.published_at ? new Date(v.published_at).toLocaleDateString() : '';
  return (
    <div className="flex min-w-0 gap-2.5">
      {v.thumbnail && (
        <a href={v.url} target="_blank" rel="noreferrer" className="shrink-0" title="Open on YouTube">
          <span className="relative block">
            <img src={v.thumbnail} alt={v.title ?? 'video'} className="aspect-video w-32 rounded-lg border border-white/[0.07] object-cover" />
            {v.duration && (
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-px font-mono text-[9px] text-slate-200">
                {v.duration}
              </span>
            )}
          </span>
        </a>
      )}
      <div className="min-w-0 flex-1">
        <a href={v.url} target="_blank" rel="noreferrer" className="line-clamp-2 font-medium leading-snug text-slate-200 hover:text-accent hover:underline">
          {v.title || v.url}
        </a>
        <div className="mt-0.5 truncate text-[10px] text-slate-500">
          {v.channel}
          {date && <span> · {date}</span>}
        </div>
        {detailed && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {v.views != null && v.views > 0 && (
              <span className="flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                <Eye size={10} /> {fmtCount(v.views)}
              </span>
            )}
            {v.likes != null && v.likes > 0 && (
              <span className="flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                <ThumbsUp size={10} /> {fmtCount(v.likes)}
              </span>
            )}
          </div>
        )}
        {detailed && v.description && <p className="mt-1.5 line-clamp-3 leading-snug text-slate-400">{v.description}</p>}
      </div>
    </div>
  );
}

/** Video cards for `youtube`: search → thumbnail list; video → one detailed card with stats. */
function YouTubeBlock({ block }: { block: ToolBlock }) {
  const r = okResult(block);
  const action = String(block.args?.action ?? (r ? String(r.action ?? '') : ''));
  const results = (r?.results ?? null) as VideoHit[] | null;
  const video = (r?.video ?? null) as VideoHit | null;
  if (block.status !== 'running' && !results && !video) return <GenericToolBlock block={block} />;

  const query = String(block.args?.query ?? '');
  return (
    <RichToolCard
      block={block}
      icon={<Youtube size={13} className="shrink-0 text-red-400" />}
      runningLabel={action === 'video' ? 'Fetching video details…' : `Searching YouTube for “${query}”…`}
      chips={
        <>
          {action && <HeaderChip>{action}</HeaderChip>}
          {query && <HeaderChip title={query}>“{query}”</HeaderChip>}
        </>
      }
    >
      {video ? (
        <VideoRow v={video} detailed />
      ) : results && results.length > 0 ? (
        <div className="space-y-2.5">
          {results.map((v, i) => (
            <VideoRow key={v.video_id ?? i} v={v} />
          ))}
        </div>
      ) : (
        <div className="text-slate-500">No videos found.</div>
      )}
    </RichToolCard>
  );
}

interface PlaceHit {
  name?: string;
  address?: string;
  lat?: number;
  lng?: number;
  rating?: number | null;
  ratings_count?: number;
  open_now?: boolean | null;
  url?: string;
}

/** Place cards / geocode rows / a route summary for `google_maps`, depending on the action. */
function MapsBlock({ block }: { block: ToolBlock }) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const r = okResult(block);
  const action = String(block.args?.action ?? (r ? String(r.action ?? '') : ''));
  const results = (r?.results ?? null) as PlaceHit[] | Array<{ address?: string; lat?: number; lng?: number }> | null;
  const route = (r?.route ?? null) as {
    summary?: string;
    mode?: string;
    origin?: string;
    destination?: string;
    distance?: string;
    duration?: string;
    steps?: Array<{ instruction?: string; distance?: string }>;
  } | null;
  if (block.status !== 'running' && !results && !route) return <GenericToolBlock block={block} />;

  const query = String(block.args?.query ?? block.args?.location ?? '');
  const chip =
    action === 'directions' ? `${String(block.args?.origin ?? '')} → ${String(block.args?.destination ?? '')}` : query;

  return (
    <RichToolCard
      block={block}
      icon={<MapPin size={13} className="shrink-0 text-emerald-400" />}
      runningLabel={action === 'directions' ? 'Computing the route…' : `Searching Maps for “${query}”…`}
      chips={
        <>
          {action && <HeaderChip>{action}</HeaderChip>}
          {chip && <HeaderChip title={chip}>{chip}</HeaderChip>}
        </>
      }
    >
      {route ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1">
            <span className="flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
              <Navigation size={10} className="text-emerald-400" /> {route.distance}
            </span>
            <span className="flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
              <Clock size={10} /> {route.duration}
            </span>
            {route.mode && <HeaderChip>{route.mode}</HeaderChip>}
            {route.summary && <span className="text-[10px] text-slate-500">via {route.summary}</span>}
          </div>
          <div className="truncate text-[11px] text-slate-400" title={`${route.origin} → ${route.destination}`}>
            {route.origin} <span className="text-slate-600">→</span> {route.destination}
          </div>
          {route.steps && route.steps.length > 0 && (
            <div>
              <button
                onClick={() => setStepsOpen((o) => !o)}
                className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500 hover:text-slate-300"
              >
                <ChevronRight size={11} className={`transition-transform ${stepsOpen ? 'rotate-90' : ''}`} />
                {route.steps.length} steps
              </button>
              {stepsOpen && (
                <ol className="mt-1.5 space-y-1 pl-1">
                  {route.steps.map((s, i) => (
                    <li key={i} className="flex gap-2 leading-snug">
                      <span className="w-4 shrink-0 text-right font-mono text-[10px] text-slate-600">{i + 1}</span>
                      <span className="min-w-0 flex-1 text-slate-400">{s.instruction}</span>
                      {s.distance && <span className="shrink-0 font-mono text-[10px] text-slate-600">{s.distance}</span>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      ) : results && results.length > 0 ? (
        <div className="space-y-2">
          {results.map((p, i) => {
            const place = p as PlaceHit;
            const mapsUrl = place.url ?? `https://www.google.com/maps?q=${place.lat},${place.lng}`;
            return (
              <div key={i} className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <a href={mapsUrl} target="_blank" rel="noreferrer" className="truncate font-medium text-slate-200 hover:text-accent hover:underline">
                    {place.name || place.address || `${place.lat}, ${place.lng}`}
                  </a>
                  {typeof place.rating === 'number' && (
                    <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-amber-400" title={`${place.rating} (${place.ratings_count ?? 0} ratings)`}>
                      <Star size={10} className="fill-amber-400" /> {place.rating}
                      {place.ratings_count ? <span className="text-slate-500"> ({fmtCount(place.ratings_count)})</span> : null}
                    </span>
                  )}
                  {place.open_now === true && (
                    <span className="shrink-0 rounded bg-emerald-500/10 px-1 py-px text-[9px] uppercase tracking-wide text-emerald-400">open</span>
                  )}
                  {place.open_now === false && (
                    <span className="shrink-0 rounded bg-white/[0.06] px-1 py-px text-[9px] uppercase tracking-wide text-slate-500">closed</span>
                  )}
                </div>
                {(place.name ? place.address : null) && (
                  <div className="truncate text-[10px] text-slate-500">{place.address}</div>
                )}
                {place.lat != null && place.lng != null && !place.name && (
                  <div className="font-mono text-[10px] text-slate-500">
                    {place.lat.toFixed(6)}, {place.lng.toFixed(6)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-slate-500">No results.</div>
      )}
    </RichToolCard>
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
