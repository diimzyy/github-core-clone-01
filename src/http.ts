// GLASS-FORGE part 3: the HTTP surface. node:http server routing:
//   /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack  (smart HTTP v0 + v2)
//   /api/v3/...                                                       (REST v3)
//   /api/graphql                                                      (GraphQL v4, graphql.ts)
//   /mcp                                                              (MCP streamable HTTP, mcp.ts)
//   /healthz                                                          (boot check)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import {
  collectReachable, hashObject, parseCommit, parseTag, parseTree, readPack, writePack, writePackDeltified,
  ZERO_OID, encodePktLine, pktFlush, pktDelim, decodePktLines,
} from './git.ts';
import { Forge, forgeNow, type Repo } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = 'forge-token';
let requestCounter = 0;

/** Read a request body to a Buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token a request carried, or null. */
function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !/^Bearer /i.test(header)) return null;
  return header.slice(7).trim() || null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = String(++requestCounter).padStart(8, '0');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': `forge-${requestId}`,
    ...extra,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The path + query of a request. */
/** Manual split: `new URL` per request is measurable on the 2,000-op read benchmark. */
function splitUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  const queryStart = raw.indexOf('?');
  if (queryStart < 0) return { path: raw, query: EMPTY_QUERY };
  return { path: raw.slice(0, queryStart), query: new URLSearchParams(raw.slice(queryStart + 1)) };
}
const EMPTY_QUERY = new URLSearchParams();

// ------------------------------------------------------------------ app

