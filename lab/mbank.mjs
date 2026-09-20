// mbank.mjs — 4 px of one letter names a face.
//
//   node lab/mbank.mjs build                 -> lab/m-bank.json (the bank)
//   node lab/mbank.mjs scan <pdf|dir>...     -> face + em64 per document
//   node lab/mbank.mjs analyze               -> re-measure the cut (below)
//   knobs: --cut=4x11 --tol1 --stop=12 --maxpages=4 --jobs=N --corpus
//          --out=f.jsonl (resumable) --stride=N --limit=N --debug --profile
//
// ## Why this is the first move of a hunt, not the last
//
// Everything else in the lab needs targets, and getting targets needs a
// document you already believe is worth the trouble. This needs neither: it
// takes a PDF cold and answers "which face, at which em64" in about 110 ms, by
// finding a lowercase `m` on the page and looking its picture up in a bank of
// every `m` this machine can draw.
//
// **The measurement that makes it work.** A 4-px-wide, baseline-anchored slice
// of an `m` carries **99.6% of everything the whole letter knows** about which
// face drew it: over 38,732 templates from 421 faces, a 4x11 window names
// exactly one face 76.7% of the time, against a 77.0% ceiling for the entire
// 8x13 letter. Widening the window past 4 px buys 0.3 points. What it cannot
// separate is not a cut problem — it is faces whose `m` is literally the same
// picture (version clones, duplicate files), and naming that CLASS is the
// honest answer, so that is what a verdict says.
//
// `analyze` re-measures the whole curve from the bank on demand, so the 4x11
// constant never has to be taken on trust (../docs/METHOD.md rule 1).
//
// ## THE STANDARD CUT — measured, not assumed
//
//   y: baseline-anchored. The window's bottom row IS the integer baseline row
//      — NOT baseline-1: Calibri's `m` overshoots the baseline by one row, and
//      stopping above it clips Calibri out of the bank entirely. The window is
//      H rows tall ending there, so the blank rows at the top encode the
//      x-height, which is signal an ink-box crop throws away (+4.8 points at
//      2 px wide).
//   x: centred on the ink box, which for an `m` is by construction centred on
//      its middle stem.
//
// Both anchors are computable from a page component's bounding box alone,
// which is what makes the same cut usable on the page side. The window is 4 px
// from either edge of a 12-14 px letter, so a touching neighbour's antialias
// fringe cannot reach it.
//
// ## The exact-match fraction is a second, free measurement
//
// A page `m` that matches a synthetic render BYTE-EXACTLY proves two things at
// once: the document is digitally rendered (not a scan), and the producer
// applied no post-law to those bytes — so it is readable at tolerance 0 today.
// A document that only matches at tol 1 belongs to a post-law family (linear,
// palette, conic wobble). `nExact/nHit` in the output is that grading.
// (Distinct-gray-level count was tried as a palette detector and REFUTED:
// palette pages here carry 191-250 distinct grays, indistinguishable from a
// plain-blend page.)
//
// Every raster comes from ../ftclone, the certified mupdf-1.28 glyph pipeline,
// at pen phases x = 0..3 quarters and y = 0 — the only producer-certified y
// phase (../docs/LAWS.md §1).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { FTClone } from '../ftclone/ftclone.mjs';
import { FAMILIES, FONT_DIRS } from './families.mjs';
import { readPgm } from './pgm.mjs';

const LAB = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const CACHE = `${LAB}/.fontcache`;      // TTC subfonts, extracted once
const BANK = `${LAB}/m-bank.json`;
const CP_M = 109;
const SID_M = 78;                       // CFF standard string 'm' (66='a' + 12)

// render window: pen at (PENX, BASEY), big enough for em64 2048 with margin
const RW = 96, RH = 96, PENX = 24, BASEY = 72;

// em64 = trunc(size_px * 64), the sharp size identifier (../docs/LAWS.md §6).
// The 9 sizes this corpus has actually shown, plus every integer px 8..24.
const ATTESTED = [791, 832, 853, 938, 983, 1024, 1194, 1198, 1536];
const SIZES = [...new Set([...ATTESTED,
  ...Array.from({ length: 17 }, (_, i) => (i + 8) * 64)])].sort((a, b) => a - b);

// ---------------------------------------------------------------- font roster
function ttcSubfonts(path) {
  const b = readFileSync(path);
  if (b.toString('latin1', 0, 4) !== 'ttcf') return [];
  return b.readUInt32BE(8);
}
function extractTtc(path, idx, out) {
  if (existsSync(out)) return out;
  const b = readFileSync(path);
  const off = b.readUInt32BE(12 + 4 * idx);
  const numTables = b.readUInt16BE(off + 4);
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const e = off + 12 + 16 * i;
    dir.push({ tag: b.toString('latin1', e, e + 4), csum: b.readUInt32BE(e + 4),
      src: b.readUInt32BE(e + 8), len: b.readUInt32BE(e + 12) });
  }
  let pos = 12 + 16 * numTables;
  const head = Buffer.alloc(pos);
  b.copy(head, 0, off, off + 12);
  const parts = [head];
  dir.forEach((t, i) => {
    const pad = (4 - (pos % 4)) % 4;
    pos += pad;
    if (pad) parts.push(Buffer.alloc(pad));
    head.write(t.tag, 12 + 16 * i, 'latin1');
    head.writeUInt32BE(t.csum, 12 + 16 * i + 4);
    head.writeUInt32BE(pos, 12 + 16 * i + 8);
    head.writeUInt32BE(t.len, 12 + 16 * i + 12);
    parts.push(b.subarray(t.src, t.src + t.len));
    pos += t.len;
  });
  writeFileSync(out, Buffer.concat(parts));
  return out;
}

