import { createLogger } from '../../config/logger';
import type { AgentExecutor } from '../../isolation/AgentContainerManager';
import { settingsService } from '../settings/settings.service';
import { GitLabError, type GitLabConnection } from './gitlab.service';

const log = createLogger('gitlab-git');

/**
 * Real git inside an agent's container (`GITLAB_PLAN.md` §2).
 *
 * The whole job here is to make `git push` work in a plain `bash` call *without* the credential ever
 * being visible to the agent. That rules out the two easy options: an env var (the agent can print
 * its own environment) and a token embedded in the remote URL (`git remote -v` prints it, and so
 * does every error message git writes about that remote). What is left is git's own credential
 * store — a 0600 file the helper reads and nothing echoes — or an SSH key, same idea.
 *
 * The token is still *reachable* by an agent determined to read `~/.git-credentials`, and that is
 * accepted: the agent is already trusted to push to these repositories. The property being defended
 * is the weaker, more important one — that the token does not end up in a tool result, a transcript,
 * or a training corpus by accident.
 */

/** Marker file: credentials already installed in this container, so the setup is skipped. */
const STAMP = '$HOME/.pleiades/gitlab-credentials';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The host part of the configured instance URL — what a credential entry and SSH config key on. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new GitLabError(`the configured GitLab URL is not a valid URL: ${url}`);
  }
}

/**
 * Install git credentials in the container, once.
 *
 * Idempotent by a stamp file rather than by re-running: a container is long-lived and shared by
 * every turn of its agent, so this would otherwise re-write the key on every clone. The stamp also
 * carries the transport, so flipping HTTPS → SSH in settings re-provisions instead of silently
 * leaving the old helper in place.
 */
export async function ensureGitCredentials(
  exec: AgentExecutor,
  conn: GitLabConnection,
  agentName: string,
): Promise<{ transport: 'https' | 'ssh'; host: string }> {
  const settings = await settingsService.get();
  const transport = settings.gitlab_git_transport;
  const host = hostOf(conn.url);
  const stamp = `${STAMP}-${transport}`;

  const identity =
    `git config --global user.name ${shellQuote(agentName)} && ` +
    // A commit needs *an* address; it is never read, so it names the instance rather than inventing
    // a person. The agent's own name is already on the commit, which is the part that matters.
    `git config --global user.email ${shellQuote(`${agentName.toLowerCase().replace(/\s+/g, '-')}@${host}`)} && ` +
    'git config --global init.defaultBranch main && ' +
    // Without this, a `git pull` on a diverged branch stops to ask which strategy to use — and
    // nobody is there to answer.
    'git config --global pull.rebase false';

  let provision: string;
  if (transport === 'ssh') {
    const { sshKey } = await settingsService.gitlabSecrets();
    if (!sshKey) {
      throw new GitLabError(
        'GitLab git transport is set to SSH but no private key is configured (Settings → Connections → GitLab).',
      );
    }
    const sshHost = settings.gitlab_ssh_host.trim() || host;
    const port = settings.gitlab_ssh_port || 22;
    // The key arrives on stdin, never as an argv: an argv is visible in `ps` for the life of the
    // exec, and a 3 KB key would also flirt with ARG_MAX.
    provision =
      'mkdir -p "$HOME/.ssh" "$HOME/.pleiades" && chmod 700 "$HOME/.ssh" && ' +
      'cat > "$HOME/.ssh/gitlab_key" && chmod 600 "$HOME/.ssh/gitlab_key" && ' +
      `printf '%s\\n' ${shellQuote(
        [
          `Host ${sshHost}`,
          `  HostName ${sshHost}`,
          `  Port ${port}`,
          '  User git',
          '  IdentityFile ~/.ssh/gitlab_key',
          '  IdentitiesOnly yes',
          '  StrictHostKeyChecking accept-new',
        ].join('\n'),
      )} > "$HOME/.ssh/config" && chmod 600 "$HOME/.ssh/config" && ` +
      `${identity} && touch ${stamp}`;
    const res = await exec.run(provision, { timeoutMs: 30_000, stdin: `${sshKey.trimEnd()}\n` });
    if (res.exitCode !== 0) {
      throw new GitLabError(`could not install the GitLab SSH key in the container: ${res.stderr.slice(0, 500)}`);
    }
  } else {
    provision =
      'mkdir -p "$HOME/.pleiades" && ' +
      'cat > "$HOME/.git-credentials" && chmod 600 "$HOME/.git-credentials" && ' +
      'git config --global credential.helper store && ' +
      `${identity} && touch ${stamp}`;
    // `oauth2:<token>@host` is GitLab's documented HTTPS form for a personal access token.
    const line = `https://oauth2:${encodeURIComponent(conn.token)}@${host}\n`;
    const res = await exec.run(provision, { timeoutMs: 30_000, stdin: line });
    if (res.exitCode !== 0) {
      throw new GitLabError(`could not install git credentials in the container: ${res.stderr.slice(0, 500)}`);
    }
  }
  log.info({ agent: agentName, transport, host }, 'git credentials provisioned in container');
  // Handed back so the caller builds a remote URL that matches the credential just installed —
  // an SSH key and an https:// remote is the one combination that fails at push time, not clone time.
  return { transport, host: transport === 'ssh' ? settings.gitlab_ssh_host.trim() || host : host };
}

