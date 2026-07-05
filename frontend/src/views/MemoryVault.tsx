import { useEffect, useState } from 'react';
import { agentsApi, memoryApi, type Agent } from '../lib/api';

type Point = { id: string | number; payload: Record<string, unknown> };

/**
 * Memory Vault (spec §4): select an agent, inspect its *isolated* Qdrant vector block, and
 * explicitly delete corrupted memories. The namespace is resolved server-side from the agent,
 * so the UI can never cross agent boundaries.
 */
export function MemoryVault() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [points, setPoints] = useState<Point[]>([]);

  useEffect(() => {
    agentsApi.list().then((a) => {
      setAgents(a);
      if (a[0]) setAgentId(a[0]._id);
    });
  }, []);

  useEffect(() => {
    if (agentId) memoryApi.list(agentId).then(setPoints);
  }, [agentId]);

  async function remove(id: string | number) {
    await memoryApi.remove(agentId, [id]);
    setPoints((p) => p.filter((x) => x.id !== id));
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-xs uppercase text-slate-500">Isolated memory</span>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 text-sm"
        >
          {agents.map((a) => (
            <option key={a._id} value={a._id}>
              {a.name} · {a.qdrant_namespace}
            </option>
          ))}
        </select>
      </div>

      <table className="w-full border-collapse text-left text-xs">
        <thead className="text-slate-500">
          <tr>
            <th className="border-b border-border py-1 pr-4">ID</th>
            <th className="border-b border-border py-1 pr-4">Payload</th>
            <th className="border-b border-border py-1" />
          </tr>
        </thead>
        <tbody className="font-mono">
          {points.map((p) => (
            <tr key={String(p.id)}>
              <td className="border-b border-border py-1 pr-4 text-slate-400">{String(p.id)}</td>
              <td className="border-b border-border py-1 pr-4 text-slate-300">
                {JSON.stringify(p.payload)}
              </td>
              <td className="border-b border-border py-1">
                <button onClick={() => remove(p.id)} className="text-red-400 hover:underline">
                  delete
                </button>
              </td>
            </tr>
          ))}
          {!points.length && (
            <tr>
              <td colSpan={3} className="py-4 text-slate-600">
                No vectors in this namespace.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
