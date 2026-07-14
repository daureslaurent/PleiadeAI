// Seed a curated pack of general-purpose skills (spec §3 dynamic skills).
// Idempotent: existing skills (matched by name) are updated in place, new ones created.
// Usage: node scripts/seed-skills.mjs  (targets API_URL, default http://localhost:4000)
const API = process.env.API_URL || 'http://localhost:4000';
const USER = process.env.AUTH_USERNAME || 'admin';
const PASS = process.env.AUTH_PASSWORD || 'change-me';

// ---------------------------------------------------------------------------
// Skill sources. Python skills define a top-level `run(args)`; TS skills export
// a default async function. Both must return a JSON-serialisable value.
// ---------------------------------------------------------------------------

const CALC_PY = `
import ast
import math
import statistics

_ALLOWED_FUNCS = {
    name: getattr(math, name)
    for name in (
        "sqrt", "log", "log2", "log10", "exp", "sin", "cos", "tan", "asin", "acos",
        "atan", "atan2", "floor", "ceil", "factorial", "gcd", "lcm", "degrees",
        "radians", "hypot", "fabs", "pow", "trunc",
    )
}
_ALLOWED_FUNCS.update({
    "abs": abs, "round": round, "min": min, "max": max, "sum": sum, "len": len,
    "mean": statistics.mean, "median": statistics.median, "stdev": statistics.stdev,
    "variance": statistics.variance,
})
_ALLOWED_NAMES = {"pi": math.pi, "e": math.e, "tau": math.tau, "inf": math.inf}

_ALLOWED_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Call, ast.Constant, ast.Name,
    ast.List, ast.Tuple, ast.Load, ast.Add, ast.Sub, ast.Mult, ast.Div,
    ast.FloorDiv, ast.Mod, ast.Pow, ast.USub, ast.UAdd, ast.Compare,
    ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Eq, ast.NotEq,
)


def _check(node):
    if not isinstance(node, _ALLOWED_NODES):
        raise ValueError(f"disallowed syntax: {type(node).__name__}")
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _ALLOWED_FUNCS:
            raise ValueError("only whitelisted math/statistics functions may be called")
    if isinstance(node, ast.Name) and node.id not in _ALLOWED_FUNCS and node.id not in _ALLOWED_NAMES:
        raise ValueError(f"unknown name: {node.id}")
    if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float, complex)):
        raise ValueError("only numeric constants allowed")
    for child in ast.iter_child_nodes(node):
        _check(child)


def run(args):
    expression = str(args.get("expression", "")).strip()
    if not expression:
        return {"ok": False, "error": "expression is required"}
    tree = ast.parse(expression, mode="eval")
    _check(tree)
    value = eval(compile(tree, "<calc>", "eval"), {"__builtins__": {}}, {**_ALLOWED_FUNCS, **_ALLOWED_NAMES})
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return {"expression": expression, "result": str(value)}
    return {"expression": expression, "result": value}
`.trim();

const HTTP_REQUEST_TS = `
interface Args {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_ms?: number;
}

const MAX_BODY_CHARS = 6000;

export default async function run(args: Args) {
  const url = new URL(args.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http/https URLs are allowed');
  }
  const method = (args.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(args.headers ?? {}) };
  let body: string | undefined;
  if (args.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(url, {
    method,
    headers,
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.min(args.timeout_ms ?? 10_000, 12_000)),
  });

  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  let parsed: unknown = null;
  if (contentType.includes('json')) {
    try { parsed = JSON.parse(text); } catch { /* fall through to raw text */ }
  }

  return {
    status: res.status,
    ok: res.ok,
    content_type: contentType,
    body: parsed ?? text.slice(0, MAX_BODY_CHARS),
    truncated: parsed === null && text.length > MAX_BODY_CHARS,
  };
}
`.trim();

