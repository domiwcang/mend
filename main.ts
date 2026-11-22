// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A text file as lines: its line break, its lines and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Line equality at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions where O occurs in lines at a tier, from `from` on (occurrences may overlap). */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (of the first `maxTier`) at which O occurs in lines at or after `from`. */
function findTier(lines: string[], O: string[], from = 0, maxTier = 3): { tier: number; positions: number[] } | null {
  for (let tier = 0; tier < maxTier; tier++) {
    const positions = occurrences(lines, O, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One step of applying a body: keep the file's line, drop it, or add a patch line. */
type Op = { kind: 'ctx' } | { kind: 'del' } | { kind: 'add'; text: string };

/**
 * Apply ops at position `pos` of `lines` (O's lines sit there): context lines are written as the
 * file's own matched lines, added lines are re-indented at tier 2 (SPEC.md section 5).
 */
function applyOps(lines: string[], pos: number, O: string[], ops: Op[], tier: number): string[] {
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const F = pos < lines.length ? leadingWs(lines[pos]!) : '';
  const out: string[] = [...lines.slice(0, pos)];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') { out.push(lines[pos + oi]!); oi += 1; }
    else if (op.kind === 'del') { oi += 1; }
    else {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/**
 * Read a hunk/chunk body (lines starting with ' ', '-', '+' or empty, plus '\' markers):
 * O is its context and '-' lines, ops its steps in body order, and whether a '\' line follows
 * its last context or '+' line (SPEC.md section 6).
 */
function parseBody(body: string[]): { O: string[]; ops: Op[]; lastBackslash: boolean } {
  const O: string[] = [];
  const ops: Op[] = [];
  let lastCtxOrPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ')) { O.push(l === '' ? '' : l.slice(1)); ops.push({ kind: 'ctx' }); lastCtxOrPlus = k; }
    else if (l.startsWith('-')) { O.push(l.slice(1)); ops.push({ kind: 'del' }); }
    else if (l.startsWith('+')) { ops.push({ kind: 'add', text: l.slice(1) }); lastCtxOrPlus = k; }
  }
  const lastBackslash = lastCtxOrPlus >= 0 && lastCtxOrPlus + 1 < body.length && body[lastCtxOrPlus + 1]!.startsWith('\\');
  return { O, ops, lastBackslash };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits performed, in order, so the output can print `R <old> -> <new>`. */
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Apply a section's hunks to a file's state, in order (SPEC.md section 6). */
function applyHunks(state: FileState, hunks: Array<{ a: number; body: string[] }>, path: string, strict: boolean): FileState {
  let lines = [...state.lines];
  let final = state.final;
  let d = 0;
  for (const h of hunks) {
    const { O, ops, lastBackslash } = parseBody(h.body);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      const added = ops.filter((o) => o.kind === 'add').map((o) => (o as { text: string }).text);
      lines = [...lines.slice(0, at), ...added, ...lines.slice(at)];
      if (atEnd) final = !lastBackslash;
      d += added.length;
    } else {
      const found = findTier(lines, O, 0, strict ? 1 : 3);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dd = Math.abs(p - target);
        if (dd < best) { best = dd; pos = p; }
      }
      const runsToEnd = pos + O.length === lines.length;
      lines = applyOps(lines, pos, O, ops, found.tier);
      if (runsToEnd) final = !lastBackslash;
      const nLen = ops.filter((o) => o.kind !== 'del').length;
      d += nLen - O.length;
    }
  }
  return { lines, br: state.br, final };
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Array<{ a: number; body: string[] }>;
}

function headerPath(l: string): string {
  const t = l.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function unifiedEdit(s: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || s.creation) {
      const p = newP;
      if (p === null || p === undefined) return;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastBackslash = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.startsWith('+')) {
            plus.push(b.slice(1));
            lastBackslash = k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\');
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastBackslash ? '' : '\n'));
      return;
    }
    if (newP === null || s.deletion) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (oldP !== newP && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const out = applyHunks(parseFile(cur), s.hunks, p, strict);
    const text = renderFile(out);
    if (oldP !== newP) {
      tree.now.set(p, null);
      tree.now.set(newP!, text);
      tree.moves.push({ old: p, nw: newP! });
    } else {
      tree.now.set(p, text);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let pairPaths = false;
  let i = 0;
  const newSection = (oldPath: string | null, newPath: string | null): void => {
    cur = { oldPath, newPath, creation: false, deletion: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    pairPaths = false;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) newSection(null, null);
      const oldRaw = headerPath(l);
      const newRaw = headerPath(lines[i + 1]!);
      cur!.oldPath = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
      cur!.newPath = newRaw === '/dev/null' ? null : stripAB(newRaw);
      pairPaths = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( |$)/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) { body.push(b); j += 1; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ') && !pairPaths) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !pairPaths) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.creation = true;
      else if (l.startsWith('deleted file mode')) cur.deletion = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (oldLines.length === 0) {
      if (cur !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    if (cur === null) throw new Fail('missing', path);
    const st = parseFile(cur);
    const found = findTier(st.lines, oldLines, 0, strict ? 1 : 3);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const ops: Op[] = [
      ...oldLines.map(() => ({ kind: 'del' as const })),
      ...newLines.map((t) => ({ kind: 'add' as const, text: t })),
    ];
    const out = applyOps(st.lines, found.positions[0]!, oldLines, ops, found.tier);
    tree.now.set(path, renderFile({ lines: out, br: st.br, final: st.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, fileLines: string[] | null, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const fl = fileLines ?? [];
      tree.now.set(path, fl.length === 0 ? '' : fl.join('\n') + '\n');
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(cur);
    let lines = [...st.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTier(lines, [ch.anchor], cursor, strict ? 1 : 3);
        if (!found) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      const { O, ops } = parseBody(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const added = ops.filter((o) => o.kind === 'add').map((o) => (o as { text: string }).text);
        lines = [...lines.slice(0, at), ...added, ...lines.slice(at)];
        cursor = at + added.length;
      } else {
        const found = findTier(lines, O, cursor, strict ? 1 : 3);
        if (!found) throw new Fail('no-match', path);
        let pos: number | null = null;
        for (const p of found.positions) {
          if (ch.eof && p + O.length !== lines.length) continue;
          pos = p;
          break;
        }
        if (pos === null) throw new Fail('no-match', path);
        lines = applyOps(lines, pos, O, ops, found.tier);
        cursor = pos + ops.filter((o) => o.kind !== 'del').length;
      }
    }
    const text = renderFile({ lines, br: st.br, final: st.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      const fl: Array<{ t: string; blankLine: boolean }> = [];
      i += 1;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m) || m.trim() === '*** End Patch') break;
        if (m.startsWith('+')) { fl.push({ t: m.slice(1), blankLine: false }); i += 1; }
        else if (blank(m)) { fl.push({ t: '', blankLine: true }); i += 1; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fl.length > 0 && fl[fl.length - 1]!.blankLine) fl.pop();
      edits.push(v4aEdit('add', p, fl.map((x) => x.t), null, [], strict));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m) || m.trim() === '*** End Patch') break;
        if (blank(m)) { i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aEdit('delete', p, null, null, [], strict));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let needChunkStart = false;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m) || m.trim() === '*** End Patch') break;
        if (blank(m)) {
          if (cur !== null) cur.body.push('');
          i += 1;
          continue;
        }
        if (moveTo === null && chunks.length === 0 && cur === null && m.startsWith('*** Move to: ')) {
          moveTo = m.slice('*** Move to: '.length).trim();
          i += 1;
          continue;
        }
        if (m.startsWith('@@')) {
          cur = { anchor: m.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          needChunkStart = false;
          i += 1;
          continue;
        }
        if (m.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          needChunkStart = true;
          i += 1;
          continue;
        }
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+')) {
          if (cur === null) {
            if (needChunkStart) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push(m);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aEdit('update', p, null, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Compose the moves into chains (a file moved twice shows as one R line), and keep
  // only chains whose old path existed before the patch and is gone after it, and whose
  // new path did not exist before it and does after it (SPEC.md section 2).
  const dest = new Map<string, string>();
  for (const m of tree.moves) {
    let start: string | null = null;
    for (const [s, d] of dest) {
      if (d === m.old) { start = s; break; }
    }
    if (start !== null) dest.set(start, m.nw);
    else dest.set(m.old, m.nw);
  }
  const covered = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [s, q] of dest) {
    if (tree.original(s) !== null && tree.get(s) === null && tree.original(q) === null && tree.get(q) !== null) {
      rows.push({ key: q, line: `R ${s} -> ${q}` });
      covered.add(s);
      covered.add(q);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const linesOut = rows.map((r) => r.line);
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
