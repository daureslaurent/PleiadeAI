import {
  BookUser,
  Brain,
  BookOpen,
  CalendarClock,
  Database,
  Eye,
  FileDiff,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FolderOpen,
  Globe,
  type LucideIcon,
  MousePointerClick,
  Search,
  Settings2,
  Wrench,
} from 'lucide-react';

/**
 * At-a-glance description of a tool call for the *collapsed* card: a per-tool icon, the primary
 * action value (the file read, the pattern searched, the key pressed…) and, once the call lands, a
 * faint result hint (line count, match count, bytes written…). See DIRECT_ART.md — this is what
 * lets the operator scan a turn's tool trace without expanding every card.
 */
export interface ToolSummary {
  Icon: LucideIcon;
  /** Primary action value, rendered in a faint monospace chip. Empty → chip is omitted. */
  value: string;
  /** Full, untruncated value for the hover tooltip (paths, long queries). */
  title?: string;
  /** Right-aligned faint result hint, only once the call finishes. */
  hint?: string;
}

/** Keep the last 2 path segments, prefixed with `…/` when the path is deeper. */
export function shortenPath(raw: string): string {
  const p = String(raw).trim();
  if (!p) return '';
  const segs = p.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs.length <= 2) return p.startsWith('/') ? p : segs.join('/');
  return `…/${segs.slice(-2).join('/')}`;
}

function truncate(s: string, n = 48): string {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function quote(s: string, n = 40): string {
  const t = truncate(s, n);
  return t ? `"${t}"` : '';
}

function formatBytes(b: number): string {
  if (!Number.isFinite(b)) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

type Args = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Human-readable detail for a `visual_act` call: the key combo, typed text, or scroll. */
export function visualActDetail(args: Args): string {
  const action = str(args.action);
  if (action === 'key') {
    const keys = Array.isArray(args.keys) ? (args.keys as unknown[]).map(str) : [];
    if (keys.length) return keys.join('+');
    return str(args.text);
  }
  if (action === 'type') return quote(str(args.text));
  if (action === 'scroll') {
    const dir = str(args.direction);
    const amt = str(args.amount);
    return [dir, amt].filter(Boolean).join(' ');
  }
  return '';
}

/**
 * Map a tool call to its collapsed-card summary. Data-driven per tool; unknown tools fall back to
 * the first recognisable arg (path/url/query/…) so custom skills still get a useful preview.
 */
export function describeTool(
  tool: string,
  args: Args,
  result: unknown,
  status: 'running' | 'success' | 'error',
): ToolSummary {
  const r = asRecord(result);
  const done = status !== 'running';
  const n = (v: unknown): number | undefined => {
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };

  switch (tool) {
    case 'read': {
      const path = str(args.filePath ?? args.path);
      const lines = n(r.total_lines);
      const isImage = r.type === 'image';
      return {
        Icon: FileText,
        value: shortenPath(path),
        title: path,
        hint: done ? (isImage ? 'image' : lines != null ? `${lines} lines` : undefined) : undefined,
      };
    }
    case 'write': {
      const path = str(args.filePath ?? args.path);
      const bytes = n(r.bytes);
      return {
        Icon: FilePlus,
        value: shortenPath(path),
        title: path,
        hint: done && bytes != null ? formatBytes(bytes) : undefined,
      };
    }
    case 'edit': {
      const path = str(args.filePath ?? args.path);
      return {
        Icon: FilePen,
        value: shortenPath(path),
        title: path,
        hint: done ? (r.action === 'created' ? 'created' : 'edited') : undefined,
      };
    }
    case 'patch': {
      const text = str(args.patchText);
      const m = text.match(/^\+\+\+ (?:b\/)?(.+)$/m) ?? text.match(/\*\*\* (?:Update|Add) File: (.+)$/m);
      const path = m?.[1] ? m[1].trim() : '';
      return { Icon: FileDiff, value: path ? shortenPath(path) : 'patch', title: path || undefined };
    }
    case 'list': {
      const path = str(args.path) || '.';
      const count = n(r.count);
      return {
        Icon: FolderOpen,
        value: shortenPath(path),
        title: path,
        hint: done && count != null ? `${count} ${count === 1 ? 'entry' : 'entries'}` : undefined,
      };
    }
    case 'glob': {
      const count = n(r.count);
      return {
        Icon: FileSearch,
        value: str(args.pattern),
        title: str(args.pattern),
        hint: done && count != null ? `${count} ${count === 1 ? 'file' : 'files'}` : undefined,
      };
    }
    case 'grep': {
      const count = n(r.count);
      return {
        Icon: Search,
        value: quote(str(args.pattern)),
        title: str(args.pattern),
        hint: done && count != null ? `${count} ${count === 1 ? 'match' : 'matches'}` : undefined,
      };
    }
    case 'web_search': {
      const count = n(r.count);
      return {
        Icon: Search,
        value: quote(str(args.query)),
        title: str(args.query),
        hint: done && count != null ? `${count} ${count === 1 ? 'result' : 'results'}` : undefined,
      };
    }
    case 'webfetch': {
      const url = str(args.url);
      let host = url;
      try {
        host = new URL(url).host + new URL(url).pathname.replace(/\/$/, '');
      } catch {
        /* keep raw */
      }
      const hint = done
        ? r.binary
          ? str(r.resource_id) || 'binary'
          : r.reduced
            ? 'reduced'
            : undefined
        : undefined;
      return { Icon: Globe, value: truncate(host, 44), title: url, hint };
    }
    case 'remember': {
      const content = str(args.content);
      return { Icon: Brain, value: quote(content, 44), title: content };
    }
    case 'visual_click': {
      return { Icon: MousePointerClick, value: quote(str(args.target), 44), title: str(args.target) };
    }
    case 'ask_agent':
    case 'annuaire': {
      const v = str(args.agent);
      return { Icon: BookUser, value: v, title: v };
    }
    case 'guide': {
      const topic = str(args.topic);
      return { Icon: BookOpen, value: topic || 'index', title: topic || 'guide index' };
    }
    case 'data': {
      const act = str(args.action);
      const handle = str(args.handle);
      const path = str(args.path);
      let value = act;
      if (act === 'save') value = `${handle} → ${shortenPath(path)}`.trim();
      else if (act === 'store') value = path ? shortenPath(path) : 'store';
      const count = n(r.count);
      return {
        Icon: Database,
        value,
        title: path || handle || act,
        hint: done && act === 'list' && count != null ? `${count} item${count === 1 ? '' : 's'}` : str(r.handle) || undefined,
      };
    }
    case 'set_agent_parameter': {
      const key = str(args.key ?? args.name);
      return { Icon: Settings2, value: key, title: key };
    }
    case 'schedule_task': {
      return { Icon: CalendarClock, value: truncate(str(args.query ?? args.prompt), 44) };
    }
    case 'analyze_image':
    case 'visual_screenshot': {
      return { Icon: Eye, value: quote(str(args.question), 44), title: str(args.question) };
    }
    default: {
      // Unknown skill/tool: surface the first recognisable argument.
      for (const key of ['filePath', 'path', 'url', 'query', 'pattern', 'target', 'name', 'content']) {
        const v = str((args as Args)[key]);
        if (v) {
          const isPath = key === 'filePath' || key === 'path';
          return { Icon: Wrench, value: isPath ? shortenPath(v) : truncate(v, 44), title: v };
        }
      }
      return { Icon: Wrench, value: '' };
    }
  }
}