const WEATHER_PY = `
import json
import urllib.parse
import urllib.request

_WMO = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "depositing rime fog", 51: "light drizzle", 53: "drizzle",
    55: "dense drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "heavy freezing rain", 71: "light snow", 73: "snow",
    75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
    82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "PleiadesAI-skill/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.load(resp)


def run(args):
    location = str(args.get("location", "")).strip()
    if not location:
        return {"ok": False, "error": "location is required"}
    days = max(1, min(int(args.get("days", 3)), 7))

    geo = _get(
        "https://geocoding-api.open-meteo.com/v1/search?"
        + urllib.parse.urlencode({"name": location, "count": 1, "format": "json"})
    )
    hits = geo.get("results") or []
    if not hits:
        return {"ok": False, "error": f"no location found for {location!r}"}
    place = hits[0]

    fc = _get(
        "https://api.open-meteo.com/v1/forecast?"
        + urllib.parse.urlencode({
            "latitude": place["latitude"],
            "longitude": place["longitude"],
            "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
            "daily": "temperature_2m_min,temperature_2m_max,precipitation_sum,weather_code",
            "forecast_days": days,
            "timezone": "auto",
        })
    )
    cur = fc.get("current", {})
    daily = fc.get("daily", {})
    forecast = [
        {
            "date": daily["time"][i],
            "min_c": daily["temperature_2m_min"][i],
            "max_c": daily["temperature_2m_max"][i],
            "precipitation_mm": daily["precipitation_sum"][i],
            "conditions": _WMO.get(daily["weather_code"][i], "unknown"),
        }
        for i in range(len(daily.get("time", [])))
    ]
    return {
        "location": {
            "name": place.get("name"),
            "country": place.get("country"),
            "timezone": fc.get("timezone"),
        },
        "current": {
            "temperature_c": cur.get("temperature_2m"),
            "humidity_pct": cur.get("relative_humidity_2m"),
            "wind_kmh": cur.get("wind_speed_10m"),
            "conditions": _WMO.get(cur.get("weather_code"), "unknown"),
        },
        "forecast": forecast,
    }
`.trim();

const RSS_READ_PY = `
import urllib.request
import xml.etree.ElementTree as ET

_ATOM = "{http://www.w3.org/2005/Atom}"


def _text(el, *tags):
    for tag in tags:
        found = el.find(tag)
        if found is not None and (found.text or "").strip():
            return found.text.strip()
    return None


def _strip_html(s, limit=300):
    if not s:
        return None
    out, in_tag = [], False
    for ch in s:
        if ch == "<":
            in_tag = True
        elif ch == ">":
            in_tag = False
        elif not in_tag:
            out.append(ch)
    clean = " ".join("".join(out).split())
    return clean[:limit] + ("…" if len(clean) > limit else "")


def run(args):
    url = str(args.get("url", "")).strip()
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "url must be http(s)"}
    limit = max(1, min(int(args.get("limit", 5)), 20))

    req = urllib.request.Request(url, headers={"User-Agent": "PleiadesAI-skill/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        root = ET.fromstring(resp.read())

    items = []
    if root.tag == f"{_ATOM}feed":  # Atom
        feed_title = _text(root, f"{_ATOM}title")
        for entry in root.findall(f"{_ATOM}entry")[:limit]:
            link_el = entry.find(f"{_ATOM}link")
            items.append({
                "title": _text(entry, f"{_ATOM}title"),
                "link": link_el.get("href") if link_el is not None else None,
                "published": _text(entry, f"{_ATOM}published", f"{_ATOM}updated"),
                "summary": _strip_html(_text(entry, f"{_ATOM}summary", f"{_ATOM}content")),
            })
    else:  # RSS 2.0
        channel = root.find("channel")
        if channel is None:
            return {"ok": False, "error": "not a recognised RSS/Atom feed"}
        feed_title = _text(channel, "title")
        for item in channel.findall("item")[:limit]:
            items.append({
                "title": _text(item, "title"),
                "link": _text(item, "link"),
                "published": _text(item, "pubDate"),
                "summary": _strip_html(_text(item, "description")),
            })

    return {"feed": feed_title, "count": len(items), "items": items}
`.trim();

const DATETIME_PY = `
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def _parse(value, tz):
    dt = datetime.fromisoformat(str(value))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(tz) if tz else timezone.utc)
    return dt


def run(args):
    op = args.get("operation", "now")

    if op == "now":
        tz = args.get("timezone", "UTC")
        now = datetime.now(ZoneInfo(tz))
        return {
            "timezone": tz,
            "iso": now.isoformat(),
            "human": now.strftime("%A %d %B %Y, %H:%M:%S"),
            "unix": int(now.timestamp()),
        }

    if op == "convert":
        if not args.get("datetime") or not args.get("to_timezone"):
            return {"ok": False, "error": "convert needs 'datetime' and 'to_timezone'"}
        dt = _parse(args["datetime"], args.get("from_timezone"))
        out = dt.astimezone(ZoneInfo(args["to_timezone"]))
        return {"input": dt.isoformat(), "converted": out.isoformat(),
                "human": out.strftime("%A %d %B %Y, %H:%M:%S %Z")}

    if op == "diff":
        if not args.get("start") or not args.get("end"):
            return {"ok": False, "error": "diff needs 'start' and 'end'"}
        delta = _parse(args["end"], args.get("from_timezone")) - _parse(args["start"], args.get("from_timezone"))
        total = int(delta.total_seconds())
        sign = "-" if total < 0 else ""
        total = abs(total)
        return {
            "total_seconds": int(delta.total_seconds()),
            "human": f"{sign}{total // 86400}d {total % 86400 // 3600}h {total % 3600 // 60}m {total % 60}s",
        }

    return {"ok": False, "error": f"unknown operation {op!r} (use now | convert | diff)"}
`.trim();

