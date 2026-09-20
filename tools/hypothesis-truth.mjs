// hypothesis-truth.mjs — the string tester (engine/hypothesis.js) on REAL
// redaction bars whose text is KNOWN: the source document exists un-redacted,
// so every bar has a truth and every other name of the width is a decoy.
// tools/hypothesis-bench.mjs paints synthetic bars; this reads the producer's
// own bars with tol0's certified read, so an engine failure shows here and a
// Recto failure (the seam's pen inputs, the width tie, the name list) does
// not — run both and diff.
//
//   node tools/hypothesis-truth.mjs --pdf X.pdf --page 1 --pool calibri \
//        --truth truth.json [--names names.json] [--tol 0.5] [--debug <x0>] [--verbose]
//
// truth.json: [{ "x": 392, "y": 406, "text": "Sarah Kellen" }, ...] — x within
// 4 px of the detected box's left column, y a baseline inside its rows.
// names.json (Recto's redaction_matching list): first x last strings whose
// advance ties the truth's within --tol are the decoys, as the matcher would.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { materializeSet } from './glyph-bundle.mjs';
import { POOLS } from './glyph-registry.mjs';
import { cacheDirFor, pageFile } from './raster-cache.mjs';
import E from '../engine/ocr-engine.js';
import R from '../engine/render.js';
import Hy from '../engine/hypothesis.js';

const o = { pdf: null, page: 1, glyphs: null, truth: null, names: null, tol: 0.5, readTol: 0, debug: null, verbose: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
  else if (a === '--page') o.page = +next();
  else if (a === '--glyphs') o.glyphs = next();
  else if (a === '--pool') { const p = POOLS[next()]; if (!p) throw new Error('unknown pool'); o.glyphs = p.glyphs; o.readTol = p.tol ?? 0; }   // the family's certified tolerance (Calibri 1.02 reads at 2)
  else if (a === '--read-tol') o.readTol = +next();
  else if (a === '--truth') o.truth = resolve(process.cwd(), next());
  else if (a === '--names') o.names = resolve(process.cwd(), next());
  else if (a === '--tol') o.tol = +next();
  else if (a === '--debug') o.debug = +next();
  else if (a === '--verbose') o.verbose = true;
  else if (a === '--font-metrics') o.fontMetrics = true;   // lay out with the set's own advances, not the page's
  else if (a === '--min-ink') o.minInk = +next();          // the tester's evidence floor (default 6)
  else throw new Error(`unknown arg ${a}`);
}
if (!o.pdf || !o.glyphs || !o.truth) { console.error('need --pdf, --pool/--glyphs and --truth'); process.exit(2); }

const { dir } = cacheDirFor(o.pdf);
const fp = join(dir, pageFile(o.page));
if (!existsSync(fp)) { console.error(`not rasterized: ${fp} — run tools/rasterize-mupdf.mjs`); process.exit(2); }
const raw = gunzipSync(readFileSync(fp)); const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
const W = hdr[2], H = hdr[3]; let page;
if (hdr[1] === 1) page = { w: W, h: H, gray: Uint8Array.from(new Uint8Array(raw.buffer, raw.byteOffset + 16, W * H)) };
else if (hdr[1] === 4) {                                   // colour page: LAWS §9, as blind-read.mjs readGray does it
  const c = E.colourInk(W, H, new Uint8Array(raw.buffer, raw.byteOffset + 16, 3 * W * H), 3);
  page = { w: W, h: H, gray: c.gray, converted: c.convertedN ? c.converted : null, bandLo: c.bandLo, bandHi: c.bandHi };
} else { const s = new Uint16Array(raw.buffer, raw.byteOffset + 16, W * H); const gray = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) gray[i] = s[i] >= 765 ? 255 : Math.round(s[i] / 3); page = { w: W, h: H, gray }; }