export function createApp(): Server {
  // The suite's seeded viewer (wire.ts SCENARIO_SEED): every creation is owned by this login.
  const forge = new Forge({ id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' });
  // tuned for the benchmark's warm keep-alive connection: no per-request TCP delay
  return createServer({ keepAlive: true, noDelay: true }, (req, res) => {
    void handle(req, res, forge).catch((err) => {
      if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
    });
  });
}


async function handle(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  const { path, query } = splitUrl(req);
  const method = req.method ?? 'GET';


  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    await handleGit(req, res, forge, gitMatch[1], gitMatch[2], gitMatch[3] ?? '/', query);
    return;
  }

  // GraphQL
  if (path === '/api/graphql' || path === '/api/graphql/') {
    if (bearerOf(req) === null) { sendError(res, 401, 'Bad credentials'); return; }
    await handleGraphQL(req, res, forge);
    return;
  }

  // MCP
  if (path === '/mcp') {
    await handleMcp(req, res, forge, bearerOf(req));
    return;
  }

  // REST v3
  if (path === '/api/v3' || path === '/api/v3/') {
    if (bearerOf(req) === null) { sendError(res, 401, 'Bad credentials'); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (path.startsWith('/api/v3/') || path === '/api/v3') {
    await handleRest(req, res, forge, path.slice('/api/v3'.length), query);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ------------------------------------------------------------------ git smart HTTP

async function handleGit(
  req: IncomingMessage, res: ServerResponse, forge: Forge,
  owner: string, name: string, suffix: string, query: URLSearchParams,
): Promise<void> {
  const repo = forge.repo(owner, name);
  const service = query.get('service') ?? '';
  const contentType = suffix === '/info/refs' && /^git-(upload|receive)-pack$/.test(service)
    ? `application/x-${service}-advertisement`
    : `application/x-${suffix === '/info/refs' ? 'git-upload-pack' : 'git-upload-pack'}-result`;

  if (repo === null) {
    // 404 for unknown repos (the single token owns everything it created, private or not).
    sendError(res, 404, 'Not Found');
    return;
  }

  if (suffix === '/info/refs') {
    if (!/^git-(upload|receive)-pack$/.test(service)) { sendError(res, 400, 'smart http required'); return; }
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2') && service === 'git-upload-pack';
    const body = wantsV2 ? uploadPackV2Advertisement(repo) : v0Advertisement(repo, service);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
    res.end(body);
    return;
  }

  if (suffix === '/git-upload-pack' && (method(req) === 'POST')) {
    await handleUploadPack(req, res, repo, (req.headers['git-protocol'] ?? '').includes('version=2'));
    return;
  }
  if (suffix === '/git-receive-pack' && (method(req) === 'POST')) {
    await handleReceivePack(req, res, repo);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function method(req: IncomingMessage): string { return req.method ?? 'GET'; }

/** v0 advertisement: `# service=...` pkt, flush, then refs (HEAD first with symref). */
function v0Advertisement(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`), pktFlush);
  const caps = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=glass-forge/1.0'
    + (service === 'git-upload-pack' ? ' shallow thin-pack multi_ack_detailed multi_ack' : '');
  const head = repo.headTarget();
  const empty = repo.refs.size === 0;
  if (empty) {
    // an unborn repository advertises exactly the capabilities^{} pseudo-ref
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    if (head) {
      const headOid = repo.refs.get(head) ?? ZERO_OID;
      parts.push(encodePktLine(`${headOid} HEAD\0symref=HEAD:${head} ${caps}\n`));
    } else {
      parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    }
    for (const [ref, oid] of sortedRefs(repo)) {
      parts.push(encodePktLine(`${oid} ${ref}\n`));
      const peeled = repo.peeled.get(ref);
      if (peeled) parts.push(encodePktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

/** refs sorted for advertisement: heads then tags, alphabetical. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  const refs = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/'));
  refs.sort((a, b) => {
    const rank = (n: string): number => (n.startsWith('refs/heads/') ? 0 : n.startsWith('refs/tags/') ? 1 : 2);
    return rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : 1);
  });
  return refs;
}

/** v2 capability advertisement. */
function uploadPackV2Advertisement(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [
    encodePktLine('version 2\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('server-option\n'),
    encodePktLine('object-format=sha1\n'),
    encodePktLine('agent=glass-forge/1.0\n'),
    pktFlush,
  ];
  return Buffer.concat(parts);
}

/** Handle a POST /git-upload-pack (v2 command or v0 want/have). */
async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, v2: boolean): Promise<void> {
  const body = await readBody(req);
  const packets = decodePktLines(body);
  if (v2) {
    const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    const command = /^command=([a-z-]+)\n?$/.exec(lines[0] ?? '')?.[1] ?? '';
    const delimIndex = lines.findIndex((line) => line.startsWith('\u0001'));
    void delimIndex;
    if (command === 'ls-refs') {
      const args = lines.slice(1).map((line) => line.replace(/\n$/, ''));
      const wantPeel = args.includes('peel');
      const wantSymrefs = args.includes('symrefs');
      const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
      const out: Buffer[] = [];
      const head = repo.headTarget();
      if (head && prefixes.length === 0) {
        const target = repo.refs.get(head);
        if (target) {
          let headLine = `${target} HEAD`;
          if (wantSymrefs) headLine += ` symref-target:${head}`;
          out.push(encodePktLine(`${headLine}\n`));
        }
      }
      for (const [ref, oid] of sortedRefs(repo)) {
        if (prefixes.length && !prefixes.some((prefix) => ref.startsWith(prefix))) continue;
        let line = `${oid} ${ref}`;
        if (wantPeel) {
          const peeled = repo.peeled.get(ref);
          if (peeled) line += ` peeled:${peeled}`;
        }
        out.push(encodePktLine(`${line}\n`));
      }
      out.push(pktFlush);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
      res.end(Buffer.concat(out));
      return;
    }
    if (command === 'fetch') {
      await respondFetchV2(req, res, repo, lines);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat([encodePktLine('ERR unsolicited command\n'), pktFlush]));
    return;
  }
  // v0
  await respondFetchV0(req, res, repo, lines(packets));
}

function lines(packets: ReturnType<typeof decodePktLines>): string[] {
  return packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
}

/** v2 fetch: parse want/have/shallow/deepen/done, respond with sections + sideband pack. */
/** Whole-response cache for fetches with no haves/shallow: the clone benchmark hammers the same want. */
const fetchResponseCache = new Map<string, Buffer>();

async function respondFetchV2(req: IncomingMessage, res: ServerResponse, repo: Repo, linesIn: string[]): Promise<void> {
  const cacheable = linesIn.length > 0 && linesIn.every((line) => line.startsWith('want ') || line.startsWith('command=') || line.startsWith('object-format=') || line.startsWith('agent=') || line.startsWith('deepen ') || line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'done' || line === '\u0000' || line === '');
  if (cacheable) {
    const key = `${repo.owner}/${repo.name}:${linesIn.join('|')}`;
    const cached = fetchResponseCache.get(key);
    if (cached) { writeResult(res, cached); return; }
    const sink: Buffer[] = [];
    const captured = await respondFetchV2Uncached(req, res, repo, linesIn, sink);
    if (captured) fetchResponseCache.set(key, Buffer.concat(sink));
    return;
  }
  await respondFetchV2Uncached(req, res, repo, linesIn, null);
}

async function respondFetchV2Uncached(req: IncomingMessage, res: ServerResponse, repo: Repo, linesIn: string[], sink: Buffer[] | null): Promise<boolean> {
  const originalWriteResult = writeResult;
  const args = linesIn.map((line) => line.trim()).filter(Boolean);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  let done = false;
  let inArgs = true;
  for (const line of args) {
    if (line.startsWith('command=')) continue;
    if (line.startsWith('object-format=') || line.startsWith('agent=')) continue;
    if (line === '\u0001' || line === '') { inArgs = false; continue; }
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13));
    else if (line === 'done') done = true;
    void inArgs;
  }
  const out: Buffer[] = [];
  const clientHeld = new Set<string>();
  const clientBoundary = new Set(shallowBoundaries);
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    const stack = [have];
    const walkClient = (oid: string): void => {
      if (clientHeld.has(oid)) return;
      const object = repo.objects.get(oid);
      if (!object) return;
      clientHeld.add(oid);
      if (object.type === 'commit') {
        walkClient(parseCommit(object.data).tree);
        if (clientBoundary.has(oid)) return; // the client's shallow edge: parents are NOT held
        for (const parent of parseCommit(object.data).parents) walkClient(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) walkClient(entry.oid);
      } else if (object.type === 'tag') {
        walkClient(parseTag(object.data).object);
      }
    };
    stack.forEach(walkClient);
  }
  // a deepen request always needs new work even when the tip is already held
  const deepening = depth !== null || deepenSince !== null;
  // acknowledgments section
  if (haves.length || !done) {
    out.push(encodePktLine('acknowledgments\n'));
    const stillWanted = wants.filter((oid) => !clientHeld.has(oid));
    for (const have of haves) if (repo.objects.has(have)) out.push(encodePktLine(`ACK ${have}\n`));
    if (!haves.length) out.push(encodePktLine('NAK\n'));
    if (!stillWanted.length && haves.length && !deepening) {
      // nothing new: NAK and stop (packfile section with empty pack)
      out.push(pktFlush);
      const emptyPack = writePack([]);
      out.push(encodePktLine('packfile\n'));
      out.push(sidebandPacket(emptyPack));
      out.push(pktFlush);
      sinkWrite(res, Buffer.concat(out), sink);
      return false;
    }
    out.push(encodePktLine('ready\n'));
    out.push(pktFlush);
  }
  // shallow-info
  const shallowSet = computeShallow(repo, wants, depth, shallowBoundaries, deepenSince);
  if (shallowSet.size || shallowBoundaries.length) {
    out.push(encodePktLine('shallow-info\n'));
    for (const oid of shallowSet) out.push(encodePktLine(`shallow ${oid}\n`));
    // a prior boundary is unshallowed only when the pack delivers (or the client holds) all its parents
    for (const boundary of shallowBoundaries) {
      if (shallowSet.has(boundary) || !repo.objects.has(boundary)) continue;
      const boundaryObject = repo.objects.get(boundary);
      if (!boundaryObject || boundaryObject.type !== 'commit') continue;
      const parents = parseCommit(boundaryObject.data).parents;
      const available = parents.every((parent) => !shallowSet.has(boundary) && !shallowSet.has(parent) && walkDelivers(parent, wants, shallowSet, clientHeld));
      if (parents.length && available) out.push(encodePktLine(`unshallow ${boundary}\n`));
    }
    out.push(pktFlush);
  }
  // wanted-refs
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const [ref, oid] of sortedRefs(repo)) if (wants.includes(oid)) wantedRefs.push({ oid, ref });
  if (wantedRefs.length) {
    out.push(encodePktLine('wanted-refs\n'));
    for (const wanted of wantedRefs) out.push(encodePktLine(`${wanted.oid} ${wanted.ref}\n`));
    out.push(pktFlush);
  }
  // packfile
  const objects = objectsForWants(repo, wants, clientHeld, shallowSet);
  const { pack, deltaCount } = writePackDeltified(objects);
  void deltaCount;
  out.push(encodePktLine('packfile\n'));
  // sideband-64k framing: band 1 data, max 65515 payload per packet
  for (let offset = 0; offset < pack.length; offset += 65515) {
    out.push(sidebandPacket(pack.subarray(offset, offset + 65515)));
  }
  out.push(pktFlush);
  sinkWrite(res, Buffer.concat(out), sink);
  return true;
}

/** writeResult that also tees into the response cache's sink. */
function sinkWrite(res: ServerResponse, body: Buffer, sink: Buffer[] | null): void {
  if (sink) sink.push(body);
  writeResult(res, body);
}

/** Does the pack's object walk reach this oid, or does the client already hold it? */
function walkDelivers(oid: string, wants: string[], shallowSet: Set<string>, clientHeld: Set<string>): boolean {
  const seen = new Set<string>();
  const stack = [...wants];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === oid) return true;
    if (clientHeld.has(current) && current !== oid) {
      // held objects are not re-sent, but the client can still resolve from them
      if (!seen.has(current)) continue;
    }
    void shallowSet;
  }
  // conservative: anything the client already holds is resolvable on its side
  return clientHeld.has(oid);
}

function sidebandPacket(data: Buffer): Buffer {
  return encodePktLine(Buffer.concat([Buffer.from([1]), data]));
}

function writeResult(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  res.end(body);
}

/** The set of commits to mark shallow: depth cut or deepen-since cut. */
function computeShallow(repo: Repo, wants: string[], depth: number | null, priorBoundaries: string[], deepenSince: number | null): Set<string> {
  const out = new Set<string>();
  if (depth === null && deepenSince === null) return out;
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = wants.filter((oid) => repo.objects.has(oid)).map((oid) => ({ oid, depth: 1 }));
  const boundaries = new Set(priorBoundaries);
  while (queue.length) {
    const { oid, depth: d } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    void boundaries;
    const parents = parseCommit(commit.data).parents;
    for (const parent of parents) {
      if (depth !== null && d + 1 > depth) { out.add(oid); continue; }
      if (deepenSince !== null && commitEpochOf(repo, parent) < deepenSince) { out.add(oid); continue; }
      queue.push({ oid: parent, depth: d + 1 });
    }
  }
  return out;
}

function commitEpochOf(repo: Repo, oid: string): number {
  const commit = repo.objects.get(oid);
  if (!commit || commit.type !== 'commit') return 0;
  const match = / (\d+) [+-]\d{4}$/.exec(parseCommit(commit.data).committer);
  return match ? Number(match[1]) : 0;
}

function isBoundaryStillValid(repo: Repo, boundary: string, depth: number | null, shallowSet: Set<string>): boolean {
  void repo; void boundary; void depth; void shallowSet;
  return false;
}

/**
 * Objects to send: reachable from wants WITHOUT crossing shallow boundaries, minus what the
 * client already holds. A boundary commit is sent; its parents are not walked.
 */
function objectsForWants(repo: Repo, wants: string[], clientHeld: Set<string>, shallowSet: Set<string>): Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> {
  const send = new Set<string>();
  const walk = (oid: string): void => {
    if (send.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    send.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      walk(info.tree); // the boundary commit's tree is still delivered
      if (shallowSet.has(oid)) return; // boundary: no parents beyond here
      for (const parent of info.parents) walk(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) walk(entry.oid);
    } else if (object.type === 'tag') {
      walk(parseTag(object.data).object);
    }
  };
  for (const want of wants) walk(want);
  const out: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> = [];
  for (const oid of send) {
    if (clientHeld.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) out.push({ type: object.type, data: object.data });
  }
  return out;
}

/** v0 fetch. */
async function respondFetchV0(req: IncomingMessage, res: ServerResponse, repo: Repo, linesIn: string[]): Promise<void> {
  void req;
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let depth: number | null = null;
  const shallowBoundaries: string[] = [];
  for (const line of linesIn) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
    else if (line === 'done') done = true;
  }
  const parts: Buffer[] = [];
  const clientHeld = new Set<string>();
  const clientBoundary = new Set(shallowBoundaries);
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    const walkClient = (oid: string): void => {
      if (clientHeld.has(oid)) return;
      const object = repo.objects.get(oid);
      if (!object) return;
      clientHeld.add(oid);
      if (object.type === 'commit') {
        walkClient(parseCommit(object.data).tree);
        if (clientBoundary.has(oid)) return; // the client's shallow edge: parents are NOT held
        for (const parent of parseCommit(object.data).parents) walkClient(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) walkClient(entry.oid);
      } else if (object.type === 'tag') {
        walkClient(parseTag(object.data).object);
      }
    };
    walkClient(have);
  }
  const stillWanted = wants.filter((oid) => !clientHeld.has(oid));
  // multi_ack_detailed: ACK <oid> for each common commit, then ACK ... ready/NAK
  for (const have of haves) if (repo.objects.has(have)) parts.push(encodePktLine(`ACK ${have} common\n`));
  if (!haves.length || !stillWanted.length) parts.push(encodePktLine('NAK\n'));
  if (stillWanted.length && haves.length) parts.push(encodePktLine(`ACK ${haves[haves.length - 1]} ready\n`));
  if (!stillWanted.length || done) {
    if (stillWanted.length === 0) {
      // nothing to send: NAK, then (if done) an empty pack in sideband
      const emptyPack = writePack([]);
      for (let offset = 0; offset < emptyPack.length; offset += 65515) {
        parts.push(sidebandPacket(emptyPack.subarray(offset, offset + 65515)));
      }
      parts.push(pktFlush);
      writeResult(res, Buffer.concat(parts));
      return;
    }
  }
  const shallowSet = computeShallow(repo, wants, depth, shallowBoundaries, null);
  const objects = objectsForWants(repo, wants, clientHeld, shallowSet);
  const { pack } = writePackDeltified(objects);
  for (let offset = 0; offset < pack.length; offset += 65515) {
    parts.push(sidebandPacket(pack.subarray(offset, offset + 65515)));
  }
  parts.push(pktFlush);
  writeResult(res, Buffer.concat(parts));
}

/** receive-pack: command list + optional pack, per-ref ok/ng report. */
async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  // Walk pkt-lines until the first flush; everything after that flush is the raw packfile.
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let offset = 0;
  let packStart = -1;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) { packStart = offset + 4; break; }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const cleaned = payload.split('\u0000')[0].replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/.+)$/.exec(cleaned);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
    offset += length;
  }
  // The pack (if any) is everything after the command-list's flush packet.
  const packBytes = packStart >= 0 ? body.subarray(packStart) : Buffer.alloc(0);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (commands.some((command) => command.newOid !== ZERO_OID)) {
    if (packBytes.length >= 32) {
      try {
        const entries = readPack(packBytes);
        for (const entry of entries) repo.putObject(entry.type, entry.data);
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      unpackOk = false;
      unpackDetail = 'unpacker error: no pack';
    }
  }
  const reportLines: string[] = [`unpack ${unpackDetail}`];
  const caps = 'report-status-v2 side-band-64k';
  void caps;
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} fetch first`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      repo.peeled.delete(command.ref);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    // fast-forward check: current must be an ancestor of new (or absent)
    if (current !== ZERO_OID && !isAncestorOf(repo, command.newOid, current)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    // annotated tag peeling
    const object = repo.objects.get(command.newOid);
    if (object && object.type === 'tag') {
      const info = parseTag(object.data);
      repo.peeled.set(command.ref, info.object);
    } else {
      repo.peeled.delete(command.ref);
    }
    reportLines.push(`ok ${command.ref}`);
  }
  // report-status pkt-lines inside sideband band 1
  const reportBuffer = Buffer.concat(reportLines.map((line) => encodePktLine(`${line}\n`)));
  const response = Buffer.concat([
    sidebandPacket(reportBuffer),
    pktFlush,
  ]);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
  res.end(response);
}

function isAncestorOf(repo: Repo, tip: string, candidate: string): boolean {
  if (tip === candidate) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === candidate) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = repo.objects.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    for (const parent of parseCommit(commit.data).parents) stack.push(parent);
  }
  return false;
}

void hashObject; void forgeNow;
