import crypto from 'node:crypto';
import { createLogger } from '../../config/logger';
import { decryptSecret, encryptSecret } from '../../isolation/ssh.service';
import { AgentModel, type AgentDoc } from '../agents/agent.model';
import { settingsService } from '../settings/settings.service';
import { GitLabError, connection, request, type GitLabConnection } from './gitlab.service';

const log = createLogger('gitlab-provision');

/**
 * One GitLab account per agent (`GITLAB_PLAN.md` §11).
 *
 * The fleet started as a single bot account, which was the right first move and became the wrong
 * one for three reasons: `git log` could not say *which* agent wrote a commit; "this agent may
 * propose, that one may merge" was unexpressible, because permissions attach to accounts and there
 * was one; and the webhook router had to read an agent's name out of prose rather than out of an
 * assignee field. Real users fix all three at once, and the permission model becomes GitLab's own.
 *
 * **The admin token never leaves this file.** Creating users, minting their tokens and setting group
 * membership all need instance-admin rights, which is a far larger credential than the fleet token —
 * so it is read here, used here, and never placed in a `GitLabConnection` that a tool could hold.
 * What a tool gets is the agent's *own* token, which can do exactly what that agent's GitLab account
 * can do and nothing else.
 */

/** GitLab's access levels. 30 is Developer — the default for a newly provisioned agent. */
export const ACCESS_LEVELS: Record<number, string> = {
  10: 'Guest',
  20: 'Reporter',
  30: 'Developer',
  40: 'Maintainer',
  50: 'Owner',
};

/** Renew an agent's token when it is inside this many days of expiring. */
const RENEW_WITHIN_DAYS = 30;
/** How long a minted token lasts. GitLab caps a PAT at one year. */
const TOKEN_DAYS = 350;

export interface AgentIdentity {
  userId: number;
  username: string;
  token: string;
  expiresAt: Date | null;
}

/**
 * The admin connection, or null when none is configured.
 *
 * Null rather than throwing: provisioning is a *best-effort enhancement*. An instance with no admin
 * token still works exactly as it did — every agent acts as the shared bot account — and that has to
 * stay true, or adding this feature would break a working fleet the moment the token expired.
 */
async function adminConnection(): Promise<GitLabConnection | null> {
  const { adminToken } = await settingsService.gitlabSecrets();
  if (!adminToken) return null;
  const base = await connection();
  return { ...base, token: adminToken };
}

/** `Scout Prime` → `scout-prime`. GitLab usernames allow letters, digits, `_`, `-`, `.`. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 240);
  // A username has to start with a letter or digit, and cannot end in a reserved suffix.
  return /^[a-z0-9]/.test(slug) ? slug : `agent-${slug || 'unnamed'}`;
}

/** An address for an account nobody reads — GitLab requires one. */
async function emailFor(username: string, conn: GitLabConnection): Promise<string> {
  const settings = await settingsService.get();
  const domain = settings.gitlab_user_email_domain.trim() || new URL(conn.url).host;
  return `${username}@${domain}`;
}

/** Find an existing GitLab user by exact username. */
async function findUser(conn: GitLabConnection, username: string): Promise<Record<string, any> | null> {
  const rows = await request<Record<string, any>[]>('users', { conn, query: { username } });
  return rows.find((u) => String(u.username).toLowerCase() === username.toLowerCase()) ?? null;
}

/**
 * Create the user, or adopt the one already sitting there under that name.
 *
 * Adoption matters more than it looks: a re-provision after a failed run, a restored database, or an
 * operator who made the account by hand all land here, and creating `scout1` beside the existing
 * `scout` would quietly split one agent's history across two accounts.
 */
async function ensureUser(conn: GitLabConnection, agent: AgentDoc): Promise<Record<string, any>> {
  const username = slugify(agent.name);
  const existing = await findUser(conn, username);
  if (existing) {
    log.info({ agent: agent.name, username, userId: existing.id }, 'adopting an existing GitLab user');
    return existing;
  }
  return request<Record<string, any>>('users', {
    conn,
    method: 'POST',
    body: {
      username,
      name: agent.name,
      email: await emailFor(username, conn),
      // A password nobody will ever use: the account is reached by token only. Generated rather than
      // fixed so the accounts are not interchangeable if password auth is ever switched on.
      password: crypto.randomBytes(24).toString('base64url'),
      // Without this the account sits unconfirmed and its token is refused — the single most likely
      // way for this whole feature to appear broken.
      skip_confirmation: true,
      // Marks it in GitLab's own UI as what it is, so the operator's user list stays legible.
      bot: false,
      can_create_group: false,
      projects_limit: 0,
    },
  });
}