// ---------------------------------------------------------------------------

const SKILLS = [
  {
    name: 'calc',
    description:
      'Exact calculator: evaluates a math expression (arithmetic, sqrt/log/trig, mean/median/stdev over lists). Use instead of doing arithmetic yourself. Example: "mean([3, 5, 8]) * sqrt(2)".',
    language: 'py',
    source: CALC_PY,
    parameters_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression, e.g. "(1500 * 1.21) / 12" or "stdev([2,4,4,4,5,5,7,9])"' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'http_request',
    description:
      'Call any HTTP/REST API: choose method, headers and JSON body; returns status and parsed response. Use for APIs and webhooks (POST/PUT/DELETE) — use webfetch for reading web pages.',
    language: 'ts',
    source: HTTP_REQUEST_TS,
    parameters_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method, default GET' },
        headers: { type: 'object', description: 'Extra request headers, e.g. {"Authorization": "Bearer …"}' },
        body: { description: 'Request body: an object is sent as JSON, a string as-is' },
        timeout_ms: { type: 'number', description: 'Request timeout in ms (max 12000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'weather',
    description:
      'Current weather and a 1–7 day forecast for any city (Open-Meteo, no API key). Returns temperature, humidity, wind, conditions and daily min/max/precipitation.',
    language: 'py',
    source: WEATHER_PY,
    parameters_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name, e.g. "Paris" or "Lyon, France"' },
        days: { type: 'number', description: 'Forecast days 1–7, default 3' },
      },
      required: ['location'],
    },
  },
  {
    name: 'rss_read',
    description:
      'Fetch an RSS or Atom feed and return the latest items (title, link, date, summary). Ideal for scheduled news/blog digests.',
    language: 'py',
    source: RSS_READ_PY,
    parameters_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Feed URL, e.g. https://hnrss.org/frontpage' },
        limit: { type: 'number', description: 'Max items 1–20, default 5' },
      },
      required: ['url'],
    },
  },
  {
    name: 'datetime_tool',
    description:
      'Reliable date/time utility: current time in any IANA timezone ("now"), convert a datetime between timezones ("convert"), or compute the exact duration between two datetimes ("diff").',
    language: 'py',
    source: DATETIME_PY,
    parameters_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['now', 'convert', 'diff'], description: 'What to do' },
        timezone: { type: 'string', description: 'IANA timezone for "now", e.g. Europe/Paris' },
        datetime: { type: 'string', description: 'ISO datetime for "convert"' },
        from_timezone: { type: 'string', description: 'Timezone of naive input datetimes (default UTC)' },
        to_timezone: { type: 'string', description: 'Target timezone for "convert"' },
        start: { type: 'string', description: 'ISO start datetime for "diff"' },
        end: { type: 'string', description: 'ISO end datetime for "diff"' },
      },
      required: ['operation'],
    },
  },
];

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { token } = await login.json();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const existing = await (await fetch(`${API}/api/skills`, { headers: auth })).json();
  const byName = new Map(existing.map((s) => [s.name, s]));

  for (const skill of SKILLS) {
    const prev = byName.get(skill.name);
    const res = prev
      ? await fetch(`${API}/api/skills/${prev._id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ ...skill, enabled: true, disabled_reason: null, failure_count: 0 }) })
      : await fetch(`${API}/api/skills`, { method: 'POST', headers: auth, body: JSON.stringify({ ...skill, enabled: true }) });
    console.log(`${prev ? 'updated' : 'created'} ${skill.name} → ${res.status}`);
    if (!res.ok) console.error(await res.text());
  }
  console.log('skill seed complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
