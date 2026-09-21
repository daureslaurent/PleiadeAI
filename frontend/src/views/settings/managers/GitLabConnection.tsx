import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  History,
  Loader2,
  PlayCircle,
  Plus,
  RefreshCcw,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  agentsApi,
  gitlabApi,
  type Agent,
  type GitLabConnectionInfo,
  type GitLabIdentities,
  type GitLabPollConfig,
  type GitLabPollReport,
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
/**
 * The poll catalogue, grouped the way the three sources differ from each other — because what an
 * operator needs to decide is not "which fourteen events" but "should agents answer things aimed at
 * them, should they watch project activity nobody is notified about, and should they watch CI".
 */
const SOURCE_GROUPS: { source: GitLabPollConfig['catalogue'][number]['source']; title: string; blurb: string }[] = [
  {
    source: 'todo',
    title: 'Directed at an agent',
    blurb:
      'Read from GitLab’s own to-do list, once per account. An agent with its own GitLab user (below) ' +
      'is woken by GitLab’s answer to “who is this for”, so nothing has to be guessed from prose.',
  },
  {
    source: 'event',
    title: 'Project activity',
    blurb:
      'Things GitLab notifies nobody about. These name no agent, so they go to the project’s row or ' +
      'the default agent — and anything the fleet itself did is skipped.',
  },
  {
    source: 'pipeline',
    title: 'Continuous integration',
    blurb: 'A merge request’s own author hears about its pipeline; nobody owns the default branch.',
  },
];

