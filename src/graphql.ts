// GLASS-FORGE part 5: GraphQL v4 at /api/graphql — a small document parser and the resolvers
// for the gh/github-mcp-server document set the conformance suite sends.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { buildCommit, parseCommit } from './git.ts';
import { forgeNow, type Forge, type Issue, type Pull, type Repo } from './store.ts';

// ------------------------------------------------------------------ request

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  const raw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  let body: unknown;
  try { body = JSON.parse(raw); } catch {
    finish(res, 200, { errors: [{ message: 'Parse error' }] });
    return;
  }
  // batching: an array of documents
  const documents: unknown[] = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const document of documents) {
    const single = typeof document === 'object' && document !== null ? document as Record<string, unknown> : {};
    const query = typeof single.query === 'string' ? single.query : '';
    const variables = (typeof single.variables === 'object' && single.variables !== null ? single.variables : {}) as Record<string, unknown>;
    const operationName = typeof single.operationName === 'string' ? single.operationName : null;
    results.push(execute(query, variables, operationName, forge));
  }
  finish(res, 200, Array.isArray(body) ? results : results[0]);
}

function finish(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

// ------------------------------------------------------------------ parser

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  children: FieldNode[];
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  definitions: FieldNode[];
}

/** Parse a GraphQL document (queries and mutations with fields, args, aliases, nesting). */
export function parseDocument(source: string): Operation[] {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (): string => tokens[pos] ?? '';
  const eat = (): string => tokens[pos++] ?? '';
  const expect = (value: string): void => {
    if (peek() !== value) throw new Error(`expected ${value}, got ${peek()}`);
    pos += 1;
  };

  const operations: Operation[] = [];
  while (pos < tokens.length) {
    if (peek() === '{') {
      // anonymous shorthand query
      const definitions = parseSelectionSet();
      operations.push({ kind: 'query', name: null, definitions });
      continue;
    }
    if (peek() === 'query' || peek() === 'mutation') {
      const kind = eat() as 'query' | 'mutation';
      let name: string | null = null;
      // operation name may be present; variable definitions in parens
      if (/^[A-Za-z]/.test(peek()) && peek() !== '{') name = eat();
      if (peek() === '(') skipBalanced(tokens, () => pos, (v) => { pos = v; }, eat);
      // parseSelectionSet() consumes the '{' itself
      const definitions = parseSelectionSet();
      operations.push({ kind, name, definitions });
    } else {
      pos += 1; // stray token between operations
    }
  }

  function parseSelectionSet(): FieldNode[] {
    expect('{');
    const fields: FieldNode[] = [];
    while (peek() !== '}' && pos < tokens.length) {
      if (peek() === ',') { eat(); continue; }
      // `... on X { }` inline fragments (the node probe)
      if (peek() === '...') {
        eat();
        if (peek() === 'on') { eat(); eat(); }
        if (peek() === '{') {
          const children = parseSelectionSet();
          fields.push({ alias: null, name: '...on', args: {}, children });
          continue;
        }
        continue;
      }
      let alias: string | null = null;
      let name = eat();
      if (peek() === ':') { eat(); alias = name; name = eat(); }
      let args: Record<string, unknown> = {};
      if (peek() === '(') {
        eat();
        args = parseArgs();
      }
      let children: FieldNode[] = [];
      if (peek() === '{') {
        children = parseSelectionSet();
      }
      fields.push({ alias, name, args, children });
    }
    expect('}');
    return fields;
  }

  function parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    while (peek() !== ')' && pos < tokens.length) {
      const key = eat();
      expect(':');
      args[key] = parseValue();
      if (peek() === ',') eat();
    }
    expect(')');
    return args;
  }

  function parseValue(): unknown {
    const token = peek();
    if (token === '{') {
      eat();
      const object: Record<string, unknown> = {};
      while (peek() !== '}' && pos < tokens.length) {
        const key = eat();
        expect(':');
        object[key] = parseValue();
        if (peek() === ',') eat();
      }
      expect('}');
      return object;
    }
    if (token === '[') {
      eat();
      const items: unknown[] = [];
      while (peek() !== ']' && pos < tokens.length) {
        items.push(parseValue());
        if (peek() === ',') eat();
      }
      expect(']');
      return items;
    }
    if (token.startsWith('$')) {
      eat();
      return { variable: token.slice(1) };
    }
    eat();
    if (token === 'null') return null;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^-?\d+$/.test(token)) return Number(token);
    return token.replace(/^"|"$/g, '');
  }

  return operations;
}

