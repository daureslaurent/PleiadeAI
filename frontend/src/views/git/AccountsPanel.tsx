import { useCallback, useEffect, useState } from 'react';
import { KeyRound, RefreshCw, UserPlus } from 'lucide-react';
import { Button, Callout, Dot, Hint, Section, Spinner, useConfirm } from '../../components/ui';
import { gitApi, type GitIdentity } from '../../lib/api';
import { errText, relativeTime } from './gitBits';

/** Why an agent has no route to git, in the operator's terms (the backend's reason is written to the agent). */
function unreachableLabel(network: string | null): string {
  if (!network) return 'No isolation profile — its tools run on the backend, which has no route to git.';
  if (network === 'none') return 'Its isolation profile is offline (network: none).';
  if (network === 'ssh') return 'Its commands run on a remote host over SSH, outside the git network.';
  return `Network mode "${network}" has no route to the git server.`;
}

/**
 * One git account per agent. Accounts are made on an isolated agent's first run anyway; this page is
 * for seeing where each agent stands — whether its environment can reach the server at all, and on
 * which URL — and for making or re-keying an account by hand.
 */
export function AccountsPanel() {
  const confirm = useConfirm();
  const [rows, setRows] = useState<GitIdentity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await gitApi.identities());
      setError(null);
    } catch (e) {
      setError(errText(e));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (agentId: string, fn: (id: string) => Promise<unknown>) => {
    setBusy(agentId);
    try {
      await fn(agentId);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!rows) return <Spinner />;

  return (
    <div className="flex flex-col gap-3">
      {error && <Callout tone="error">{error}</Callout>}
      <Section title="Agent accounts" icon={<KeyRound size={12} />} right={<Button icon={<RefreshCw size={12} />} onClick={() => void load()}>Refresh</Button>}>
        <Hint>
          Credentials are planted into the agent&apos;s own container (never shown here). Rotating a token revokes the old
          one; the container picks up the new one on the agent&apos;s next tool call.
        </Hint>
        <div className="mt-3 divide-y divide-hairline overflow-hidden rounded-xl border hairline well">
          {rows.map((r) => (
            <div key={r.agent_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Dot tone={r.reachable ? 'ok' : 'idle'} title={r.reachable ? 'can reach git' : 'cannot reach git'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-slate-200">{r.agent_name}</span>
                  {r.network && (
                    <span className="rounded raise-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-500">{r.network}</span>
                  )}
                </div>
                <div className="truncate text-[11px] text-slate-500">
                  {r.reachable ? <span className="font-mono">{r.url}</span> : unreachableLabel(r.network)}
                </div>
              </div>
              <div className="min-w-[10rem] text-right">
                <div className="truncate font-mono text-[11px] text-slate-300">{r.username ?? '—'}</div>
                <div className="text-[10px] text-slate-600">
                  {r.provisioned_at ? `token ${relativeTime(r.provisioned_at)}` : 'no account'}
                </div>
              </div>
              {r.username ? (
                <Button
                  icon={<RefreshCw size={12} />}
                  loading={busy === r.agent_id}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Rotate ${r.agent_name}'s git token?`,
                      body: 'The current token stops working at once; the agent gets the new one on its next tool call.',
                      confirmLabel: 'Rotate',
                    });
                    if (ok) await act(r.agent_id, gitApi.rotate);
                  }}
                >
                  Rotate token
                </Button>
              ) : !r.reachable ? null : (
                <Button icon={<UserPlus size={12} />} loading={busy === r.agent_id} onClick={() => void act(r.agent_id, gitApi.provision)}>
                  Create account
                </Button>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