const sets = o.glyphs.split(',').map(g => { const p = g.split('+'); return p.length > 1 ? E.unionSets(p.map(n => materializeSet(n))) : materializeSet(g); });
const base = await E.readPage(page, sets, { tol: o.readTol });
const spaceAdv = E.spaceCalib(base.lines);
const certified = base.lines.filter(L => L.set && L.clean);
// the producer's metrics are measured from pens the reader certified
// byte-exactly; a tolerance page's pens are not that (Calibri 1.02 at tol 2
// gave "Lesley Groff" 76.08 px on one page and 77.91 on another, the font
// 77.24 — and the bars are 77 wide), so those pages lay out with the font's
const metrics = o.fontMetrics || o.readTol > 0 ? null : R.pageMetrics(certified, spaceAdv);
const det = E.detectObjects(page);
const boxes = det.objects.filter(b => b.type === 'box');
console.log(`${o.pdf.replace(/.*[\\/]/, '')} p${o.page} (tol ${o.readTol}): ${base.lines.length} lines, ${certified.length} certified, ${boxes.length} boxes, space ${spaceAdv.toFixed(2)}, metrics ${metrics ? `${metrics.adv.size} advances / ${metrics.kern.size} kern pairs` : 'the font\'s'}`);

const truths = JSON.parse(readFileSync(o.truth, 'utf8'));
const pool = [];
if (o.names) {
  for (const e of JSON.parse(readFileSync(o.names, 'utf8'))) {
    const firsts = e.first || [], lasts = e.last || [];
    for (const f of firsts) for (const l of lasts) pool.push(`${f} ${l}`);
    for (const f of firsts) pool.push(f);
    for (const l of lasts) pool.push(l);
  }
}
const uniq = [...new Set(pool)];
const advOf = (set, text) => R.layoutLine(set, text, 0, { spaceAdv, metrics }).advanceW;