function skipBalanced(tokens: string[], get: () => number, set: (v: number) => void, eat: () => string): void {
  let depth = 0;
  eat(); // the '('
  depth = 1;
  while (depth > 0 && get() < tokens.length) {
    const token = eat();
    if (token === '(') depth += 1;
    else if (token === ')') depth -= 1;
  }
}

/** Tokenize: identifiers, punctuation, strings, numbers. */
function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (/[{}()\[\]:,]/.test(char)) { tokens.push(char); i += 1; continue; }
    if (char === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (char === '.' && source.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if (char === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += 1;
      tokens.push(source.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(char)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_.\-]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

// ------------------------------------------------------------------ execution

function execute(query: string, variables: Record<string, unknown>, operationName: string | null, forge: Forge): Record<string, unknown> {
  try {
    const operations = parseDocument(query);
    const wanted = (operationName ? operations.find((op) => op.name === operationName) : undefined) ?? operations[0];
    if (!wanted) return { errors: [{ message: 'no operation' }] };
    const root = wanted.kind === 'query' ? queryRoot(forge) : mutationRoot(forge);
    const data: Record<string, unknown> = {};
    for (const field of wanted.definitions) {
      const key = field.alias ?? field.name;
      if (field.name === '...on') continue;
      data[key] = resolveField(field, root, variables, forge);
    }
    return { data };
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** Resolve variables and enums inside parsed arg values. */
function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'variable' in (value as Record<string, unknown>)) {
    const name = (value as { variable: string }).variable;
    return variables[name] ?? null;
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

interface RootContext {
  readonly forge: Forge;
  kind: 'query' | 'mutation';
  repository?: Repo;
  issue?: { repo: Repo; issue: Issue };
  pull?: { repo: Repo; pull: Pull };
}

function queryRoot(forge: Forge): RootContext { return { forge, kind: 'query' }; }
function mutationRoot(forge: Forge): RootContext { return { forge, kind: 'mutation' }; }

function resolveField(field: FieldNode, context: RootContext, variables: Record<string, unknown>, forge: Forge): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, variables);
  const name = field.name;

  // viewer
  if (name === 'viewer') {
    for (const child of field.children) {
      if (!['login', '__typename', 'name', 'email', 'id'].includes(child.name)) {
        throw new GraphQLFieldError(`Cannot query field '${child.name}' on type 'User'`);
      }
    }
    return { login: forge.login, __typename: 'User' };
  }
  // repository(owner, name)
  if (name === 'repository') {
    const owner = String(args.owner ?? '');
    const repoName = String(args.name ?? '');
    const repo = forge.repo(owner, repoName);
    if (!repo) return null;
    return repositoryObject(repo, field.children, forge, variables);
  }
  // node(id)
  if (name === 'node') {
    const id = String(args.id ?? '');
    const match = /^repo:(\d+)$/.exec(id);
    if (match) {
      const repo = [...forge.repos.values()].find((candidate) => String(candidate.id) === match[1]);
      if (repo) return repositoryObject(repo, field.children, forge);
    }
    return null;
  }
  // __type(name)
  if (name === '__type') {
    return typeObject(String(args.name ?? ''), field.children);
  }
  // __schema
  if (name === '__schema') {
    return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
  }
  if (name === '__typename') return 'Query';

  // mutations
  if (name === 'createIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = repositoryIdOf(forge, String(input.repositoryId ?? ''));
    if (!repo) throw new Error('repository not found');
    const issue = createIssueOn(repo, String(input.title ?? ''), String(input.body ?? ''));
    return { issue: issueObject(repo, issue, field.children) };
  }
  if (name === 'closeIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = issueIdOf(forge, String(input.issueId ?? ''));
    if (!found) throw new Error('issue not found');
    found.issue.state = 'closed';
    found.repo.issueJsonCache.clear();
    found.issue.closed_at = forgeNow();
    return { issue: issueObject(found.repo, found.issue, field.children) };
  }
  if (name === 'createPullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = repositoryIdOf(forge, String(input.repositoryId ?? ''));
    if (!repo) throw new Error('repository not found');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) throw new Error('branch not found');
    const number = repo.pullCounter + 1;
    repo.pullCounter = number;
    const pull: Pull = {
      number, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open',
      merged: false, merged_at: null, merge_commit_sha: null,
      head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, created_at: forgeNow(),
    };
    repo.pulls.push(pull);
    return { pullRequest: pullObject(repo, pull, field.children) };
  }
  if (name === 'mergePullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = pullIdOf(forge, String(input.pullRequestId ?? ''));
    if (!found) throw new Error('pull not found');
    const { repo, pull } = found;
    if (pull.state !== 'open' || pull.merged) throw new Error('not mergeable');
    const merged = mergePullOn(repo, pull, String(input.mergeMethod ?? 'MERGE'));
    return { pullRequest: pullObject(repo, merged, field.children) };
  }
  if (name === 'addComment') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const subjectId = String(input.subjectId ?? '');
    const found = issueNumberFromSubject(forge, subjectId);
    if (!found) throw new Error('subject not found');
    const id = found.repo.commentCounter + 1;
    found.repo.commentCounter = id;
    const comment = { id, body: String(input.body ?? ''), user: forge.login, created_at: forgeNow() };
    found.issue.comments.push(comment);
    found.repo.issueJsonCache.clear();
    return { commentEdge: { node: { id: `comment:${id}`, body: comment.body } } };
  }

  return null;
}

class GraphQLFieldError extends Error {}

function repositoryObject(repo: Repo, children: FieldNode[], forge: Forge, variables: Record<string, unknown> = {}): Record<string, unknown> {
  const unknownFields: string[] = [];
  const varNumber = (field: FieldNode): number => {
    const raw = field.args.number;
    const value = raw !== null && typeof raw === 'object' && 'variable' in (raw as Record<string, unknown>)
      ? variables[(raw as { variable: string }).variable]
      : raw;
    return Number(value ?? 0) || 0;
  };
  const out: Record<string, unknown> = {
    id: `repo:${repo.id}`,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner, __typename: 'Organization' },
    __typename: 'Repository',
  };
  for (const child of children) {
    const key = child.alias ?? child.name;
    switch (child.name) {
      case 'defaultBranchRef': out[key] = repo.defaultBranch ? { name: repo.defaultBranch } : null; break;
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'description': out[key] = repo.description; break;
      case 'issue': {
        const number = varNumber(child);
        const issue = repo.issues.find((candidate) => candidate.number === number);
        out[key] = issue ? issueObject(repo, issue, child.children) : null;
        break;
      }
      case 'issues': out[key] = issueConnection(repo, child, variables); break;
      case 'pullRequests': out[key] = pullConnection(repo, child, variables); break;
      case 'pullRequest': {
        const number = varNumber(child);
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        out[key] = pull ? pullObject(repo, pull, child.children) : null;
        break;
      }
      case 'id': out[key] = out.id; break;
      case 'name': out[key] = out.name; break;
      case 'databaseId': out[key] = out.databaseId; break;
      case 'nameWithOwner': out[key] = out.nameWithOwner; break;
      case 'owner': out[key] = { login: repo.owner, __typename: 'Organization' }; break;
      default:
        if (child.name === '...on') {
          // an inline fragment's fields resolve against the same object
          const fragment = repositoryObject(repo, child.children, forge, variables);
          for (const [fragmentKey, value] of Object.entries(fragment)) out[fragmentKey] = value;
        } else {
          out[key] = null;
          unknownFields.push(child.name);
        }
        break;
    }
  }
  if (unknownFields.length) {
    throw new GraphQLFieldError(`Cannot query field '${unknownFields[0]}' on type 'Repository'`);
  }
  return out;
}

