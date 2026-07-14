import { createLogger } from '../../config/logger';
import { agentRepository } from '../../domain/agents/agent.repository';
import { mailAccountRepository } from '../../domain/mail/mail-account.repository';
import { GmailError, listMail as gmailList, readMail as gmailRead } from '../../domain/mail/gmail.service';
import type { MailAccountDoc } from '../../domain/mail/mail-account.model';
import type { Tool, ToolContext } from '../types';

const log = createLogger('tool:mail');

/** Cap on `read_mail` body length fed back into context; the tool reports when it truncates. */
const MAX_BODY_CHARS = 20_000;

/**
 * Resolve which linked mailbox this call targets, enforcing the per-agent grant
 * (`agent.mail_accounts`, set by the operator on the Agents page). `account` may name the address
 * (full or unambiguous prefix); omitted, it defaults when exactly one mailbox is granted.
 */
async function resolveAccount(
  ctx: ToolContext,
  accountArg: unknown,
): Promise<{ account: MailAccountDoc } | { error: string }> {
  const agent = await agentRepository.findById(ctx.agentId);
  const grantedIds = agent?.mail_accounts ?? [];
  if (grantedIds.length === 0) {
    return { error: 'this agent has no mailbox granted — the operator assigns mail accounts on the Agents page' };
  }
  const granted = await mailAccountRepository.findByIds(grantedIds);
  if (granted.length === 0) return { error: 'the granted mail account no longer exists' };

  const wanted = String(accountArg ?? '').trim().toLowerCase();
  if (!wanted) {
    if (granted.length === 1) return { account: granted[0]! };
    return {
      error: `several mailboxes are granted — pass \`account\`: ${granted.map((a) => a.email).join(', ')}`,
    };
  }
  const match = granted.filter((a) => a.email.toLowerCase() === wanted || a.email.toLowerCase().startsWith(wanted));
  if (match.length === 1) return { account: match[0]! };
  return {
    error:
      match.length === 0
        ? `no granted mailbox matches "${wanted}" — granted: ${granted.map((a) => a.email).join(', ')}`
        : `"${wanted}" is ambiguous — granted: ${match.map((a) => a.email).join(', ')}`,
  };
}

/** Gmail/config failures are expected tool errors the agent should read, not thrown exceptions. */
function asToolError(err: unknown): { result: { ok: false; error: string } } {
  if (err instanceof GmailError) return { result: { ok: false, error: err.message } };
  throw err;
}

/** Shared `account` parameter fragment for both tools' JSON schemas. */
const ACCOUNT_PARAM = {
  type: 'string',
  description:
    'Which linked mailbox to read (email address). Optional when only one mailbox is granted to you.',
};

/**
 * `list_mail` — browse a granted Gmail mailbox, metadata only (read-only: the origin mailbox is
 * never marked read). Opt-in per agent via `tools_allowed` + a mailbox grant.
 */
export const listMail: Tool = {
  name: 'list_mail',
  description:
    'List messages from a linked Gmail mailbox, newest first — metadata only (sender, subject, date, ' +
    'snippet, unread flag), no bodies. Use `read_mail` with a returned `id` to read one. Filter with ' +
    '`query` (Gmail search syntax: `from:alice`, `subject:invoice`, `newer_than:7d`, `has:attachment`…), ' +
    '`unread_only`, and `label` (INBOX, SENT, SPAM, TRASH, STARRED, IMPORTANT, or a custom label). ' +
    'Reading never marks mail as read in the mailbox.',
  parameters: {
    type: 'object',
    properties: {
      account: ACCOUNT_PARAM,
      label: {
        type: 'string',
        description: 'Mailbox label to list (default INBOX).',
      },
      limit: {
        type: 'number',
        description: 'How many messages to return, 1-25 (default 10).',
      },
      unread_only: {
        type: 'boolean',
        description: 'Only unread messages (default false).',
      },
      query: {
        type: 'string',
        description: 'Optional Gmail search query, e.g. "from:boss newer_than:3d".',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const resolved = await resolveAccount(ctx, args.account);
    if ('error' in resolved) return { result: { ok: false, error: resolved.error } };

    log.info({ agent: ctx.agentName, account: resolved.account.email }, 'list_mail');
    try {
      const messages = await gmailList(String(resolved.account._id), {
        label: typeof args.label === 'string' ? args.label : undefined,
        limit: Number(args.limit) || undefined,
        unreadOnly: Boolean(args.unread_only),
        query: typeof args.query === 'string' ? args.query : undefined,
      });
      return { result: { ok: true, account: resolved.account.email, count: messages.length, messages } };
    } catch (err) {
      return asToolError(err);
    }
  },
};

/**
 * `read_mail` — fetch one message's full content as plain text (HTML converted), with attachment
 * metadata. Never alters read-state: the Gmail API only changes UNREAD via an explicit `modify`
 * call, which this integration does not make.
 */
export const readMail: Tool = {
  name: 'read_mail',
  description:
    'Read one email from a linked Gmail mailbox by the `id` returned from `list_mail`: full headers ' +
    'plus the body as plain text (HTML is converted; long bodies are truncated with a marker). ' +
    'Attachments are listed by name/type/size but not downloaded. Reading never marks the message ' +
    'as read in the mailbox.',
  parameters: {
    type: 'object',
    properties: {
      account: ACCOUNT_PARAM,
      id: {
        type: 'string',
        description: 'The message id from `list_mail`.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const id = String(args.id ?? '').trim();
    if (!id) return { result: { ok: false, error: 'id is required — get one from list_mail' } };

    const resolved = await resolveAccount(ctx, args.account);
    if ('error' in resolved) return { result: { ok: false, error: resolved.error } };

    log.info({ agent: ctx.agentName, account: resolved.account.email, id }, 'read_mail');
    try {
      const message = await gmailRead(String(resolved.account._id), id, MAX_BODY_CHARS);
      return { result: { ok: true, account: resolved.account.email, message } };
    } catch (err) {
      return asToolError(err);
    }
  },
};
