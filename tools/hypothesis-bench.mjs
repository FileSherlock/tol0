// hypothesis-bench.mjs — does engine/hypothesis.js keep the truth and drop
// the decoys?
//
// On a page the gate certifies (every glyph's identity and pen KNOWN), pick
// one word per line, paint a black box over it bar-last through the law —
// an edge column of alpha E on each side, the body black between — leaving
// `open` columns of the word's own ink on the open page at both ends, and
// run testHypothesis over a list = the truth + every other word on the page
// whose advance ties it within ¼ px (the §0 width equation). The line's own
// terms come from the certified read: its set, baseline, y-phase, band,
// the neighbour words' pens, and the line's space (the median of its other
// gaps, the page's calibrated space when it has fewer than two).
//
//   node tools/hypothesis-bench.mjs --pdf fixtures/corpus/nimbus791/EFTA00751637.pdf --page 1 --pool nimbus791
//        [--edges 196,165,119,74,52] [--open 0,1,2] [--seed 7] [--verbose]
//
// Per setting: truth consistent (must be all), truth contradicted (the gate:
// must be 0), decoys contradicted (what the feature is worth), ties (decoys
// left consistent — reported, never resolved), no-evidence on either side.
// Standard-law pools only (the painted box composite is (gb·k)>>8).
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { materializeSet } from './glyph-bundle.mjs';
import { POOLS } from './glyph-registry.mjs';
import { cacheDirFor, pageFile } from './raster-cache.mjs';
import E from '../engine/ocr-engine.js';
import R from '../engine/render.js';
import Hy from '../engine/hypothesis.js';

const o = { pdf: null, page: 1, glyphs: null, edges: [196, 165, 119, 74, 52], open: [0, 1, 2], seed: 7, verbose: false, minLen: 3, debug: null, rows: 'padded' };
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
  else if (a === '--debug') o.debug = +next();      // dump the window of the target on this baseline
  else if (a === '--rows') o.rows = next();
  else if (a === '--no-rows') o.judgeRows = false;   // the bar's own top/bottom rows do not judge
  else if (a === '--min-ink') o.minInk = +next();     // the tester's evidence floor          // padded (a row past the band each way) | tight (the band's own first and last rows are the edge rows)
  else throw new Error(`unknown arg ${a}`);
}
if (!o.pdf || !o.glyphs) { console.error('need --pdf and --pool/--glyphs'); process.exit(2); }

const { dir } = cacheDirFor(o.pdf);
const fp = join(dir, pageFile(o.page));
if (!existsSync(fp)) { console.error(`not rasterized: ${fp}`); process.exit(2); }
const raw = gunzipSync(readFileSync(fp)); const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
const W = hdr[2], H = hdr[3]; let gray;
if (hdr[1] === 1) gray = new Uint8Array(raw.buffer, raw.byteOffset + 16, W * H);
else { const s = new Uint16Array(raw.buffer, raw.byteOffset + 16, W * H); gray = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) gray[i] = s[i] >= 765 ? 255 : Math.round(s[i] / 3); }

const sets = o.glyphs.split(',').map(g => { const p = g.split('+'); return p.length > 1 ? E.unionSets(p.map(n => materializeSet(n))) : materializeSet(g); });
if (sets.some(s => s.linear)) { console.error('standard-law pools only'); process.exit(2); }

// ground truth: the certified read of the untouched page
const base = await E.readPage({ w: W, h: H, gray: Uint8Array.from(gray) }, sets, { tol: 0 });
const spaceAdv = E.spaceCalib(base.lines);
const lines = base.lines.filter(L => L.set && L.clean && L.glyphs.length >= 6);
// the producer's metrics, measured from the page's own pens (render.js pageMetrics)
const metrics = R.pageMetrics(base.lines.filter(L => L.set && L.clean), spaceAdv);
console.log('page metrics: ' + metrics.adv.size + ' advances, ' + metrics.kern.size + ' kern pairs' +
  (metrics.kern.size ? ' (' + [...metrics.kern.entries()].slice(0, 6).map(([k, v]) => k + ' ' + v.toFixed(2)).join(', ') + ')' : ''));
