import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { decryptSecret, encryptSecret } from '../../isolation/ssh.service';
import { AgentModel } from '../agents/agent.model';
import { ensureGitServer } from './git-bootstrap';
import { forgejo, GitError, seg } from './forgejo.client';
import { GitIdentityModel, type GitIdentityDoc } from './git-identity.model';

const log = createLogger('git-identity');

/** What an agent's container needs to push as itself. Only ever handed to the credential planter. */
export interface GitCredentials {
  username: string;
  email: string;
  token: string;
  tokenHash: string;
}

type AgentRef = { _id: unknown; name: string };

/** Token scopes: push/pull code and read its own profile — no org, admin or user-management rights. */
const TOKEN_SCOPES = ['write:repository', 'read:user'];

/** `agent-<slug>-<last 6 of id>`: readable in a log, unique without a lookup, and never renamed. */
export function usernameFor(agent: AgentRef): string {
  const slug =
    agent.name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20)
      .replace(/-+$/g, '') || 'agent';
  return `agent-${slug}-${String(agent._id).slice(-6)}`;
}

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

/**
 * One Forgejo account per agent (GIT_SERVER_PLAN.md §2), made lazily the first time an isolated agent
 * runs with git enabled, or from the Git page. Every mutation is serialised per agent so a turn and a
 * page click can't both create the same account.
 */
class GitIdentityService {
  private readonly inflight = new Map<string, Promise<GitIdentityDoc>>();
  /** Agents whose account was confirmed to exist on the server in this process (a wiped volume is noticed once). */
  private readonly verified = new Set<string>();

  list(): Promise<GitIdentityDoc[]> {
    return GitIdentityModel.find().sort({ username: 1 }).exec();
  }

  findByAgent(agentId: string | Types.ObjectId): Promise<GitIdentityDoc | null> {
    return GitIdentityModel.findOne({ agent_id: agentId }).exec();
  }

  /** The account for this agent, created (or re-created on a wiped server) when missing. */
  ensure(agent: AgentRef): Promise<GitIdentityDoc> {
    return this.serialised(String(agent._id), () => this.doEnsure(agent));
  }

  /** Mint a fresh token and revoke the old one. The container notices the new hash on its next ensure. */
  rotate(agent: AgentRef): Promise<GitIdentityDoc> {
    return this.serialised(String(agent._id), async () => {
      const identity = await this.doEnsure(agent);
      return this.mintToken(identity);
    });
  }

  /** Decrypted credentials for planting into the agent's container. Null when not provisioned. */
  async credentials(agentId: string): Promise<GitCredentials | null> {
    const doc = await GitIdentityModel.findOne({ agent_id: agentId }).select('+token_enc').exec();
    if (!doc?.token_enc) return null;
    try {
      const token = decryptSecret(doc.token_enc);
      return { username: doc.username, email: doc.email, token, tokenHash: doc.token_hash || hashToken(token) };
    } catch (err) {
      log.warn({ agentId, err: String(err) }, 'git token undecryptable (encryption key changed?) — re-mint it from the Git page');
      return null;
    }
  }

  /** Keep the account's display name on the agent's name. Best-effort. */
  async syncName(agent: AgentRef): Promise<void> {
    const identity = await this.findByAgent(String(agent._id));
    if (!identity) return;
    await forgejo
      .json(`/admin/users/${seg(identity.username)}`, {
        method: 'PATCH',
        body: { full_name: agent.name, login_name: identity.username, source_id: 0 },
      })
      .catch((err) => log.warn({ username: identity.username, err: String(err) }, 'git display name sync failed'));
  }

  /** Delete the agent's account (its commits keep their author name/email) and the record. */
  async remove(agentId: string): Promise<void> {
    const identity = await this.findByAgent(agentId);
    if (!identity) return;
    await forgejo.request(`/admin/users/${seg(identity.username)}`, {
      method: 'DELETE',
      query: { purge: true },
      okStatuses: [404],
    });
    await GitIdentityModel.deleteOne({ _id: identity._id }).exec();
    this.verified.delete(agentId);
    log.info({ agentId, username: identity.username }, 'removed git account');
  }