export function GitLabConnection() {
  const [form, setForm] = useState<GitLabConnectionInfo | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [token, setToken] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<GitLabTestResult | null>(null);
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [poll, setPoll] = useState<GitLabPollConfig | null>(null);
  const [polling, setPolling] = useState(false);
  const [report, setReport] = useState<GitLabPollReport | null>(null);

  useEffect(() => {
    void gitlabApi.connection().then(setForm).catch(() => setForm(null));
    void agentsApi.list().then(setAgents).catch(() => setAgents([]));
    // The catalogue is served rather than declared here, so a release that adds an event kind shows
    // up as a new checkbox with no frontend change (`GITLAB_PLAN.md` §13.2).
    void gitlabApi
      .poll()
      .then((p) => {
        setPoll(p);
        setReport(p.last);
      })
      .catch(() => setPoll(null));
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
        ...(adminToken ? { admin_token: adminToken } : {}),
        ...(sshKey ? { ssh_key: sshKey } : {}),
      });
      setToken('');
      setAdminToken('');
      setSshKey('');
      setForm(await gitlabApi.connection());
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const toggleEvent = (id: string, on: boolean) => {
    if (!form) return;
    set('poll_events', on ? [...form.poll_events, id] : form.poll_events.filter((e) => e !== id));
  };

  const runPoll = async () => {
    setPolling(true);
    try {
      setReport(await gitlabApi.runPoll());
    } finally {
      setPolling(false);
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
          Project check
        </div>
        <Hint>
          The <strong>Check</strong> button on the GitLab page asks an agent what needs attention on
          a project: unclaimed issues, work that was assigned and has gone quiet, merge requests
          waiting, and a red default branch. It reports back and changes nothing.
        </Hint>
        <Field
          label="Call it stale after"
          hint="Days of silence before an assigned issue or an open merge request is flagged."
        >
          <Input
            type="number"
            className="w-28"
            value={form.stale_days}
            onChange={(e) => set('stale_days', Math.max(1, Number(e.target.value) || 3))}
          />
        </Field>
      </div>

      <div className="space-y-3 border-t hairline pt-4">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          One GitLab account per agent
        </div>
        <Hint>
          Without this, every agent acts as the one bot account above:{' '}
          <span className="font-mono">git log</span> cannot say which agent wrote a commit, and “this
          one may propose, that one may merge” is unexpressible, because permissions attach to
          accounts and there is one. With an admin token here, each agent gets a real GitLab user,
          its own access token, and membership in your group — after which its access level in GitLab
          is the permission model.
        </Hint>
        <Field
          label={
            form.admin_token_set
              ? 'Provisioning admin token (configured — type to replace)'
              : 'Provisioning admin token'
          }
          hint="An admin PAT with the api scope. Used ONLY to create users, mint their tokens and set group membership — never handed to a tool, so no agent call carries admin rights. Safe to delete once the fleet is provisioned."
        >
          <Input
            type="password"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            placeholder={form.admin_token_set ? '••••••••••••••••' : 'glpat-… (admin)'}
          />
        </Field>
        <Checkbox checked={form.auto_provision} onChange={(v) => set('auto_provision', v)}>
          Give an agent its own account the first time it touches GitLab
        </Checkbox>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Access level in the group" hint="Adjust individuals in GitLab afterwards.">
            <Select
              value={String(form.member_access_level)}
              onChange={(e) => set('member_access_level', Number(e.target.value))}
            >
              <option value="10">Guest</option>
              <option value="20">Reporter — read and comment only</option>
              <option value="30">Developer — branch, commit, open MRs</option>
              <option value="40">Maintainer — can merge protected branches</option>
            </Select>
          </Field>
          <Field
            label="When an agent is deleted here"
            hint="Blocking keeps its commits and comments attributed; deleting hands them to GitLab's ghost user."
          >
            <Select
              value={form.on_agent_delete}
              onChange={(e) => set('on_agent_delete', e.target.value as 'block' | 'delete' | 'nothing')}
            >
              <option value="block">Block its GitLab user (recommended)</option>
              <option value="delete">Delete its GitLab user</option>
              <option value="nothing">Leave GitLab alone</option>
            </Select>
          </Field>
        </div>
        <Field
          label="Email domain for created users"
          hint="GitLab requires an address on every account, even one nobody reads. Empty uses the instance host."
        >
          <Input
            value={form.user_email_domain}
            onChange={(e) => set('user_email_domain', e.target.value)}
            placeholder={form.url ? form.url.replace(/^https?:\/\//, '') : 'git.example.com'}
          />
        </Field>
        <GitLabIdentitiesList agents={agents} adminReady={form.admin_token_set} />
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
          Webhooks — instant, if GitLab can reach this instance
        </div>
        <Hint>
          Both ship off. When on, GitLab calls this instance and one agent takes a full turn — so arm
          them deliberately: an assignment or a review request then costs inference the moment it
          happens. This needs a webhook per project (group-wide hooks are a paid feature, and an
          instance behind a NAT cannot call in at all) — if that is not available to you, use polling
          below instead. Both may run together; an event that arrives twice still wakes one agent
          once.
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

          </div>
        )}
      </div>

      <div className="space-y-3 border-t hairline pt-4">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          Polling — no webhook needed
        </div>
        <Hint>
          Group webhooks are a paid feature and project webhooks have to be armed one repository at a
          time, so this asks GitLab what happened instead of waiting to be told. Each armed event is
          polled with the token you configured above; an event nobody ticked is never even fetched.
        </Hint>

        <Checkbox checked={form.poll_enabled} onChange={(v) => set('poll_enabled', v)}>
          Poll GitLab on a schedule
        </Checkbox>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Every (minutes)" hint="How often a tick runs. Five is a sane starting point.">
            <Input
              type="number"
              value={form.poll_interval_minutes}
              onChange={(e) => set('poll_interval_minutes', Math.max(1, Number(e.target.value) || 5))}
            />
          </Field>
          <Field
            label="Turns per tick"
            hint="The cap on how many agents one tick may wake. The rest waits for the next tick — nothing is dropped."
          >
            <Input
              type="number"
              value={form.poll_max_wakes}
              onChange={(e) => set('poll_max_wakes', Math.max(1, Number(e.target.value) || 5))}
            />
          </Field>
        </div>

        {poll && (
          <div className="space-y-3">
            {SOURCE_GROUPS.map(({ source, title, blurb }) => {
              const kinds = poll.catalogue.filter((k) => k.source === source);
              if (!kinds.length) return null;
              return (
                <div key={source} className="space-y-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    {title}
                  </div>
                  <Hint>{blurb}</Hint>
                  {kinds.map((kind) => (
                    <div key={kind.id}>
                      <Checkbox
                        checked={form.poll_events.includes(kind.id)}
                        onChange={(v) => toggleEvent(kind.id, v)}
                      >
                        {kind.label}
                      </Checkbox>
                      <div className="ml-6 text-[11px] text-slate-600">{kind.hint}</div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        <Field
          label="Projects to watch"
          hint="Comma-separated full paths. Leave empty and the 20 most recently active projects in scope are polled. Only the project-activity and CI events use this — to-dos follow the accounts, not the projects."
        >
          <Input
            value={form.poll_projects.join(', ')}
            placeholder="group/app, group/infra"
            onChange={(e) =>
              set(
                'poll_projects',
                e.target.value
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean),
              )
            }
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            icon={polling ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />}
            onClick={runPoll}
          >
            Poll now
          </Button>
          <Button
            variant="ghost"
            icon={<History size={12} />}
            onClick={() => void gitlabApi.catchUpPoll().then(runPoll)}
          >
            Catch up
          </Button>
          <Button
            variant="ghost"
            icon={<RefreshCcw size={12} />}
            onClick={() => void gitlabApi.rebaselinePoll().then(() => setReport(null))}
          >
            Re-baseline
          </Button>
          <span className="text-[11px] text-slate-600">
            Save first — a tick reads what is stored, not what is typed. <strong>Catch up</strong>
            {' '}reconsiders every to-do still pending; <strong>Re-baseline</strong> starts from now.
          </span>
        </div>

        {report && (
          <Callout tone={report.errors.length ? 'warn' : 'info'}>
            <div className="space-y-1">
              {!report.ran && <div>Nothing polled — {report.reason}.</div>}
              {report.ran && (
                <div>
                  Read {report.identities.length} account{report.identities.length === 1 ? '' : 's'}
                  {report.projects.length ? ` and ${report.projects.length} project${report.projects.length === 1 ? '' : 's'}` : ''}
                  , matched {report.found}, woke {report.woke.length}
                  {report.deferred ? `, deferred ${report.deferred} to the next tick` : ''}.
                </div>
              )}
              {report.baselined.length > 0 && (
                <div>
                  Baselined {report.baselined.length} source
                  {report.baselined.length === 1 ? '' : 's'} — nothing before now will wake anybody.
                </div>
              )}
              {report.woke.map((w, i) => (
                <div key={i} className="font-mono text-[11px]">
                  {w.agent} ← {w.kind} · {w.title}
                </div>
              ))}
              {report.unmatched?.map((u, i) => (
                <div key={`u${i}`} className="text-[11px] text-slate-500">
                  read but armed by nothing: {u.count} × <span className="font-mono">{u.action}</span> on{' '}
                  <span className="font-mono">{u.target_type}</span> ({u.source})
                </div>
              ))}
              {report.skipped.map((line, i) => (
                <div key={`s${i}`} className="text-[11px] text-slate-500">
                  skipped: {line}
                </div>
              ))}
              {report.errors.map((line, i) => (
                <div key={`e${i}`} className="text-[11px] text-red-400">
                  {line}
                </div>
              ))}
            </div>
          </Callout>
        )}
      </div>

      {(form.wake_issues || form.wake_reviews || form.poll_enabled) && (
        <div className="space-y-3 border-t hairline pt-4">
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Who answers
          </div>
          <Hint>
            Used when the event named nobody — every polled project activity, and any webhook that
            matched no agent. A to-do read on an agent&rsquo;s own GitLab account always wakes that
            agent, whatever is set here.
          </Hint>

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

/**
 * Which agents have their own GitLab account, and a button for the ones that don't.
 *
 * The button exists because ordinary provisioning is deliberately silent — it falls back to the
 * fleet account rather than failing a tool call — so without an explicit path the operator would
 * have no way to find out *why* an agent never got an account.
 */
function GitLabIdentitiesList({ agents, adminReady }: { agents: Agent[]; adminReady: boolean }) {
  const [data, setData] = useState<GitLabIdentities | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = () => {
    void gitlabApi
      .identities()
      .then(setData)
      .catch(() => setData(null));
  };
  useEffect(load, []);

  const provision = async (agentId: string) => {
    setBusy(agentId);
    setErr('');
    try {
      await gitlabApi.provision(agentId);
      load();
    } catch (e: any) {
      setErr(e?.response?.data?.error ?? 'could not provision this agent');
    } finally {
      setBusy('');
    }
  };

  if (!data) return null;
  const byAgent = new Map(data.identities.map((i) => [i.agentId, i]));
  const top = agents.filter((a) => !a.subagent);

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Identities</div>
      {!adminReady && (
        <Hint>No admin token yet — every agent acts as the shared bot account.</Hint>
      )}
      {err && <Callout tone="error">{err}</Callout>}
      {top.map((a) => {
        const identity = byAgent.get(a._id);
        return (
          <Row key={a._id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{a.name}</span>
            {identity ? (
              <>
                <span className="shrink-0 font-mono text-[11px] text-emerald-400">@{identity.username}</span>
                {identity.expiresAt && (
                  <span className="shrink-0 text-[10px] text-slate-600">
                    token to {new Date(identity.expiresAt).toLocaleDateString()}
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="shrink-0 text-[10px] text-slate-600">shared bot account</span>
                <Button
                  variant="ghost"
                  loading={busy === a._id}
                  disabled={!adminReady}
                  icon={<UserPlus size={11} />}
                  onClick={() => void provision(a._id)}
                >
                  Provision
                </Button>
              </>
            )}
          </Row>
        );
      })}
    </div>
  );
}
