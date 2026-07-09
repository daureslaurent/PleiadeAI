import { useState, type FormEvent } from 'react';
import { login } from '../lib/api';
import { useAuth } from '../store/auth';

/** Secure lock screen validating the operator credential and storing the JWT (spec §1). */
export function AuthGuard() {
  const setToken = useAuth((s) => s.setToken);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setToken(await login(username, password));
    } catch {
      setError('Invalid credentials');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={onSubmit}
        className="w-80 space-y-4 rounded-lg border border-border bg-surface p-6"
      >
        <h1 className="font-mono text-lg font-bold text-accent">PleiadesAI Command Center</h1>
        <input
          className="w-full rounded border border-border bg-panel px-3 py-2 text-sm"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="w-full rounded border border-border bg-panel px-3 py-2 text-sm"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          disabled={busy}
          className="w-full rounded bg-accent py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Authenticating…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
