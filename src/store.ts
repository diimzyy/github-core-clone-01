// GLASS-FORGE part 2: the forge store — users, repos, refs, issues, pulls, labels, comments.
// All in-memory; ids deterministic from a monotonically increasing counter per repo.

import {
  buildCommit, buildTree, collectReachable, commitEpoch, commitList, hashObject,
  isAncestor, parseCommit, parseTree, ZERO_OID,
  type GitObject, type TreeEntry,
} from './git.ts';

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** git writes tree entries' mode as both '40000' and '040000'; both are directories. */
export function isTreeMode(mode: string): boolean {
  return mode === '040000' || mode === '40000';
}

export interface Label { name: string; color: string }

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: string;
  readonly created_at: string;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  created_at: string;
}

/** One repository: refs, objects, and its resource collections. */
export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  /** oid -> object, insertion-ordered. */
  readonly objects = new Map<string, GitObject>();
  /** full ref name -> oid. */
  readonly refs = new Map<string, string>();
  /** the peeled oid of annotated tag refs (ref -> peeled commit). */
  readonly peeled = new Map<string, string>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels: Label[] = [];
  issueCounter = 0;
  pullCounter = 0;
  commentCounter = 0;
  /** bumped on every issue/comment/label mutation; REST read paths key their JSON caches on it. */
  issueVersion = 0;
  /** issue number -> serialized issue JSON (the read benchmark hits GET /issues/{n} 2,000 times). */
  readonly issueJsonCache = new Map<number, string>();
  /** (baseSha, headSha) -> file list; pull listings and files endpoints re-diff every pull without this. */
  readonly diffCache = new Map<string, PullFile[]>();
  /** (baseSha, headSha) -> merge base tree result; the merge endpoint recomputed this per call. */
  readonly mergeCache = new Map<string, { sha: string }>();

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = 'main') {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.private = isPrivate;
    this.defaultBranch = defaultBranch;
  }

  get fullName(): string { return `${this.owner}/${this.name}`; }

  /** Insert an object if new; its oid. */
  putObject(type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** HEAD's symref target: the default branch when it exists, else the first branch. */
  headTarget(): string | null {
    if (this.refs.has(`refs/heads/${this.defaultBranch}`)) return `refs/heads/${this.defaultBranch}`;
    for (const name of this.refs.keys()) if (name.startsWith('refs/heads/')) return name;
    return null;
  }

  /** branch name -> tip oid (heads only). */
  branches(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, oid] of this.refs) if (name.startsWith('refs/heads/')) out.set(name.slice('refs/heads/'.length), oid);
    return out;
  }

  /** tag name -> oid (tags only). */
  tags(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, oid] of this.refs) if (name.startsWith('refs/tags/')) out.set(name.slice('refs/tags/'.length), oid);
    return out;
  }

  /** All commits reachable from a branch, newest first. */
  commitsOn(branch: string): string[] {
    const tip = this.refs.get(`refs/heads/${branch}`);
    if (!tip) return [];
    return commitList(this.objects, [tip]);
  }

  /** The tree entries at a path on a commit; null when the path is absent. */
  treeAt(commitOid: string): TreeEntry[] | null {
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const tree = this.objects.get(parseCommit(commit.data).tree);
    if (!tree || tree.type !== 'tree') return null;
    return parseTree(tree.data);
  }

  /** Resolve a nested path to { entry, oid, data } on a commit; null when absent or a directory. */
  fileAt(commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entries = parseTree(tree.data);
      const entry = entries.find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (isTreeMode(entry.mode)) return null; // a directory, not a file
        const object = this.objects.get(entry.oid);
        if (!object) return null;
        return { oid: entry.oid, data: object.data };
      }
      treeOid = entry.oid;
    }
    return null;
  }

  /** Create/update/delete a file on a branch through a new commit; the commit sha. */
  commitFile(branch: string, path: string, content: Buffer | null, message: string, author: string): string | null {
    const branchRef = `refs/heads/${branch}`;
    const parent = this.refs.get(branchRef);
    const commit = parent ? this.objects.get(parent) : null;
    const treeOid = commit && commit.type === 'commit' ? parseCommit(commit.data).tree : null;
    // Build the new tree: walk to the path's directory, splice the entry.
    const newTree = this.splicePath(treeOid, path.split('/').filter(Boolean), content === null ? null : this.putObject('blob', content));
    const parents = parent ? [parent] : [];
    const committer = author;
    const commitData = buildCommit(newTree, parents, author, committer, message);
    const commitOid = this.putObject('commit', commitData);
    this.refs.set(branchRef, commitOid);
    if (parent === undefined) this.defaultBranch = branch;
    return commitOid;
  }

  /** Rebuild a tree with `segments` replaced by a blob oid (or deleted). */
  splicePath(treeOid: string | null, segments: string[], blobOid: string | null): string {
    const [head, ...rest] = segments;
    const entries = treeOid ? (() => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return [] as TreeEntry[];
      return parseTree(tree.data);
    })() : [];
    if (rest.length === 0) {
      const next = entries.filter((entry) => entry.name !== head);
      if (blobOid !== null) next.push({ mode: '100644', name: head, oid: blobOid });
      next.sort((a, b) => (a.name < b.name ? -1 : 1));
      return this.putObject('tree', buildTree(next));
    }
    const existing = entries.find((entry) => entry.name === head);
    const subtreeOid = existing ? existing.oid : null;
    const newSubtree = this.splicePath(subtreeOid, rest, blobOid);
    const next = entries.filter((entry) => entry.name !== head);
    if (newSubtree !== null || this.treeHasEntries(newSubtree)) next.push({ mode: '040000', name: head, oid: newSubtree });
    next.sort((a, b) => (a.name < b.name ? -1 : 1));
    return this.putObject('tree', buildTree(next));
  }

  /** Whether a subtree we just built holds any entries (empty dirs are pruned). */
  private treeHasEntries(treeOid: string): boolean {
    const tree = this.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return false;
    return parseTree(tree.data).length > 0;
  }

  /** A pull request's changed files: diff the head and base trees. */
  diffTrees(baseOid: string, headOid: string): PullFile[] {
    const cacheKey = `${baseOid}:${headOid}`;
    const cached = this.diffCache.get(cacheKey);
    if (cached) return cached;
    const computed = this.computeDiffTrees(baseOid, headOid);
    this.diffCache.set(cacheKey, computed);
    return computed;
  }

  private computeDiffTrees(baseOid: string, headOid: string): PullFile[] {
    const flat = (oid: string, prefix: string, out: Map<string, string>): void => {
      const tree = this.objects.get(oid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (isTreeMode(entry.mode)) flat(entry.oid, path, out);
        else out.set(path, entry.oid);
      }
    };
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    const resolveRoot = (oid: string): string | null => {
      const object = this.objects.get(oid);
      if (!object) return null;
      if (object.type === 'commit') return parseCommit(object.data).tree;
      if (object.type === 'tree') return oid;
      return null;
    };
    const baseRoot = resolveRoot(baseOid);
    const headRoot = resolveRoot(headOid);
    if (baseRoot !== null) flat(baseRoot, '', baseFiles);
    if (headRoot !== null) flat(headRoot, '', headFiles);
    const files: PullFile[] = [];
    for (const [path, oid] of headFiles) {
      const baseOidHere = baseFiles.get(path);
      if (baseOidHere === undefined) {
        const blob = this.objects.get(oid);
        files.push({ filename: path, status: 'added', additions: blob ? Math.max(1, blob.data.toString('utf8').split('\n').length) : 1, deletions: 0, changes: 1 });
      } else if (baseOidHere !== oid) {
        const blob = this.objects.get(oid);
        const old = this.objects.get(baseOidHere);
        const newLines = blob ? blob.data.toString('utf8').split('\n').length : 0;
        const oldLines = old ? old.data.toString('utf8').split('\n').length : 0;
        files.push({ filename: path, status: 'modified', additions: Math.max(1, newLines), deletions: oldLines, changes: newLines + oldLines });
      }
    }
    for (const [path] of baseFiles) {
      if (!headFiles.has(path)) files.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    }
    files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
    return files;
  }
}

/** The forge: the token's owner and every repository by owner/name. */
export class Forge {
  readonly viewer: User;
  readonly users = new Map<string, User>();
  readonly repos = new Map<string, Repo>();
  private repoCounter = 1000;

  constructor(viewer: User) {
    this.viewer = viewer;
    this.users.set(viewer.login, viewer);
  }

  /** The token's login. */
  get login(): string { return this.viewer.login; }

  /** A repo by owner/name, or null. */
  repo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  /** Create a repo; a duplicate name answers null (the caller turns it into 422). */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.repoCounter++, owner, name, description, isPrivate, defaultBranch);
    this.repos.set(key, repo);
    return repo;
  }

  /** Delete a repository. */
  deleteRepo(owner: string, name: string): void {
    this.repos.delete(`${owner}/${name}`);
  }

  /** The viewer's repositories, insertion order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer.login);
  }
}

/** GitHub-style timestamp: fixed epoch base + a deterministic tick so ids stay stable. */
let clockTick = 0;
export function forgeNow(): string {
  clockTick += 1;
  return new Date(1735689600000 + clockTick * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

void ZERO_OID; void collectReachable; void commitEpoch;
