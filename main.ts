// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file as lines plus how it ends and the break it uses (SPEC.md section 3). */
interface FileState {
  lines: string[];
  finalBreak: boolean;
  br: string;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], finalBreak: false, br: '\n' };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    parts.pop();
    finalBreak = true;
  }
  return { lines: parts, finalBreak, br };
}

function serializeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

/** Line matching (SPEC.md section 5): tier 0 exact, tier 1 trailing blanks off, tier 2 both ends off. */
const TIERS_ALL = [0, 1, 2];

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

interface Occurrence {
  tier: number;
  positions: number[];
}

/** Every occurrence of oTexts in lines at the first tier that has one, at or after `from`. */
function findOccurrences(lines: string[], oTexts: string[], tiers: number[], from = 0, eofOnly = false): Occurrence | null {
  const k = oTexts.length;
  if (k === 0) return null;
  for (const tier of tiers) {
    const want = oTexts.map((t) => normLine(t, tier));
    const positions: number[] = [];
    for (let i = from; i + k <= lines.length; i += 1) {
      if (eofOnly && i + k !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < k; j += 1) {
        if (normLine(lines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface OLine {
  text: string;
  kind: 'ctx' | 'del';
}
interface NLine {
  text: string;
  kind: 'ctx' | 'add';
  oIdx: number;
}

/**
 * The lines written where O matched at `pos`: context lines are the file's own matched lines, and at tier 2 every
 * other new line is re-indented from O's first line's indent to the file's first matched line's (SPEC.md section 5).
 */
function buildReplacement(fileLines: string[], pos: number, o: OLine[], n: NLine[], tier: number): string[] {
  const F = leadingWs(fileLines[pos] ?? '');
  const P = leadingWs(o.length > 0 ? o[0]!.text : '');
  return n.map((e) => {
    if (e.kind === 'ctx') return fileLines[pos + e.oIdx]!;
    if (tier === 2) {
      const L = e.text;
      if (L !== '' && !/^[ \t]*$/.test(L) && L.startsWith(P)) return F + L.slice(P.length);
    }
    return e.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, in order, as [old path, new path]; read back for the `R` output lines. */
  readonly moves: [string, string][] = [];
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

/** Unified diffs (SPEC.md section 6). */

interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  isNew: boolean;
  isDel: boolean;
  headerOpen: boolean;
  hunks: Hunk[];
}

/** The path a `--- `/`+++ ` line names: up to the first tab, spaces off, `/dev/null` is no file, `a/`/`b/` off. */
function headerPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunk: Hunk | null = null;
  const newSection = (): USection => {
    const s: USection = {
      diffOld: null,
      diffNew: null,
      hasPair: false,
      pairOld: null,
      pairNew: null,
      renameOld: null,
      renameNew: null,
      isNew: false,
      isDel: false,
      headerOpen: true,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  const finishHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.rawEmpty) hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      hunk = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        finishHunk();
        continue;
      }
      const c = line.charAt(0);
      if (line === '') hunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
      else if (c === ' ') hunk.body.push({ kind: 'ctx', text: line.slice(1), rawEmpty: false });
      else if (c === '-') hunk.body.push({ kind: 'del', text: line.slice(1), rawEmpty: false });
      else if (c === '+') hunk.body.push({ kind: 'add', text: line.slice(1), rawEmpty: false });
      else if (c === '\\') hunk.body.push({ kind: 'bs', text: '', rawEmpty: false });
      else {
        finishHunk();
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && cur.headerOpen && !cur.hasPair) {
          cur.pairOld = headerPath(line.slice(4));
          cur.pairNew = headerPath(next.slice(4));
          cur.hasPair = true;
        } else {
          const s = newSection();
          s.pairOld = headerPath(line.slice(4));
          s.pairNew = headerPath(next.slice(4));
          s.hasPair = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.headerOpen) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.headerOpen = false;
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      continue;
    }
    if (cur !== null && cur.headerOpen) {
      if (line.startsWith('rename from ')) {
        if (cur.renameOld === null) cur.renameOld = line.slice('rename from '.length).replace(/^ +| +$/g, '');
      } else if (line.startsWith('rename to ')) {
        if (cur.renameNew === null) cur.renameNew = line.slice('rename to '.length).replace(/^ +| +$/g, '');
      } else if (line.startsWith('new file mode')) {
        cur.isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDel = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  finishHunk();
  return sections.map((s) => unifiedApply(s, strict));
}

function unifiedApply(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP: string | null = s.hasPair ? s.pairOld : s.renameOld ?? s.diffOld;
    const newP: string | null = s.hasPair ? s.pairNew : s.renameNew ?? s.diffNew;
    const tiers = strict ? [0] : TIERS_ALL;
    const isCreate = oldP === null || s.isNew;
    const isDelete = !isCreate && (newP === null || s.isDel);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const flat: BodyLine[] = [];
      for (const h of s.hunks) flat.push(...h.body);
      const addLines: string[] = [];
      let lastAdd = -1;
      flat.forEach((b, idx) => {
        if (b.kind === 'add') {
          addLines.push(b.text);
          lastAdd = idx;
        }
      });
      const noBreak = lastAdd >= 0 && flat[lastAdd + 1]?.kind === 'bs';
      const st: FileState = { lines: addLines, finalBreak: !noBreak, br: '\n' };
      tree.now.set(newP, serializeFile(st));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldP!;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    const isMove = newP !== null && newP !== src;
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const st = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const O: OLine[] = [];
      const N: NLine[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          O.push({ text: b.text, kind: 'ctx' });
          N.push({ text: b.text, kind: 'ctx', oIdx: O.length - 1 });
        } else if (b.kind === 'del') {
          O.push({ text: b.text, kind: 'del' });
        } else if (b.kind === 'add') {
          N.push({ text: b.text, kind: 'add', oIdx: -1 });
        }
      }
      let lastCN = -1;
      h.body.forEach((b, idx) => {
        if (b.kind === 'ctx' || b.kind === 'add') lastCN = idx;
      });
      const bsAfter = lastCN >= 0 && h.body[lastCN + 1]?.kind === 'bs';
      if (O.length === 0) {
        const pos = Math.max(0, Math.min(h.a + d, st.lines.length));
        const atEnd = pos === st.lines.length;
        st.lines.splice(pos, 0, ...N.map((e) => e.text));
        if (atEnd) st.finalBreak = !bsAfter;
      } else {
        const occ = findOccurrences(st.lines, O.map((o) => o.text), tiers);
        if (occ === null) throw new Fail('no-match', src);
        const target = h.a - 1 + d;
        let best = occ.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of occ.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const reachesEnd = best + O.length === st.lines.length;
        const repl = buildReplacement(st.lines, best, O, N, occ.tier);
        st.lines.splice(best, O.length, ...repl);
        if (reachesEnd) st.finalBreak = !bsAfter;
      }
      d += N.length - O.length;
    }
    const out = serializeFile(st);
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(newP!, out);
      tree.moves.push([src, newP!]);
    } else {
      tree.now.set(src, out);
    }
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j -= 1) {
        const l = lines[j]!;
        if (!blank(l) && !l.trim().startsWith('```')) {
          path = l.trim();
          break;
        }
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = -1;
      for (let k = i + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '=======') {
          j = k;
          break;
        }
      }
      if (j < 0) throw new Exit2(`error: parse ${i + 1}`);
      let k2 = -1;
      for (let k = j + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          k2 = k;
          break;
        }
      }
      if (k2 < 0) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, j), newLines: lines.slice(j + 1, k2) });
      prevPath = path;
      prevEnd = k2 + 1;
      i = k2 + 1;
    } else {
      i += 1;
    }
  }
  return blocks.map((b) => srApply(b, strict));
}