/** Mint a personal access token for that user. Admin-only, and the reason this needs admin at all. */
async function mintToken(
  conn: GitLabConnection,
  userId: number,
  agentName: string,
): Promise<{ token: string; expiresAt: Date }> {
  const expires = new Date(Date.now() + TOKEN_DAYS * 86_400_000);
  const created = await request<Record<string, any>>(`users/${userId}/personal_access_tokens`, {
    conn,
    method: 'POST',
    body: {
      name: `pleiades-${slugify(agentName)}-${Date.now()}`,
      scopes: ['api', 'read_repository', 'write_repository'],
      expires_at: expires.toISOString().slice(0, 10),
    },
  });
  if (!created.token) {
    throw new GitLabError('GitLab minted a token but did not return it — check the admin token’s scopes');
  }
  return { token: String(created.token), expiresAt: new Date(created.expires_at ?? expires) };
}

/** Put the user in the configured group so it can actually see anything. */
async function addToGroup(conn: GitLabConnection, userId: number): Promise<void> {
  if (!conn.group) return;
  const settings = await settingsService.get();
  const accessLevel = settings.gitlab_member_access_level || 30;
  try {
    await request(`groups/${encodeURIComponent(conn.group)}/members`, {
      conn,
      method: 'POST',
      body: { user_id: userId, access_level: accessLevel },
    });
  } catch (err) {
    // Already a member is the common case on a re-provision, and it is a success, not a failure.
    if (err instanceof GitLabError && /already a member/i.test(err.message)) return;
    throw err;
  }
}

/**
 * In-flight provisioning, keyed by agent.
 *
 * A batch of parallel-safe GitLab calls from one turn all reach `connectionFor` at once, and without
 * this each would create its own user. The promise is shared so the first call provisions and the
 * rest wait for it.
 */
const inflight = new Map<string, Promise<AgentIdentity | null>>();

/** Read the identity stored on an agent, decrypting its token. */
async function storedIdentity(agentId: string): Promise<AgentIdentity | null> {
  const doc = await AgentModel.findById(agentId).select('+gitlab_token_enc').lean();
  if (!doc?.gitlab_user_id || !doc.gitlab_token_enc) return null;
  try {
    return {
      userId: doc.gitlab_user_id,
      username: doc.gitlab_username ?? '',
      token: decryptSecret(doc.gitlab_token_enc),
      expiresAt: doc.gitlab_token_expires_at ?? null,
    };
  } catch {
    // Undecryptable after a key rotation: treat as unprovisioned so the next call re-mints, rather
    // than sending ciphertext to GitLab as a bearer token.
    log.warn({ agentId }, 'stored GitLab token will not decrypt — re-provisioning');
    return null;
  }
}

async function save(agentId: string, identity: AgentIdentity): Promise<void> {
  await AgentModel.updateOne(
    { _id: agentId },
    {
      $set: {
        gitlab_user_id: identity.userId,
        gitlab_username: identity.username,
        gitlab_token_enc: encryptSecret(identity.token),
        gitlab_token_expires_at: identity.expiresAt,
      },
    },
  ).exec();
}

function expiringSoon(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - Date.now() < RENEW_WITHIN_DAYS * 86_400_000;
}

