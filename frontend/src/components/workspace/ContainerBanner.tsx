import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Box, Hammer, Loader2, Play } from 'lucide-react';
import { agentsApi, type Agent, type AgentContainerStatus } from '../../lib/api';

/** Re-poll cadence while an isolated agent's chat is open (matches IsolationPanel's usage strip). */
const POLL_MS = 4000;

/** Read the `error` code off an axios error without pulling axios types in. */
function errCode(e: unknown): string | null {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? null;
}

interface Props {
  agent: Agent | null;
}

/**
 * Chat-header warning strip for isolated agents (spec §"Per-agent Docker isolation"). When the
 * active agent is assigned an isolation profile but its container can't service tool calls, warn the
 * operator *before* they hit a cold-start delay or a hard tool failure:
 *
 *  - image not built (`image_status` ≠ `built`) → **hard** red warning: tools will fail with
 *    `IsolationNotReadyError` until the image is built on the Isolation page.
 *  - image built but container not running → **soft** amber notice: the container auto-starts on the
 *    next tool call, but the operator can pre-warm it here to skip the cold start.
 *
 * Polls the per-agent container endpoint so the banner appears/clears live as the container starts,
 * stops (idle auto-stop), or an image finishes building. Renders nothing when all is well.
 */
export function ContainerBanner({ agent }: Props) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<AgentContainerStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const agentId = agent?._id ?? null;

  const load = useCallback(async () => {
    if (!agentId) return;
    try {
      setStatus(await agentsApi.container(agentId));
    } catch {
      setStatus(null);
    }
  }, [agentId]);

  // Poll while an isolated agent is active; reset immediately on agent switch so a stale banner from
  // the previous agent never lingers.
  useEffect(() => {
    setStatus(null);
    if (!agentId) return;
    let alive = true;
    const tick = () => {
      if (alive) void load();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [agentId, load]);

  if (!agent || !status || !status.isolation_id) return null;

  const built = status.image_status === 'built';
  const running = status.container_state === 'running';
  if (built && running) return null;

  async function start() {
    if (!agent) return;
    setStarting(true);
    try {
      await agentsApi.startContainer(agent._id);
    } catch (e) {
      // Image vanished/never built between poll and click → the next load surfaces the hard banner.
      if (errCode(e) !== 'not_ready') {
        /* transient docker error — the poll will re-reflect true state */
      }
    } finally {
      setStarting(false);
      await load();
    }
  }

  // Image still building: transient, nothing the operator can do but wait — soft amber with a spinner.
  if (status.image_status === 'building') {
    return (
      <Strip tone="amber">
        <Loader2 size={14} className="shrink-0 animate-spin text-amber-400" />
        <Text tone="amber">
          <b className="font-semibold">Building container image…</b> {agent.name}’s tools will run
          once the <span className="text-amber-200">{status.isolation_name}</span> image finishes.
        </Text>
      </Strip>
    );
  }

  // Image not built (none / error) → hard blocker: tool calls will fail until it's built.
  if (!built) {
    const errored = status.image_status === 'error';
    return (
      <Strip tone="red">
        <AlertTriangle size={14} className="shrink-0 text-red-400" />
        <Text tone="red">
          <b className="font-semibold">
            {errored ? 'Container image build failed' : 'No container image built'}
          </b>{' '}
          — {agent.name} can’t run tools until its{' '}
          <span className="text-red-200">{status.isolation_name}</span> image is built.
        </Text>
        <Action tone="red" icon={Hammer} onClick={() => navigate('/isolation')}>
          {errored ? 'Rebuild' : 'Build image'}
        </Action>
      </Strip>
    );
  }

  // Image built but container stopped → soft: it auto-starts on the next tool call, but pre-warming
  // skips the cold start.
  return (
    <Strip tone="amber">
      <Box size={14} className="shrink-0 text-amber-400" />
      <Text tone="amber">
        <b className="font-semibold">Container stopped</b> — {agent.name}’s isolated container will
        cold-start on its next action. Start it now to skip the delay.
      </Text>
      <Action tone="amber" icon={Play} busy={starting} onClick={start}>
        Start
      </Action>
    </Strip>
  );
}

/* ---------------------------------------------------------------- pieces ---- */

type Tone = 'amber' | 'red';

function Strip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const cls =
    tone === 'red'
      ? 'border-red-900/60 bg-red-950/30'
      : 'border-amber-900/60 bg-amber-950/25';
  return (
    <div className={`flex items-center gap-2.5 border-b px-4 py-2 ${cls}`} role="status">
      {children}
    </div>
  );
}

function Text({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const cls = tone === 'red' ? 'text-red-300/90' : 'text-amber-300/90';
  return <p className={`min-w-0 flex-1 text-[11px] leading-relaxed ${cls}`}>{children}</p>;
}

function Action({
  tone,
  icon: Icon,
  busy,
  onClick,
  children,
}: {
  tone: Tone;
  icon: typeof Play;
  busy?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const cls =
    tone === 'red'
      ? 'border-red-800 text-red-200 hover:bg-red-950'
      : 'border-amber-800 text-amber-200 hover:bg-amber-950';
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${cls}`}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />} {children}
    </button>
  );
}