/** Whether credentials are installed, and what is checked out — `gitlab_repo({action:'status'})`. */
export async function credentialStatus(exec: AgentExecutor): Promise<Record<string, unknown>> {
  const settings = await settingsService.get();
  const res = await exec.run(
    // Either stamp counts: the operator may have switched transport, and what the agent is asking
    // is "will git authenticate", not "which of the two did I install".
    `{ ls ${STAMP}-https >/dev/null 2>&1 || ls ${STAMP}-ssh >/dev/null 2>&1; } && echo installed || echo missing; ` +
      'ls -1d ~/repos/*/* 2>/dev/null | head -50',
    { timeoutMs: 15_000 },
  );
  const lines = res.stdout.trim().split('\n');
  return {
    credentials: lines[0] === 'installed' ? 'installed' : 'not installed yet — the next clone installs them',
    transport: settings.gitlab_git_transport,
    checkouts: lines.slice(1).filter(Boolean),
  };
}

/** The clone command and the directory it lands in. */
export function cloneCommand(
  projectPath: string,
  opts: { branch: string; target: string; depth: number; transport: 'https' | 'ssh'; host: string },
): { command: string; dir: string } {
  // The remote has to match the credential that was just installed — an SSH key against an https://
  // remote is the combination that fails at push time rather than clone time, which is the worst
  // moment to find out. `ensureGitCredentials` therefore reports what it installed, and this builds
  // the matching URL from that rather than re-reading settings.
  const remote =
    opts.transport === 'ssh' ? sshRemote(opts.host, projectPath) : `https://${opts.host}/${projectPath}.git`;
  const dir = opts.target;
  const depth = opts.depth > 0 ? `--depth ${Math.floor(opts.depth)}` : '';
  const command =
    `mkdir -p "$(dirname ${shellQuote(dir)})" && ` +
    `if [ -d ${shellQuote(`${dir}/.git`)} ]; then ` +
    // Re-cloning over an existing checkout is how a turn loses uncommitted work from the last one.
    `cd ${shellQuote(dir)} && git fetch --all --prune && git checkout ${shellQuote(opts.branch)} && git pull --ff-only; ` +
    `else git clone ${depth} --branch ${shellQuote(opts.branch)} ${shellQuote(remote)} ${shellQuote(dir)}; fi && ` +
    `cd ${shellQuote(dir)} && git log --oneline -1`;
  return { command, dir };
}

/** SSH remote form, for the `ssh` transport. */
export function sshRemote(host: string, projectPath: string): string {
  return `git@${host}:${projectPath}.git`;
}
