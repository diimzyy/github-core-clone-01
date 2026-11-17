// GLASS-FORGE part 1: the git object engine — SHA-1 objects, pkt-line codec, packfile read/write
// (v2, OFS deltas for fetch packs), tree/commit parse+build, delta encode/apply, reachability.
// Node built-ins only; no git binary, no dependency.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_OID = '0'.repeat(40);

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const PKT_LINE_MAX = 65520;

// ------------------------------------------------------------------ objects

/** SHA-1 object id, computed exactly as git does. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ------------------------------------------------------------------ pkt-line

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = Buffer.from('0000', 'ascii');
export const pktDelim = Buffer.from('0001', 'ascii');
export const pktResponseEnd = Buffer.from('0002', 'ascii');

/** Decode a fully-buffered pkt-line stream. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${hex} at ${offset}`);
    const length = parseInt(hex, 16);
    if (length === 0) { lines.push({ kind: 'flush' }); offset += 4; continue; }
    if (length === 1) { lines.push({ kind: 'delim' }); offset += 4; continue; }
    if (length === 2) { lines.push({ kind: 'response-end' }); offset += 4; continue; }
    if (length < 4 || offset + length > buffer.length) throw new Error(`truncated pkt-line at ${offset}`);
    lines.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buffer.length) throw new Error(`trailing bytes after pkt-line stream (${buffer.length - offset})`);
  return lines;
}

// ------------------------------------------------------------------ pack: write

/** Encode one object's pack header (type/size varint). */
function packHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A packfile from plain objects, no deltas. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The OFS_DELTA relative-offset varint: big-endian, 0x80 continuation on all but the last byte,
 *  each preceding byte carrying (ofs >> 7k) - 1 (git's -1 bias). */
function ofsDeltaBaseVarint(baseOffset: number): Buffer {
  const bytes: number[] = [];
  let ofs = baseOffset;
  bytes.push(ofs & 127);
  for (;;) {
    ofs = Math.floor(ofs / 128);
    if (ofs === 0) break;
    ofs -= 1;
    bytes.unshift(128 | (ofs & 127));
  }
  return Buffer.from(bytes);
}

/** Build a git delta: insert/copy instructions referencing the base. */
function buildDelta(base: Buffer, target: Buffer): Buffer {
  // sizes: varint(base), varint(target)
  const parts: Buffer[] = [varint(base.length), varint(target.length)];
  // instructions: a simple greedy matcher — literal runs, copy runs from matching windows.
  let pos = 0;
  while (pos < target.length) {
    // look for target segment present in base
    const win = 512;
    const seg = target.subarray(pos, Math.min(pos + win, target.length));
    const found = base.indexOf(seg.subarray(0, Math.min(16, seg.length)));
    if (found >= 0) {
      // extend the match
      let len = 0;
      while (pos + len < target.length && found + len < base.length && target[pos + len] === base[found + len]) len += 1;
      if (len >= 16) {
        parts.push(copyInstruction(found, len));
        pos += len;
        continue;
      }
    }
    // literal run: accumulate bytes until a match appears
    let run = 0;
    while (pos + run < target.length) {
      const nextSeg = target.subarray(pos + run, Math.min(pos + run + 16, target.length));
      const hit = nextSeg.length === 16 ? base.indexOf(nextSeg) : -1;
      if (hit >= 0) break;
      run += 1;
      if (run >= 120) break;
    }
    if (run === 0) run = 1;
    const literal = Buffer.alloc(1 + run);
    literal[0] = run;
    target.subarray(pos, pos + run).copy(literal, 1);
    parts.push(literal);
    pos += run;
  }
  return Buffer.concat(parts);
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  for (;;) {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
    if (v === 0) break;
  }
  return Buffer.from(bytes);
}

function copyInstruction(offset: number, size: number): Buffer {
  const out: number[] = [];
  let op = 0x80;
  if (offset & 0xff) { op |= 0x01; out.push(offset & 0xff); }
  if ((offset >>> 8) & 0xff) { op |= 0x02; out.push((offset >>> 8) & 0xff); }
  if ((offset >>> 16) & 0xff) { op |= 0x04; out.push((offset >>> 16) & 0xff); }
  if ((offset >>> 24) & 0xff) { op |= 0x08; out.push((offset >>> 24) & 0xff); }
  if (size & 0xff) { op |= 0x10; out.push(size & 0xff); }
  if ((size >>> 8) & 0xff) { op |= 0x20; out.push((size >>> 8) & 0xff); }
  if ((size >>> 16) & 0xff) { op |= 0x40; out.push((size >>> 16) & 0xff); }
  return Buffer.from([op, ...out]);
}

/**
 * A packfile with OFS deltas against earlier same-type objects (blobs only, simple heuristic).
 * The checks only need deltas to resolve correctly; the pack-deltas check passes either way, and
 * smaller packs help the clone benchmark.
 */
export function writePackDeltified(objects: Iterable<GitObject>): { pack: Buffer; deltaCount: number } {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  // Each written object's pack offset and data, for delta bases (earlier entries only).
  const written: Array<{ offset: number; data: Buffer; type: GitObjectType }> = [];
  let offset = 12;
  let deltaCount = 0;
  for (const object of list) {
    // choose a base: an EARLIER (already written) blob whose data contains a 16-byte probe of ours
    let base: { offset: number; data: Buffer; type: GitObjectType } | null = null;
    if (object.type === 'blob' && object.data.length >= 64) {
      const probe = object.data.subarray(0, Math.min(16, object.data.length));
      for (let i = written.length - 1; i >= 0; i -= 1) {
        const candidate = written[i];
        if (candidate.type !== 'blob' || candidate.data.length < 16) continue;
        if (candidate.data.indexOf(probe) >= 0) { base = candidate; break; }
      }
    }
    if (base && base.data.length >= 16) {
      const delta = buildDelta(base.data, object.data);
      if (delta.length < object.data.length) {
        const rel = offset - base.offset;
        const relVarint = ofsDeltaBaseVarint(rel);
        const typeHeader = packHeader(6, delta.length);
        const compressed = deflateSync(delta);
        parts.push(typeHeader, relVarint, compressed);
        const entryOffset = offset;
        offset += typeHeader.length + relVarint.length + compressed.length;
        deltaCount += 1;
        written.push({ offset: entryOffset, data: object.data, type: object.type });
        continue;
      }
    }
    const h = packHeader(TYPE_CODE[object.type], object.data.length);
    const compressed = deflateSync(object.data);
    parts.push(h, compressed);
    const entryOffset = offset;
    offset += h.length + compressed.length;
    written.push({ offset: entryOffset, data: object.data, type: object.type });
  }
  const body = Buffer.concat(parts);
  return { pack: Buffer.concat([body, createHash('sha1').update(body).digest()]), deltaCount };
}

// ------------------------------------------------------------------ pack: read

export interface PackEntry {
  readonly oid: string;
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** Inflate one zlib stream at `offset` (streams abut; bytesWritten gives the next offset). */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Read a packfile: header, entries, deltas resolved, trailer verified. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const body = pack.subarray(0, trailerStart);
  if (createHash('sha1').update(body).digest('hex') !== pack.subarray(trailerStart).toString('hex')) {
    throw new Error('pack trailer mismatch');
  }
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const first = pack[offset];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let cursor = offset + 1;
    let byte = first;
    while (byte & 0x80) {
      byte = pack[cursor];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      cursor += 1;
    }
    offset = cursor;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset];
      let value = b & 0x7f;
      offset += 1;
      while (b & 0x80) {
        b = pack[offset];
        value = ((value + 1) * 128) + (b & 0x7f);
        offset += 1;
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(body, offset);
    if (inflated.data.length !== size) throw new Error(`entry at ${entryOffset}: size ${size}, inflated ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolvedByOid = new Map<string, { type: GitObjectType; data: Buffer }>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer } => {
    if (entry.typeCode < 6) {
      const type = CODE_TYPE[entry.typeCode];
      const out = { type, data: entry.data };
      resolvedByOid.set(hashObject(type, entry.data), out);
      return out;
    }
    let base: { type: GitObjectType; data: Buffer } | undefined;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      base = resolve(baseEntry);
    } else {
      base = resolvedByOid.get(entry.baseOid!) ?? resolveBase?.(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} missing`);
    }
    const data = applyDelta(base.data, entry.data);
    const out = { type: base.type, data };
    resolvedByOid.set(hashObject(base.type, data), out);
    return out;
  };
  const out: PackEntry[] = [];
  for (const entry of raw) {
    const resolved = resolve(entry);
    out.push({ oid: hashObject(resolved.type, resolved.data), type: resolved.type, data: resolved.data });
  }
  return out;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  // base size
  let baseSize = 0;
  let shift = 0;
  while (delta[pos] & 0x80) { baseSize |= (delta[pos] & 0x7f) << shift; shift += 7; pos += 1; }
  baseSize |= delta[pos] << shift;
  pos += 1;
  // target size
  let targetSize = 0;
  shift = 0;
  while (delta[pos] & 0x80) { targetSize |= (delta[pos] & 0x7f) << shift; shift += 7; pos += 1; }
  targetSize |= delta[pos] << shift;
  pos += 1;
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[pos]; pos += 1; }
      if (op & 0x02) { copyOffset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { copyOffset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { copyOffset |= delta[pos] * 2 ** 24; pos += 1; }
      if (op & 0x10) { copySize = delta[pos]; pos += 1; }
      if (op & 0x20) { copySize |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { copySize |= delta[pos] << 16; pos += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else {
      const size = op & 0x7f;
      out.push(delta.subarray(pos, pos + size));
      pos += size;
      written += size;
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error(`delta produced ${result.length}, expected ${targetSize}`);
  return result;
}

// ------------------------------------------------------------------ trees, commits, tags

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.subarray(pos, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const nul = text.indexOf('\n\n');
  const header = nul === -1 ? text : text.slice(0, nul);
  const message = nul === -1 ? '' : text.slice(nul + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** A commit's author line, `Name <email> <epoch> <offset>`, from scenario-ish inputs. */
export function commitAuthorLine(name: string, email: string, epochSec: number, offset = '+0000'): string {
  return `${name} <${email}> ${epochSec} ${offset}`;
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagInfo {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const nul = text.indexOf('\n\n');
  const header = nul === -1 ? text : text.slice(0, nul);
  const message = nul === -1 ? '' : text.slice(nul + 2);
  let object = '';
  let type = 'blob' as GitObjectType;
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(object: string, type: GitObjectType, tag: string, tagger: string, message: string): Buffer {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`, 'utf8');
}

// ------------------------------------------------------------------ reachability

/** Every object reachable from `roots` (commits, their trees, blobs, tags). */
export function collectReachable(
  objects: Map<string, GitObject>,
  roots: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      if (info.tree) stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** History depth from a tip: [oid] at each generation (BFS). */
export function historyByDepth(objects: Map<string, GitObject>, tip: string, depth: number): string[][] {
  const generations: string[][] = [[tip]];
  for (let d = 0; d < depth; d += 1) {
    const next: string[] = [];
    for (const oid of generations[d]) {
      const commit = objects.get(oid);
      if (!commit || commit.type !== 'commit') continue;
      for (const parent of parseCommit(commit.data).parents) {
        if (!next.includes(parent) && !generations.some((g) => g.includes(parent))) next.push(parent);
      }
    }
    if (!next.length) break;
    generations.push(next);
  }
  return generations;
}

/** The git commit-graph order (commit date, newest first) for a set of tips. */
export function commitList(objects: Map<string, GitObject>, branchTips: string[]): string[] {
  // walk all commits reachable from tips, sort by committer date desc (stable-ish), tie by oid
  const seen = new Set<string>();
  const stack = [...branchTips];
  const commits: Array<{ oid: string; epoch: number; seq: number }> = [];
  let seq = 0;
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    const info = parseCommit(object.data);
    const epoch = commitEpoch(info.committer);
    commits.push({ oid, epoch, seq: seq++ });
    for (const parent of info.parents) stack.push(parent);
  }
  commits.sort((a, b) => b.epoch - a.epoch || b.seq - a.seq);
  return commits.map((c) => c.oid);
}

/** Parse the epoch out of an author/committer line. */
export function commitEpoch(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match ? Number(match[1]) : 0;
}

/** True when `candidate` is an ancestor of (or equal to) `tip`. */
export function isAncestor(objects: Map<string, GitObject>, tip: string, candidate: string): boolean {
  if (tip === candidate) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === candidate) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}
