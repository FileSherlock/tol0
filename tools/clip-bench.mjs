// clip-bench.mjs — how often is a glyph read from under a redaction box RIGHT?
//
// The edge model (docs/LAWS.md §8) lets the reader transcribe a glyph that a
// black box mostly destroyed, from the column or two it leaks on the open
// page and from its shadow in the box's anti-aliased edge column. Whether
// that reads more letters right than wrong is a measurement, not an
// argument, and this is the instrument: take a page the gate certifies
// (every glyph's identity and pen are then KNOWN), paint a black box over one
// glyph per line exactly the way a redactor's box lands — bar-last through
// the blend law, an edge column of alpha E, the body black to the end of
// the line — read the page again, and score what comes back at the covered
// glyph's pen: right, wrong (any other letter emitted under the box) or
// refused. Repeated per amount of leaked evidence: `open` = how many of the
// glyph's leading ink columns stay on the open page (0 = shadow only).
//
//   node tools/clip-bench.mjs --pdf fixtures/corpus/nimbus791/EFTA00751637.pdf --page 1 --pool nimbus791
//        [--edges 196,165,119,74,52] [--open 0,1,2] [--seed 7] [--verbose]
//
// Standard-law pools only (the box composite is (gb·k)>>8, (255·k)>>8 = E).
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { materializeSet } from './glyph-bundle.mjs';
import { POOLS } from './glyph-registry.mjs';
import { cacheDirFor, pageFile } from './raster-cache.mjs';
import E from '../engine/ocr-engine.js';

const o = { pdf: null, page: 1, glyphs: null, edges: [196, 165, 119, 74, 52], open: [0, 1, 2], seed: 7, verbose: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
  else if (a === '--page') o.page = +next();
  else if (a === '--glyphs') o.glyphs = next();
  else if (a === '--pool') o.glyphs = POOLS[next()]?.glyphs ?? (() => { throw new Error('unknown pool'); })();
  else if (a === '--edges') o.edges = next().split(',').map(Number);
  else if (a === '--open') o.open = next().split(',').map(Number);
  else if (a === '--seed') o.seed = +next();
  else if (a === '--verbose') o.verbose = true;
  else throw new Error(`unknown arg ${a}`);
}
if (!o.pdf || !o.glyphs) { console.error('need --pdf and --pool/--glyphs'); process.exit(2); }

// raster (mode 1 / 3, neutral pages only — this is a synthetic instrument)
const { dir } = cacheDirFor(o.pdf);
const fp = join(dir, pageFile(o.page));
if (!existsSync(fp)) { console.error(`not rasterized: ${fp}`); process.exit(2); }
const raw = gunzipSync(readFileSync(fp)); const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
const W = hdr[2], H = hdr[3]; let gray;
if (hdr[1] === 1) gray = new Uint8Array(raw.buffer, raw.byteOffset + 16, W * H);
else { const s = new Uint16Array(raw.buffer, raw.byteOffset + 16, W * H); gray = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) gray[i] = s[i] >= 765 ? 255 : Math.round(s[i] / 3); }

const sets = o.glyphs.split(',').map(g => { const p = g.split('+'); return p.length > 1 ? E.unionSets(p.map(n => materializeSet(n))) : materializeSet(g); });
if (sets.some(s => s.linear)) { console.error('standard-law pools only'); process.exit(2); }
const recOf = (L, g) => {                          // the glyph record the reader matched
  const set = L.set, phx = g.pen - Math.floor(g.pen);
  return (set.byPhy.get(L.phy) ?? []).find(r => r.ch === g.ch && Math.abs(r.phx - phx) < 1e-6 && (!g.src || r.src === g.src));
};

// ground truth: the certified read of the untouched page
const base = await E.readPage({ w: W, h: H, gray: Uint8Array.from(gray) }, sets, { tol: 0 });
const lines = base.lines.filter(L => L.set && L.clean && L.glyphs.length >= 4);
let seed = o.seed; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const targets = lines.map(L => {
  const i = 1 + Math.floor(rnd() * (L.glyphs.length - 2));   // never the first or last glyph
  const g = L.glyphs[i], r = recOf(L, g);
  return r ? { L, g, r, x0: Math.floor(g.pen) + r.dx + r.inkLeft } : null;
}).filter(Boolean);
console.log(`${o.pdf.replace(/.*[\/]/, '')} p${o.page}: ${lines.length} certified lines, ${targets.length} target glyphs`);

const kOf = Ev => { for (let k = 1; k <= 256; k++) if (((255 * k) >> 8) === Ev) return k; throw new Error(`no k for ${Ev}`); };
const rows = [];
for (const open of o.open) for (const Ev of o.edges) {
  const k = kOf(Ev), kAA = kOf(187);
  const g2 = Uint8Array.from(gray);
  for (const t of targets) {
    const xe = t.x0 + open;                       // the edge column; body from xe+1 to the line's end
    const y0 = t.L.top - 2, y1 = t.L.bot + 2, x1 = Math.min(W, t.L.xTo + 8);
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = xe; x < x1; x++) {
        const i = y * W + x;
        if (y === y0 || y === y1 - 1) g2[i] = (g2[i] * kAA) >> 8;      // top/bottom AA rows
        else if (x === xe) g2[i] = (g2[i] * k) >> 8;                   // the edge column
        else g2[i] = 0;                                                // the body
      }
  }
  const res = await E.readPage({ w: W, h: H, gray: g2 }, sets, { tol: 0 });
  let right = 0, wrong = 0, refused = 0; const wrongs = [];
  for (const t of targets) {
    const L = res.lines.find(l => l.set && Math.abs(l.baseline - t.L.baseline) <= 1);
    const under = L ? L.glyphs.filter(g => g.pen >= t.x0 - 2 - (recOf(t.L, t.g)?.dx ?? 0) - 1 && Math.floor(g.pen) + 12 > t.x0) : [];
    const hit = under.find(g => g.ch === t.g.ch && Math.abs(g.pen - t.g.pen) <= 0.5);
    const others = under.filter(g => g !== hit && g.pen + 0.5 >= t.g.pen);
    if (hit && !others.length) right++;
    else if (under.length) { wrong++; wrongs.push(`y${t.L.baseline} '${t.g.ch}'→${under.map(g => `'${g.ch}'@${g.pen}${g.shadow ? 's' : g.clip ? 'c' : ''}`).join(',')}`); }
    else refused++;
  }
  rows.push({ open, edge: Ev, n: targets.length, right, wrong, refused });
  console.log(`open ${open}  edge ${String(Ev).padStart(3)}  right ${String(right).padStart(3)}  wrong ${String(wrong).padStart(3)}  refused ${String(refused).padStart(3)}` +
    (wrongs.length && o.verbose ? `\n      ${wrongs.join('\n      ')}` : ''));
}
const tot = rows.reduce((a, r) => ({ right: a.right + r.right, wrong: a.wrong + r.wrong, refused: a.refused + r.refused }), { right: 0, wrong: 0, refused: 0 });
console.log(`total: right ${tot.right}, wrong ${tot.wrong}, refused ${tot.refused}`);
