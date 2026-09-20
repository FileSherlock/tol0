// harvest.mjs — mine ground-truth glyph rasters out of ingested pages.
//
//   node lab/harvest.mjs --doc EFTA00751637 --out courier
//   node lab/harvest.mjs --doc <DOC> --dry
//   knobs: --min-obs 3  --max-var 8  --adv <px>  (--adv PINS the lattice)
//
// Output is `lab/targets/<out>/<id>.pgm` + `index.json`, which is the one
// target format in this lab: identify.mjs and sweep.mjs both read it.
//
// ## What makes a target trustworthy
//
// Nothing here trusts a renderer, a font metric, or the overlay's geometry:
//
//   1. mask frame objects (long vertical/horizontal rules) so they cannot join
//      two text lines into one band;
//   2. split the page into ink bands on blank rows;
//   3. **fit the cell lattice per band from INK ALONE** — autocorrelation for
//      a seed period, then a 2-D sweep for the (advance, phase) whose sampled
//      columns sit in the ink valleys. A wrong advance drifts off the cell
//      boundaries within half a line, so the cost function has a sharp
//      minimum; bands with no sharp minimum (proportional headers, rules) are
//      skipped and counted. The overlay contributes NO geometry.
//   4. cut one window per cell, trimmed to its own ink rows + 1 white guard row;
//   5. cluster byte-identical windows, and PROMOTE one only when it was seen
//      ≥ --min-obs times with ≥2 distinct LEFT and ≥2 distinct RIGHT neighbour
//      labels. **That diversity requirement is the proof the cut is right**: a
//      window cut at the wrong offset includes a slice of its neighbour, so it
//      differs per neighbour and can never reach byte-identity across two.
//
// ## Two limits worth knowing before you trust the output
//
// **Monospace only.** The lattice fit assumes abutting equal-width cells. On a
// proportional face it still emits byte-identical clusters, but they are glyph
// FRAGMENTS cut at a fictional pitch, and matching against them proves nothing.
// For a proportional face, go straight to the mbank → fontgen → read route in
// lab/README.md.
//
// **Cells clip wide glyphs, and that is silent.** A cell window is exactly one
// advance wide, so a glyph whose ink runs past its cell loses columns. Such a
// window still clusters byte-identically and still looks fine on screen — it
// just has the wrong DIMENSIONS, so it fails every dims-gated sweep for a
// reason that has nothing to do with the face. Cells whose ink run crosses a
// boundary are therefore dropped here and counted as `boundary-clipped`.
//
// The test is "an ink run crosses the boundary", not "ink touches the border":
// a glyph that exactly fills its cell is perfectly good ground truth. On
// EFTA00751637 the difference is 61 of 126 windows — a border-touch rule would
// have thrown away half the usable targets.
//
// ## Labels are claims
//
// `ch` comes from the producer's own OCR overlay. A systematic confusion (O/0,
// l/I) can survive even unanimity — so if a renderer matches a target labelled
// 'O' with its '0', believe the pixels and fix the label.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { readPgm, writePgm, INK } from './pgm.mjs';

const LAB = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const args = process.argv.slice(2);
const optN = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? +args[i + 1] : d; };
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const MIN_OBS = optN('min-obs', 3);
const MAX_VAR = optN('max-var', 8);
const DRY = args.includes('--dry');
const OUT = optS('out', 'default').replace(/[\\/]+$/, '');
const ADV_PIN = args.includes('--adv') ? optN('adv', 0) : null;
const docFilter = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--doc') docFilter.push(args[i + 1]);

const pagesRoot = `${LAB}/pages`;
if (!existsSync(pagesRoot)) { console.error('nothing ingested — run: node lab/ingest.mjs <pdf>'); process.exit(2); }
const docs = (docFilter.length ? docFilter : readdirSync(pagesRoot))
  .filter(d => existsSync(`${pagesRoot}/${d}/meta.json`));
if (!docs.length) { console.error('no ingested docs under lab/pages/ — run lab/ingest.mjs first'); process.exit(2); }

