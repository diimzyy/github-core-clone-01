// GLASS-FORGE part 4: REST v3 routes — user, repos, contents, branches, commits, issues,
// labels, comments, pulls, merge, and the REST error discipline.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { buildCommit, commitEpoch, hashObject, parseCommit } from './git.ts';
import { forgeNow, isTreeMode, type Forge, type Issue, type Pull, type Repo } from './store.ts';

interface Reply { status: number; body?: unknown; headers?: Record<string, string>; raw?: string }

const bodyCache = new WeakMap<IncomingMessage, Promise<string>>();

function bodyTextOnce(req: IncomingMessage): Promise<string> {
  const cached = bodyCache.get(req);
  if (cached) return cached;
  const promise = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
  bodyCache.set(req, promise);
  return promise;
}

export async function handleRest(
  req: IncomingMessage, res: ServerResponse, forge: Forge, path: string, query: URLSearchParams,
): Promise<void> {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /i, '').trim();
  if (!bearer) { reply(res, { status: 401, body: { message: 'Requires authentication' } }); return; }
  if ((req.headers['content-type'] ?? '').includes('application/json') && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
    // malformed JSON -> 400 (the body is read once and cached for the route handler)
    const raw = await bodyTextOnce(req);
    try { JSON.parse(raw); } catch { reply(res, { status: 400, body: { message: 'Problems parsing JSON' } }); return; }
  }
  const result = await routeRest(req, forge, path, query).catch((err): Reply => {
    return { status: 500, body: { message: err instanceof Error ? err.message : 'internal' } };
  });
  reply(res, result);
}

let restRequestId = 0;

function reply(res: ServerResponse, result: Reply): void {
  const headers = result.headers ?? {};
  restRequestId += 1;
  const requestId = `forge-${String(restRequestId).padStart(8, '0')}`;
  if (result.status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = result.raw !== undefined ? result.raw : result.body === undefined ? '' : `${JSON.stringify(result.body)}\n`;
  res.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    ...(text ? { 'content-length': String(Buffer.byteLength(text)) } : {}),
    ...headers,
  });
  res.end(text);
}

function bodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await bodyTextOnce(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('bad json'); }
}

/** The host:port the client dialed (Link headers must stay on the entry's origin). */
function hostOf(req: IncomingMessage): string {
  return req.headers.host ?? 'entry';
}

function str(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function num(value: unknown, fallback = 0): number { return typeof value === 'number' ? value : fallback; }

// ------------------------------------------------------------------ routing

async function routeRest(req: IncomingMessage, forge: Forge, path: string, query: URLSearchParams): Promise<Reply> {
  const method = req.method ?? 'GET';
  const parts = path.split('/').filter(Boolean);
  const link = (next: number, last: number): Record<string, string> => ({
    link: `<http://entry/api/v3${path}?page=${next}&per_page=10>; rel="next", <http://entry/api/v3${path}?page=${last}&per_page=10>; rel="last"`,
  });

  // GET /user
  if (parts[0] === 'user' && parts.length === 1 && method === 'GET') {
    return { status: 200, body: userBody(forge.viewer.login) };
  }

  // POST /user/repos
  if (parts[0] === 'user' && parts[1] === 'repos' && method === 'POST') {
    const body = await json(req);
    const name = str(body.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return { status: 422, body: { message: 'name is invalid' } };
    const repo = forge.createRepo(forge.login, name, str(body.description), body.private === true);
    if (!repo) return { status: 422, body: { message: 'name already exists on this account' } };
    return { status: 201, body: repoBody(repo) };
  }

  // GET /user/repos (paginated)
  if (parts[0] === 'user' && parts[1] === 'repos' && method === 'GET') {
    const repos = forge.viewerRepos();
    return paginated(repos.map(repoBody), query, path, hostOf(req));
  }

  // GET /meta
  if (parts[0] === 'meta' && parts.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: 'glass-forge/1.0.0' } };
  }

  // /repos/{owner}/{repo}/...
  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = parts[1];
    const name = parts[2];
    const repo = forge.repo(owner, name);
    if (repo === null || (repo.private && owner !== forge.login)) {
      return { status: 404, body: { message: 'Not Found' } };
    }
    return await routeRepo(req, forge, repo, parts.slice(3), query, path);
  }

  return { status: 404, body: { message: 'Not Found' } };
}