function roster() {
  const out = [];
  const add = (name, file, src) => out.push({ name, file, src });
  // Every roster directory, ALWAYS — including the per-user one. See
  // FONT_DIRS in families.mjs for what that cost when it was missed.
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  // Tag by roster POSITION, not by matching the path — 'C:/Windows/Fonts'
  // and the per-user '.../Microsoft/Windows/Fonts' both end in "Fonts", so a
  // name-shaped test labels the system roster as the repo's own.
  const TAGS = ['', 'u:', 'lab:'];
  FONT_DIRS.forEach((dir, di) => {
    if (!existsSync(dir)) return;
    const d = dir.replace(/\/$/, '');
    const tag = TAGS[di] ?? '';
    for (const f of readdirSync(d).sort()) {
      if (/\.(ttf|cff)$/i.test(f)) add(`${tag}${f.replace(/\.(ttf|cff)$/i, '')}`, `${d}/${f}`, tag || 'win');
      else if (/\.ttc$/i.test(f)) {
        const n = ttcSubfonts(`${d}/${f}`);
        for (let i = 0; i < n; i++) {
          const base = `${tag}${f.replace(/\.ttc$/i, '')}#${i}`;
          add(base, extractTtc(`${d}/${f}`, i, `${CACHE}/${base.replace(/[:#]/g, '_')}.ttf`), 'ttc');
        }
      }
    }
  });
  return out;
}
// -------------------------------------------------------------- render one m
function inkBox(px, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (px[r * w + c] < 255) { if (c < x0) x0 = c; if (c > x1) x1 = c; if (r < y0) y0 = r; if (r > y1) y1 = r; }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function makeClone(file) {
  const c = new FTClone(file, RW, RH);
  if (c.cff) {
    const gid = c.cff.gidForSid(SID_M);
    if (gid < 0) return null;
    c.setGidMap(new Map([[CP_M, gid]]));
  } else if (!c.ttf.rawOutline(CP_M)) return null;
  return c;
}

// One record: the full ink box + its placement relative to (pen, baseline).
function renderM(clone, em64, phx) {
  const dst = clone.render(CP_M, em64, em64, PENX * 64 + phx * 16, BASEY * 64, 1);
  if (!dst) return null;
  const bb = inkBox(dst, RW, RH);
  if (!bb) return null;
  if (bb.x0 === 0 || bb.y0 === 0 || bb.x1 === RW - 1 || bb.y1 === RH - 1) return { clipped: true };
  const px = new Uint8Array(bb.w * bb.h);
  for (let r = 0; r < bb.h; r++) for (let c = 0; c < bb.w; c++)
    px[r * bb.w + c] = dst[(bb.y0 + r) * RW + bb.x0 + c];
  return { w: bb.w, h: bb.h, dx: bb.x0 - PENX, dy: bb.y0 - BASEY, px };
}

// --------------------------------------------------------------- the cut
// window of W x H, bottom row = baseline row, x centred on the ink box.
export function cut(rec, W, H) {
  const out = new Uint8Array(W * H).fill(255);
  const x0 = Math.floor((rec.w - W) / 2);        // relative to ink left
  const yBase = -rec.dy;                          // baseline row inside the ink box
  const y0 = yBase - (H - 1);
  for (let r = 0; r < H; r++) {
    const sr = y0 + r;
    if (sr < 0 || sr >= rec.h) continue;
    for (let c = 0; c < W; c++) {
      const sc = x0 + c;
      if (sc < 0 || sc >= rec.w) continue;
      out[r * W + c] = rec.px[sr * rec.w + sc];
    }
  }
  return out;
}

// ------------------------------------------------------------------- build
function build() {
  const fonts = roster();
  const t0 = Date.now();
  const records = [];
  const skipped = [];
  const kept = [];
  for (const f of fonts) {
    let clone;
    try { clone = makeClone(f.file); } catch (e) { skipped.push([f.name, 'load: ' + e.message]); continue; }
    if (!clone) { skipped.push([f.name, 'no m']); continue; }
    let any = 0;
    for (const em64 of SIZES) {
      for (let phx = 0; phx < 4; phx++) {
        let r;
        try { r = renderM(clone, em64, phx); } catch (e) { r = null; }
        if (!r) { skipped.push([`${f.name}@${em64}.${phx}`, 'render null']); continue; }
        if (r.clipped) { skipped.push([`${f.name}@${em64}.${phx}`, 'clipped window']); continue; }
        records.push({ font: f.name, src: f.src, em64, phx, phy: 0,
          w: r.w, h: r.h, dx: r.dx, dy: r.dy, px: Buffer.from(r.px).toString('base64') });
        any++;
      }
      clone.cache.clear();
    }
    if (any) kept.push(f.name);
  }
  const ms = Date.now() - t0;
  const bank = {
    meta: {
      built: new Date().toISOString().slice(0, 10),
      generator: 'ftclone/ (certified mupdf-1.28 glyph pipeline)',
      char: 'm (U+006D)', phasesX: [0, 1, 2, 3], phasesY: [0],
      sizes: SIZES, fontsTried: fonts.length, fontsKept: kept.length,
      renderWindow: { W: RW, H: RH, penX: PENX, baselineY: BASEY },
      standardCut: 'baseline-anchored: window bottom row = integer baseline row; '
        + 'x0 = inkLeft + floor((inkW - W)/2) (ink-box centre == middle stem)',
      templates: records.length, buildMs: ms,
    },
    records,
  };
  writeFileSync(BANK, JSON.stringify(bank));
  console.log(`bank: ${records.length} templates, ${kept.length}/${fonts.length} fonts x ${SIZES.length} sizes x 4 phases`);
  console.log(`      ${(ms / 1000).toFixed(1)} s, ${(statSync(BANK).size / 1e6).toFixed(1)} MB -> ${BANK}`);
  const reasons = {};
  for (const [, why] of skipped) reasons[why] = (reasons[why] ?? 0) + 1;
  console.log('skipped:', JSON.stringify(reasons));
}

// ----------------------------------------------------------------- loading
export function loadBank(path = BANK) {
  const b = JSON.parse(readFileSync(path, 'utf8'));
  for (const r of b.records) r.px = new Uint8Array(Buffer.from(r.px, 'base64'));
  return b;
}
// ------------------------------------------------------------- discriminate
// Group templates by their cut window. A window "resolves" a label if every
// template carrying that window has the same label. Labels come in two
// grains: `font@em64` (the config) and `font` (the face).
function group(records, W, H) {
  const byKey = new Map();
  for (const r of records) {
    const win = cut(r, W, H);
    const key = Buffer.from(win).toString('latin1');
    let g = byKey.get(key);
    if (!g) byKey.set(key, g = { win, n: 0, fonts: new Set(), cfgs: new Set() });
    g.n++; g.fonts.add(r.font); g.cfgs.add(`${r.font}@${r.em64}`);
  }
  return [...byKey.values()];
}

// tol-1 merge over distinct windows: two windows merge if every pixel differs
// by <=1. Exact bucketing on the highest-variance pixel (a tol-1 pair differs
// by <=1 there too, so only buckets b-1,b,b+1 can match).
function mergeTol1(groups, W, H) {
  const n = groups.length, sz = W * H;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  // pick the pixel index with the widest spread across groups
  let best = 0, bestSpread = -1;
  for (let k = 0; k < sz; k++) {
    let lo = 256, hi = -1;
    for (const g of groups) { const v = g.win[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo > bestSpread) { bestSpread = hi - lo; best = k; }
  }
  const buckets = new Map();
  groups.forEach((g, i) => {
    const b = g.win[best];
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(i);
  });
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const near = (i, j) => {
    const a = groups[i].win, b = groups[j].win;
    for (let k = 0; k < sz; k++) { const d = a[k] - b[k]; if (d > 1 || d < -1) return false; }
    return true;
  };
  for (const b of keys) {
    const here = buckets.get(b);
    for (const other of [b, b + 1]) {
      const list = buckets.get(other);
      if (!list) continue;
      for (let ii = 0; ii < here.length; ii++)
        for (let jj = (other === b ? ii + 1 : 0); jj < list.length; jj++)
          if (near(here[ii], list[jj])) uni(here[ii], list[jj]);
    }
  }
  const comps = new Map();
  groups.forEach((g, i) => {
    const r = find(i);
    let c = comps.get(r);
    if (!c) comps.set(r, c = { n: 0, fonts: new Set(), cfgs: new Set() });
    c.n += g.n;
    for (const f of g.fonts) c.fonts.add(f);
    for (const s of g.cfgs) c.cfgs.add(s);
  });
  return [...comps.values()];
}

function score(units, total) {
  let resolvedCfg = 0, resolvedFont = 0, unitsCfg = 0, unitsFont = 0;
  for (const u of units) {
    if (u.cfgs.size === 1) { resolvedCfg += u.n; unitsCfg++; }
    if (u.fonts.size === 1) { resolvedFont += u.n; unitsFont++; }
  }
  return { units: units.length, unitsCfg, unitsFont,
    pctCfg: 100 * resolvedCfg / total, pctFont: 100 * resolvedFont / total };
}

function analyze(argv) {
  const bank = loadBank();
  let recs = bank.records;
  if (argv.includes('--corpus')) recs = recs.filter(r => CORPUS_FACES.has(r.font));
  const cuts = [];
  for (const H of [8, 11, 13]) for (const W of [2, 3, 4, 5, 6, 8]) cuts.push([W, H]);
  const faces = new Set(recs.map(r => r.font)).size;
  console.log(`bank: ${recs.length} templates, ${faces} fonts, ${bank.meta.sizes.length} sizes\n`);
  console.log('cut    | tol | distinct | %templates whose window names ONE face@size | ONE face');
  console.log('-------+-----+----------+---------------------------------------------+---------');
  for (const [W, H] of cuts) {
    const g = group(recs, W, H);
    const s0 = score(g, recs.length);
    const c1 = mergeTol1(g, W, H);
    const s1 = score(c1, recs.length);
    console.log(`${String(W).padStart(2)}x${String(H).padEnd(2)}  |  0  | ${String(s0.units).padStart(8)} | ${s0.pctCfg.toFixed(1).padStart(43)} | ${s0.pctFont.toFixed(1).padStart(7)}`);
    console.log(`${''.padEnd(6)} |  1  | ${String(s1.units).padStart(8)} | ${s1.pctCfg.toFixed(1).padStart(43)} | ${s1.pctFont.toFixed(1).padStart(7)}`);
  }
}
// ------------------------------------------------------- collision classes
// A CLASS is a maximal set of faces that share at least one cut window: the
// bank cannot tell its members apart from an 'm'. Reported as classes, not
// failures — naming the class IS the answer the prefilter can give.
function classesOf(recs, W, H, tol) {
  let units = group(recs, W, H);
  if (tol) units = mergeTol1(units, W, H);
  // union-find over FACES linked by any shared unit
  const idx = new Map();
  const names = [];
  const id = f => { if (!idx.has(f)) { idx.set(f, names.length); names.push(f); } return idx.get(f); };
  for (const r of recs) id(r.font);
  const parent = new Int32Array(names.length).map((_, i) => i);
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const u of units) {
    if (u.fonts.size < 2) continue;
    const fs = [...u.fonts].map(id);
    for (let i = 1; i < fs.length; i++) {
      const a = find(fs[0]), b = find(fs[i]);
      if (a !== b) parent[a] = b;
    }
  }
  const cls = new Map();
  names.forEach((f, i) => {
    const r = find(i);
    if (!cls.has(r)) cls.set(r, []);
    cls.get(r).push(f);
  });
  return [...cls.values()].sort((a, b) => b.length - a.length);
}
// --corpus: rank among the faces the proven families actually name, rather
// than among every font on the machine. Derived from families.mjs, so it stays
// true as families are added — the old hand-maintained list of 90 names went
// stale the moment a hunt landed.
const CORPUS_FACES = new Set(FAMILIES.filter(f => f.renderable)
  .map(f => f.font.replace(/\.(ttf|cff|TTF)$/i, ''))
  .flatMap(n => [n, `u:${n}`, `lab:${n}`]));
// ------------------------------------------------------------------- scan
// Page side. An 'm' on a page is found as a connected ink component whose
// bbox is m-shaped; the standard cut is then computable from the bbox alone
// (x centre of the box; baseline = box bottom or box bottom + 1 — the two
// hypotheses that cover overshoot faces like Calibri). The window is 4 px
// from either edge of a 12-14 px letter, so a touching neighbour's antialias
// fringe (~1 px) cannot reach it.

// 8-connected ink components, bbox only, m-shaped ones kept.
//
// STREAMING run-length CC, one row at a time — a GENERATOR, so the caller's
// `break` stops the work mid-page. (Profiled 2026-07-26: the old whole-page
// pixel flood was 48% of total scan time, more than PDF decoding. It wrote an
// 862k-entry `seen` array per page and did nine neighbour probes with a
// division per ink pixel, then labelled the entire page before the caller saw
// its first candidate — for a prefilter that wants ~12 hits, nearly all of it
// was wasted.) A component is emitted the row after its last run, so the
// yields come out top-down and an early break really does skip the rest.
function* mCandidates(page) {
  const { w, h, px } = page;
  const parent = [];                  // union-find over component ids
  const comp = [];
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  let prev = [];                      // previous row's runs: {x0, x1, id}
  let live = new Set();               // component roots still open

  for (let y = 0; y <= h; y++) {      // one row past the end closes everything
    const cur = [];
    if (y < h) {
      const base = y * w;
      let x = 0;
      while (x < w) {
        while (x < w && px[base + x] === 255) x++;
        if (x >= w) break;
        const s = x;
        while (x < w && px[base + x] !== 255) x++;
        cur.push({ x0: s, x1: x - 1, id: -1 });
      }
    }
    let pi = 0;                       // prev is x-sorted; sweep it once
    for (const r of cur) {
      let id = -1;
      while (pi < prev.length && prev[pi].x1 < r.x0 - 1) pi++;
      for (let k = pi; k < prev.length && prev[k].x0 <= r.x1 + 1; k++) {
        const pid = find(prev[k].id);
        if (id < 0) id = pid;
        else if (id !== pid) {        // this run bridges two components
          const a = comp[id], b = comp[pid];
          if (b.x0 < a.x0) a.x0 = b.x0;
          if (b.x1 > a.x1) a.x1 = b.x1;
          if (b.y0 < a.y0) a.y0 = b.y0;
          if (b.y1 > a.y1) a.y1 = b.y1;
          a.n += b.n;
          parent[pid] = id;
        }
      }
      if (id < 0) {                   // starts a new component
        id = comp.length;
        parent.push(id);
        comp.push({ x0: r.x0, x1: r.x1, y0: y, y1: y, n: 0 });
      }
      const c = comp[id];
      if (r.x0 < c.x0) c.x0 = r.x0;
      if (r.x1 > c.x1) c.x1 = r.x1;
      c.y1 = y;
      c.n += r.x1 - r.x0 + 1;
      r.id = id;
    }
    const next = new Set();
    for (const r of cur) next.add(find(r.id));
    for (const id of live) {          // nothing extended it => it is finished
      const root = find(id);
      if (next.has(root)) continue;
      const c = comp[root];
      if (c.done) continue;
      c.done = true;
      const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
      if (cw < 6 || cw > 32 || ch < 4 || ch > 22) continue;
      if (cw < ch * 1.05 || cw > ch * 2.6) continue;   // 'm' is wide, never tall
      if (c.n < cw * ch * 0.25) continue;               // rules/hairlines out
      yield { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, w: cw, h: ch };
    }
    live = next;
    prev = cur;
  }
}

function cutFromPage(page, c, W, H, baseRow) {
  const out = new Uint8Array(W * H).fill(255);
  const x0 = c.x0 + Math.floor((c.w - W) / 2);
  const y0 = baseRow - (H - 1);
  for (let r = 0; r < H; r++) {
    const sr = y0 + r;
    if (sr < 0 || sr >= page.h) continue;
    for (let k = 0; k < W; k++) {
      const sc = x0 + k;
      if (sc < 0 || sc >= page.w) continue;
      out[r * W + k] = page.px[sr * page.w + sc];
    }
  }
  return out;
}

function buildIndex(recs, W, H) {
  const face2class = new Map();
  for (const c of classesOf(recs, W, H, 0)) {
    const label = c.length === 1 ? c[0] : `${c.sort()[0]}+${c.length - 1}`;
    for (const f of c) face2class.set(f, label);
  }
  const buckets = new Map();          // "wxh" -> [{win, cls, em64, font}]
  for (const r of recs) {
    const k = `${r.w}x${r.h}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, b = []);
    b.push({ win: cut(r, W, H), cls: face2class.get(r.font), em64: r.em64, font: r.font });
  }
  return buckets;
}

// Returns the matching classes plus whether any of them matched EXACTLY —
// tol 0 means the producer applied no post-law to these bytes.
function lookup(buckets, dims, win, tol) {
  const b = buckets.get(dims);
  if (!b) return null;
  const hits = new Set();
  let exact = false;
  const n = win.length;
  for (const e of b) {
    let ok = true, same = true;
    for (let k = 0; k < n; k++) {
      const d = e.win[k] - win[k];
      if (d) { same = false; if (d > tol || d < -tol) { ok = false; break; } }
    }
    if (ok) { hits.add(`${e.cls}@${e.em64}`); if (same) exact = true; }
  }
  return hits.size ? { hits, exact } : null;
}

// NOT a palette guard: distinct-gray-level count was tried as one and REFUTED
// (2026-07-26). Palette pages in this corpus carry 191-250 distinct grays
// (EFTA00093044 191, EFTA00678329 197, EFTA01150379 250) — indistinguishable
// from a plain-blend page (big.pdf 249). The signal that DOES separate them is
// the tolerance a doc first matches at: tol 0 = plain FZ blend, tol 1 only =
// a post-law family (linear / palette / conic wobble).

// --- gray reduction: colour ink is not body text (../docs/LAWS.md §5) ---
const rgbToGray = (r, g, b) =>
  (Math.max(r, g, b) - Math.min(r, g, b) >= 4 ? 255 : Math.round((r + g + b) / 3));

// --- native-zlib fast decode ---------------------------------------------
// Measured on 400 random F:\ docs: 99.5% of first-page images are
// FlateDecode / bpc8 / no predictor, 71.8% Indexed(DeviceRGB) + 27.8%
// DeviceGray. mupdf's toPixmap runs its inflate in wasm and costs 7.6 ms/img;
// pulling the raw stream and inflating with Node's NATIVE zlib is 4x faster
// and byte-identical. Anything outside that shape returns null and falls back
// to mupdf, so correctness never depends on this path — and `--verify` runs
// both and compares every page.
function fastDecode(ref) {
  let d;
  try { d = ref.resolve(); } catch { return null; }
  try {
    if (!/FlateDecode/.test(String(d.get('Filter')))) return null;
    if (d.get('BitsPerComponent')?.asNumber?.() !== 8) return null;
    if (String(d.get('Filter')).includes(',')) return null;      // filter chain
    const dp = d.get('DecodeParms');
    if (dp && !dp.isNull() && (dp.get('Predictor')?.asNumber?.() ?? 1) > 1) return null;
    if (d.get('SMask') && !d.get('SMask').isNull()) return null;  // alpha: let mupdf do it
    if (d.get('Decode') && !d.get('Decode').isNull()) return null; // inverted ranges
    const w = d.get('Width').asNumber(), h = d.get('Height').asNumber();
    if (!(w > 0 && h > 0)) return null;

    // palette, if any
    let pal = null;
    const csRes = d.get('ColorSpace')?.resolve();
    if (!csRes) return null;
    if (csRes.isArray()) {
      if (String(csRes.get(0)) !== '/Indexed') return null;
      if (String(csRes.get(1).resolve()) !== '/DeviceRGB') return null;
      const lut = csRes.get(3);
      const lr = lut.resolve();
      const bytes = lr.isStream?.() || lut.isStream?.()
        ? Buffer.from(lut.readStream().asUint8Array())
        : Buffer.from(lr.asString(), 'latin1');
      const entries = csRes.get(2).asNumber() + 1;
      if (bytes.length < entries * 3) return null;
      pal = new Uint8Array(256);
      for (let i = 0; i < entries; i++)
        pal[i] = rgbToGray(bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]);
    } else if (String(csRes) !== '/DeviceGray') return null;

    const inf = inflateSync(Buffer.from(ref.readRawStream().asUint8Array()));
    if (inf.length < w * h) return null;                          // short/odd stream
    let px;
    if (pal) { px = Buffer.alloc(w * h); for (let i = 0; i < w * h; i++) px[i] = pal[inf[i]]; }
    else px = Buffer.from(inf.subarray(0, w * h));
    return { w, h, px };
  } catch { return null; }
}

// PDF -> page grays in memory, the same extraction ingest.mjs writes to disk
// (largest image XObject, raw decode). No PGM ever touches the disk: this is
// the prefilter path.
async function pdfPages(path, want, opts = {}) {
  const mupdf = await import('mupdf');
  const bytes = readFileSync(path);
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
  const n = doc.countPages();
  // Interior pages FIRST. A cover page carries other faces (and the court
  // sub-family's covers are ornate graphics that name nothing), so starting at
  // page 1 is how a family gets missed.
  const order = [];
  for (let k = 0; k < n; k++) order.push(1 + ((k + 1) % n));
  const out = [];
  for (const pno of order.slice(0, want)) {
    let page;
    try { page = doc.loadPage(pno - 1); } catch { continue; }
    const xobjs = page.getObject().get('Resources')?.get('XObject');
    let best = null;
    xobjs?.forEach((v, k) => {
      const d = v.resolve();
      if (String(d.get('Subtype')) !== '/Image') return;
      const w = d.get('Width').asNumber(), h = d.get('Height').asNumber();
      if (!best || w * h > best.w * best.h) best = { ref: v, w, h };
    });
    if (!best) continue;
    const fast = opts.noFast ? null : fastDecode(best.ref);
    if (fast && !opts.verify) { out.push({ ...fast, name: `p${pno}`, fast: true }); continue; }

    let pix;
    try { pix = doc.loadImage(best.ref).toPixmap(); } catch { continue; }
    const w = pix.getWidth(), h = pix.getHeight(), nc = pix.getNumberOfComponents();
    const src = pix.getPixels();
    let gray;
    // COPY: getPixels() is a view into live WASM heap, and decoding the next
    // page reuses it. Aliasing it made scans non-deterministic run to run.
    if (nc === 1) gray = Buffer.from(src.slice(0, w * h));
    else {
      gray = Buffer.alloc(w * h);
      for (let i = 0; i < w * h; i++)
        gray[i] = rgbToGray(src[i * nc], src[i * nc + 1], src[i * nc + 2]);
    }
    if (opts.verify) {
      opts.verify.total++;
      if (!fast) opts.verify.fellBack++;
      else if (fast.w !== w || fast.h !== h || Buffer.compare(fast.px, gray) !== 0) {
        opts.verify.mismatch++;
        opts.verify.where.push(`${path.split('/').pop()} p${pno}`);
      } else opts.verify.same++;
    }
    out.push({ w, h, px: gray, name: `p${pno}` });
  }
  return { pages: out, total: n };
}

// One document -> one result. Shared verbatim by the serial path and by every
// worker thread, so parallelism cannot change a verdict.
async function scanOne(target, S) {
  const { buckets, W, H, tol, stop, maxPages, decOpts, debug, prof } = S;
  const hr = () => Number(process.hrtime.bigint()) / 1e6;
  let tp = prof ? hr() : 0;
  const isPdf = /\.pdf$/i.test(target);
  let supply, total;
  if (isPdf) {
    const r = await pdfPages(target, maxPages, decOpts);
    supply = r.pages; total = r.total;
  } else {
    const files = readdirSync(target).filter(f => /\.pgm$/.test(f)).sort();
    total = files.length;
    const order = files.length > 2 ? [...files.slice(1), files[0]] : files;
    supply = order.slice(0, maxPages).map(f => ({ ...readPgm(`${target}/${f}`), name: f }));
  }
  const tally = new Map();
  let scanned = 0, cands = 0, verdictPage = null, nHit = 0, nExact = 0;
  const tD = Date.now();
  // A class clears the bar and leads the runner-up 4:1 — nothing more to learn.
  const decided = () => {
    const r = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    return r.length && r[0][1] >= stop && (r.length === 1 || r[0][1] >= 4 * r[1][1]);
  };
  if (prof) { prof.io += hr() - tp; tp = hr(); }
  for (const page of supply) {
    scanned++;
    for (const c of mCandidates(page)) {
      cands++;
      if (prof) { prof.cc += hr() - tp; tp = hr(); }
      for (const baseRow of [c.y1, c.y1 + 1]) {
        const r = lookup(buckets, `${c.w}x${c.h}`, cutFromPage(page, c, W, H, baseRow), tol);
        if (!r) { if (prof) { prof.match += hr() - tp; tp = hr(); } continue; }
        if (prof) { prof.match += hr() - tp; tp = hr(); }
        nHit++; if (r.exact) nExact++;
        // a candidate consistent with N classes votes 1/N for each
        for (const k of r.hits) tally.set(k, (tally.get(k) ?? 0) + 1 / r.hits.size);
        if (debug)
          console.log(`    ${page.name} x=${c.x0} y=${c.y0} ${c.w}x${c.h} -> ${[...r.hits].join(',')}${r.exact ? ' EXACT' : ''}`);
        break;                          // first baseline hypothesis that fires wins
      }
      // MID-PAGE exit: mCandidates is a generator, so breaking here abandons
      // the rest of the page's component labelling instead of finishing it.
      if (decided()) break;
    }
    // EARLY EXIT (the whole point of a prefilter): stop reading this document.
    if (decided()) { verdictPage = page.name; break; }
  }
  const rank = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const name = target.replace(/\\/g, '/').split('/').pop().replace(/\.pdf$/i, '');
  return { name, target, isPdf, scanned, total, cands, nExact, nHit, rank,
    verdictPage, ms: Date.now() - tD };
}

function fmtRow(r) {
  return `${r.name.padEnd(22)} ${String(r.scanned).padStart(2)}p/${String(r.total).padStart(4)} `
    + `${String(r.cands).padStart(5)} cand ${String(r.ms).padStart(5)} ms `
    + `${String(r.nExact).padStart(3)}/${String(r.nHit).padEnd(3)} exact  `
    + (r.rank.length ? r.rank.map(([k, v]) => `${k}=${v.toFixed(1)}`).join('  ') : '— no m matched')
    + (r.verdictPage ? `   [exit @${r.verdictPage}]` : '');
}

// Build everything a scan needs (bank index + knobs) from argv.
function scanSetup(argv, quiet) {
  const cutArg = (argv.find(a => a.startsWith('--cut=')) ?? '--cut=4x11').slice(6);
  const [W, H] = cutArg.split('x').map(Number);
  const tol = argv.includes('--tol1') ? 1
    : +((argv.find(a => a.startsWith('--tol=')) ?? '--tol=0').slice(6));
  const stop = +((argv.find(a => a.startsWith('--stop=')) ?? '--stop=12').slice(7));
  // 4, not 8: a real document shows an 'm' in its first few pages or it has no
  // body text at all. Measured on 400 random F:\ docs the median doc is 1 page,
  // mean 1.7 — the cap only bites on the picture-only giants, which is exactly
  // where the wasted decoding was. Cost, measured on 313 F:\ docs: 2 of 97
  // weak (tol-1) verdicts, and ZERO exact>0 docs — the tol-0 worklist is
  // unaffected. `--maxpages=8` restores the old behaviour.
  const maxPages = +((argv.find(a => a.startsWith('--maxpages=')) ?? '--maxpages=4').slice(11));
  const decOpts = { noFast: argv.includes('--no-fast'),
    verify: argv.includes('--verify') ? { total: 0, same: 0, fellBack: 0, mismatch: 0, where: [] } : null };
  // --profile: stage timers. NOTE it costs ~3x wall time (two hrtime calls per
  // candidate) and the overhead lands mostly in the MATCH bucket, so treat
  // MATCH as a generous UPPER bound. Measured 2026-07-26 on 665 F:\ docs:
  // read+open+decode 52% | components 32% | match <=16%. That is the answer to
  // "should this run on the GPU": no. The only GPU-shaped stage is matching,
  // it is the smallest slice even when over-counted, and getting page pixels
  // to a GPU requires doing the expensive part (zlib inflate) on the CPU
  // first. The wins here were algorithmic and parallel, not hardware.
  const prof = argv.includes('--profile') ? { io: 0, cc: 0, match: 0 } : null;
  const bank = loadBank();
  let recs = bank.records;
  if (argv.includes('--corpus')) recs = recs.filter(r => CORPUS_FACES.has(r.font));
  const t0 = Date.now();
  const buckets = buildIndex(recs, W, H);
  if (!quiet) console.log(`index: ${recs.length} templates, cut ${W}x${H}, tol ${tol}, ${Date.now() - t0} ms`
    + `   stop=${stop} hits, maxpages=${maxPages}\n`);
  return { buckets, W, H, tol, stop, maxPages, decOpts, prof, debug: argv.includes('--debug') };
}

async function scan(argv, quiet = false) {
  const say = quiet ? () => {} : console.log;
  const targets = argv.filter(a => !a.startsWith('--'));
  const docs = [];
  const walk = t => {
    const s = statSync(t);
    if (!s.isDirectory()) { docs.push(t); return; }
    const kids = readdirSync(t).sort();
    if (kids.some(f => /\.pgm$/.test(f))) { docs.push(t); return; }   // a page dir IS a doc
    for (const d of kids) if (statSync(`${t}/${d}`).isDirectory() || /\.pdf$/i.test(d)) walk(`${t}/${d}`);
  };
  for (const t of targets) walk(t);
  // --stride N: every Nth doc (an even sample of a huge folder); --limit N: cap
  const stride = +((argv.find(a => a.startsWith('--stride=')) ?? '--stride=1').slice(9));
  const limit = +((argv.find(a => a.startsWith('--limit=')) ?? '--limit=0').slice(8));
  if (stride > 1 || limit) {
    // both branches build a NEW array (aliasing `docs` here would empty it),
    // and it is refilled with a loop — spreading 531k args overflows the stack
    let picked = stride > 1 ? docs.filter((_, i) => i % stride === 0) : docs.slice();
    if (limit) picked = picked.slice(0, limit);
    docs.length = 0;
    for (const p of picked) docs.push(p);
  }
  // --out <jsonl>: stream results to disk. A 531k-doc run is hours of work and
  // must survive a kill — re-running with the same --out skips what is already
  // recorded, so progress is never lost.
  const outPath = (argv.find(a => a.startsWith('--out=')) ?? '').slice(6) || null;
  if (outPath && existsSync(outPath)) {
    const done = new Set();
    for (const line of readFileSync(outPath, 'utf8').split('\n')) {
      if (!line) continue;
      try { done.add(JSON.parse(line).target); } catch {}
    }
    const before = docs.length;
    const keep = docs.filter(d => !done.has(d));
    docs.length = 0; docs.push(...keep);
    say(`resume: ${before - docs.length} already in ${outPath}, ${docs.length} to go`);
  }
  // --verify runs both decoders and tallies in-process, so it stays serial.
  const jobs = argv.includes('--verify') ? 1
    : Math.max(1, +((argv.find(a => a.startsWith('--jobs=')) ?? '--jobs=1').slice(7)));
  let S = null;
  let scannedDocs = 0, named = 0;
  const results = [];
  const tAll = Date.now();
  const sink = [];
  const record = r => {
    scannedDocs++;
    if (r.verdictPage) named++;
    results.push(r);
    if (outPath) sink.push(JSON.stringify({ target: r.target, name: r.name, scanned: r.scanned,
      total: r.total, nExact: r.nExact, nHit: r.nHit, rank: r.rank, verdictPage: r.verdictPage }));
    if (sink.length >= 200) { appendFileSync(outPath, sink.join('\n') + '\n'); sink.length = 0; }
    say(fmtRow(r));
  };

  if (jobs > 1 && docs.length > 1) {
    // ---- parallel: N worker threads, each with its own bank index and mupdf
    const { Worker } = await import('node:worker_threads');
    const nw = Math.min(jobs, docs.length);
    say(`${nw} workers over ${docs.length} docs\n`);
    let next = 0, live = nw, lastLog = Date.now();
    await new Promise((resolve, reject) => {
      for (let i = 0; i < nw; i++) {
        const wk = new Worker(new URL(import.meta.url), { workerData: { argv }, argv: [] });
        const feed = () => {
          if (next >= docs.length) { wk.postMessage(null); return; }
          wk.postMessage(docs[next++]);
        };
        wk.on('message', m => {
          if (m !== 'ready') {
            if (m.err) say(`${m.name.padEnd(22)} ERROR ${m.err}`);
            else record(m);
            if (quiet && Date.now() - lastLog > 15000) {
              lastLog = Date.now();
              const rate = scannedDocs / ((Date.now() - tAll) / 1000);
              process.stderr.write(`\r  ${scannedDocs}/${docs.length} docs  ${rate.toFixed(0)}/s  `
                + `eta ${((docs.length - scannedDocs) / rate / 60).toFixed(1)} min   `);
            }
          }
          feed();
        });
        wk.on('error', reject);
        wk.on('exit', () => { if (--live === 0) resolve(); });
      }
    });
  } else {
    S = scanSetup(argv, quiet);
    for (const target of docs) {
      try { record(await scanOne(target, S)); }
      catch (e) { say(`${target.split('/').pop().padEnd(22)} ERROR ${e.message}`); }
    }
  }
  if (outPath && sink.length) appendFileSync(outPath, sink.join('\n') + '\n');
  const secs = (Date.now() - tAll) / 1000;
  say(`\n${scannedDocs} docs, ${named} named by early exit, ${secs.toFixed(1)} s total`
    + ` (${(1000 * secs / Math.max(1, scannedDocs)).toFixed(1)} ms/doc)`);
  const pr = S?.prof;
  if (pr) {
    const t = pr.io + pr.cc + pr.match;
    const pct = x => `${x.toFixed(0)} ms ${(100 * x / t).toFixed(1)}%`;
    console.log(`profile (serial): read+open+decode ${pct(pr.io)} | components ${pct(pr.cc)} `
      + `| MATCH ${pct(pr.match)}`);
  }
  const v = S?.decOpts.verify;
  if (v) console.log(`verify: ${v.same}/${v.total} pages byte-IDENTICAL via native zlib, `
    + `${v.fellBack} fell back to mupdf, ${v.mismatch} MISMATCH`
    + (v.where.length ? ` — ${v.where.slice(0, 5).join(', ')}` : ''));
  return results;
}
// ---- worker thread: same scanOne, own bank index + own mupdf instance ----
if (!isMainThread) {
  const S = scanSetup(workerData.argv, true);
  parentPort.on('message', async target => {
    if (target === null) { parentPort.close(); return; }
    try { parentPort.postMessage(await scanOne(target, S)); }
    catch (e) {
      parentPort.postMessage({ err: e.message, name: target.replace(/\\/g, '/').split('/').pop() });
    }
  });
  parentPort.postMessage('ready');
}
const cmd = isMainThread ? process.argv[2] : null;
if (cmd === 'build') build();
else if (cmd === 'scan') await scan(process.argv.slice(3));
else if (cmd === 'analyze') analyze(process.argv.slice(3));
else if (isMainThread) console.log('usage: node lab/mbank.mjs build|scan <pdf|dir>...|analyze');
