import { useCallback, useEffect, useState } from 'react';
import { Send, Settings2 } from 'lucide-react';
import { settingsApi, telegramApi, type TelegramStatus } from '../../lib/api';
import { Button, Chip, Dot, Field, Hint, Input, Section } from '../../components/ui';

/**
 * Telegram alert channel card: effective status (bot identity via getMe, target chats, interactive
 * polling) plus the inline config form. Config is DB-backed on the settings singleton
 * (`telegram_bot_token` / `telegram_chat_ids`, env as fallback) — saving restarts the bot
 * server-side, no redeploy.
 */
export function TelegramPanel() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [chatIds, setChatIds] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(() => {
    telegramApi.status().then(setStatus).catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  async function openEditor() {
    // Prefill from the effective settings (operator session — token is returned in plaintext,
    // same policy as the other credentials forms).
    const s = await settingsApi.get();
    setToken(s.telegram_bot_token);
    setChatIds(s.telegram_chat_ids);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setFeedback(null);
    try {
      await settingsApi.update({
        telegram_bot_token: token.trim(),
        telegram_chat_ids: chatIds.trim(),
      });
      setEditing(false);
      // The server re-probes getMe on /status; small delay so the restart settles first.
      setTimeout(refresh, 800);
    } catch {
      setFeedback({ ok: false, text: 'failed to save Telegram settings' });
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setFeedback(null);
    try {
      const r = await telegramApi.test();
      setFeedback({ ok: true, text: `test sent to ${r.targets.length} chat${r.targets.length === 1 ? '' : 's'}` });
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setFeedback({ ok: false, text: e.response?.data?.error ?? 'test send failed' });
    } finally {
      setTesting(false);
    }
  }

  const tone = !status?.configured
    ? ('idle' as const)
    : status.bot
      ? ('ok' as const)
      : ('error' as const);
  const stateLabel = !status?.configured
    ? 'not configured'
    : status.bot
      ? (status.bot.username ? `@${status.bot.username}` : 'connected')
      : 'token invalid / unreachable';

  return (
    <Section
      title="Telegram"
      icon={<Send size={13} />}
      right={
        <button
          onClick={() => (editing ? setEditing(false) : void openEditor())}
          title="Configure"
          className={`rounded-md p-1 transition-colors hover:bg-white/[0.06] ${
            editing ? 'text-accent' : 'text-slate-500 hover:text-slate-200'
          }`}
        >
          <Settings2 size={13} />
        </button>
      }
    >
      <div className="flex items-center gap-2 text-xs">
        <Dot tone={tone} />
        <span className={`font-mono ${tone === 'ok' ? 'text-slate-200' : 'text-slate-500'}`}>
          {status ? stateLabel : '…'}
        </span>
        {status && status.targets.length > 0 && (
          <Chip className="normal-case">{status.targets.length} chat{status.targets.length === 1 ? '' : 's'}</Chip>
        )}
        {status && (
          <Chip className={`ml-auto normal-case ${status.running ? 'text-emerald-400' : ''}`}>
            bot {status.running ? 'live' : status.polling ? 'starting' : 'alerts only'}
          </Chip>
        )}
      </div>

      {editing && (
        <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
          <Field
            label="Bot token"
            hint={<>Create a bot with <span className="font-mono">@BotFather</span> and paste its token.</>}
          >
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456:ABC-…"
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <Field
            label="Chat ids"
            hint="Comma-separated. These chats receive alerts and may talk to the bot; get yours from @userinfobot."
          >
            <Input
              value={chatIds}
              onChange={(e) => setChatIds(e.target.value)}
              placeholder="123456789, -100987654321"
              className="font-mono"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      )}

      {!editing && (
        <div className="mt-3 flex items-center gap-2">
          <Button
            variant="accentSoft"
            icon={<Send size={12} />}
            loading={testing}
            disabled={!status?.configured || status.targets.length === 0}
            onClick={sendTest}
          >
            Send test
          </Button>
          {status?.configured && status.targets.length === 0 && (
            <Hint>add at least one chat id to receive alerts</Hint>
          )}
        </div>
      )}

      {feedback && (
        <p className={`mt-2 text-[11px] ${feedback.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {feedback.text}
        </p>
      )}
    </Section>
  );
}