// ---------------------------------------------------------------- the lattice
// Sampled columns land in the ink VALLEYS between cells. `contrast` is that
// minimum divided by the mean cost over the search — a real lattice is a sharp
// valley (<< 1); anything above 0.82 is a band with no lattice at all.
function bandLattice(proj, near, w) {
  let mean = 0, n = 0;
  for (let c = 0; c < w; c++) if (near[c]) { mean += proj[c]; n++; }
  if (n < 30) return null;
  mean /= n;
  const d = new Float64Array(w);
  for (let c = 0; c < w; c++) d[c] = near[c] ? proj[c] - mean : 0;
  let bestLag = 0, bestAC = -Infinity;
  for (let lag = 4; lag <= 14; lag++) {
    let s = 0;
    for (let c = 0; c + lag < w; c++) s += d[c] * d[c + lag];
    if (s > bestAC) { bestAC = s; bestLag = lag; }
  }
  const cost = (adv, phi) => {
    let s = 0, nb = 0;
    for (let x = phi; x < w; x += adv) {
      const c = Math.round(x);
      if (c < w && near[c]) { s += proj[c]; nb++; }
    }
    return nb >= 8 ? { c: s / nb, nb } : null;
  };
  let best = null, costSum = 0, costN = 0;
  const lo = ADV_PIN ?? bestLag - 0.75, hi = ADV_PIN ?? bestLag + 0.75;
  for (let adv = lo; adv <= hi; adv += 0.01)
    for (let phi = 0; phi < adv; phi += 1 / 8) {
      const r = cost(adv, phi);
      if (!r) continue;
      costSum += r.c; costN++;
      if (!best || r.c < best.cost) best = { adv, phi, cost: r.c };
    }
  if (!best || !costN) return null;
  for (let adv = best.adv - 0.02; adv <= best.adv + 0.02; adv += 0.002)
    for (let phi = best.phi - 0.3; phi <= best.phi + 0.3; phi += 1 / 32) {
      const r = cost(adv, ((phi % adv) + adv) % adv);
      if (r && r.c < best.cost) best = { adv, phi: ((phi % adv) + adv) % adv, cost: r.c };
    }
  best.contrast = best.cost / (costSum / costN);
  return best;
}

// ---------------------------------------------------------------- collect
const clusters = new Map();
const stats = { pages: 0, bands: 0, bandsNoWords: 0, bandsOffLattice: 0,
  cells: 0, cellsMasked: 0, cellsBlank: 0, cellsClipped: 0, wordsDropped: 0, bandAdvs: [] };