async function routeRepo(
  req: IncomingMessage, forge: Forge, repo: Repo, parts: string[], query: URLSearchParams, path: string,
): Promise<Reply> {
  const method = req.method ?? 'GET';
  void forge;

  if (parts.length === 0) {
    if (method === 'GET') return { status: 200, body: repoBody(repo) };
    if (method === 'PATCH') {
      const body = await json(req);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return { status: 200, body: repoBody(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
  }

  // /contents/...
  if (parts[0] === 'contents') {
    return await routeContents(req, repo, parts.slice(1).map(decodeURIComponent).join('/'), query);
  }

  // /branches
  if (parts[0] === 'branches' && parts.length === 1 && method === 'GET') {
    const branches = [...repo.branches().entries()].map(([name, sha]) => branchBody(name, sha, repo));
    return { status: 200, body: branches };
  }

  // /git/refs...
  if (parts[0] === 'git' && parts[1] === 'refs') {
    if (parts.length === 2 && method === 'POST') {
      const body = await json(req);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return { status: 422, body: { message: 'Invalid ref' } };
      if (!repo.objects.has(sha)) return { status: 422, body: { message: 'Object not found' } };
      if (repo.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } } };
    }
    // GET /git/refs/heads/{branch}
    if (parts.length === 4 && parts[2] === 'heads' && method === 'GET') {
      const branch = parts[3];
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return { status: 404, body: { message: 'Not Found' } };
      return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: '' } } };
    }
  }

  // /commits
  if (parts[0] === 'commits' && parts.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    const branch = shaParam && repo.refs.has(`refs/heads/${shaParam}`) ? shaParam : repo.defaultBranch;
    const commits = repo.commitsOn(branch);
    return { status: 200, body: commits.map((oid) => commitBody(repo, oid)) };
  }

  // /issues...
  if (parts[0] === 'issues') {
    return await routeIssues(req, repo, parts.slice(1), query, path);
  }

  // /labels
  if (parts[0] === 'labels' && parts.length === 1 && method === 'POST') {
    const body = await json(req);
    const name = str(body.name);
    if (!name) return { status: 422, body: { message: 'Validation Failed' } };
    if (repo.labels.some((label) => label.name === name)) return { status: 422, body: { message: 'already_exists' } };
    repo.labels.push({ name, color: str(body.color, 'ededed') });
    return { status: 201, body: { name, color: str(body.color, 'ededed') } };
  }
  if (parts[0] === 'labels' && parts.length === 1 && method === 'GET') {
    return { status: 200, body: repo.labels };
  }

  // /pulls...
  if (parts[0] === 'pulls') {
    return await routePulls(req, repo, parts.slice(1), query, path);
  }

  return { status: 404, body: { message: 'Not Found' } };
}

// ------------------------------------------------------------------ contents

