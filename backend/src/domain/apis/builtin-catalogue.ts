import type { AuthType, HttpMethod, ParamLocation, ParamType } from './api-source.model';

/**
 * The APIs this instance ships with (`API_TOOL_PLAN.md` §8).
 *
 * Every entry here was called for real before being written down — several obvious candidates were
 * dropped because they had quietly died or gone paid (worldtimeapi, dictionaryapi.dev, RestCountries
 * v3, which now returns a deprecation notice instead of a country). Presets are installed into
 * `api_sources` as ordinary documents: the operator can edit, disable or delete any of them, and
 * nothing here is consulted again at call time.
 *
 * Two rules for adding one:
 *
 * 1. **It must work with no account.** The one concession is `auth_optional` — an API that answers
 *    anonymously but answers *better* with a key (GitHub's 60 vs 5000 requests an hour). Those ship
 *    working, with a hint telling the operator what a key would buy.
 * 2. **Descriptions are the interface.** `api_man` shows exactly these words to the model, so each
 *    one says what the operation returns and when to reach for it — not what it is called.
 */

export interface BuiltinParam {
  name: string;
  in: ParamLocation;
  type: ParamType;
  required?: boolean;
  description: string;
  default?: string;
}

export interface BuiltinOperation {
  id: string;
  description: string;
  method?: HttpMethod;
  path: string;
  /** Host override for this operation alone — some APIs put one endpoint on a different domain. */
  base_url?: string;
  query?: { key: string; value: string }[];
  body_template?: string;
  params?: BuiltinParam[];
  /** A known-good argument set. Not persisted — it exists so the catalogue can be smoke-tested. */
  sample?: Record<string, unknown>;
}

export interface BuiltinApi {
  name: string;
  description: string;
  base_url: string;
  auth_type?: AuthType;
  auth_header?: string;
  auth_query?: string;
  token_url?: string;
  auth_scope?: string;
  /** The API answers without a credential; one only raises limits or unlocks extras. */
  auth_optional?: boolean;
  /** Shown under the credential field in Settings → APIs — what a key buys and where to get one. */
  secret_hint?: string;
  headers?: { key: string; value: string }[];
  methods_allowed?: HttpMethod[];
  notes?: string;
  /** Off on install — for an API that needs setup before its first call can succeed. */
  enabled?: boolean;
  operations: BuiltinOperation[];
}

/** Politeness header several of these ask for by name (Nominatim, GitHub, the 4chan CDN). */
const UA = { key: 'User-Agent', value: 'PleiadesAI/1.0 (multi-agent assistant)' };