for (const doc of docs) {
  const files = readdirSync(`${pagesRoot}/${doc}`).filter(f => /^page-\d+\.pgm$/.test(f)).sort();
  for (const f of files) {
    const pno = +/(\d+)/.exec(f)[1];
    const wordsFile = `${pagesRoot}/${doc}/${f.replace('.pgm', '.words.json')}`;
    if (!existsSync(wordsFile)) continue;
    const { w, h, px } = readPgm(`${pagesRoot}/${doc}/${f}`);
    const words = JSON.parse(readFileSync(wordsFile, 'utf8')).words;
    stats.pages++;

    // ---- mask long rules: vertical runs ≥40 px, horizontal runs ≥300 px ----
    const mask = new Uint8Array(w * h);
    for (let c = 0; c < w; c++) {
      let run = 0;
      for (let r = 0; r <= h; r++) {
        const on = r < h && px[r * w + c] < INK;
        if (on) run++;
        else { if (run >= 40) for (let k = r - run; k < r; k++) mask[k * w + c] = 1; run = 0; }
      }
    }
    for (let r = 0; r < h; r++) {
      let run = 0;
      for (let c = 0; c <= w; c++) {
        const on = c < w && px[r * w + c] < INK;
        if (on) run++;
        else { if (run >= 300) for (let k = c - run; k < c; k++) mask[r * w + k] = 1; run = 0; }
      }
    }
    const ink = (r, c) => px[r * w + c] < INK && !mask[r * w + c];

    // ---- bands ----
    const inkedRow = new Uint8Array(h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (ink(r, c)) { inkedRow[r] = 1; break; }
    const bands = [];
    for (let r = 0; r < h; r++) {
      if (!inkedRow[r]) continue;
      let r1 = r; while (r1 + 1 < h && inkedRow[r1 + 1]) r1++;
      bands.push({ r0: r, r1 }); r = r1;
    }

    for (const band of bands) {
      stats.bands++;
      const bandWords = words.filter(o =>
        o.px.yBase >= band.r0 - 1 && o.px.yBase <= band.r1 + 2 && o.text.trim() && o.chars);
      if (!bandWords.length) { stats.bandsNoWords++; continue; }
      if (band.r1 - band.r0 < 4) { stats.bandsOffLattice++; continue; }   // rules, dust

      const proj = new Float64Array(w);
      for (let c = 0; c < w; c++) {
        let s = 0;
        for (let r = band.r0; r <= band.r1; r++) if (ink(r, c)) s++;
        proj[c] = s;
      }
      const near = new Uint8Array(w);
      for (let c = 0; c < w; c++) if (proj[c])
        for (let k = Math.max(0, c - 8); k < Math.min(w, c + 9); k++) near[k] = 1;
      const fit = bandLattice(proj, near, w);
      if (!fit || fit.contrast > 0.82) { stats.bandsOffLattice++; continue; }
      const ADVB = fit.adv, phi = fit.phi;
      stats.bandAdvs.push(ADVB);

      // ---- cut cells, word by word ----
      // A word whose claimed cells are >30% blank is an overlay artifact (the
      // OCR hallucinated text where the page has none) and is dropped whole.
      for (const o of bandWords) {
        const text = o.text;
        const cuts = [];
        let blanks = 0;
        for (let j = 0; j < text.length; j++) {
          // snap each char independently: long-word overlay drift stays under
          // half a cell, so per-char snapping beats extrapolating from the start
          const kj = Math.round((o.chars[j] - phi - 1.2) / ADVB);
          const start = phi + kj * ADVB;
          const c0 = Math.round(start), c1 = Math.round(start + ADVB);
          if (c0 < 0 || c1 > w) continue;
          let masked = false, top = -1, bot = -1;
          for (let r = band.r0; r <= band.r1 && !masked; r++)
            for (let c = c0; c < c1; c++) {
              if (mask[r * w + c]) { masked = true; break; }
              if (px[r * w + c] < INK) { if (top < 0) top = r; bot = r; }
            }
          if (top < 0 && !masked) blanks++;
          // CLIPPED: an ink run crosses the cell boundary, so this window lost
          // columns of its own glyph and has the wrong dimensions. Note this is
          // NOT "ink touches the border" — a glyph that exactly fills its cell
          // is fine, and 61 of this document's 126 windows are exactly that.
          let clipped = false;
          for (let r = top; r >= 0 && r <= bot && !clipped; r++)
            clipped = (c0 > 0 && px[r * w + c0] < INK && px[r * w + c0 - 1] < INK)
              || (c1 < w && px[r * w + c1 - 1] < INK && px[r * w + c1] < INK);
          cuts.push({ j, start, c0, c1, masked, top, bot, clipped });
        }
        if (blanks > 0.3 * text.length) { stats.wordsDropped++; continue; }
        for (const { j, start, c0, c1, masked, top, bot, clipped } of cuts) {
          stats.cells++;
          if (masked) { stats.cellsMasked++; continue; }
          if (top < 0) { stats.cellsBlank++; continue; }
          if (clipped) { stats.cellsClipped++; continue; }
          const g0 = top - 1, g1 = bot + 1;              // 1 white guard row each side
          const cw = c1 - c0, ch = g1 - g0 + 1;
          const bytes = Buffer.alloc(cw * ch);
          for (let r = g0; r <= g1; r++) for (let c = c0; c < c1; c++)
            bytes[(r - g0) * cw + (c - c0)] = (r < 0 || r >= h) ? 255 : px[r * w + c];
          const key = `${cw}x${ch}:${bytes.toString('latin1')}`;
          let cl = clusters.get(key);
          if (!cl) clusters.set(key, cl = { w: cw, h: ch, px: bytes, obs: 0,
            labels: new Map(), left: new Set(), right: new Set(), fracs: [], srcs: [] });
          cl.obs++;
          const label = text[j];
          cl.labels.set(label, (cl.labels.get(label) ?? 0) + 1);
          cl.left.add(j > 0 ? text[j - 1] : '␣');
          cl.right.add(j < text.length - 1 ? text[j + 1] : '␣');
          cl.fracs.push(((start % 1) + 1) % 1);
          if (cl.srcs.length < 3) cl.srcs.push({ doc, page: pno, x: c0, y: g0 });
        }
      }
    }
  }
}

const medianAdv = () => {
  if (!stats.bandAdvs.length) return ADV_PIN ?? 0;
  const s = [...stats.bandAdvs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// ---------------------------------------------------------------- promote
const promoted = [];
let rejObs = 0, rejLabel = 0, rejNb = 0, byMajority = 0;
for (const cl of clusters.values()) {
  if (cl.obs < MIN_OBS) { rejObs++; continue; }
  if (cl.left.size < 2 || cl.right.size < 2) { rejNb++; continue; }
  // Unanimous, or a ≥90% majority with ≥3 votes: the overlay itself misreads
  // (base64 walls especially), and the PIXELS of a repeated cell are still
  // truth even when its label vote is not unanimous.
  const votes = [...cl.labels.entries()].sort((a, b) => b[1] - a[1]);
  const [ch, top] = votes[0];
  if (cl.labels.size !== 1) {
    if (top < 3 || top / cl.obs < 0.9) { rejLabel++; continue; }
    byMajority++;
  }
  const frac = cl.fracs.reduce((a, b) => a + b, 0) / cl.fracs.length;
  promoted.push({ ch, cp: ch.codePointAt(0), frac, labelShare: +(top / cl.obs).toFixed(3), cl });
}

// group by (codepoint, ¼-px phase slot); keep the most-observed variants
const bySlot = new Map();
for (const p of promoted) {
  const k = `${p.cp}_${Math.min(3, Math.floor(p.frac * 4))}`;
  if (!bySlot.has(k)) bySlot.set(k, []);
  bySlot.get(k).push(p);
}
let overflow = 0;
const targets = [];
const outDir = `${LAB}/targets/${OUT}`;
if (!DRY) mkdirSync(outDir, { recursive: true });
for (const [k, list] of [...bySlot.entries()].sort()) {
  list.sort((a, b) => b.cl.obs - a.cl.obs);
  if (list.length > MAX_VAR) { overflow += list.length - MAX_VAR; list.length = MAX_VAR; }
  list.forEach((p, i) => {
    const slot = +k.split('_')[1];
    const id = `${p.cp}_p${slot}_v${i + 1}`;
    const { w: cw, h: chh, px: b } = p.cl;
    targets.push({ id, ch: p.ch, cp: p.cp, phaseSlot: slot, phx: slot / 4, variant: i + 1,
      w: cw, h: chh, adv: +medianAdv().toFixed(6), frac: +p.frac.toFixed(4),
      labelShare: p.labelShare, obs: p.cl.obs, srcs: p.cl.srcs });
    if (!DRY) writePgm(`${outDir}/${id}.pgm`, cw, chh, b);
  });
}

if (!DRY) writeFileSync(`${outDir}/index.json`, JSON.stringify({
  adv: +medianAdv().toFixed(6), source: docs,
  note: 'Cells cut on a per-band lattice fitted from INK ALONE, trimmed to ink rows + 1 white guard row. '
    + `Promoted at >=${MIN_OBS} byte-identical observations with >=2 distinct left AND right neighbour labels — `
    + 'that diversity is the proof the cut is right. Cells whose ink run crosses a cell boundary are DROPPED, '
    + 'not promoted: such a window lost columns of its own glyph and its dimensions are a lie. '
    + 'phx = phaseSlot/4; frac = mean sub-pixel cell origin.',
  targets,
}, null, 1));

const chars = new Set(targets.map(t => t.ch));
if (stats.bandAdvs.length) {
  const s = [...stats.bandAdvs].sort((a, b) => a - b);
  console.log(`band advance: median ${s[s.length >> 1].toFixed(4)} px  (q10 ${s[s.length / 10 | 0].toFixed(4)}, q90 ${s[9 * s.length / 10 | 0].toFixed(4)}, n ${s.length})`);
}
console.log(`pages ${stats.pages}  bands ${stats.bands} (noWords ${stats.bandsNoWords}, offLattice ${stats.bandsOffLattice})`);
console.log(`cells ${stats.cells} (masked ${stats.cellsMasked}, blank ${stats.cellsBlank}, `
  + `boundary-clipped ${stats.cellsClipped})  clusters ${clusters.size}`);
console.log(`promoted ${promoted.length} (${byMajority} by 90% majority label) -> ${targets.length} targets, `
  + `${chars.size} distinct chars (variant overflow dropped: ${overflow})`);
console.log(`rejected: obs<${MIN_OBS} ${rejObs}, label-conflict ${rejLabel}, neighbour-diversity ${rejNb}; words dropped ${stats.wordsDropped}`);
console.log([...chars].sort().join(''));
if (!DRY) console.log(`\nwrote lab/targets/${OUT}/index.json + ${targets.length} PGMs`);