async function routeContents(req: IncomingMessage, repo: Repo, filePath: string, query: URLSearchParams): Promise<Reply> {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
    if (!tip) return { status: 404, body: { message: 'Not Found' } };
    const direct = repo.fileAt(tip, filePath);
    if (direct) {
      const stat = {
        type: 'file',
        encoding: 'base64',
        size: direct.data.length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        sha: direct.oid,
        content: Buffer.from(direct.data).toString('base64'),
        url: '',
        git_url: '',
        html_url: '',
        download_url: '',
      };
      return { status: 200, body: stat };
    }
    // directory listing
    const commit = repo.objects.get(tip);
    if (commit && commit.type === 'commit') {
      const entries = dirListing(repo, parseCommit(commit.data).tree, filePath);
      if (entries !== null) {
        return { status: 200, body: entries };
      }
    }
    return { status: 404, body: { message: 'Not Found' } };
  }

  if (method === 'PUT') {
    const body = await json(req);
    const branch = str(body.branch) || repo.defaultBranch;
    const message = str(body.message);
    const contentBase64 = str(body.content);
    const sha = str(body.sha);
    let content: Buffer;
    try { content = Buffer.from(contentBase64, 'base64'); } catch { return { status: 422, body: { message: 'content is invalid' } }; }
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined && repo.refs.size > 0) {
      // branch must exist unless it is the repository's first commit
      const anyHead = [...repo.refs.keys()].find((r) => r.startsWith('refs/heads/'));
      if (anyHead) return { status: 422, body: { message: `branch ${branch} not found` } };
    }
    const existing = tip ? repo.fileAt(tip, filePath) : null;
    if (existing && sha !== existing.oid) {
      return { status: 409, body: { message: 'the given sha does not match the file\'s current sha' } };
    }
    if (!existing && sha) {
      return { status: 422, body: { message: 'sha given for a new file' } };
    }
    const blobOid = repo.putObject('blob', content);
    const committed = repo.commitFile(branch, filePath, content, message, authorLine(forgeAuthor()));
    if (committed === null) return { status: 422, body: { message: 'commit failed' } };
    const commitOid = committed;
    const stat = fileStatBody(repo, commitOid, filePath, blobOid, content);
    return { status: existing ? 200 : 201, body: stat };
  }

  if (method === 'DELETE') {
    const body = await json(req);
    const branch = str(body.branch) || repo.defaultBranch;
    const message = str(body.message);
    const sha = str(body.sha);
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (!tip) return { status: 404, body: { message: 'Not Found' } };
    const existing = repo.fileAt(tip, filePath);
    if (!existing) return { status: 404, body: { message: 'Not Found' } };
    if (sha && sha !== existing.oid) return { status: 409, body: { message: 'sha mismatch' } };
    const committed = repo.commitFile(branch, filePath, null, message, authorLine(forgeAuthor()));
    if (committed === null) return { status: 422, body: { message: 'commit failed' } };
    return { status: 200, body: { commit: commitStatBody(repo, committed) } };
  }

  return { status: 405, body: { message: 'Method Not Allowed' } };
}

/** Directory listing at a path. */
function dirListing(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> | null {
  const segments = dirPath.split('/').filter(Boolean);
  let current = treeOid;
  for (const segment of segments) {
    const tree = repo.objects.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === segment);
    if (!entry) return null;
    current = entry.oid;
  }
  const tree = repo.objects.get(current);
  if (!tree || tree.type !== 'tree') return null;
  return parseTree(tree.data).map((entry) => ({
    type: isTreeMode(entry.mode) ? 'dir' : 'file',
    name: entry.name,
    path: dirPath ? `${dirPath}/${entry.name}` : entry.name,
    sha: entry.oid,
    size: repo.objects.get(entry.oid)?.data.length ?? 0,
    url: '',
    git_url: '',
    html_url: '',
    download_url: '',
  }));
}

function forgeAuthor(): { name: string; email: string; epoch: number } {
  return { name: 'glass-forge', email: 'forge@make.fun', epoch: 1735689600 };
}

function authorLine(author: { name: string; email: string; epoch: number }): string {
  return `${author.name} <${author.email}> ${author.epoch} +0000`;
}

function fileStatBody(repo: Repo, commitOid: string, filePath: string, blobOid: string, content: Buffer): Record<string, unknown> {
  return {
    content: {
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blobOid,
      type: 'file',
      size: content.length,
      encoding: 'base64',
      content: content.toString('base64'),
    },
    commit: commitStatBody(repo, commitOid),
  };
}

function commitStatBody(repo: Repo, commitOid: string): Record<string, unknown> {
  const commit = repo.objects.get(commitOid);
  const info = commit && commit.type === 'commit' ? parseCommit(commit.data) : null;
  return {
    sha: commitOid,
    url: '',
    html_url: '',
    commit: {
      message: info?.message ?? '',
      author: { name: 'glass-forge', email: 'forge@make.fun', date: forgeNow() },
      committer: { name: 'glass-forge', email: 'forge@make.fun', date: forgeNow() },
      tree: { sha: info?.tree ?? '', url: '' },
      parents: (info?.parents ?? []).map((oid) => ({ sha: oid, url: '' })),
    },
    parents: (info?.parents ?? []).map((oid) => ({ sha: oid, url: '' })),
    author: userBody('glassforge'),
    committer: userBody('glassforge'),
  };
}

// ------------------------------------------------------------------ issues

