// blind-read.mjs — self-calibrating byte-exact reader: NO layout constants.
// The scanning physics (ink bands, baseline pin, left→right composite-aware
// scan, non-text object detection, space calibration) live in ONE shared
// place, ../engine/ocr-engine.js — the same DOM-free core the browser/Recto app
// (engine/blindocr.js) runs. This file owns only what's CLI-specific: raster
// acquisition from the GRY1 cache (readGray/cachePages), the glyph bundle
// loader (tools/glyph-bundle.mjs, a Node Buffer reader — the app's parallel
// reader in blindocr.js uses DataView; two I/O front ends for one binary
// format, not the matcher), CLI arg parsing, truth-diffing, and text/JSON
// output.
//
// Where the main app assumes the corpus grid (rows 40+18·r, baseline +11,
// startX 45, measureText spacing), the engine measures everything from the
// page:
//
//   1. ink bands       : maximal runs of inked rows, split on blank rows;
//   2. baseline pin    : per band, try candidate baselines (integer AND ½-px
//                        y-phase) and keep the one whose leftmost glyphs
//                        byte-match;
//   3. left→right scan : at the leftmost unexplained ink column, try every
//                        (glyph, ¼-px x-phase) whose first ink column lands
//                        there; predicted = blend(explained-canvas, coverage)
//                        via the proven law dst=(dst·(256−e))>>8, e=cov+(cov>>7);
//                        byte-exact on the glyph's ink (pixels the NEXT glyph
//                        may darken are held pending and settled when it is
//                        blended in). Accept the candidate explaining the most
//                        ink; pens come out on the ¼-px lattice for free;
//   4. spaces          : measured pen gaps vs advances — space width is
//                        self-calibrated from the gap histogram, narrow styled
//                        spaces become measurements instead of model errors.
//
// Multiple glyph sets may be given; the reader auto-picks per band (font
// detection). Sets come from the committed fontgen rasters (assets/fonts/*.npz,
// zero corpus pixels), exported by export-glyphs.mjs.
//
//   node tools/blind-read.mjs --pdf fixtures/corpus/v3.pdf --page 2
//   node tools/blind-read.mjs --pdf fixtures/corpus/v3.pdf --all --truth fixtures/corpus/v3.txt
//   node tools/blind-read.mjs --raster <page.gray.gz> --glyphs times16,arial16
//   node tools/blind-read.mjs --pdf X.pdf --all --pool nimbusrom
//
// Colour pages (mode 4 rasters, u8 RGB) go through ONE implementation of the
// colour law, Engine.colourInk (docs/LAWS.md §9): coloured text becomes the
// black-ink coverage it was drawn as, through the page's own pens, and reads
// with the sets the reader has; what no pen explains is whitened. Coloured
// ink that stays unread is counted apart in the summary ("of which N
// coloured ink") so a document's neutral-text □ stays comparable.
//
// A --pdf must already be in the raster cache (fixtures/raster-cache/, keyed by
// the PDF's sha256): `node tools/rasterize-mupdf.mjs --pdf X.pdf` fills it.
// The reader never renders a page itself — it reads the producer's own
// embedded page image, because rendering would invent pixels.
//
// `--pool <name>` takes a certified family recipe (glyphs + tol + palette/
// quant) straight from the ONE registry, tools/glyph-registry.mjs POOLS —
// the same source gate.mjs reads, so a pool can never drift from its
// certified command. Explicit flags after it still win.
//
// `--shadow` reads glyphs from their shadow alone under a redaction box's
// edge (docs/LAWS.md §8) — off by default, measured wrong more often than
// right on real boxes; the JSON marks such glyphs with a 3rd tuple element
// (pixels the box destroyed) and `shadow` reads carry no open ink at all.
//
// Debug envs (see ../engine/ocr-engine.js scanLine): BR_DEBUG=1 (fail pixels),
// BR_LINE=<baseline> (accept trace), BR_PIX=<col> (per-pixel rejection detail),
// BR_PROF=1 (probe count and time per sweep, per page).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { POOLS } from './glyph-registry.mjs';
import { readGray, paletteLUTs, loadSets, pageResult } from './read-core.mjs';
import { CACHE_DIR, cacheDirFor, pageFile } from './raster-cache.mjs';
import Engine from '../engine/ocr-engine.js';

// ---------------- args ----------------
const o = { pdf: null, raster: null, page: 1, all: false, truth: null, out: null,
  json: null, glyphs: ['times16'], tol: 0, matchcols: 0 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
  else if (a === '--raster') o.raster = resolve(process.cwd(), next());
  else if (a === '--page') o.page = parseInt(next(), 10);
  else if (a === '--all') o.all = true;
  else if (a === '--truth') o.truth = resolve(process.cwd(), next());
  else if (a === '--out') o.out = resolve(process.cwd(), next());
  else if (a === '--json') o.json = resolve(process.cwd(), next());
  else if (a === '--tol') o.tol = parseInt(next(), 10);
  else if (a === '--glyphs') o.glyphs = next().split(',');
  else if (a === '--union') o.union = true;
  else if (a === '--shadow') o.shadow = true;      // shadow-only reads under boxes (LAWS §8; off by default)
  else if (a === '--quant') o.quant = true;
  else if (a === '--palette') o.palette = true;
  else if (a === '--matchcols') o.matchcols = parseInt(next(), 10);
  else if (a === '--pool') {
    const p = POOLS[next()];
    if (!p) { console.error(`unknown pool; have: ${Object.keys(POOLS).join(' ')}`); process.exit(2); }
    o.glyphs = p.glyphs.split(',');
    if (p.tol !== undefined) o.tol = p.tol;
    if (p.palette) o.palette = true;
    if (p.quant) o.quant = true;
  }
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}