function issueConnection(repo: Repo, field: FieldNode, variables: Record<string, unknown> = {}): Record<string, unknown> {
  const resolved = (value: unknown): unknown => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'variable' in (value as Record<string, unknown>)) {
      return variables[(value as { variable: string }).variable] ?? null;
    }
    return value;
  };
  const first = Number(resolved(field.args.first) ?? 50) || 50;
  const after = resolved(field.args.after);
  const states = Array.isArray(field.args.states) ? field.args.states.map(String) : null;
  const orderBy = (resolved(field.args.orderBy) ?? {}) as Record<string, unknown>;
  const direction = String((orderBy as Record<string, unknown>).direction ?? 'DESC');
  let issues = repo.issues.filter((issue) => (states ? states.includes(issue.state.toUpperCase()) : true));
  issues = [...issues].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  // after: a cursor names the last node of the previous page
  if (typeof after === 'string' && after) {
    const match = /cursor:(\d+)$/.exec(after);
    if (match) {
      const lastNumber = Number(match[1]);
      issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > lastNumber : issue.number < lastNumber));
    }
  }
  const slice = issues.slice(0, first);
  return {
    nodes: slice.map((issue) => issueObject(repo, issue, field.children)),
    pageInfo: { hasNextPage: issues.length > first, endCursor: slice.length ? `cursor:${slice[slice.length - 1].number}` : null },
    totalCount: issues.length,
  };
}

