import { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { Callout, Hint, Section, Select, Spinner, Toggle } from '../../components/ui';
import { gitApi, type GitAccess, type GitIdentity, type GitPermission } from '../../lib/api';
import { errText } from './gitBits';

/**
 * Who can do what on one repo. Read for the whole fleet is a single switch (membership of the repo in
 * the fleet team); write — and read on a repo the fleet can't see — is a grant per agent. Granting an
 * agent that has no git account yet creates the account.
 */
export function AccessTab({ repo }: { repo: string }) {
  const [access, setAccess] = useState<GitAccess | null>(null);
  const [agents, setAgents] = useState<GitIdentity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, ids] = await Promise.all([gitApi.access(repo), gitApi.identities()]);
      setAccess(a);
      setAgents(ids);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [repo]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (key: string, body: Parameters<typeof gitApi.setAccess>[1]) => {
    setBusy(key);
    try {
      setAccess(await gitApi.setAccess(repo, body));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!access) return error ? <Callout tone="error">{error}</Callout> : <Spinner />;

  const byAgent = new Map(access.agents.map((a) => [a.agent_id, a]));

  return (
    <div className="flex flex-col gap-3">
      {error && <Callout tone="error">{error}</Callout>}
      <Section title="Fleet">
        <div className="flex items-center gap-3">
          <Toggle
            checked={access.fleet_readable}
            disabled={busy === 'fleet'}
            onChange={(v) => void apply('fleet', { fleet_readable: v })}
          />
          <div>
            <div className="text-sm text-slate-200">Every agent can read this repo</div>
            <Hint>Off makes it private to the agents granted below.</Hint>
          </div>
        </div>
      </Section>

      <Section title="Agents" icon={<Users size={12} />}>
        <div className="divide-y divide-hairline overflow-hidden rounded-xl border hairline well">
          {[...agents].sort((a, b) => Number(b.reachable) - Number(a.reachable)).map((agent) => {
            const current = byAgent.get(agent.agent_id);
            const permission: GitPermission = current?.permission ?? (access.fleet_readable && agent.username ? 'read' : 'none');
            const explicit = current?.explicit ?? false;
            return (
              <div key={agent.agent_id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-200">{agent.agent_name}</div>
                  <div className="truncate font-mono text-[11px] text-slate-500">
                    {agent.username ?? 'no git account yet'}
                    {!agent.reachable && <span className="ml-2 font-sans text-amber-400/80">· can't reach git from its environment</span>}
                  </div>
                </div>
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-slate-600">
                  {explicit ? 'granted' : permission === 'read' ? 'via fleet' : ''}
                </span>
                <Select
                  className="!w-28 !py-1 text-xs"
                  value={explicit ? permission : 'default'}
                  disabled={busy === agent.agent_id}
                  onChange={(e) => {
                    const v = e.target.value;
                    void apply(agent.agent_id, { agent_id: agent.agent_id, permission: v === 'default' ? 'none' : (v as GitPermission) });
                  }}
                >
                  <option value="default">{!agent.username ? 'no account' : access.fleet_readable ? 'fleet (read)' : 'no access'}</option>
                  <option value="read">read</option>
                  <option value="write">write</option>
                </Select>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
