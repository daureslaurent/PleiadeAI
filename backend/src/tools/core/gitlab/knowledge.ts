import { createLogger } from '../../../config/logger';
import {
  GitLabError,
  request,
  scopedPath,
  seg,
  slimCommit,
  slimIssue,
  slimMergeRequest,
  slimProject,
} from '../../../domain/gitlab/gitlab.service';
import {
  PROJECT_PARAM,
  actionParam,
  agentConnection,
  clip,
  guard,
  logWrite,
  project,
  readOnly,
  unknownAction,
} from './shared';
import type { Tool } from '../../types';

const log = createLogger('tool:gitlab');

const SEARCH_SCOPES = ['blobs', 'commits', 'issues', 'merge_requests', 'wiki_blobs', 'projects', 'users'];

/**
 * `gitlab_search` — find the thing, across everything.
 *
 * The counterpart to `gitlab_projects({action:'list'})`: that answers "what exists", this answers
 * "where is X". `blobs` in particular is the one that changes how an agent works — grepping the
 * organisation's actual source for a function name beats reasoning about what it probably does, and
 * it costs one call instead of a clone.
 *
 * Confined to the operator's group when one is configured, by running against
 * `/groups/<group>/search` rather than `/search`: a code search that quietly spans every repository
 * on the instance is a different tool than the one that was authorised.
 */
export const gitlabSearch: Tool = {
  name: 'gitlab_search',
  parallelSafe: true,
  description:
    'Search GitLab. `scope` picks what for: `blobs` (source code — grep the org\'s real code), ' +
    '`commits`, `issues`, `merge_requests`, `wiki_blobs`, `projects`, `users`. `query` is the search ' +
    'text; GitLab\'s code-search filters work in it (`filename:`, `extension:`, `path:`). Pass ' +
    '`project` to search within one repository instead of everywhere. Use this to find the project, ' +
    'the file, or the prior discussion before asking anyone.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('The kind of thing to search for.', SEARCH_SCOPES),
      query: { type: 'string', description: 'What to search for.' },
      project: { type: 'string', description: 'Optional: confine the search to this project path.' },
      limit: { type: 'number', description: 'How many results (default 20, max 100).' },
    },
    required: ['action', 'query'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const scope = String(args.action ?? '');
      if (!SEARCH_SCOPES.includes(scope)) return unknownAction(scope, SEARCH_SCOPES);
      const query = String(args.query ?? '').trim();
      if (!query) throw new GitLabError('`query` is required');
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const hasProject = !!String(args.project ?? '').trim();
      const scopeRef = hasProject ? await project(args, ctx) : null;
      const conn = scopeRef?.conn ?? (await agentConnection(ctx));
      const path = scopeRef ? `projects/${scopeRef.id}/search` : scopedPath(conn, 'search', 'search');
      log.info({ agent: ctx.agentName, scope, query, project: args.project }, 'gitlab_search');

      const rows = await request<Record<string, any>[]>(path, {
        conn,
        paginate: limit,
        query: { scope, search: query },
      });

      switch (scope) {
        case 'blobs':
        case 'wiki_blobs':
          return {
            count: rows.length,
            results: rows.map((r) => ({
              project_id: r.project_id,
              path: r.path,
              ref: r.ref,
              startline: r.startline,
              // The matched lines, not the file: a blob search that returned whole files would cost
              // more context than the clone it is meant to avoid.
              excerpt: clip(String(r.data ?? ''), 2_000).text,
            })),
          };
        case 'commits':
          return { count: rows.length, results: rows.map(slimCommit) };
        case 'issues':
          return { count: rows.length, results: rows.map(slimIssue) };
        case 'merge_requests':
          return { count: rows.length, results: rows.map(slimMergeRequest) };
        case 'projects':
          return { count: rows.length, results: rows.map(slimProject) };
        default:
          return {
            count: rows.length,
            results: rows.map((u) => ({ id: u.id, username: u.username, name: u.name, state: u.state })),
          };
      }
    });
  },
};

const WIKI_ACTIONS = ['list', 'read', 'write', 'delete'];

/**
 * `gitlab_wiki` — the project's own documentation, writable.
 *
 * Small on purpose. The value is not the four actions, it is that a fleet which already writes its
 * findings to the forum now has somewhere to put the ones that belong *to a project* rather than to
 * the fleet — where the humans on that project will actually find them.
 */
export const gitlabWiki: Tool = {
  name: 'gitlab_wiki',
  parallelSafe: readOnly('list', 'read'),
  description:
    'Read and write a GitLab project wiki. `list` → every page. `read` (`slug`) → one page\'s ' +
    'Markdown. `write` (`slug`, `content`, optional `title`) → create or update a page. `delete` ' +
    '(`slug`). Put documentation that belongs to a project here, where its maintainers will find it; ' +
    'findings that belong to the fleet go on the forum instead.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', WIKI_ACTIONS),
      project: PROJECT_PARAM,
      slug: { type: 'string', description: 'The page slug (from `list`).' },
      title: { type: 'string', description: '`write`: the page title (defaults to the slug).' },
      content: { type: 'string', description: '`write`: the full page content, Markdown.' },
    },
    required: ['action', 'project'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      const { conn, id, path } = await project(args, ctx);
      const slug = String(args.slug ?? '').trim();
      log.info({ agent: ctx.agentName, action, project: path, slug }, 'gitlab_wiki');

      switch (action) {
        case 'list': {
          const rows = await request<Record<string, any>[]>(`projects/${id}/wikis`, { conn });
          return { count: rows.length, pages: rows.map((w) => ({ slug: w.slug, title: w.title, format: w.format })) };
        }

        case 'read': {
          if (!slug) throw new GitLabError('`slug` is required');
          const page = await request<Record<string, any>>(`projects/${id}/wikis/${seg(slug)}`, { conn });
          const { text, truncated } = clip(String(page.content ?? ''), 60_000);
          return { slug: page.slug, title: page.title, truncated, content: text };
        }

        case 'write': {
          if (!slug) throw new GitLabError('`slug` is required');
          if (typeof args.content !== 'string') {
            throw new GitLabError('`content` is required — the complete page, not a patch');
          }
          const title = String(args.title ?? '').trim() || slug;
          // Create-or-update: GitLab has no upsert, so an existing page is detected by a read that
          // 404s. Cheaper than making the agent decide, and it cannot get the decision wrong.
          let exists = true;
          try {
            await request(`projects/${id}/wikis/${seg(slug)}`, { conn });
          } catch (err) {
            if (err instanceof GitLabError && err.status === 404) exists = false;
            else throw err;
          }
          const page = await request<Record<string, any>>(
            exists ? `projects/${id}/wikis/${seg(slug)}` : `projects/${id}/wikis`,
            {
              conn,
              method: exists ? 'PUT' : 'POST',
              body: { title, content: args.content, format: 'markdown' },
            },
          );
          logWrite(ctx, path, 'gitlab_wiki.write', {
            target: page.slug,
            title: `${exists ? 'updated' : 'created'} wiki page "${title}"`,
            url: `${conn.url}/${path}/-/wikis/${page.slug}`,
          });
          return { slug: page.slug, title: page.title, created: !exists };
        }

        case 'delete': {
          if (!slug) throw new GitLabError('`slug` is required');
          await request(`projects/${id}/wikis/${seg(slug)}`, { conn, method: 'DELETE' });
          logWrite(ctx, path, 'gitlab_wiki.delete', { target: slug, title: `deleted wiki page "${slug}"` });
          return { deleted: slug };
        }

        default:
          return unknownAction(action, WIKI_ACTIONS);
      }
    });
  },
};