const recOf = (L, g) => {
  const phx = g.pen - Math.floor(g.pen);
  return (L.set.byPhy.get(L.phy) ?? []).find(r => r.ch === g.ch && Math.abs(r.phx - phx) < 1e-6 && (!g.src || r.src === g.src));
};
const inkRight = r => { let m = 0; for (let k = 0; k < r.inkC.length; k++) if (r.inkC[k] > m) m = r.inkC[k]; return m; };
// words: runs of glyphs whose gaps are under half a space
function wordsOf(L) {
  const words = [];
  let cur = null;
  for (let i = 0; i < L.glyphs.length; i++) {
    const g = L.glyphs[i];
    const gap = i ? g.pen - L.glyphs[i - 1].pen - L.glyphs[i - 1].adv : 0;
    if (!cur || gap > 0.55 * spaceAdv) { cur = { i0: i, i1: i, text: g.ch }; words.push(cur); }
    else { cur.i1 = i; cur.text += g.ch; }
  }
  return words;
}
let seed = o.seed; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const targets = [];
const vocab = new Set();
for (const L of lines) {
  const words = wordsOf(L);
  for (const w of words) if (!/[ﬁﬂ□]/.test(w.text)) vocab.add(w.text);
  // a target: a word with a neighbour on each side, ≥ minLen glyphs, no ligature
  const cands = words.map((w, k) => ({ w, k })).filter(({ w, k }) => k > 0 && k < words.length - 1 && w.text.length >= o.minLen && !/[ﬁﬂ□]/.test(w.text));
  if (!cands.length) continue;
  const { w, k } = cands[Math.floor(rnd() * cands.length)];
  const first = L.glyphs[w.i0], last = L.glyphs[w.i1];
  const rf = recOf(L, first), rl = recOf(L, last);
  if (!rf || !rl) continue;
  const prev = L.glyphs[words[k - 1].i1], next = L.glyphs[words[k + 1].i0];
  // the line's own space: median of its other gaps
  const gaps = [];
  for (let i = 1; i < L.glyphs.length; i++) {
    if (i > w.i0 - 1 && i <= w.i1 + 1) continue;             // not the target's own gaps
    const gap = L.glyphs[i].pen - L.glyphs[i - 1].pen - L.glyphs[i - 1].adv;
    if (gap > 0.55 * spaceAdv) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const spaceLine = gaps.length >= 2 ? (gaps.length % 2 ? gaps[gaps.length >> 1] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2) : spaceAdv;
  // the bar's rows: one row past the band each way — a real bar covers its
  // text with a margin; at a tight pitch neighbouring bars then touch on a
  // row, which is what the tester's "black under an edge is destroyed"
  // rule is for
  const y0 = o.rows === 'tight' ? L.top : L.top - 1, y1 = o.rows === 'tight' ? L.bot : L.bot + 1;
  targets.push({ L, w, y0, y1, inkL: Math.floor(first.pen) + rf.dx + rf.inkLeft, inkR: Math.floor(last.pen) + rl.dx + inkRight(rl),
    penLeft: prev.pen + prev.adv, penRight: next.pen, spaceLine,
    others: L.glyphs.filter((g, i) => i < w.i0 || i > w.i1) });
}
console.log(`${o.pdf.replace(/.*[\\/]/, '')} p${o.page}: ${lines.length} certified lines, ${targets.length} target words, vocabulary ${vocab.size}`);

const advOf = (set, text) => R.layoutLine(set, text, 0, { spaceAdv: spaceAdv, metrics }).advanceW;
const kOf = Ev => { for (let k = 1; k <= 256; k++) if (((255 * k) >> 8) === Ev) return k; throw new Error(`no k for ${Ev}`); };
const kAA = kOf(187);
const rows = [];
for (const open of o.open) for (const Ev of o.edges) {
  const k = kOf(Ev);
  const g2 = Uint8Array.from(gray);
  const painted = [];
  for (const t of targets) {
    const xe0 = t.inkL + open, xe1 = t.inkR - open;              // edge columns; body strictly between
    if (xe1 - xe0 < 10) continue;
    const y0 = t.y0, y1 = t.y1;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = xe0; x <= xe1; x++) {
        const i = y * W + x;
        if (y === y0 || y === y1 - 1) g2[i] = (g2[i] * kAA) >> 8;
        else if (x === xe0 || x === xe1) g2[i] = (g2[i] * k) >> 8;
        else g2[i] = 0;
      }
    painted.push({ t, xe0, xe1, y0, y1 });
  }
  const page = { w: W, h: H, gray: g2 };
  const det = E.detectObjects(page);
  const c = { open, edge: Ev, n: 0, truthC: 0, truthX: 0, truthN: 0, decoys: 0, decoyX: 0, ties: 0, decoyN: 0 };
  const notes = [];
  for (const { t, xe0, xe1, y0, y1 } of painted) {
    const L = t.L, set = L.set;
    const boxObj = det.objects.find(b => b.type === 'box' && b.x0 <= xe1 && b.x1 > xe0 && b.y0 < y1 && b.y1 > y0) || null;
    const line = { baseline: L.baseline, phy: L.phy, tol: 0, spaceLine: t.spaceLine, penLeft: t.penLeft, penRight: t.penRight, top: L.top, bot: L.bot, metrics };
    // explained ink: this line's other glyphs, and the neighbouring lines'
    // glyphs whose rows reach into the window (descenders from above,
    // ascenders from below)
    const explained = [R.renderLine(set, t.others.map(g => ({ ch: g.ch, pen: g.pen })), L.baseline, { phy: L.phy })];
    for (const M of lines) {
      if (M === L || !M.glyphs.length) continue;
      if (M.baseline + M.set.maxDesc <= L.baseline - set.maxAsc || M.baseline - M.set.maxAsc >= L.baseline + set.maxDesc) continue;
      explained.push(R.renderLine(M.set, M.glyphs.map(g => ({ ch: g.ch, pen: g.pen })), M.baseline, { phy: M.phy }));
    }
    const truthAdv = advOf(set, t.w.text);
    const decoys = [...vocab].filter(v => v !== t.w.text && Math.abs(advOf(set, v) - truthAdv) <= 0.25);
    const opts = { explained, judgeRows: o.judgeRows, minInk: o.minInk, trace: o.debug === L.baseline ? [] : null };
    const tv = Hy.testHypothesis(page, det, set, line, boxObj, t.w.text, opts);
    if (opts.trace && opts.trace.length) console.log('   trace:', opts.trace.slice(0, 12).map(c => `(${c.x},${c.y}) ev=${c.ev} g=${c.g} pv=${c.pv} ${c.kind}`).join(' '));
    if (o.debug === L.baseline) {
      console.log(`-- debug y${L.baseline} '${t.w.text}' open ${open} edge ${Ev}: verdict ${tv.verdict} pen0 ${tv.pen0} pens ${tv.pens.join(',')} TRUTH pens ${L.glyphs.slice(t.w.i0, t.w.i1 + 1).map(g => g.pen).join(',')} est ${(t.penLeft + t.spaceLine).toFixed(3)} / ${(t.penRight - t.spaceLine - R.layoutLine(set, t.w.text, 0, { spaceAdv: t.spaceLine, metrics }).advanceW).toFixed(3)} box ${JSON.stringify(boxObj)} bar cols ${xe0}-${xe1}`);
      const wn = tv.window, r = tv.render;
      let head = '     '; for (let x = wn.x0; x < wn.x0 + wn.w; x++) head += String(x % 1000).padStart(5); console.log(head);
      for (let y = wn.y0; y < wn.y0 + wn.h; y++) {
        let l1 = String(y).padStart(4) + ' ', l2 = '  pr ';
        for (let x = wn.x0; x < wn.x0 + wn.w; x++) {
          const i = y * W + x, m = det.mask[i], e = det.mask._edge[i];
          const rx = x - r.x0, ry = y - r.y0, pr = rx >= 0 && ry >= 0 && rx < r.w && ry < r.h ? r.gray[ry * r.w + rx] : 255;
          l1 += String(page.gray[i]).padStart(4) + (m ? (e ? 'e' : 'm') : ' ');
          l2 += (pr === 255 ? '   .' : String(pr).padStart(4)) + (tv.mism[(y - wn.y0) * wn.w + (x - wn.x0)] ? '!' : ' ');
        }
        console.log(l1); console.log(l2);
      }
      for (const cx of [xe0, xe1]) { const lst = []; for (let y = 0; y < H; y++) { const i = y * W + cx; if (det.mask._edgeV[i]) lst.push(`${y}:${page.gray[i]}/${det.mask._edge[i]}`); } console.log(`   column ${cx} edgeV cells (y:page/edge):`, lst.join(' ')); }
      console.log('   objects near the bar:', JSON.stringify(det.objects.filter(ob => ob.x1 > xe0 - 5 && ob.x0 < xe1 + 5 && ob.y1 > y0 - 3 && ob.y0 < y1 + 3)));
      const cells = [];
      for (let y = wn.y0; y < wn.y0 + wn.h; y++) for (let x = wn.x0; x < wn.x0 + wn.w; x++) if (tv.mism[(y - wn.y0) * wn.w + (x - wn.x0)]) { const i = y * W + x; cells.push(`(${x},${y})=${page.gray[i]}${det.mask[i] ? (det.mask._edgeV[i] ? 'v' + det.mask._edge[i] : det.mask._edge[i] ? 'e' + det.mask._edge[i] : 'm') : ''}`); }
      console.log('   mismatch cells:', cells.join(' '));
    }
    c.n++;
    if (tv.verdict === 'consistent') c.truthC++;
    else if (tv.verdict === 'contradicted') { c.truthX++; notes.push(`y${L.baseline} '${t.w.text}' TRUTH CONTRADICTED open ${tv.open.differ}/${tv.open.ink} edge ${tv.edge.differ}/${tv.edge.ink} unexplained ${tv.unexplained} penFit ${tv.penFit?.toFixed(2)}`); }
    else c.truthN++;
    for (const d of decoys) {
      const dv = Hy.testHypothesis(page, det, set, line, boxObj, d, opts);
      c.decoys++;
      if (dv.verdict === 'contradicted') c.decoyX++;
      else if (dv.verdict === 'consistent') { c.ties++; if (o.verbose) notes.push(`y${L.baseline} '${t.w.text}' tie with '${d}'`); }
      else c.decoyN++;
    }
  }
  rows.push(c);
  console.log(`open ${open}  edge ${String(Ev).padStart(3)}  words ${String(c.n).padStart(3)}  truth: consistent ${String(c.truthC).padStart(3)} contradicted ${String(c.truthX).padStart(2)} no-evidence ${String(c.truthN).padStart(3)}  decoys ${String(c.decoys).padStart(4)}: contradicted ${String(c.decoyX).padStart(4)} ties ${String(c.ties).padStart(3)} no-evidence ${String(c.decoyN).padStart(3)}` +
    (notes.length ? `\n      ${notes.slice(0, 8).join('\n      ')}` : ''));
}
const tot = rows.reduce((a, r) => ({ truthX: a.truthX + r.truthX, truthC: a.truthC + r.truthC, decoyX: a.decoyX + r.decoyX, ties: a.ties + r.ties, decoys: a.decoys + r.decoys }), { truthX: 0, truthC: 0, decoyX: 0, ties: 0, decoys: 0 });
console.log(`total: truth contradicted ${tot.truthX} (gate: must be 0), truth consistent ${tot.truthC}; decoys ${tot.decoys}: contradicted ${tot.decoyX}, ties ${tot.ties}`);
if (tot.truthX) process.exit(1);
