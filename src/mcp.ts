// GLASS-FORGE part 6: the MCP endpoint at /mcp — streamable HTTP, JSON-RPC 2.0.
// Modern era: `server/discover` (2026-07-28 revision), every request declares its revision in
// _meta + the MCP-Protocol-Version header. Legacy era fallback: initialize + notifications.
// Six tools: create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { buildCommit, parseCommit } from './git.ts';
import { forgeNow, type Forge, type Issue, type Pull, type Repo } from './store.ts';

const REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, forge: Forge, token: string | null): Promise<void> {
  if (token === null) {
    sendRpcError(res, 401, { message: 'Unauthorized' });
    return;
  }
  const raw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    // HTTP 400 + JSON-RPC -32700 parse error
    const body = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
    return;
  }
  const method = request.method ?? '';
  const id = request.id ?? null;
  const params = request.params ?? {};
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const revision = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
    ? meta['io.modelcontextprotocol/protocolVersion'] as string
    : (typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION);

  switch (method) {
    case 'server/discover': {
      sendResult(res, id, {
        serverInfo: { name: 'glass-forge', version: '1.0.0' },
        capabilities: { tools: {} },
        supportedVersions: [REVISION, ...LEGACY_REVISIONS],
      });
      return;
    }
    case 'initialize': {
      sendResult(res, id, {
        protocolVersion: revision,
        serverInfo: { name: 'glass-forge', version: '1.0.0' },
        capabilities: { tools: {} },
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled': {
      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
      res.end();
      return;
    }
    case 'tools/list': {
      sendResult(res, id, { tools: TOOLS });
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        // unknown tool: a JSON-RPC error, never HTTP 500
        sendRpcJsonRpcError(res, 200, id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const missing = requiredMissing(tool, args);
      if (missing) {
        sendRpcJsonRpcError(res, 200, id, -32602, `Missing required argument: ${missing}`);
        return;
      }
      const result = callTool(name, args, forge);
      if (result.error !== undefined) {
        sendRpcJsonRpcError(res, 200, id, -32602, result.error);
        return;
      }
      sendResult(res, id, {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 1) }],
        isError: false,
      });
      return;
    }
    default: {
      if (String(method).startsWith('notifications/')) {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
        res.end();
        return;
      }
      sendRpcJsonRpcError(res, 200, id, -32601, `Method not found: ${method}`);
      return;
    }
  }
}

function requiredMissing(tool: { name: string; inputSchema: { required?: string[] } }, args: Record<string, unknown>): string | null {
  for (const name of tool.inputSchema.required ?? []) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function sendResult(res: ServerResponse, id: unknown, result: unknown): void {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendRpcJsonRpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendRpcError(res: ServerResponse, status: number, error: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(error));
}

// ------------------------------------------------------------------ tools

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function callTool(name: string, args: Record<string, unknown>, forge: Forge): { value?: unknown; error?: string } {
  const owner = typeof args.owner === 'string' ? args.owner : forge.login;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');

  switch (name) {
    case 'create_repo': {
      const name = str(args.name);
      const repo = forge.createRepo(forge.login, name, str(args.description), args.private === true);
      if (!repo) return { error: `repository ${name} already exists` };
      return { value: repoSummary(repo) };
    }
    case 'get_repo': {
      const repo = forge.repo(owner, repoName);
      if (!repo) return { error: `repository ${owner}/${repoName} not found` };
      return { value: repoSummary(repo) };
    }
    case 'create_issue': {
      const repo = forge.repo(owner, repoName);
      if (!repo) return { error: `repository ${owner}/${repoName} not found` };
      const title = str(args.title);
      if (!title) return { error: 'title is required' };
      const number = repo.issueCounter + 1;
      repo.issueCounter = number;
      const issue: Issue = {
        number, title, body: str(args.body), state: 'open', labels: [], comments: [],
        created_at: forgeNow(), updated_at: forgeNow(), closed_at: null,
      };
      repo.issues.push(issue);
      return { value: issueSummary(repo, issue) };
    }
    case 'list_issues': {
      const repo = forge.repo(owner, repoName);
      if (!repo) return { error: `repository ${owner}/${repoName} not found` };
      const state = str(args.state) || 'open';
      return { value: repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state)).map((issue) => issueSummary(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = forge.repo(owner, repoName);
      if (!repo) return { error: `repository ${owner}/${repoName} not found` };
      const head = str(args.head);
      const base = str(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { error: 'head or base branch not found' };
      const number = repo.pullCounter + 1;
      repo.pullCounter = number;
      const pull: Pull = {
        number, title: str(args.title), body: str(args.body), state: 'open', merged: false,
        merged_at: null, merge_commit_sha: null, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha },
        created_at: forgeNow(),
      };
      repo.pulls.push(pull);
      return { value: pullSummary(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = forge.repo(owner, repoName);
      if (!repo) return { error: `repository ${owner}/${repoName} not found` };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return { error: `pull request ${number} not found` };
      if (pull.state !== 'open' || pull.merged) return { error: 'pull request is not mergeable' };
      const headCommit = repo.objects.get(pull.head.sha);
      const headTree = headCommit && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : '';
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
      if (!baseTip) return { error: 'base branch missing' };
      const author = 'glass-forge <forge@make.fun> 1735689600 +0000';
      const commitOid = repo.putObject('commit', buildCommit(headTree, [baseTip], author, author, `Merge pull request #${pull.number}`));
      repo.refs.set(`refs/heads/${pull.base.ref}`, commitOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = forgeNow();
      pull.merge_commit_sha = commitOid;
      return { value: pullSummary(repo, pull) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: repo.fullName, private: repo.private,
    description: repo.description, default_branch: repo.defaultBranch, owner: repo.owner,
  };
}

function issueSummary(repo: Repo, issue: Issue): Record<string, unknown> {
  return { id: issue.number, number: issue.number, title: issue.title, state: issue.state, body: issue.body, repository: repo.fullName };
}

function pullSummary(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number, number: pull.number, title: pull.title, state: pull.state, merged: pull.merged,
    head: { ref: pull.head.ref, sha: pull.head.sha }, base: { ref: pull.base.ref, sha: pull.base.sha },
    merge_commit_sha: pull.merge_commit_sha, repository: repo.fullName,
  };
}