export const gitlabProvision = {
  /** Whether this instance can provision at all — the UI's "why is nothing happening" answer. */
  async available(): Promise<boolean> {
    return (await adminConnection()) !== null;
  },

  /**
   * Make sure this agent has a usable GitLab identity, creating or renewing as needed.
   *
   * Returns null — never throws — when there is no admin token, when provisioning is switched off,
   * or when GitLab refuses. The caller falls back to the shared fleet token, so a provisioning
   * problem degrades the *attribution* of a call and never the call itself.
   */
  async ensure(agentId: string, opts: { force?: boolean } = {}): Promise<AgentIdentity | null> {
    const existing = await storedIdentity(agentId);
    if (existing && !opts.force && !expiringSoon(existing.expiresAt)) return existing;

    const pending = inflight.get(agentId);
    if (pending) return pending;

    const task = (async (): Promise<AgentIdentity | null> => {
      try {
        const settings = await settingsService.get();
        if (!settings.gitlab_auto_provision && !opts.force) return existing;
        const conn = await adminConnection();
        if (!conn) {
          if (opts.force) {
            throw new GitLabError(
              'no provisioning admin token is configured (Settings → Connections → GitLab), so agent ' +
                'identities cannot be created.',
            );
          }
          return existing;
        }

        // Not `.lean()`: `ensureUser` and `mintToken` only read `name`, and the hydrated document
        // is what the model's own types describe — a lean projection fights them for no gain here.
        const agent = await AgentModel.findById(agentId).exec();
        if (!agent) return null;

        const user = await ensureUser(conn, agent);
        await addToGroup(conn, user.id);
        // The token is re-minted whenever we get here: either there was none, or the one we had is
        // about to lapse. GitLab will not hand back an existing token's value, so there is no
        // "reuse" branch to write — the old one simply expires beside the new one.
        const { token, expiresAt } = await mintToken(conn, user.id, agent.name);
        const identity: AgentIdentity = {
          userId: user.id,
          username: user.username,
          token,
          expiresAt,
        };
        await save(agentId, identity);
        log.info(
          { agent: agent.name, username: user.username, userId: user.id },
          'agent provisioned with its own GitLab identity',
        );
        return identity;
      } catch (err) {
        if (opts.force) throw err;
        log.warn(
          { agentId, err: err instanceof Error ? err.message : String(err) },
          'could not provision a GitLab identity — falling back to the fleet account',
        );
        return existing;
      } finally {
        inflight.delete(agentId);
      }
    })();

    inflight.set(agentId, task);
    return task;
  },

  /**
   * Keep the GitLab username in step with a renamed agent.
   *
   * GitLab leaves a redirect behind a renamed user, so nothing breaks in the meantime; what would
   * break without this is recognition — the webhook router matches an assignee against agent names,
   * and an agent renamed here would stop being findable under the name GitLab still shows.
   */
  async rename(agentId: string, newName: string): Promise<void> {
    const identity = await storedIdentity(agentId);
    if (!identity) return;
    const conn = await adminConnection();
    if (!conn) return;
    const username = slugify(newName);
    if (username === identity.username) return;
    try {
      await request(`users/${identity.userId}`, {
        conn,
        method: 'PUT',
        body: { username, name: newName },
      });
      await AgentModel.updateOne({ _id: agentId }, { $set: { gitlab_username: username } }).exec();
      log.info({ agentId, from: identity.username, to: username }, 'renamed the agent’s GitLab user');
    } catch (err) {
      log.warn({ agentId, err: String(err) }, 'could not rename the agent’s GitLab user');
    }
  },

  /**
   * Retire an agent's GitLab user when the agent is deleted here.
   *
   * `block` by default, and that default is the whole argument for per-agent accounts: deleting a
   * GitLab user reassigns everything it ever did to the ghost user, so the commits, issues and
   * review comments stop naming who made them — which is precisely the attribution this feature
   * exists to create. Blocking keeps the record and makes the account unusable, which is what
   * "this agent is gone" actually means.
   */
  async retire(agentId: string): Promise<void> {
    const identity = await storedIdentity(agentId);
    if (!identity) return;
    const settings = await settingsService.get();
    if (settings.gitlab_on_agent_delete === 'nothing') return;
    const conn = await adminConnection();
    if (!conn) return;
    try {
      if (settings.gitlab_on_agent_delete === 'delete') {
        await request(`users/${identity.userId}`, { conn, method: 'DELETE' });
        log.info({ agentId, username: identity.username }, 'deleted the agent’s GitLab user');
      } else {
        await request(`users/${identity.userId}/block`, { conn, method: 'POST' });
        log.info({ agentId, username: identity.username }, 'blocked the agent’s GitLab user');
      }
    } catch (err) {
      log.warn({ agentId, err: String(err) }, 'could not retire the agent’s GitLab user');
    }
  },

  /**
   * The identity already stored on an agent, or null — **without provisioning one**.
   *
   * `ensure` is the wrong call for the poller (`GITLAB_PLAN.md` §13): a tick that ran every five
   * minutes through `ensure` would mint a GitLab account for every agent in the fleet the first
   * time it fired. Polling reads the accounts that exist; creating them stays a decision made by a
   * tool call or the operator's Provision button.
   */
  async stored(agentId: string): Promise<AgentIdentity | null> {
    return storedIdentity(agentId);
  },

  /** Every provisioned identity, for the settings page. Tokens are never included. */
  async list(): Promise<
    { agentId: string; agentName: string; username: string; userId: number; expiresAt: Date | null }[]
  > {
    const rows = await AgentModel.find({ gitlab_user_id: { $ne: null } })
      .select('name gitlab_user_id gitlab_username gitlab_token_expires_at')
      .lean();
    return rows.map((a) => ({
      agentId: String(a._id),
      agentName: a.name,
      username: a.gitlab_username ?? '',
      userId: a.gitlab_user_id as number,
      expiresAt: a.gitlab_token_expires_at ?? null,
    }));
  },
};

/**
 * The connection a tool should use: the calling agent's own account when it has one, the shared
 * fleet account otherwise.
 *
 * This is the single seam where per-agent identity enters the tool layer. Everything above it
 * (`request`, `projectPath`, the nine tools) is unchanged and unaware — which is the point, because
 * the alternative was threading an identity through forty call sites.
 */
export async function connectionFor(agentId?: string): Promise<GitLabConnection> {
  const base = await connection();
  if (!agentId) return base;
  const identity = await gitlabProvision.ensure(agentId);
  if (!identity) return base;
  return { ...base, token: identity.token, actingAs: identity.username };
}
