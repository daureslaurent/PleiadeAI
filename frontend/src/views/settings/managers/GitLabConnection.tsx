import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Plus, RefreshCcw, Trash2, X } from 'lucide-react';
import {
  agentsApi,
  gitlabApi,
  type Agent,
  type GitLabConnectionInfo,
  type GitLabTestResult,
} from '../../../lib/api';
import { Button, Callout, Checkbox, Field, Hint, Input, Row, Select } from '../../../components/ui';

/**
 * Settings → Connections → GitLab (`GITLAB_PLAN.md` §1).
 *
 * Deliberately not built from the generic `SettingText field=…` controls the rest of the page uses:
 * those write through the settings PUT, and three of these fields are secrets that must be encrypted
 * on the way in and must never be read back. This form posts to `/api/gitlab/connection`, which
 * stores them and answers with presence flags only — so a configured token renders as "configured"
 * and there is no code path that could put it back in a browser.
 *
 * The shape follows what setting this up actually takes, in order: point at the instance, prove the
 * token works (Test fills in the bot username from the answer), decide how much of the instance the
 * fleet may touch, then — optionally — arm the webhook.
 */
export function GitLabConnection() {
  const [form, setForm] = useState<GitLabConnectionInfo | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [token, setToken] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<GitLabTestResult | null>(null);
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void gitlabApi.connection().then(setForm).catch(() => setForm(null));
    void agentsApi.list().then(setAgents).catch(() => setAgents([]));
  }, []);

  if (!form) return <Loader2 size={14} className="animate-spin text-slate-500" />;

  const set = <K extends keyof GitLabConnectionInfo>(key: K, value: GitLabConnectionInfo[K]) => {
    setForm({ ...form, [key]: value });
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      await gitlabApi.saveConnection({
        ...form,
        // Sent only when typed: an untouched field must leave the stored secret alone, which is what
        // lets the form render "configured" without ever having held the value.
        ...(token ? { token } : {}),
        ...(sshKey ? { ssh_key: sshKey } : {}),
      });
      setToken('');
      setSshKey('');
      setForm(await gitlabApi.connection());
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const result = await gitlabApi.test();
      setTest(result);
      // The account the token belongs to is exactly what the webhook router compares assignees
      // against, so offer it rather than making the operator type it a second time.
      if (result.ok && result.suggested_bot_username && !form.bot_username) {
        set('bot_username', result.suggested_bot_username);
      }
    } finally {
      setTesting(false);
    }
  };

  const webhookUrl = `${window.location.origin}/api/gitlab/webhook`;

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <Field
          label="Instance URL"
          hint="The root of your GitLab, with no trailing slash and no /api/v4."
        >
          <Input
            value={form.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://git.lda-dev.com"
          />
        </Field>

        <Field
          label={form.token_set ? 'Access token (configured — type to replace)' : 'Access token'}
          hint={
            <>
              A personal access token with the <span className="font-mono">api</span> scope, on the
              account the whole fleet acts as. Encrypted at rest and never returned to this page.
            </>
          }
        >
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={form.token_set ? '••••••••••••••••' : 'glpat-…'}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button variant="accentSoft" onClick={runTest} loading={testing}>
            Test connection
          </Button>
          {test?.ok && (
            <span className="text-[11px] text-emerald-400">
              Connected as <span className="font-mono">{test.user?.username}</span>
              {test.group ? ` · confined to ${test.group}` : ' · whole instance'}
              {test.reachable_projects === false && ' · but it can see no projects'}
            </span>
          )}
          {test && !test.ok && <span className="text-[11px] text-red-400">{test.error}</span>}
        </div>

        <Field
          label="Group (optional)"
          hint="Confine the fleet to one namespace — every listing, search and project lookup is checked against it, and anything outside is refused. Leave empty for the whole instance."
        >
          <Input value={form.group} onChange={(e) => set('group', e.target.value)} placeholder="lda" />
        </Field>

        <Field
          label="Bot username"
          hint="The token account's own GitLab username. Used to recognise “assigned to us” on a webhook, and to ignore comments the fleet wrote itself."
        >
          <Input
            value={form.bot_username}
            onChange={(e) => set('bot_username', e.target.value)}
            placeholder="pleiades-bot"
          />
        </Field>
      </div>

      <div className="space-y-3 border-t hairline pt-4">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Cloning inside agent containers
        </div>
        <Hint>
          How a checked-out repository authenticates when an agent clones it with{' '}
          <span className="font-mono">gitlab_repo</span>. Either way the credential is written to a
          0600 file inside the container — never an environment variable, never a command line.
        </Hint>
        <Field label="Transport">
          <Select value={form.git_transport} onChange={(e) => set('git_transport', e.target.value as 'https' | 'ssh')}>
            <option value="https">HTTPS — reuse the access token above</option>
            <option value="ssh">SSH — use the private key below</option>
          </Select>
        </Field>
        {form.git_transport === 'ssh' && (
          <>
            <Field
              label={form.ssh_key_set ? 'Private key (configured — paste to replace)' : 'Private key'}
              hint="Add the matching public key to the bot account in GitLab (or as a deploy key on each project). Encrypted at rest."
            >
              <textarea
                value={sshKey}
                onChange={(e) => setSshKey(e.target.value)}
                rows={4}
                placeholder={form.ssh_key_set ? '••••• configured •••••' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                className="w-full rounded-lg border hairline well px-3 py-2 font-mono text-[11px] text-slate-300 outline-none focus:hairline-strong"
              />
            </Field>
            <div className="grid grid-cols-[1fr_6rem] gap-3">
              <Field label="SSH host" hint="Defaults to the instance host.">
                <Input value={form.ssh_host} onChange={(e) => set('ssh_host', e.target.value)} placeholder="git.lda-dev.com" />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={form.ssh_port}
                  onChange={(e) => set('ssh_port', Number(e.target.value) || 22)}
                />
              </Field>
            </div>
          </>
        )}
      </div>

      <div className="space-y-3 border-t hairline pt-4">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Waking agents from GitLab
        </div>
        <Hint>
          Both ship off. When on, GitLab calls this instance and one agent takes a full turn — so arm
          them deliberately: an assignment or a review request then costs inference the moment it
          happens.
        </Hint>
        <div className="space-y-2">
          <Checkbox checked={form.wake_issues} onChange={(v) => set('wake_issues', v)}>
            An issue assigned to an agent, or a comment naming one, starts a turn
          </Checkbox>
          <Checkbox checked={form.wake_reviews} onChange={(v) => set('wake_reviews', v)}>
            A merge request that asks an agent to review starts a turn
          </Checkbox>
        </div>

        {(form.wake_issues || form.wake_reviews) && (
          <div className="space-y-3">
            <Callout tone="info">
              In GitLab, add a project (or group) webhook pointing at{' '}
              <span className="font-mono">{webhookUrl}</span>, tick <em>Issues</em>,{' '}
              <em>Comments</em> and <em>Merge request</em> events, and paste the secret below into its
              “Secret token” field.
            </Callout>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                icon={copied ? <Check size={12} /> : <Copy size={12} />}
                onClick={() => {
                  void navigator.clipboard.writeText(webhookUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                Copy URL
              </Button>
              <Button
                variant="ghost"
                icon={<RefreshCcw size={12} />}
                onClick={() => void gitlabApi.generateWebhookSecret().then((r) => setSecret(r.secret))}
              >
                {form.webhook_secret_set ? 'Regenerate secret' : 'Generate secret'}
              </Button>
              {form.webhook_secret_set && !secret && (
                <span className="text-[11px] text-slate-500">A secret is set (shown only once, when generated).</span>
              )}
            </div>
            {secret && (
              <Callout tone="warn">
                Copy this now — it is not shown again:{' '}
                <span className="select-all font-mono text-slate-200">{secret}</span>
              </Callout>
            )}

            <Field
              label="Default agent"
              hint="Who answers when the event named nobody and no project row matches. Leave unset and such events are ignored rather than handed to someone at random."
            >
              <Select value={form.default_agent_id} onChange={(e) => set('default_agent_id', e.target.value)}>
                <option value="">— nobody (ignore unrouted events) —</option>
                {agents.map((a) => (
                  <option key={a._id} value={a._id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>

            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Per-project routing
                </span>
                <Button
                  variant="ghost"
                  className="ml-auto"
                  icon={<Plus size={12} />}
                  onClick={() =>
                    set('project_agents', [...form.project_agents, { project: '', agent_id: agents[0]?._id ?? '' }])
                  }
                >
                  Add
                </Button>
              </div>
              <div className="space-y-1.5">
                {form.project_agents.map((row, i) => (
                  <Row key={i} className="flex items-center gap-2 p-2">
                    <Input
                      className="flex-1"
                      value={row.project}
                      placeholder="group/project"
                      onChange={(e) => {
                        const next = [...form.project_agents];
                        next[i] = { ...row, project: e.target.value };
                        set('project_agents', next);
                      }}
                    />
                    <Select
                      className="w-44"
                      value={row.agent_id}
                      onChange={(e) => {
                        const next = [...form.project_agents];
                        next[i] = { ...row, agent_id: e.target.value };
                        set('project_agents', next);
                      }}
                    >
                      {agents.map((a) => (
                        <option key={a._id} value={a._id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                    <button
                      onClick={() => set('project_agents', form.project_agents.filter((_, j) => j !== i))}
                      className="shrink-0 text-slate-600 hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </Row>
                ))}
                {form.project_agents.length === 0 && (
                  <Hint>No overrides — everything unrouted falls to the default agent above.</Hint>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t hairline pt-4">
        <Button variant="primary" onClick={save} loading={saving}>
          Save connection
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
            <Check size={12} /> Saved
          </span>
        )}
        {!form.token_set && !token && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            <X size={12} /> No token yet — the tools stay unavailable until one is saved.
          </span>
        )}
      </div>
    </div>
  );
}
