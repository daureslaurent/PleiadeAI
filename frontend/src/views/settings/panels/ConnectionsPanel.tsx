import { useState } from 'react';
import { Check, Copy, KeySquare, Mail } from 'lucide-react';
import { Section } from '../../../components/ui';
import { SettingText } from '../controls';
import { MailAccountsManager } from '../managers/MailAccountsManager';
import { useSettings } from '../context';

/**
 * `/settings/connections` — external services agents can reach. For now: Gmail, read-only.
 * One-time setup: create an OAuth client in the Google Cloud console (type "Web application"),
 * register the redirect URI shown here, paste the client ID/secret, then link mailboxes below.
 */
export function ConnectionsPanel() {
  return (
    <div className="animate-fade-up space-y-5">
      <Section title="Google OAuth client" icon={<KeySquare size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Linking a mailbox needs a Google Cloud OAuth client (APIs &amp; Services → Credentials →
          “Web application”, with the Gmail API enabled). Access is requested with the read-only
          <span className="font-mono"> gmail.readonly</span> scope — agents can never send, delete,
          or mark mail as read.
        </p>
        <div className="space-y-4">
          <SettingText
            field="public_base_url"
            label="Public base URL"
            placeholder="https://pleiades.example.com"
            hint="How your browser reaches this instance — the redirect URI below is derived from it."
          />
          <RedirectUri />
          <SettingText
            field="google_client_id"
            label="Client ID"
            placeholder="1234567890-abc.apps.googleusercontent.com"
          />
          <SettingText
            field="google_client_secret"
            label="Client secret"
            password
            hint="Stored in this instance's settings; scrubbed from API-key responses."
          />
        </div>
      </Section>

      <Section title="Linked mailboxes" icon={<Mail size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Each linked account becomes a mailbox you can grant to agents on the Agents page; granted
          agents read it with the <span className="font-mono">list_mail</span> /{' '}
          <span className="font-mono">read_mail</span> tools. Reading never marks messages as read
          in the origin mailbox.
        </p>
        <MailAccountsManager />
      </Section>
    </div>
  );
}

/** The exact redirect URI to register on the OAuth client, with one-click copy. */
function RedirectUri() {
  const { form } = useSettings();
  const [copied, setCopied] = useState(false);
  const base = form.public_base_url.trim().replace(/\/+$/, '');
  if (!base) return null;
  const uri = `${base}/api/mail/oauth/callback`;

  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
        Authorized redirect URI — register this on the OAuth client
      </div>
      <div className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">{uri}</code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(uri);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 text-slate-500 transition-colors hover:text-slate-200"
          title="Copy"
        >
          {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}