function pullConnection(repo: Repo, field: FieldNode, variables: Record<string, unknown> = {}): Record<string, unknown> {
  const resolved = (value: unknown): unknown => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'variable' in (value as Record<string, unknown>)) {
      return variables[(value as { variable: string }).variable] ?? null;
    }
    return value;
  };
  const first = Number(resolved(field.args.first) ?? 50) || 50;
  const pulls = repo.pulls.slice(0, first);
  return { nodes: pulls.map((pull) => pullObject(repo, pull, field.children)), pageInfo: { hasNextPage: repo.pulls.length > first, endCursor: pulls.length ? `cursor:${pulls[pulls.length - 1].number}` : null }, totalCount: repo.pulls.length };
}

function issueObject(repo: Repo, issue: Issue, children: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: `issue:${repo.id}:${issue.number}`,
    databaseId: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    __typename: 'Issue',
  };
  for (const child of children) {
    const key = child.alias ?? child.name;
    switch (child.name) {
      case 'id': out[key] = out.id; break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'body': out[key] = issue.body; break;
      case 'state': out[key] = issue.state.toUpperCase(); break;
      case 'createdAt': out[key] = issue.created_at; break;
      case 'updatedAt': out[key] = issue.updated_at; break;
      default: out[key] = null; break;
    }
  }
  return out;
}

function pullObject(repo: Repo, pull: Pull, children: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: `pull:${repo.id}:${pull.number}`,
    databaseId: pull.number,
    number: pull.number,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: 'MERGEABLE',
    __typename: 'PullRequest',
  };
  for (const child of children) {
    const key = child.alias ?? child.name;
    if (child.name === 'files') {
      const files = repo.diffTrees(pull.base.sha, pull.head.sha);
      const first = Number(child.args.first ?? 50) || 50;
      out[key] = { nodes: files.slice(0, first).map((file) => ({ path: file.filename, __typename: 'PullRequestChangedFile' })) };
    } else if (child.name === 'mergedAt') {
      out[key] = pull.merged_at;
    } else if (child.name === 'mergeCommit') {
      out[key] = pull.merge_commit_sha ? { sha: pull.merge_commit_sha } : null;
    } else if (child.name === 'id') {
      out[key] = out.id;
    } else if (child.name === 'number') {
      out[key] = pull.number;
    } else if (child.name === 'state') {
      out[key] = pull.merged ? 'MERGED' : pull.state.toUpperCase();
    } else if (child.name === 'merged') {
      out[key] = pull.merged;
    } else if (child.name === 'title') {
      out[key] = pull.title;
    } else if (child.name === 'body') {
      out[key] = pull.body;
    } else if (child.name === 'headRefName') {
      out[key] = pull.head.ref;
    } else if (child.name === 'baseRefName') {
      out[key] = pull.base.ref;
    } else if (child.name === 'mergeable') {
      out[key] = 'MERGEABLE';
    } else {
      out[key] = null;
    }
  }
  return out;
}

