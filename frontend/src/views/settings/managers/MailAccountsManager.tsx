import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Mail, Plus, Trash2 } from 'lucide-react';
import { Button, Callout, Dot, Row, useConfirm } from '../../../components/ui';
import { mailApi, type MailAccount } from '../../../lib/api';
import { useSettings } from '../context';

/**
 * Linked Gmail mailboxes (Settings → Connections). "Connect" starts the OAuth dance: the backend
 * hands us Google's consent URL and the browser navigates away; Google then redirects back to
 * `/settings/connections?mail=linked|error`, which this component consumes as a one-shot banner.
 * Tokens never reach the browser — the list is address + status only.
 */
export function MailAccountsManager() {
  const { mailAccounts: accounts, reloadMailAccounts: reload } = useSettings();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<string | null>(null);

  // Consume the OAuth callback's outcome from the query string exactly once.
  useEffect(() => {
    const outcome = params.get('mail');
    if (!outcome) return;
    if (outcome === 'linked') setLinked(params.get('email') ?? '');
    else setError(params.get('reason') || 'linking failed');
    setParams({}, { replace: true });
    void reload();
  }, [params, setParams, reload]);

  async function connect() {
    setError(null);
    setConnecting(true);
    try {
      const { url } = await mailApi.oauthStart();
      window.location.href = url;
    } catch (err) {
      const detail = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(detail ?? 'Could not start the link flow.');
      setConnecting(false);
    }
  }

  async function unlink(account: MailAccount) {
    const ok = await confirm({
      title: `Unlink “${account.email}”?`,
      body: 'Agents granted this mailbox lose access immediately. The Google account itself is untouched.',
      danger: true,
    });
    if (!ok) return;
    await mailApi.remove(account._id);
    await reload();
  }

  return (
    <div className="space-y-3">
      {linked !== null && (
        <Callout tone="info">
          Linked <span className="font-mono">{linked}</span>. Grant it to agents on the Agents page.
        </Callout>
      )}
      {error && <Callout tone="error">{error}</Callout>}

      {accounts.map((a) => (
        <Row key={a._id} className="flex items-center gap-3 p-3">
          <Dot tone={a.status === 'linked' ? 'ok' : 'error'} title={a.status} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm text-slate-200">{a.email}</div>
            <div className="text-[11px] text-slate-500">
              {a.status === 'error' ? (
                <span className="text-red-400">{a.last_error || 'authentication failed'} — re-connect to fix</span>
              ) : (
                'read-only (gmail.readonly)'
              )}
            </div>
          </div>
          <Button variant="danger" onClick={() => void unlink(a)} title="Unlink mailbox" className="px-2">
            <Trash2 size={13} />
          </Button>
        </Row>
      ))}

      {accounts.length === 0 && (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <Mail size={12} /> No mailbox linked yet.
        </p>
      )}

      <button
        onClick={() => void connect()}
        disabled={connecting}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/[0.12] py-2 text-xs text-slate-400 transition-colors hover:border-white/25 hover:text-slate-200 disabled:opacity-50"
      >
        <Plus size={14} /> {connecting ? 'Opening Google consent…' : 'Connect a Google account'}
      </button>
    </div>
  );
}