function lineOf(box, y) {
  const cands = base.lines.filter(L => L.set && L.baseline >= box.y0 - 2 && L.baseline <= box.y1 + 2);
  if (!cands.length) return null;
  return cands.reduce((a, L) => Math.abs(L.baseline - y) < Math.abs(a.baseline - y) ? L : a);
}
function medianGap(L) {
  const gaps = [];
  for (let i = 1; i < L.glyphs.length; i++) {
    const p = L.glyphs[i - 1], g = L.glyphs[i];
    const gap = g.pen - p.pen - p.adv;
    if (gap <= 0.55 * spaceAdv) continue;
    if (boxes.some(b => b.y0 <= L.baseline && b.y1 >= L.baseline - 2 && b.x0 >= p.pen && b.x1 <= g.pen + 2)) continue;   // a bar sits in this gap
    gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  return gaps.length >= 2 ? (gaps.length % 2 ? gaps[gaps.length >> 1] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2) : spaceAdv;
}
const fmt = v => `${v.verdict.padEnd(12)} open ${v.open.match}/${v.open.ink} edge ${v.edge.match}/${v.edge.ink} dark ${v.dark.match}/${v.dark.ink}${v.rows && v.rows.ink ? ` (rows ${v.rows.match}/${v.rows.ink})` : ''} unexplained ${v.unexplained} pen ${v.pen0} fit ${v.penFit?.toFixed(2)}${v.reason ? ' ' + v.reason : ''}`;
const cellTag = i => det.mask[i] ? (det.mask._edgeV[i] ? 'v' + det.mask._edge[i] : det.mask._edge[i] ? 'e' + det.mask._edge[i] : 'm') : '';
let truthBad = 0;
for (const t of truths) {
  const box = boxes.filter(b => Math.abs(b.x0 - t.x) <= 4 && (t.y === undefined || (t.y >= b.y0 - 8 && t.y <= b.y1 + 8))).sort((a, b) => Math.abs(a.x0 - t.x) - Math.abs(b.x0 - t.x))[0];
  if (!box) { console.log(`?? '${t.text}' at ${t.x},${t.y}: no box`); continue; }
  const L = lineOf(box, t.y ?? box.y1);
  if (!L) { console.log(`?? '${t.text}' box ${JSON.stringify(box)}: no certified line`); continue; }
  const set = L.set;
  const prev = L.glyphs.filter(g => g.pen + g.adv <= box.x0 + 2).pop() || null;
  const next = L.glyphs.find(g => g.pen >= box.x1 - 2) || null;
  const spaceLine = medianGap(L);
  const closes = ch => /[,.;:!?'"’”)\]}]/.test(ch), opens = ch => /[('"‘“(\[{]/.test(ch);
  const line = { baseline: L.baseline, phy: L.phy, tol: o.readTol, spaceLine, penLeft: prev ? prev.pen + prev.adv : null, penRight: next ? next.pen : null,
    gapLeft: prev && opens(prev.ch) ? 0 : spaceLine, gapRight: next && closes(next.ch) ? 0 : spaceLine, top: L.top, bot: L.bot, metrics };
  const explained = [R.renderLine(set, L.glyphs.map(g => ({ ch: g.ch, pen: g.pen })), L.baseline, { phy: L.phy })];
  for (const M of base.lines) {
    if (M === L || !M.set || !M.glyphs.length) continue;
    if (M.baseline + M.set.maxDesc <= L.baseline - set.maxAsc || M.baseline - M.set.maxAsc >= L.baseline + set.maxDesc) continue;
    explained.push(R.renderLine(M.set, M.glyphs.map(g => ({ ch: g.ch, pen: g.pen })), M.baseline, { phy: M.phy }));
  }
  const truthAdv = advOf(set, t.text);
  const inner = box.x1 - box.x0;
  const decoys = uniq.filter(n => n !== t.text && Math.abs(advOf(set, n) - truthAdv) <= o.tol);
  const opts = { explained, minInk: o.minInk, trace: o.debug === box.x0 ? [] : null };
  const tv = Hy.testHypothesis(page, det, set, line, box, t.text, opts);
  const ctx = (prev ? prev.ch : '|') + '...' + (next ? next.ch : '|');
  console.log(`\n== '${t.text}' box x${box.x0}-${box.x1} y${box.y0}-${box.y1} (w ${inner}, adv ${truthAdv.toFixed(2)}) line y${L.baseline} band ${L.top}-${L.bot} '${ctx}' penLeft ${line.penLeft?.toFixed(2)} penRight ${line.penRight?.toFixed(2)} space ${spaceLine.toFixed(2)}`);
  console.log(`   TRUTH  ${fmt(tv)}${tv.verdict !== 'consistent' ? '   <-- ' + tv.verdict.toUpperCase() : ''}`);
  if (tv.verdict === 'contradicted') truthBad++;
  if (opts.trace && opts.trace.length) console.log('   trace:', opts.trace.slice(0, 16).map(c => `(${c.x},${c.y}) ev=${c.ev} g=${c.g} pv=${c.pv} ${c.kind}`).join(' '));
  if (o.debug === box.x0) {
    const wn = tv.window, r = tv.render;
    if (wn && r) {
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
    }
    for (const cx of [box.x0 - 1, box.x0, box.x1 - 1, box.x1]) {
      const lst = [];
      for (let y = box.y0 - 2; y < box.y1 + 2; y++) { const i = y * W + cx; lst.push(`${y}:${page.gray[i]}${cellTag(i)}`); }
      console.log(`   column ${cx}:`, lst.join(' '));
    }
  }
  const res = { consistent: [], contradicted: 0, none: 0 };
  for (const d of decoys) {
    const dv = Hy.testHypothesis(page, det, set, line, box, d, { explained, minInk: o.minInk });
    if (dv.verdict === 'consistent') res.consistent.push(o.verbose ? `${d} [${fmt(dv)}]` : d);
    else if (dv.verdict === 'contradicted') res.contradicted++;
    else res.none++;
  }
  if (decoys.length) console.log(`   decoys ${decoys.length} (±${o.tol} px): ${res.consistent.length} consistent, ${res.contradicted} contradicted, ${res.none} no-evidence${res.consistent.length ? ' · ' + res.consistent.join(o.verbose ? '\n      ' : ', ') : ''}` +
    (tv.verdict !== 'contradicted' && res.consistent.length === 0 && res.none === 0 ? '   => the truth is the SOLE SURVIVOR' : ''));
}
console.log(`\ntruth contradicted: ${truthBad}`);