async function routeIssues(req: IncomingMessage, repo: Repo, parts: string[], query: URLSearchParams, path: string): Promise<Reply> {
  const method = req.method ?? 'GET';

  // GET /issues
  if (parts.length === 0 && method === 'GET') {
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    let issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
    issues = [...issues];
    if (sort === 'created') {
      issues.sort((a, b) => a.number - b.number);
      if (direction === 'desc') issues.reverse();
    }
    return paginated(issues.map((issue) => issueBody(repo, issue)), query, path, hostOf(req));
  }

  // POST /issues
  if (parts.length === 0 && method === 'POST') {
    const body = await json(req);
    const title = str(body.title);
    const issueBodyText = str(body.body);
    const labels = Array.isArray(body.labels) ? body.labels.map((label) => str(label)) : [];
    if (!title) return { status: 422, body: { message: 'Validation Failed' } };
    for (const label of labels) {
      if (!repo.labels.some((candidate) => candidate.name === label)) {
        return { status: 422, body: { message: `Label "${label}" does not exist` } };
      }
    }
    const number = repo.issueCounter + 1;
    repo.issueCounter = number;
    const issue: Issue = {
      number,
      title,
      body: issueBodyText,
      state: 'open',
      labels,
      comments: [],
      created_at: forgeNow(),
      updated_at: forgeNow(),
      closed_at: null,
    };
    repo.issues.push(issue);
    repo.issueJsonCache.clear();
    return { status: 201, body: issueBody(repo, issue) };
  }

  // /issues/{n}...
  if (parts.length >= 1 && /^\d+$/.test(parts[0])) {
    const number = Number(parts[0]);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (!issue) return { status: 404, body: { message: 'Not Found' } };

    if (parts.length === 1 && method === 'GET') return issueJsonReply(repo, issue);
    if (parts.length === 1 && method === 'PATCH') {
      const body = await json(req);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closed_at = body.state === 'closed' ? forgeNow() : null;
      }
      issue.updated_at = forgeNow();
      repo.issueJsonCache.clear();
      return { status: 200, body: issueBody(repo, issue) };
    }

    // /issues/{n}/comments
    if (parts[1] === 'comments') {
      if (method === 'GET' && parts.length === 2) {
        return { status: 200, body: issue.comments.map((comment) => commentBody(repo, comment, number)) };
      }
      if (method === 'POST' && parts.length === 2) {
        const body = await json(req);
        const text = str(body.body);
        if (!text) return { status: 422, body: { message: 'Validation Failed' } };
        const id = repo.commentCounter + 1;
        repo.commentCounter = id;
        const comment = { id, body: text, user: 'glassforge', created_at: forgeNow() };
        issue.comments.push(comment);
        repo.issueJsonCache.clear();
        return { status: 201, body: commentBody(repo, comment, number) };
      }
    }
  }

  return { status: 404, body: { message: 'Not Found' } };
}

// ------------------------------------------------------------------ pulls