function srApply(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    const tiers = strict ? [0] : TIERS_ALL;
    const before = tree.get(p);
    if (b.oldLines.length === 0) {
      if (before !== null) throw new Fail('exists', p);
      const st: FileState = { lines: [...b.newLines], finalBreak: true, br: '\n' };
      tree.now.set(p, serializeFile(st));
      return;
    }
    if (before === null) throw new Fail('missing', p);
    const st = parseFile(before);
    const occ = findOccurrences(st.lines, b.oldLines, tiers);
    if (occ === null) throw new Fail('no-match', p);
    if (occ.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = occ.positions[0]!;
    const O: OLine[] = b.oldLines.map((t) => ({ text: t, kind: 'del' as const }));
    const N: NLine[] = b.newLines.map((t) => ({ text: t, kind: 'add' as const, oIdx: -1 }));
    const repl = buildReplacement(st.lines, pos, O, N, occ.tier);
    st.lines.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(p, serializeFile(st));
  };
}

/** V4A patches (SPEC.md section 8). */

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

interface VChunk {
  anchor: string | null;
  o: OLine[];
  n: NLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lastNB = k;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  const spaceTrim = (s: string): string => s.replace(/^ +| +$/g, '');
  const sections: VSection[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(V_ADD)) {
      const path = spaceTrim(line.slice(V_ADD.length));
      const raw: { text: string; num: number }[] = [];
      i += 1;
      while (i < lastNB && !isHeader(lines[i]!)) {
        raw.push({ text: lines[i]!, num: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind: 'add', path, addLines: content, moveTo: null, chunks: [] });
      continue;
    }
    if (line.startsWith(V_DEL)) {
      sections.push({ kind: 'delete', path: spaceTrim(line.slice(V_DEL.length)), addLines: [], moveTo: null, chunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith(V_UPD)) {
      const path = spaceTrim(line.slice(V_UPD.length));
      const updateLine = i + 1;
      const raw: { text: string; num: number }[] = [];
      i += 1;
      while (i < lastNB && !isHeader(lines[i]!)) {
        raw.push({ text: lines[i]!, num: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(V_MOVE)) {
        moveTo = spaceTrim(raw[0]!.text.slice(V_MOVE.length));
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, o: [], n: [], eof: false };
          chunks.push(cur);
        } else if (l === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, o: [], n: [], eof: true };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          cur = null;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            cur = { anchor: null, o: [], n: [], eof: false };
            chunks.push(cur);
          }
          if (l.startsWith(' ')) {
            cur.o.push({ text: l.slice(1), kind: 'ctx' });
            cur.n.push({ text: l.slice(1), kind: 'ctx', oIdx: cur.o.length - 1 });
          } else if (l.startsWith('-')) {
            cur.o.push({ text: l.slice(1), kind: 'del' });
          } else if (l.startsWith('+')) {
            cur.n.push({ text: l.slice(1), kind: 'add', oIdx: -1 });
          } else {
            cur.o.push({ text: '', kind: 'ctx' });
            cur.n.push({ text: '', kind: 'ctx', oIdx: cur.o.length - 1 });
          }
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind: 'update', path, addLines: [], moveTo, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aApply(s, strict));
}

function v4aApply(s: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = s.path;
    const tiers = strict ? [0] : TIERS_ALL;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const st: FileState = { lines: [...s.addLines], finalBreak: true, br: '\n' };
      tree.now.set(p, serializeFile(st));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const moveTo = s.moveTo;
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of tiers) {
          for (let pos = cursor; pos < st.lines.length; pos += 1) {
            if (normLine(st.lines[pos]!, tier) === normLine(ch.anchor, tier)) {
              found = pos;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      if (ch.o.length === 0) {
        const insPos = ch.eof ? st.lines.length : Math.min(cursor, st.lines.length);
        const texts = ch.n.map((e) => e.text);
        st.lines.splice(insPos, 0, ...texts);
        cursor = insPos + texts.length;
      } else {
        const occ = findOccurrences(st.lines, ch.o.map((o) => o.text), tiers, cursor, ch.eof);
        if (occ === null) throw new Fail('no-match', p);
        const pos = occ.positions[0]!;
        const repl = buildReplacement(st.lines, pos, ch.o, ch.n, occ.tier);
        st.lines.splice(pos, ch.o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = serializeFile(st);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
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
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: { key: string; text: string }[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (usedOld.has(o) || usedNew.has(n)) continue;
    const wasO = tree.original(o);
    const nowO = finalOf(o);
    const wasN = tree.original(n);
    const nowN = finalOf(n);
    if (wasO !== null && nowO === null && wasN === null && nowN !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => cmp(x.key, y.key));
  if (!check) {
    for (const [p, now] of tree.now) {
      const was = tree.original(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