export const BUILTIN_APIS: BuiltinApi[] = [
  // ── Reference ────────────────────────────────────────────────────────────────────────────────
  {
    name: 'wikipedia',
    description: 'English Wikipedia — search articles, read a summary, or pull an article’s full plain text.',
    base_url: 'https://en.wikipedia.org',
    headers: [UA],
    notes:
      'Titles are case-sensitive and use underscores or spaces interchangeably. `search` first when you are not certain of the exact title — `summary` and `extract` need a real one.',
    operations: [
      {
        id: 'search',
        description: 'Find articles matching a query. Returns titles, descriptions and a snippet each.',
        path: '/w/rest.php/v1/search/page',
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: 'What to look for.' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many results, 1-50.', default: '5' },
        ],
        sample: { q: 'turing machine', limit: 3 },
      },
      {
        id: 'summary',
        description: 'The lead paragraph and key facts of one article. Cheap — prefer it over `extract` unless you need the whole thing.',
        path: '/api/rest_v1/page/summary/{title}',
        params: [
          { name: 'title', in: 'path', type: 'string', required: true, description: 'Exact article title, e.g. "Alan Turing".' },
        ],
        sample: { title: 'Alan Turing' },
      },
      {
        id: 'extract',
        description: 'The complete plain text of one article. Long — expect the response to be trimmed.',
        path: '/w/api.php',
        query: [
          { key: 'action', value: 'query' },
          { key: 'prop', value: 'extracts' },
          { key: 'explaintext', value: '1' },
          { key: 'format', value: 'json' },
          { key: 'redirects', value: '1' },
        ],
        params: [{ name: 'titles', in: 'query', type: 'string', required: true, description: 'Exact article title.' }],
        sample: { titles: 'Turing machine' },
      },
    ],
  },
  {
    name: 'wikidata',
    description: 'Wikidata — resolve a name to an entity id, then read that entity’s structured facts.',
    base_url: 'https://www.wikidata.org',
    headers: [UA],
    notes: 'Two steps: `search_entities` turns "Einstein" into Q937, then `get_entity` returns its claims. Property ids (P569 = date of birth) are not resolved for you.',
    operations: [
      {
        id: 'search_entities',
        description: 'Turn a name into candidate Wikidata entity ids (Q-numbers) with descriptions.',
        path: '/w/api.php',
        query: [
          { key: 'action', value: 'wbsearchentities' },
          { key: 'language', value: 'en' },
          { key: 'format', value: 'json' },
        ],
        params: [
          { name: 'search', in: 'query', type: 'string', required: true, description: 'Name to resolve.' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many candidates.', default: '5' },
        ],
        sample: { search: 'Einstein', limit: 3 },
      },
      {
        id: 'get_entity',
        description: 'Every statement held about one entity. Large — ask for a specific id, not a browse.',
        path: '/wiki/Special:EntityData/{id}.json',
        params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'Entity id, e.g. Q937.' }],
        sample: { id: 'Q937' },
      },
    ],
  },
  {
    name: 'openalex',
    description: 'OpenAlex — scholarly papers: search the literature, then read one work’s metadata, abstract and citation counts.',
    base_url: 'https://api.openalex.org',
    headers: [UA],
    notes: 'Covers essentially all of arXiv, Crossref and PubMed. Abstracts come back as an inverted index (word → positions), not prose.',
    operations: [
      {
        id: 'search_works',
        description: 'Find papers by topic, title or author. Returns title, authors, year, venue, citation count and DOI.',
        path: '/works',
        params: [
          { name: 'search', in: 'query', type: 'string', required: true, description: 'Free-text query.' },
          { name: 'per-page', in: 'query', type: 'number', description: 'Results per page, 1-50.', default: '5' },
          { name: 'filter', in: 'query', type: 'string', description: 'Optional filter, e.g. "publication_year:>2020".' },
        ],
        sample: { search: 'attention is all you need', 'per-page': 2 },
      },
      {
        id: 'get_work',
        description: 'One paper in full, by its OpenAlex id or DOI URL.',
        path: '/works/{id}',
        params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'OpenAlex id (W2741809807) or "https://doi.org/10.xxxx/yyy".' }],
        sample: { id: 'W2741809807' },
      },
    ],
  },
  {
    name: 'openlibrary',
    description: 'Open Library — search books by title, author or subject and read a work’s details.',
    base_url: 'https://openlibrary.org',
    headers: [UA],
    operations: [
      {
        id: 'search_books',
        description: 'Find books. Returns title, author, first publication year and the work key you need for `get_work`.',
        path: '/search.json',
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: 'Title, author or free text.' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many results.', default: '5' },
        ],
        sample: { q: 'dune frank herbert', limit: 2 },
      },
      {
        id: 'get_work',
        description: 'One work’s description, subjects and covers.',
        path: '/works/{key}.json',
        params: [{ name: 'key', in: 'path', type: 'string', required: true, description: 'Work key from a search hit, e.g. OL45883W.' }],
        sample: { key: 'OL45883W' },
      },
    ],
  },

  // ── Discussion ───────────────────────────────────────────────────────────────────────────────
  {
    name: 'hackernews',
    description: 'Hacker News — search the whole archive of stories and comments, or read one item and its thread.',
    base_url: 'https://hn.algolia.com/api/v1',
    headers: [UA],
    notes: 'Search is Algolia’s index (fast, full-text, ranked). `search_by_date` is the same query sorted newest-first — use it for "what is being said today". Read one story’s comments with `item`.',
    operations: [
      {
        id: 'search',
        description: 'Search stories and comments by relevance. Returns title, url, points, author and comment count.',
        path: '/search',
        params: [
          { name: 'query', in: 'query', type: 'string', required: true, description: 'What to search for.' },
          { name: 'tags', in: 'query', type: 'string', description: 'Restrict by type: story, comment, show_hn, ask_hn, front_page.' },
          { name: 'hitsPerPage', in: 'query', type: 'number', description: 'How many hits, 1-50.', default: '10' },
        ],
        sample: { query: 'rust borrow checker', hitsPerPage: 3 },
      },
      {
        id: 'search_by_date',
        description: 'The same search, newest first — what people are posting right now.',
        path: '/search_by_date',
        params: [
          { name: 'query', in: 'query', type: 'string', required: true, description: 'What to search for.' },
          { name: 'tags', in: 'query', type: 'string', description: 'story, comment, show_hn, ask_hn, front_page.', default: 'story' },
          { name: 'hitsPerPage', in: 'query', type: 'number', description: 'How many hits.', default: '10' },
        ],
        sample: { query: 'llm', hitsPerPage: 3 },
      },
      {
        id: 'item',
        description: 'One story or comment with its whole reply tree, by id.',
        path: '/items/{id}',
        params: [{ name: 'id', in: 'path', type: 'number', required: true, description: 'HN item id (the objectID from a search hit).' }],
        sample: { id: 8863 },
      },
    ],
  },
  {
    name: 'lobsters',
    description: 'Lobste.rs — a small, high-signal tech link aggregator. Front page and newest, with tags and comment counts.',
    base_url: 'https://lobste.rs',
    headers: [UA],
    operations: [
      { id: 'hottest', description: 'The current front page.', path: '/hottest.json', sample: {} },
      { id: 'newest', description: 'Most recently submitted stories.', path: '/newest.json', sample: {} },
      {
        id: 'tagged',
        description: 'Front page filtered to one tag (rust, ai, security, programming…).',
        path: '/t/{tag}.json',
        params: [{ name: 'tag', in: 'path', type: 'string', required: true, description: 'A single Lobsters tag.' }],
        sample: { tag: 'rust' },
      },
    ],
  },
  {
    name: 'fourchan',
    description: '4chan’s read-only JSON API — board list, a board’s catalog of live threads, and one thread’s posts.',
    base_url: 'https://a.4cdn.org',
    headers: [UA],
    notes:
      'Read-only: there is no posting, voting or search. Content is unmoderated and frequently offensive or false — treat every post as an anonymous claim, never as a source. Comments arrive as HTML fragments in `com`. Threads are ephemeral; a thread id from an hour ago may already be gone.',
    operations: [
      { id: 'boards', description: 'Every board with its name, description and posting rules.', path: '/boards.json', sample: {} },
      {
        id: 'catalog',
        description: 'All live threads on one board — OP text, reply count and thread numbers. Large.',
        path: '/{board}/catalog.json',
        params: [{ name: 'board', in: 'path', type: 'string', required: true, description: 'Board letter, e.g. g (technology), sci, his.' }],
        sample: { board: 'g' },
      },
      {
        id: 'thread',
        description: 'Every post in one thread, by its number from the catalog.',
        path: '/{board}/thread/{thread}.json',
        params: [
          { name: 'board', in: 'path', type: 'string', required: true, description: 'Board letter.' },
          { name: 'thread', in: 'path', type: 'number', required: true, description: 'Thread number (the `no` of the OP).' },
        ],
      },
    ],
  },
  {
    name: 'reddit',
    description: 'Reddit — search posts, read a subreddit’s hot listing, and open a post’s comments.',
    base_url: 'https://oauth.reddit.com',
    auth_type: 'oauth2',
    token_url: 'https://www.reddit.com/api/v1/access_token',
    headers: [UA],
    enabled: false,
    secret_hint:
      'Reddit refuses anonymous API traffic. Create a "script" app at reddit.com/prefs/apps, then put its client id in Username and its secret here — the token is fetched and renewed for you. Switch this API on once both are set.',
    notes:
      'Requires your own Reddit app credentials (free, two minutes). Listings are paged with `after`, taken from the previous response’s `data.after`.',
    operations: [
      {
        id: 'search',
        description: 'Search Reddit posts site-wide, or within one subreddit.',
        path: '/search',
        query: [{ key: 'raw_json', value: '1' }],
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: 'Query. Supports subreddit:name and author:name.' },
          { name: 'sort', in: 'query', type: 'string', description: 'relevance, hot, top, new, comments.', default: 'relevance' },
          { name: 't', in: 'query', type: 'string', description: 'Time window for top/relevance: hour, day, week, month, year, all.' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many posts, 1-100.', default: '10' },
        ],
      },
      {
        id: 'subreddit_hot',
        description: 'The current hot listing of one subreddit.',
        path: '/r/{subreddit}/hot',
        query: [{ key: 'raw_json', value: '1' }],
        params: [
          { name: 'subreddit', in: 'path', type: 'string', required: true, description: 'Subreddit name without the r/.' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many posts, 1-100.', default: '10' },
          { name: 'after', in: 'query', type: 'string', description: 'Paging cursor from the previous response.' },
        ],
      },
      {
        id: 'comments',
        description: 'One post plus its comment tree, by post id.',
        path: '/comments/{id}',
        query: [{ key: 'raw_json', value: '1' }],
        params: [
          { name: 'id', in: 'path', type: 'string', required: true, description: 'Post id (the base-36 id from a listing, without the t3_ prefix).' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many comments.', default: '50' },
        ],
      },
    ],
  },
  {
    name: 'stackexchange',
    description: 'Stack Overflow and the other Stack Exchange sites — search questions and read their answers.',
    base_url: 'https://api.stackexchange.com/2.3',
    headers: [UA],
    notes: 'Answer bodies need `filter=withbody`, which `get_answers` already sets. Anonymous quota is 300 requests a day per IP.',
    operations: [
      {
        id: 'search',
        description: 'Search questions. Returns title, score, whether it is answered, and the question id.',
        path: '/search/advanced',
        query: [
          { key: 'order', value: 'desc' },
          { key: 'sort', value: 'relevance' },
        ],
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: 'What to search for.' },
          { name: 'site', in: 'query', type: 'string', description: 'Which site: stackoverflow, serverfault, superuser, unix, askubuntu…', default: 'stackoverflow' },
          { name: 'tagged', in: 'query', type: 'string', description: 'Semicolon-separated tags to require.' },
          { name: 'pagesize', in: 'query', type: 'number', description: 'How many questions.', default: '5' },
        ],
        sample: { q: 'rust lifetime elision', pagesize: 2 },
      },
      {
        id: 'get_answers',
        description: 'The answers to one question, best-voted first, with their full text.',
        path: '/questions/{id}/answers',
        query: [
          { key: 'order', value: 'desc' },
          { key: 'sort', value: 'votes' },
          { key: 'filter', value: 'withbody' },
        ],
        params: [
          { name: 'id', in: 'path', type: 'number', required: true, description: 'Question id from a search hit.' },
          { name: 'site', in: 'query', type: 'string', description: 'The site the question is on.', default: 'stackoverflow' },
          { name: 'pagesize', in: 'query', type: 'number', description: 'How many answers.', default: '3' },
        ],
        sample: { id: 11227809, pagesize: 1 },
      },
    ],
  },

  // ── Software ─────────────────────────────────────────────────────────────────────────────────
  {
    name: 'github',
    description: 'GitHub — search repositories, read a repo’s metadata and README, and list its issues and releases.',
    base_url: 'https://api.github.com',
    auth_type: 'bearer',
    auth_optional: true,
    secret_hint:
      'Optional. Anonymous calls are limited to 60 an hour; a fine-grained token with public read access raises that to 5000 (github.com/settings/tokens).',
    headers: [UA, { key: 'X-GitHub-Api-Version', value: '2022-11-28' }],
    notes: 'Read-only as configured. `get_readme` returns base64 content — decode it before quoting.',
    operations: [
      {
        id: 'search_repos',
        description: 'Find repositories. Supports GitHub search syntax (language:rust stars:>1000).',
        path: '/search/repositories',
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: 'Search query, e.g. "http client language:go".' },
          { name: 'sort', in: 'query', type: 'string', description: 'stars, forks, updated. Omit for best match.' },
          { name: 'per_page', in: 'query', type: 'number', description: 'How many repos, 1-30.', default: '5' },
        ],
        sample: { q: 'rust cli parser', per_page: 2 },
      },
      {
        id: 'get_repo',
        description: 'One repository: description, stars, language, licence, default branch, last push.',
        path: '/repos/{owner}/{repo}',
        params: [
          { name: 'owner', in: 'path', type: 'string', required: true, description: 'User or organisation.' },
          { name: 'repo', in: 'path', type: 'string', required: true, description: 'Repository name.' },
        ],
        sample: { owner: 'torvalds', repo: 'linux' },
      },
      {
        id: 'get_readme',
        description: 'The repository’s README, base64-encoded in `content`.',
        path: '/repos/{owner}/{repo}/readme',
        params: [
          { name: 'owner', in: 'path', type: 'string', required: true, description: 'User or organisation.' },
          { name: 'repo', in: 'path', type: 'string', required: true, description: 'Repository name.' },
        ],
        sample: { owner: 'openai', repo: 'whisper' },
      },
      {
        id: 'list_issues',
        description: 'Issues and pull requests on a repository, newest first.',
        path: '/repos/{owner}/{repo}/issues',
        params: [
          { name: 'owner', in: 'path', type: 'string', required: true, description: 'User or organisation.' },
          { name: 'repo', in: 'path', type: 'string', required: true, description: 'Repository name.' },
          { name: 'state', in: 'query', type: 'string', description: 'open, closed or all.', default: 'open' },
          { name: 'labels', in: 'query', type: 'string', description: 'Comma-separated label names to require.' },
          { name: 'per_page', in: 'query', type: 'number', description: 'How many, 1-30.', default: '10' },
        ],
        sample: { owner: 'rust-lang', repo: 'rust', per_page: 2 },
      },
      {
        id: 'list_releases',
        description: 'Releases with their tags, dates and notes — how to answer "what changed in the latest version".',
        path: '/repos/{owner}/{repo}/releases',
        params: [
          { name: 'owner', in: 'path', type: 'string', required: true, description: 'User or organisation.' },
          { name: 'repo', in: 'path', type: 'string', required: true, description: 'Repository name.' },
          { name: 'per_page', in: 'query', type: 'number', description: 'How many releases.', default: '5' },
        ],
        sample: { owner: 'nodejs', repo: 'node', per_page: 1 },
      },
    ],
  },
  {
    name: 'npm',
    description: 'The npm registry — search JavaScript packages and read one package’s versions and metadata.',
    base_url: 'https://registry.npmjs.org',
    headers: [UA],
    notes: '`get_package` returns every published version and is often very large; expect trimming.',
    operations: [
      {
        id: 'search',
        description: 'Search packages by name or keyword. Returns name, version, description and links.',
        path: '/-/v1/search',
        params: [
          { name: 'text', in: 'query', type: 'string', required: true, description: 'Search text.' },
          { name: 'size', in: 'query', type: 'number', description: 'How many results, 1-25.', default: '5' },
        ],
        sample: { text: 'express middleware', size: 2 },
      },
      {
        id: 'get_package',
        description: 'One package: description, latest version, dependencies, repository, licence.',
        path: '/{package}',
        params: [{ name: 'package', in: 'path', type: 'string', required: true, description: 'Package name (URL-encode a scope: @scope%2Fname).' }],
        sample: { package: 'zod' },
      },
    ],
  },
  {
    name: 'pypi',
    description: 'PyPI — one Python package’s metadata, latest version, dependencies and project links.',
    base_url: 'https://pypi.org',
    headers: [UA],
    notes: 'PyPI has no JSON search endpoint; find a package name with `web_search` or `github.search_repos` first.',
    operations: [
      {
        id: 'get_package',
        description: 'Metadata for one package, including its README in `info.description`.',
        path: '/pypi/{package}/json',
        params: [{ name: 'package', in: 'path', type: 'string', required: true, description: 'Package name, e.g. requests.' }],
        sample: { package: 'httpx' },
      },
    ],
  },
  {
    name: 'crates',
    description: 'crates.io — search Rust crates and read one crate’s versions, downloads and links.',
    base_url: 'https://crates.io/api/v1',
    headers: [UA],
    operations: [
      {
        id: 'search',
        description: 'Search crates by name or keyword, most-downloaded first.',
        path: '/crates',
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: 'Search text.' },
          { name: 'per_page', in: 'query', type: 'number', description: 'How many crates, 1-30.', default: '5' },
        ],
        sample: { q: 'async runtime', per_page: 2 },
      },
      {
        id: 'get_crate',
        description: 'One crate with its full version history and download counts.',
        path: '/crates/{crate}',
        params: [{ name: 'crate', in: 'path', type: 'string', required: true, description: 'Crate name.' }],
        sample: { crate: 'tokio' },
      },
    ],
  },
  {
    name: 'huggingface',
    description: 'Hugging Face Hub — find models and datasets, and read one model’s card, size and downloads.',
    base_url: 'https://huggingface.co/api',
    auth_type: 'bearer',
    auth_optional: true,
    secret_hint: 'Optional. A read token (huggingface.co/settings/tokens) raises rate limits and reaches gated repos.',
    headers: [UA],
    operations: [
      {
        id: 'search_models',
        description: 'Find models by name, task or author. Returns id, downloads, likes and tags.',
        path: '/models',
        params: [
          { name: 'search', in: 'query', type: 'string', description: 'Free text, e.g. "qwen3 instruct gguf".' },
          { name: 'filter', in: 'query', type: 'string', description: 'Tag filter, e.g. text-generation or gguf.' },
          { name: 'sort', in: 'query', type: 'string', description: 'downloads, likes, lastModified.', default: 'downloads' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many models.', default: '10' },
        ],
        sample: { search: 'qwen gguf', limit: 3 },
      },
      {
        id: 'get_model',
        description: 'One model: its card data, files, licence and download count.',
        path: '/models/{repo}',
        params: [{ name: 'repo', in: 'path', type: 'string', required: true, description: 'Full repo id, e.g. Qwen/Qwen2.5-7B-Instruct.' }],
      },
      {
        id: 'search_datasets',
        description: 'Find datasets by name or task.',
        path: '/datasets',
        params: [
          { name: 'search', in: 'query', type: 'string', description: 'Free text.' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many datasets.', default: '10' },
        ],
        sample: { search: 'squad', limit: 2 },
      },
    ],
  },
  {
    name: 'osv',
    description: 'OSV.dev — known security vulnerabilities affecting a specific package version, across every major ecosystem.',
    base_url: 'https://api.osv.dev/v1',
    methods_allowed: ['GET', 'HEAD', 'POST'],
    headers: [UA],
    notes: 'The authoritative answer to "is the version we pin vulnerable". An empty `vulns` list means nothing is known against it.',
    operations: [
      {
        id: 'query_package',
        description: 'Vulnerabilities affecting one package version. Returns each advisory with its severity, affected ranges and fix.',
        method: 'POST',
        path: '/query',
        body_template: '{"package": {"name": "{name}", "ecosystem": "{ecosystem}"}, "version": "{version}"}',
        params: [
          { name: 'name', in: 'body', type: 'string', required: true, description: 'Package name.' },
          { name: 'ecosystem', in: 'body', type: 'string', required: true, description: 'npm, PyPI, crates.io, Go, Maven, NuGet, RubyGems, Packagist, Debian, Alpine.' },
          { name: 'version', in: 'body', type: 'string', required: true, description: 'The exact version to check.' },
        ],
        sample: { name: 'express', ecosystem: 'npm', version: '4.17.1' },
      },
      {
        id: 'get_vuln',
        description: 'One advisory in full, by id (GHSA-…, CVE-…, RUSTSEC-…).',
        path: '/vulns/{id}',
        params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'Advisory id.' }],
        sample: { id: 'GHSA-rv95-896h-c2vc' },
      },
    ],
  },

  // ── The world ────────────────────────────────────────────────────────────────────────────────
  {
    name: 'openmeteo',
    description: 'Open-Meteo — weather forecasts, historical weather and air quality for any coordinate. No key, no limits worth worrying about.',
    base_url: 'https://api.open-meteo.com',
    headers: [UA],
    notes:
      'Everything is by latitude/longitude — turn a place name into one with `geocode` first (it lives on a different host, so it is its own operation here). Variable names are Open-Meteo’s own: temperature_2m, precipitation, wind_speed_10m, weather_code.',
    operations: [
      {
        id: 'forecast',
        description: 'Forecast for a coordinate. Ask for `current`, `hourly` or `daily` variables by name.',
        path: '/v1/forecast',
        params: [
          { name: 'latitude', in: 'query', type: 'number', required: true, description: 'Decimal degrees.' },
          { name: 'longitude', in: 'query', type: 'number', required: true, description: 'Decimal degrees.' },
          { name: 'current', in: 'query', type: 'string', description: 'Comma-separated current variables.', default: 'temperature_2m,weather_code,wind_speed_10m' },
          { name: 'daily', in: 'query', type: 'string', description: 'Comma-separated daily variables, e.g. temperature_2m_max,precipitation_sum.' },
          { name: 'hourly', in: 'query', type: 'string', description: 'Comma-separated hourly variables.' },
          { name: 'forecast_days', in: 'query', type: 'number', description: 'Days ahead, 1-16.', default: '3' },
          { name: 'timezone', in: 'query', type: 'string', description: 'IANA zone, or "auto" to use the coordinate’s own.', default: 'auto' },
        ],
        sample: { latitude: 48.85, longitude: 2.35 },
      },
      {
        id: 'geocode',
        description: 'Turn a place name into coordinates, country and timezone. Run this before `forecast`.',
        // Open-Meteo puts geocoding on its own host; keeping it as an operation of `openmeteo` means
        // the model finds it where it would look for it.
        base_url: 'https://geocoding-api.open-meteo.com',
        path: '/v1/search',
        params: [
          { name: 'name', in: 'query', type: 'string', required: true, description: 'Place name.' },
          { name: 'count', in: 'query', type: 'number', description: 'How many candidates.', default: '5' },
        ],
        sample: { name: 'Toulouse', count: 2 },
      },
    ],
  },
  {
    name: 'airquality',
    description: 'Open-Meteo air quality — PM2.5, PM10, ozone, NO2 and the European AQI for a coordinate.',
    base_url: 'https://air-quality-api.open-meteo.com',
    headers: [UA],
    operations: [
      {
        id: 'current',
        description: 'Current air quality at a coordinate.',
        path: '/v1/air-quality',
        params: [
          { name: 'latitude', in: 'query', type: 'number', required: true, description: 'Decimal degrees.' },
          { name: 'longitude', in: 'query', type: 'number', required: true, description: 'Decimal degrees.' },
          { name: 'current', in: 'query', type: 'string', description: 'Variables to return.', default: 'pm10,pm2_5,european_aqi,ozone,nitrogen_dioxide' },
        ],
        sample: { latitude: 48.85, longitude: 2.35 },
      },
    ],
  },
  {
    name: 'nominatim',
    description: 'OpenStreetMap Nominatim — addresses and places to coordinates, and coordinates back to an address.',
    base_url: 'https://nominatim.openstreetmap.org',
    headers: [UA],
    notes: 'OSM’s usage policy allows one request per second and requires the User-Agent this API already sends. Do not loop over it.',
    operations: [
      {
        id: 'search',
        description: 'Find a place or address. Returns coordinates, a display name and a bounding box.',
        path: '/search',
        query: [{ key: 'format', value: 'jsonv2' }],
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: 'Free-form place or address.' },
          { name: 'limit', in: 'query', type: 'number', description: 'How many results.', default: '3' },
        ],
        sample: { q: 'Eiffel Tower', limit: 1 },
      },
      {
        id: 'reverse',
        description: 'The address at a coordinate.',
        path: '/reverse',
        query: [{ key: 'format', value: 'jsonv2' }],
        params: [
          { name: 'lat', in: 'query', type: 'number', required: true, description: 'Latitude.' },
          { name: 'lon', in: 'query', type: 'number', required: true, description: 'Longitude.' },
        ],
        sample: { lat: 48.8584, lon: 2.2945 },
      },
    ],
  },
  {
    name: 'currency',
    description: 'Frankfurter — European Central Bank reference exchange rates, current or on any past date.',
    base_url: 'https://api.frankfurter.dev/v1',
    headers: [UA],
    notes: 'ECB rates only: about 30 major currencies, updated once each working day around 16:00 CET. Not a live trading feed, and no crypto.',
    operations: [
      {
        id: 'latest',
        description: 'The most recent rates for one base currency.',
        path: '/latest',
        params: [
          { name: 'base', in: 'query', type: 'string', description: 'Base currency code.', default: 'EUR' },
          { name: 'symbols', in: 'query', type: 'string', description: 'Comma-separated codes to return; omit for all.' },
        ],
        sample: { base: 'USD', symbols: 'EUR,GBP' },
      },
      {
        id: 'historical',
        description: 'Rates on a specific past date.',
        path: '/{date}',
        params: [
          { name: 'date', in: 'path', type: 'string', required: true, description: 'ISO date, e.g. 2026-01-15.' },
          { name: 'base', in: 'query', type: 'string', description: 'Base currency code.', default: 'EUR' },
          { name: 'symbols', in: 'query', type: 'string', description: 'Comma-separated codes to return.' },
        ],
        sample: { date: '2026-01-15', base: 'USD', symbols: 'EUR' },
      },
    ],
  },
  {
    name: 'crypto',
    description: 'CoinGecko — cryptocurrency prices and market data.',
    base_url: 'https://api.coingecko.com/api/v3',
    auth_type: 'header',
    auth_header: 'x-cg-demo-api-key',
    auth_optional: true,
    secret_hint: 'Optional. A free CoinGecko demo key raises the anonymous limit of roughly 10 calls a minute.',
    headers: [UA],
    notes: 'Coins are identified by CoinGecko ids ("bitcoin", "ethereum"), not tickers — use `search` if you only have a symbol.',
    operations: [
      {
        id: 'price',
        description: 'Current price of one or more coins in one or more currencies.',
        path: '/simple/price',
        params: [
          { name: 'ids', in: 'query', type: 'string', required: true, description: 'Comma-separated CoinGecko ids, e.g. bitcoin,ethereum.' },
          { name: 'vs_currencies', in: 'query', type: 'string', description: 'Comma-separated fiat codes.', default: 'usd' },
          { name: 'include_24hr_change', in: 'query', type: 'boolean', description: 'Include the 24-hour move.' },
        ],
        sample: { ids: 'bitcoin,ethereum', vs_currencies: 'usd,eur' },
      },
      {
        id: 'search',
        description: 'Resolve a name or ticker to a CoinGecko id.',
        path: '/search',
        params: [{ name: 'query', in: 'query', type: 'string', required: true, description: 'Name or symbol.' }],
        sample: { query: 'solana' },
      },
    ],
  },
  {
    name: 'earthquakes',
    description: 'USGS — earthquakes worldwide, filtered by magnitude, time and place.',
    base_url: 'https://earthquake.usgs.gov/fdsnws/event/1',
    headers: [UA],
    operations: [
      {
        id: 'recent',
        description: 'Recent quakes as GeoJSON features, newest first.',
        path: '/query',
        query: [
          { key: 'format', value: 'geojson' },
          { key: 'orderby', value: 'time' },
        ],
        params: [
          { name: 'limit', in: 'query', type: 'number', description: 'How many events.', default: '10' },
          { name: 'minmagnitude', in: 'query', type: 'number', description: 'Smallest magnitude to include.', default: '4.5' },
          { name: 'starttime', in: 'query', type: 'string', description: 'ISO date to start from.' },
          { name: 'latitude', in: 'query', type: 'number', description: 'Centre of a radius search.' },
          { name: 'longitude', in: 'query', type: 'number', description: 'Centre of a radius search.' },
          { name: 'maxradiuskm', in: 'query', type: 'number', description: 'Radius around that centre, in km.' },
        ],
        sample: { limit: 2, minmagnitude: 5 },
      },
    ],
  },
  {
    name: 'holidays',
    description: 'Nager.Date — public holidays for a country and year.',
    base_url: 'https://date.nager.at/api/v3',
    headers: [UA],
    operations: [
      {
        id: 'public_holidays',
        description: 'Every public holiday in one country for one year, with local and English names.',
        path: '/PublicHolidays/{year}/{country}',
        params: [
          { name: 'year', in: 'path', type: 'number', required: true, description: 'Four-digit year.' },
          { name: 'country', in: 'path', type: 'string', required: true, description: 'Two-letter country code, e.g. FR, US, JP.' },
        ],
        sample: { year: 2026, country: 'FR' },
      },
    ],
  },
  {
    name: 'worldtime',
    description: 'TimeAPI — the current local time, offset and DST state in any IANA timezone.',
    base_url: 'https://timeapi.io/api',
    headers: [UA],
    operations: [
      {
        id: 'current',
        description: 'Current date and time in one timezone.',
        path: '/Time/current/zone',
        params: [{ name: 'timeZone', in: 'query', type: 'string', required: true, description: 'IANA zone, e.g. Europe/Paris.' }],
        sample: { timeZone: 'Asia/Tokyo' },
      },
    ],
  },
  {
    name: 'ipinfo',
    description: 'ipapi.co — what an IP address resolves to: city, country, network operator and timezone.',
    base_url: 'https://ipapi.co',
    headers: [UA],
    notes: 'Free tier is roughly 1000 lookups a day per IP. Geolocation of an IP is approximate and often wrong at city level.',
    operations: [
      {
        id: 'lookup',
        description: 'Location and network details for one IP address.',
        path: '/{ip}/json/',
        params: [{ name: 'ip', in: 'path', type: 'string', required: true, description: 'IPv4 or IPv6 address.' }],
        sample: { ip: '8.8.8.8' },
      },
    ],
  },
  {
    name: 'wayback',
    description: 'Internet Archive — whether a URL has an archived snapshot, and a link to the closest one in time.',
    base_url: 'https://archive.org',
    headers: [UA],
    notes: 'Use it when a page is dead or has changed: get the snapshot URL here, then read it with `webfetch`.',
    operations: [
      {
        id: 'available',
        description: 'The closest archived snapshot of a URL, if one exists.',
        path: '/wayback/available',
        params: [
          { name: 'url', in: 'query', type: 'string', required: true, description: 'The page to look for.' },
          { name: 'timestamp', in: 'query', type: 'string', description: 'Target moment as YYYYMMDD or YYYYMMDDhhmmss; the nearest snapshot is returned.' },
        ],
        sample: { url: 'example.com' },
      },
    ],
  },
  {
    name: 'words',
    description: 'Datamuse — find words by meaning, sound or context: synonyms, rhymes, "the word that means X".',
    base_url: 'https://api.datamuse.com',
    headers: [UA],
    notes: 'Every parameter is a different question; pass one at a time. Returns words ranked by fit, no definitions.',
    operations: [
      {
        id: 'find',
        description: 'Words matching a constraint — meaning, sound, spelling or context.',
        path: '/words',
        params: [
          { name: 'ml', in: 'query', type: 'string', description: 'Means like: words with a similar meaning.' },
          { name: 'sl', in: 'query', type: 'string', description: 'Sounds like.' },
          { name: 'sp', in: 'query', type: 'string', description: 'Spelled like — supports * and ?.' },
          { name: 'rel_trg', in: 'query', type: 'string', description: 'Words statistically associated with this one.' },
          { name: 'topics', in: 'query', type: 'string', description: 'Bias results toward a subject.' },
          { name: 'max', in: 'query', type: 'number', description: 'How many words.', default: '10' },
        ],
        sample: { ml: 'happy', max: 5 },
      },
    ],
  },
];

/** Preset lookup by name, for the installer. */
export const BUILTIN_BY_NAME = new Map(BUILTIN_APIS.map((a) => [a.name, a]));