function typeObject(name: string, children: FieldNode[]): Record<string, unknown> | null {
  const known = new Set(['Issue', 'PullRequest', 'Repository', 'SearchType', 'IssueState', 'MergeableState', 'PullRequestState', 'PullRequestMergeMethod', 'RepositoryPermission', 'IssueOrderField', 'OrderDirection']);
  if (!known.has(name)) return null;
  const out: Record<string, unknown> = { name, kind: 'OBJECT' };
  for (const child of children) {
    const key = child.alias ?? child.name;
    if (child.name === 'fields') {
      const fieldsByType: Record<string, string[]> = {
        Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
        PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'mergedAt'],
        Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
        SearchType: ['id', 'number', 'title', 'state', 'body'],
      };
      out[key] = (fieldsByType[name] ?? ['id', 'number', 'title', 'state', 'body']).map((field) => ({ name: field }));
    } else if (child.name === 'enumValues') {
      out[key] = enumValuesOf(name);
    } else {
      out[key] = null;
    }
  }
  return out;
}

function enumValuesOf(name: string): Array<{ name: string }> {
  const values: Record<string, string[]> = {
    IssueState: ['OPEN', 'CLOSED'],
    MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
    PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
    PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
    RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
    IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
    OrderDirection: ['ASC', 'DESC'],
    SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  };
  return (values[name] ?? []).map((value) => ({ name: value }));
}

// ------------------------------------------------------------------ id helpers

function repositoryIdOf(forge: Forge, id: string): Repo | null {
  const match = /^repo:(\d+)$/.exec(id);
  if (match) {
    const repo = [...forge.repos.values()].find((candidate) => String(candidate.id) === match[1]);
    if (repo) return repo;
  }
  // fallback: `owner/name`
  const [owner, name] = id.split('/');
  if (owner && name) return forge.repo(owner, name);
  return null;
}

function issueIdOf(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const match = /^issue:(\d+):(\d+)$/.exec(id);
  if (match) {
    const repo = [...forge.repos.values()].find((candidate) => String(candidate.id) === match[1]);
    const issue = repo?.issues.find((candidate) => candidate.number === Number(match[2]));
    if (repo && issue) return { repo, issue };
  }
  // a plain number is the issue's number in the fixture repository (REST reads it as the id)
  if (/^\d+$/.test(id)) {
    const number = Number(id);
    for (const repo of forge.repos.values()) {
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue) return { repo, issue };
    }
  }
  return null;
}

function pullIdOf(forge: Forge, id: string): { repo: Repo; pull: Pull } | null {
  const match = /^pull:(\d+):(\d+)$/.exec(id);
  if (match) {
    const repo = [...forge.repos.values()].find((candidate) => String(candidate.id) === match[1]);
    const pull = repo?.pulls.find((candidate) => candidate.number === Number(match[2]));
    if (repo && pull) return { repo, pull };
  }
  return null;
}

function issueNumberFromSubject(forge: Forge, subjectId: string): { repo: Repo; issue: Issue } | null {
  return issueIdOf(forge, subjectId);
}

function createIssueOn(repo: Repo, title: string, body: string): Issue {
  const number = repo.issueCounter + 1;
  repo.issueCounter = number;
  const issue: Issue = {
    number, title, body, state: 'open', labels: [], comments: [],
    created_at: forgeNow(), updated_at: forgeNow(), closed_at: null,
  };
  repo.issues.push(issue);
    repo.issueJsonCache.clear();
  return issue;
}

function mergePullOn(repo: Repo, pull: Pull, method: string): Pull {
  void method;
  // squash-style: apply head tree onto base
  const headCommit = repo.objects.get(pull.head.sha);
  const headTree = headCommit && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : '';
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`)!;
  const author = `glass-forge <forge@make.fun> 1735689600 +0000`;
  const commitData = buildCommit(headTree, [baseTip], author, author, `Merge pull request #${pull.number}`);
  const commitOid = repo.putObject('commit', commitData);
  repo.refs.set(`refs/heads/${pull.base.ref}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = forgeNow();
  pull.merge_commit_sha = commitOid;
  return pull;
}
