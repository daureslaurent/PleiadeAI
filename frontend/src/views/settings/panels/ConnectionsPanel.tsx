import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Copy, KeySquare, Loader2, Mail, Smartphone, Wand2 } from 'lucide-react';
import { Section } from '../../../components/ui';
import { mediaApi, type ComfyStatus } from '../../../lib/api';
import { SettingNumber, SettingText } from '../controls';
import { MailAccountsManager } from '../managers/MailAccountsManager';
import { AndroidDevicesManager } from '../managers/AndroidDevicesManager';
import { useSettings } from '../context';

/**
 * `/settings/connections` — external services agents can reach: Gmail (read-only) and Android
 * devices. Gmail's one-time setup: create an OAuth client in the Google Cloud console (type "Web
 * application"), register the redirect URI shown here, paste the client ID/secret, then link
 * mailboxes. Android needs no credential — just an adb address the agent containers can route to.
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

      <Section title="ComfyUI server" icon={<Wand2 size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          The media tools — <span className="font-mono">generate_image</span>,{' '}
          <span className="font-mono">generate_video</span>,{' '}
          <span className="font-mono">generate_sound</span> and{' '}
          <span className="font-mono">edit_image</span> — render on a ComfyUI server started with{' '}
          <span className="font-mono">--listen</span>. Point at it here, then import the workflows each
          tool should run on the <Link to="/media" className="text-accent hover:underline">Media page</Link>.
        </p>
        <div className="space-y-4">
          <SettingText
            field="comfy_url"
            label="Base URL"
            placeholder="http://192.168.1.23:8188"
            hint="No trailing slash and no /api — the backend appends the routes itself."
          />
          <ComfyProbe />
          <SettingNumber
            field="comfy_queue_max"
            label="Max queue depth"
            hint="Refuse a job when ComfyUI already has this many queued. It runs one at a time, so joining a deep queue blocks the agent for everything ahead of it. 0 disables the check."
          />
        </div>
      </Section>

      <Section title="Android devices" icon={<Smartphone size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Emulators and phones reachable over adb TCP/IP. Link one to an agent on the Agents page and
          it gains the <span className="font-mono">android_*</span> tools and a live screen in the
          Workspace. The agent also needs an isolation profile whose image has the Android layer —
          that is where <span className="font-mono">adb</span> runs, which is also why the address
          below must be reachable from the <em>agent’s container</em>, not from your browser.
        </p>
        <AndroidDevicesManager />
      </Section>
    </div>
  );
}

/** GB with one decimal — VRAM figures are the reason this panel is worth looking at twice. */
function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)}GB`;
}

/**
 * On-demand connection probe. Reports the version, the queue depth and **free VRAM per GPU** —
 * the last one matters because a card shared with the inference server is what makes a render fail
 * halfway through with an out-of-memory error.
 */
function ComfyProbe() {
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const probe = async () => {
    setBusy(true);
    try {
      setStatus(await mediaApi.status());
    } catch {
      setStatus({ ok: false, error: 'Could not reach the backend.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={probe}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg bg-white/[0.05] px-3 py-1.5 text-xs text-slate-200 hover:bg-white/[0.09] disabled:opacity-50"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
        Test connection
      </button>

      {status && !status.ok && (
        <div className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {status.error}
        </div>
      )}

      {status?.ok && (
        <div className="space-y-1 rounded-lg bg-black/25 px-3 py-2 text-[11px] text-slate-400">
          <div>
            <span className="text-emerald-400">Connected</span> — ComfyUI{' '}
            <span className="font-mono text-slate-300">{status.version}</span>, queue{' '}
            <span className="font-mono text-slate-300">{status.queue_remaining}</span>
          </div>
          {status.devices?.map((d) => (
            <div key={d.name} className="truncate font-mono text-[10px]">
              {d.name} — {gb(d.vram_free)} free of {gb(d.vram_total)}
            </div>
          ))}
        </div>
      )}
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