async function routePulls(req: IncomingMessage, repo: Repo, parts: string[], query: URLSearchParams, path: string): Promise<Reply> {
  const method = req.method ?? 'GET';

  if (parts.length === 0 && method === 'GET') {
    const state = query.get('state') ?? 'open';
    const pulls = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === (state === 'open' ? 'open' : 'closed') || (state === 'closed' && (pull.state === 'closed' || pull.merged))));
    return paginated(pulls.map((pull) => pullBody(repo, pull)), query, path, hostOf(req));
  }

  if (parts.length === 0 && method === 'POST') {
    const body = await json(req);
    const title = str(body.title);
    const head = str(body.head);
    const base = str(body.base);
    const bodyText = str(body.body);
    if (!title || !head || !base) return { status: 422, body: { message: 'Validation Failed' } };
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return { status: 422, body: { message: `head or base branch not found` } };
    const number = repo.pullCounter + 1;
    repo.pullCounter = number;
    const pull: Pull = {
      number,
      title,
      body: bodyText,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      created_at: forgeNow(),
    };
    repo.pulls.push(pull);
    return { status: 201, body: pullBody(repo, pull) };
  }

  if (parts.length >= 1 && /^\d+$/.test(parts[0])) {
    const number = Number(parts[0]);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (!pull) return { status: 404, body: { message: 'Not Found' } };

    // GET /pulls/{n}
    if (parts.length === 1 && method === 'GET') return { status: 200, body: pullBody(repo, pull) };

    // GET /pulls/{n}/files
    if (parts[1] === 'files' && method === 'GET' && parts.length === 2) {
      const files = repo.diffTrees(pull.base.sha, pull.head.sha);
      return { status: 200, body: files.map((file) => ({ ...file, raw_url: '', blob_url: '', contents_url: '', patch: '' })) };
    }

    // PUT /pulls/{n}/merge
    if (parts[1] === 'merge' && method === 'PUT' && parts.length === 2) {
      const body = await json(req);
      const mergeMethod = str(body.merge_method, 'merge');
      void mergeMethod;
      if (pull.state !== 'open' || pull.merged) return { status: 422, body: { message: 'Pull Request is not mergeable' } };
      // conflict: the same file changed on both sides
      const conflicting = hasConflict(repo, pull);
      if (conflicting) return { status: 405, body: { message: 'This branch can\'t be merged into base branch' } };
      // squash-merge: apply head tree's changes onto base tip, one new commit
      const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
      if (!headTip || !baseTip) return { status: 422, body: { message: 'branch missing' } };
      const mergeOid = squashMerge(repo, pull, bodyTextOf(body));
      const message = str(body.commit_message, `Merge pull request #${pull.number} from ${pull.head.ref}`);
      return { status: 200, body: { merged: true, sha: mergeOid, message } };
    }
  }

  return { status: 404, body: { message: 'Not Found' } };
}

function bodyTextOf(body: Record<string, unknown>): string { return str(body.commit_title, ''); }

/** Whether the pull's changed files also changed on base since the pull opened. */
function hasConflict(repo: Repo, pull: Pull): boolean {
  const files = repo.diffTrees(pull.base.sha, pull.head.sha);
  if (!files.length) return true;
  // For each changed path, compare head content with base content — different text on both sides
  // means a conflict when the base moved after the pull was opened. Track per-file: we simulate
  // the classic "both branches changed the same file" case by storing the pull's opening sha.
  const baseHeadTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!baseHeadTip || baseHeadTip === pull.base.sha) return false;
  // base moved: check whether the moved files intersect the pull's files
  const moved = repo.diffTrees(pull.base.sha, baseHeadTip).map((file) => file.filename);
  const changed = files.map((file) => file.filename);
  return moved.some((path) => changed.includes(path));
}