  private serialised(agentId: string, fn: () => Promise<GitIdentityDoc>): Promise<GitIdentityDoc> {
    const prev = this.inflight.get(agentId) ?? Promise.resolve(null);
    const next = prev.catch(() => null).then(fn);
    const tracked = next.finally(() => {
      if (this.inflight.get(agentId) === tracked) this.inflight.delete(agentId);
    });
    this.inflight.set(agentId, tracked);
    return tracked;
  }

  private async doEnsure(agent: AgentRef): Promise<GitIdentityDoc> {
    const agentId = String(agent._id);
    const { teamId } = await ensureGitServer();
    let identity = await this.findByAgent(agentId);

    if (identity?.provisioned_at && this.verified.has(agentId)) return identity;

    const username = identity?.username ?? usernameFor(agent);
    const email = identity?.email ?? `${username}@agents.pleiades.local`;

    const existing = await forgejo.request(`/users/${seg(username)}`, { okStatuses: [404] });
    let userId: number;
    let created = false;
    if (existing.status === 404) {
      const user = await forgejo.json<{ id: number }>('/admin/users', {
        method: 'POST',
        body: {
          username,
          email,
          full_name: agent.name,
          // Never used: the agent authenticates with its token. Random so nobody can log in with it.
          password: crypto.randomBytes(24).toString('base64url'),
          must_change_password: false,
          visibility: 'private',
        },
      });
      userId = user.id;
      created = true;
      log.info({ agentId, username }, 'created git account');
    } else {
      userId = ((await existing.json()) as { id: number }).id;
    }

    await forgejo.request(`/teams/${teamId}/members/${seg(username)}`, { method: 'PUT' });

    if (!identity) {
      identity = await GitIdentityModel.create({ agent_id: agentId, username, email, forgejo_user_id: userId });
    } else if (identity.forgejo_user_id !== userId) {
      identity.forgejo_user_id = userId;
      await identity.save();
    }

    // A fresh account (first run, or the server volume was wiped) has no valid token whatever the DB says.
    const withToken = await GitIdentityModel.findById(identity._id).select('+token_enc').exec();
    if (created || !withToken?.token_enc) identity = await this.mintToken(identity);

    this.verified.add(agentId);
    return identity;
  }

  private async mintToken(identity: GitIdentityDoc): Promise<GitIdentityDoc> {
    const name = `pleiades-${Date.now()}`;
    const minted = await forgejo.json<{ sha1: string }>(`/users/${seg(identity.username)}/tokens`, {
      method: 'POST',
      body: { name, scopes: TOKEN_SCOPES },
    });
    if (!minted?.sha1) throw new GitError(`The git server returned no token for ${identity.username}.`);

    const previous = identity.token_name;
    const updated = await GitIdentityModel.findByIdAndUpdate(
      identity._id,
      {
        $set: {
          token_enc: encryptSecret(minted.sha1),
          token_name: name,
          token_hash: hashToken(minted.sha1),
          provisioned_at: new Date(),
        },
      },
      { new: true },
    ).exec();
    if (previous) {
      await forgejo
        .request(`/users/${seg(identity.username)}/tokens/${seg(previous)}`, { method: 'DELETE', okStatuses: [404] })
        .catch((err) => log.warn({ username: identity.username, err: String(err) }, 'old git token revoke failed'));
    }
    log.info({ username: identity.username }, 'minted git token');
    return updated ?? identity;
  }
}

export const gitIdentityService = new GitIdentityService();

/** Agents by id, for mapping identities back to names on the page and in activity. */
export async function agentNamesById(ids: unknown[]): Promise<Map<string, string>> {
  const agents = await AgentModel.find({ _id: { $in: ids } }, { name: 1 }).lean().exec();
  return new Map(agents.map((a) => [String(a._id), a.name]));
}