// ---------------- raster access ----------------
// (record decoding — every mode, the colour law — lives in read-core.mjs)
function cachePages(pdfPath) {
  const { key, dir } = cacheDirFor(pdfPath);
  if (!existsSync(join(dir, 'meta.json')))
    throw new Error(`${pdfPath} is not rasterized (no ${CACHE_DIR}/${key}/).\n` +
      `  run: node tools/rasterize-mupdf.mjs --pdf ${pdfPath}`);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  return { numPages: meta.numPages, page: pno => readGray(join(dir, pageFile(pno))) };
}

// ---------------- main ----------------
async function main() {
  const sets = loadSets(o.glyphs, { matchcols: o.matchcols, union: o.union });
  const t0 = Date.now();
  let pages;                                        // [{pno, page}]
  if (o.raster) pages = [{ pno: 0, page: readGray(o.raster) }];
  else {
    if (!o.pdf) { console.error('need --pdf or --raster'); process.exit(1); }
    const cache = cachePages(o.pdf);
    const list = o.all ? Array.from({ length: cache.numPages }, (_, i) => i + 1) : [o.page];
    pages = list.map(pno => ({ pno, page: cache.page(pno) }));
  }
  const palLuts = o.palette && o.pdf ? await paletteLUTs(o.pdf) : null;
  if (o.palette && (!palLuts || !palLuts.size)) console.error('  (--palette: no /Indexed palettes found)');
  const truth = o.truth ? readFileSync(o.truth, 'utf8').replace(/\r/g, '').split('\n') : null;
  // letters-only -> first matching truth row (the per-line linear find was
  // O(rows²) — ~20s of big.pdf's gate run was spent HERE, not reading)
  const truthByLetters = truth && new Map();
  if (truth) for (const t of truth) {
    if (!t.trim()) continue;
    const k = t.replace(/ /g, '');
    if (!truthByLetters.has(k)) truthByLetters.set(k, t);
  }

  let totLines = 0, totGlyphs = 0, totFails = 0, totFrags = 0, totColour = 0;
  let rowExact = 0, rowDiff = 0, spacedExact = 0;
  const diffs = [];
  const outLines = [];
  const jsonPages = [];
  const carry = { last: null, picks: new Map() };   // cross-page layout hints
  for (const { pno, page } of pages) {
    if (!page) continue;
    const { lines, objects } = await Engine.readPage(page, sets,
      { tol: o.tol, quant: (o.palette && palLuts?.get(pno)) || o.quant, shadow: o.shadow, carry });
    const r = pageResult(pno, lines, objects);
    jsonPages.push(r.json); outLines.push(...r.texts);
    totLines += r.tot.lines; totGlyphs += r.tot.glyphs; totFails += r.tot.fails; totFrags += r.tot.frags; totColour += r.tot.colour;
    if (truth) for (const jl of r.json.lines) {
      if (jl.baseline === undefined) continue;
      // row index from baseline is unknown to the reader — compare against
      // the truth row whose letters match (letters-only first, then spaced)
      const letters = jl.text.replace(/ /g, '');
      const hit = truthByLetters.get(letters);
      if (hit !== undefined) { rowExact++; if (hit.trimEnd() === jl.text.trimEnd()) spacedExact++; }
      else { rowDiff++; if (diffs.length < 12) diffs.push({ pno, base: jl.baseline, got: jl.text.slice(0, 70) }); }
    }
    process.stderr.write(`\r  page ${pno}: ${lines.length} bands`);
  }
  process.stderr.write('\n');
  console.log(`\n${totLines} lines, ${totGlyphs} glyphs, ${totFails} unreadable clusters (□)` +
    (totColour ? ` of which ${totColour} coloured ink` : '') +
    (totFrags ? `, ${totFrags} box fragments` : '') +
    `, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (truth) {
    console.log(`vs truth: ${rowExact} rows letter-exact (${spacedExact} also space-exact), ${rowDiff} rows differ`);
    for (const d of diffs) console.log(`  P${d.pno} y${d.base}: ${JSON.stringify(d.got)}`);
  }
  if (o.out) { writeFileSync(o.out, outLines.join('\n') + '\n'); console.log(`wrote ${o.out}`); }
  if (o.json) { writeFileSync(o.json, JSON.stringify({ pages: jsonPages }, null, 1)); console.log(`wrote ${o.json}`); }
}
main().catch(e => { console.error(e); process.exit(1); });