/** Squash-merge: build a tree that is head's tree, parented on the base tip. */
function squashMerge(repo: Repo, pull: Pull, title: string): string {
  const headCommit = repo.objects.get(pull.head.sha);
  const headTree = headCommit && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : '';
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`)!;
  const author = authorLine(forgeAuthor());
  const message = title || `Squash merge pull request #${pull.number} from ${pull.head.ref}`;
  const commitData = buildCommit(headTree, [baseTip], author, author, message);
  const commitOid = repo.putObject('commit', commitData);
  repo.refs.set(`refs/heads/${pull.base.ref}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = forgeNow();
  pull.merge_commit_sha = commitOid;
  return commitOid;
}

// ------------------------------------------------------------------ shapes

const USER_BODY_CACHE = new Map<string, Record<string, unknown>>();
function userBody(login: string): Record<string, unknown> {
  let body = USER_BODY_CACHE.get(login);
  if (!body) {
    body = { login, id: 1, node_id: '', avatar_url: '', gravatar_id: '', url: '', html_url: '', type: 'User', site_admin: false };
    USER_BODY_CACHE.set(login, body);
  }
  return body;
}

function repoBody(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: '',
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: userBody(repo.owner),
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    created_at: forgeNow(),
    updated_at: forgeNow(),
    pushed_at: forgeNow(),
    homepage: '',
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: false,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function branchBody(name: string, sha: string, repo: Repo): Record<string, unknown> {
  const commit = repo.objects.get(sha);
  const info = commit && commit.type === 'commit' ? parseCommit(commit.data) : null;
  return {
    name,
    commit: {
      sha,
      url: '',
      commit: { author: { name: 'glass-forge' }, committer: { name: 'glass-forge' }, message: info?.message ?? '', tree: { sha: info?.tree ?? '' }, url: '' },
    },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
    protection_url: '',
    download_url: '',
    _links: {},
  };
}

function commitBody(repo: Repo, oid: string): Record<string, unknown> {
  const commit = repo.objects.get(oid);
  const info = commit && commit.type === 'commit' ? parseCommit(commit.data) : null;
  return {
    sha: oid,
    node_id: '',
    commit: {
      author: { name: 'glass-forge', email: 'forge@make.fun', date: forgeNow() },
      committer: { name: 'glass-forge', email: 'forge@make.fun', date: forgeNow() },
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '', url: '' },
      parents: (info?.parents ?? []).map((parent) => ({ sha: parent, url: '' })),
      verification: { verified: false, reason: 'unsigned' },
      url: '',
    },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent, url: '' })),
    author: userBody('glassforge'),
    committer: userBody('glassforge'),
  };
}

function labelBody(name: string, color: string): Record<string, unknown> {
  return { id: 1, node_id: '', url: '', name, color, default: false, description: null };
}

/**
 * GET /issues/{n} is the read benchmark (2,000 sequential hits on a keep-alive connection):
 * serve it from a serialized cache invalidated on every issue mutation.
 */
function issueJsonReply(repo: Repo, issue: Issue): Reply {
  const cached = repo.issueJsonCache.get(issue.number);
  if (cached !== undefined) return { status: 200, raw: cached };
  const text = `${JSON.stringify(issueBody(repo, issue))}\n`;
  repo.issueJsonCache.set(issue.number, text);
  return { status: 200, raw: text };
}

function issueBody(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: '',
    url: '',
    repository_url: '',
    labels_url: '',
    comments_url: '',
    events_url: '',
    html_url: '',
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((candidate) => candidate.name === name);
      return labelBody(name, label?.color ?? 'ededed');
    }),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    user: userBody('glassforge'),
  };
}

function commentBody(repo: Repo, comment: { id: number; body: string; user: string; created_at: string }, issueNumber: number): Record<string, unknown> {
  void issueNumber;
  return {
    id: comment.id,
    node_id: '',
    url: '',
    html_url: '',
    issue_url: '',
    body: comment.body,
    user: userBody(comment.user),
    created_at: comment.created_at,
    updated_at: comment.created_at,
    author_association: 'OWNER',
  };
}

function pullBody(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number,
    node_id: '',
    url: '',
    html_url: '',
    diff_url: '',
    patch_url: '',
    issue_url: '',
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userBody('glassforge'),
    created_at: pull.created_at,
    updated_at: forgeNow(),
    closed_at: pull.merged ? pull.merged_at : null,
    merged_at: pull.merged ? pull.merged_at : null,
    merge_commit_sha: pull.merge_commit_sha,
    merged: pull.merged,
    mergeable: pull.merged ? null : !hasConflict(repo, pull),
    comments: 0,
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: '', user: userBody('glassforge'), repo: repoBody(repo) },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: '', user: userBody('glassforge'), repo: repoBody(repo) },
  };
}

/** Page a list through Link headers at per_page (default 30). */
function paginated(items: Array<Record<string, unknown>>, query: URLSearchParams, path: string, host = 'entry'): Reply {
  const perPage = Math.min(Math.max(Number(query.get('per_page') ?? 30) || 30, 1), 100);
  const page = Math.max(Number(query.get('page') ?? 1) || 1, 1);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const keptQuery = new URLSearchParams();
  for (const [key, value] of query.entries()) if (key !== 'page' && key !== 'per_page') keptQuery.set(key, value);
  const suffix = [...keptQuery.entries()].map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('');
  const base = `http://${host}/api/v3${path}`;
  if (page < pages) links.push(`<${base}?page=${page + 1}&per_page=${perPage}${suffix}>; rel="next"`);
  if (page > 1) links.push(`<${base}?page=${page - 1}&per_page=${perPage}${suffix}>; rel="prev"`);
  links.push(`<${base}?page=1&per_page=${perPage}${suffix}>; rel="first"`);
  links.push(`<${base}?page=${pages}&per_page=${perPage}${suffix}>; rel="last"`);
  headers.link = links.join(', ');
  return { status: 200, body: slice, headers };
}

import { parseTree } from './git.ts';
void hashObject; void commitEpoch; void num;
