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
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { materializeSet } from './glyph-bundle.mjs';
import { POOLS } from './glyph-registry.mjs';
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
function readGray(path) {
  const raw = gunzipSync(readFileSync(path));
  const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
  if (hdr[0] !== 0x31595247) throw new Error(`bad GRY1 magic: ${path}`);
  const mode = hdr[1], w = hdr[2], h = hdr[3];
  if (mode === 0) return null;
  if (mode === 1) return { w, h, gray: new Uint8Array(raw.buffer, raw.byteOffset + 16, w * h) };
  if (mode === 2) {
    // mode 2 (legacy sum-only color page). Achromatic ink (R=G=B — plain
    // black text) has sum ≡ 0 (mod 3) at every pixel, so gray = sum/3 is
    // exact there; colored ink (hyperlink blue) is non-neutral at least on
    // its AA edges. Whiten every ink component connected to a non-neutral
    // pixel — the reader then sees only the plain text, byte-exactly.
    // (Sum-only is BLIND to colors whose sum is a multiple of 3 — pure blue
    // (0,0,237) reads as "neutral 79" — and floods whole letters over JPEG
    // channel jitter; mode 3 rasters carry a spread plane instead.)
    const sums = new Uint16Array(raw.buffer, raw.byteOffset + 16, w * h);
    const gray = new Uint8Array(w * h);
    const colored = new Uint8Array(w * h);
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      gray[i] = sums[i] >= 765 ? 255 : (sums[i] / 3) | 0;
      if (sums[i] < 765 && sums[i] % 3) { colored[i] = 1; stack.push(i); }
    }
    while (stack.length) {                             // flood over connected ink
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (!colored[j] && sums[j] < 765) { colored[j] = 1; stack.push(j); }
        }
    }
    let removed = 0;
    for (let i = 0; i < w * h; i++) if (colored[i]) { gray[i] = 255; removed++; }
    if (removed) console.error(`  (color page: ${removed} colored-ink px removed)`);
    return { w, h, gray };
  }
  if (mode === 4) {
    // mode 4: u8 R,G,B. ONE implementation of the colour law (LAWS §9):
    // coloured TEXT becomes the black-ink coverage it was drawn as, through
    // the page's own pens; what no pen explains is whitened as before.
    const rgb = new Uint8Array(raw.buffer, raw.byteOffset + 16, w * h * 3);
    const c = Engine.colourInk(w, h, rgb, 3);
    if (c.convertedN || c.removed)
      console.error(`  (colour page: ${c.convertedN} coloured px read as coverage through ${c.pens.length} pen${c.pens.length === 1 ? '' : 's'}` +
        (c.pens.length ? ` [${c.pens.map(p => p.slice(0, 3).join(',')).join(' ')}]` : '') + `, ${c.removed} whitened)`);
    return { w, h, gray: c.gray, converted: c.convertedN ? c.converted : null,
      bandLo: c.bandLo, bandHi: c.bandHi };
  }
  if (mode !== 3) throw new Error(`mode ${mode} unsupported`);
  // mode 3: u16 R+G+B sums + u8 per-pixel channel spread (max−min). Real
  // color is spread ≥ 4 — seed a whitening flood that spreads ONLY through
  // pixels whose channels differ at all (spread ≥ 1: colored AA fringes),
  // never through neutral ink, so a redaction box touching a blue link
  // underline survives while the underline and its fringe vanish. Spread
  // 1–3 pixels away from color are producer JPEG jitter, NOT color: their
  // true gray is round(sum/3) (±1 single-channel jitter rounds back
  // exactly; heavier jitter lands within --tol 1).
  const sums = new Uint16Array(raw.buffer, raw.byteOffset + 16, w * h);
  const spread = new Uint8Array(raw.buffer, raw.byteOffset + 16 + 2 * w * h, w * h);
  const gray = new Uint8Array(w * h);
  const colored = new Uint8Array(w * h);
  const stack = [];
  let jitter = 0;
  for (let i = 0; i < w * h; i++) {
    gray[i] = sums[i] >= 765 ? 255 : Math.round(sums[i] / 3);
    if (spread[i] >= 4) { colored[i] = 1; stack.push(i); }
    else if (spread[i]) jitter++;
  }
  while (stack.length) {                               // flood through colored px only
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (!colored[j] && spread[j]) { colored[j] = 1; stack.push(j); }
      }
  }
  let removed = 0;
  for (let i = 0; i < w * h; i++) if (colored[i]) { gray[i] = 255; removed++; }
  if (removed || jitter) console.error(
    `  (color page: ${removed} colored px removed, ${jitter} jittered px neutralized)`);
  return { w, h, gray };
}
function cachePages(pdfPath) {
  const { key, dir } = cacheDirFor(pdfPath);
  if (!existsSync(join(dir, 'meta.json')))
    throw new Error(`${pdfPath} is not rasterized (no ${CACHE_DIR}/${key}/).\n` +
      `  run: node tools/rasterize-mupdf.mjs --pdf ${pdfPath}`);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  return { numPages: meta.numPages, page: pno => readGray(join(dir, pageFile(pno))) };
}

// ---------------- palette LUTs (--palette) ----------------
// Producers that store pages as /Indexed images (the eDiscovery Nimbus family)
// quantize the composited page ONCE at the end: page byte = gray of the
// RGB-nearest palette entry (ties darker) for the renderer's output byte.
// Reading the per-page palettes straight from the PDF gives the engine the
// TRUE quant map — the histogram heuristic (--quant) misses entries and
// mis-breaks ties.
//
// Resolution goes through mupdf's object API (the same dependency fontgen.mjs
// uses for char→gid): the earlier raw-byte scrape mislocated objects on any PDF
// whose palettes sit in object streams — it then built a garbage LUT from
// whatever bytes it hit, which passed the white check and sent the engine
// into a near-endless read (EFTA00039421, EFTA00009676). Per page: largest
// /Indexed image in the page resources wins; per-entry cap hival+1 ≤ 256 by
// spec; a palette that darkens white (lut[255] < 250) is a scan image, not a
// page of this family — skipped.
async function paletteLUTs(pdfPath) {
  let mupdf;
  try { mupdf = await import('mupdf'); }
  catch { console.error('  (--palette: mupdf not available — run npm install)'); return new Map(); }
  const luts = new Map();
  let doc;
  try { doc = mupdf.Document.openDocument(readFileSync(pdfPath), 'application/pdf'); }
  catch { return luts; }
  const n = doc.countPages();
  for (let p = 0; p < n; p++) {
    try {
      const page = doc.loadPage(p);
      const xo = page.getObject()?.get('Resources')?.get('XObject');
      if (!xo || !xo.isDictionary?.()) continue;
      let best = null, bestPx = -1;
      xo.forEach(val => {
        try {
          const im = val.resolve?.() ?? val;
          if (im.get('Subtype')?.asName?.() !== 'Image') return;
          const px = (im.get('Width')?.asNumber?.() ?? 0) * (im.get('Height')?.asNumber?.() ?? 0);
          const cs = im.get('ColorSpace')?.resolve?.() ?? im.get('ColorSpace');
          if (!cs?.isArray?.() || cs.get(0)?.asName?.() !== 'Indexed') return;
          if (px > bestPx) { bestPx = px; best = cs; }
        } catch {}
      });
      if (!best) continue;
      const hival = Math.min(best.get(2)?.asNumber?.() ?? 255, 255);
      // readStream must be called on the indirect REF (resolve() yields an
      // object whose isStream()/readStream() refuse — mupdf-js quirk)
      const lookup = best.get(3);
      let pal = null;
      try { pal = lookup.readStream().asUint8Array(); } catch {}
      if (!pal) { try { pal = Uint8Array.from(lookup.asByteString()); } catch {} }
      if (!pal || pal.length < 3) continue;
      const entries = [];
      const nEnt = Math.min(Math.floor(pal.length / 3), hival + 1);
      for (let k = 0; k + 2 < nEnt * 3; k += 3) entries.push([pal[k], pal[k + 1], pal[k + 2]]);
      if (!entries.length) continue;
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) {
        let bst = null, bd = Infinity;
        for (const e of entries) {
          const d = (e[0] - v) ** 2 + (e[1] - v) ** 2 + (e[2] - v) ** 2;
          if (d < bd || (d === bd && e[0] + e[1] + e[2] < bst[0] + bst[1] + bst[2])) { bd = d; bst = e; }
        }
        lut[v] = Math.round((bst[0] + bst[1] + bst[2]) / 3);
      }
      if (lut[255] < 250) continue;            // darkens white: scan image, not this family
      luts.set(p + 1, lut);
    } catch {}
  }
  return luts;
}

// ---------------- glyph sets ----------------
// All sets live in ONE committed binary bundle (assets/glyphs/glyphs.bin,
// built + byte-certified from the .npz rasters by export-glyphs.mjs);
// glyph-bundle.mjs materializes a set by name — legacy "glyphs_x.json"
// spellings still work. Only the bench-side extras live here.
function loadSet(file) {
  // --matchcols N (EXPERIMENT): the candidate trial only sees the middle N
  // ink columns; acceptance still subtracts the FULL raster (g.ink/g.bytes)
  // so the certification canvas is untouched. Window is centered on the
  // median ink column (extent-centering can land in a hollow middle — '"').
  const trim = o.matchcols > 0 ? (rec) => {
    const cols = [...rec.inkC].sort((a, b) => a - b);
    const med = cols[cols.length >> 1];
    const lo = med - ((o.matchcols - 1) >> 1), hi = lo + o.matchcols - 1;
    const keep = [];
    for (let k = 0; k < rec.ink.length; k++)
      if (rec.inkC[k] >= lo && rec.inkC[k] <= hi) keep.push(k);
    if (keep.length) {
      rec.inkC = Int16Array.from(keep, k => rec.inkC[k]);
      rec.inkR = Int16Array.from(keep, k => rec.inkR[k]);
      rec.inkB = Uint8Array.from(keep, k => rec.inkB[k]);
      rec.inkA = Uint8Array.from(keep, k => rec.inkA[k]);
    }
  } : null;
  const s = materializeSet(file, trim);
  const stem = s.font.replace(/_\d+.*$/, '');           // "times_16.npz" -> "times"
  return { ...s, fontFile: `C:/Windows/Fonts/${stem || 'times'}.ttf` };
}

// ---------------- spaces from measured gaps ----------------
function withSpaces(L, spaceAdv) {
  let out = '', flags = 0;
  const boxes = L.boxes ?? [];
  for (let i = 0; i < L.glyphs.length; i++) {
    if (i) {
      const a = L.glyphs[i - 1].pen + L.glyphs[i - 1].adv, b = L.glyphs[i].pen;
      const gap = b - a;
      if (Engine.boxBetween(boxes, L.glyphs[i - 1], L.glyphs[i])) {
        out += ' ';                                         // gap spans a redaction box:
      } else if (spaceAdv && gap > 0.55 * spaceAdv) {       // measured spaces meaningless
        const n = Math.max(1, Math.round(gap / spaceAdv));
        out += ' '.repeat(n);
        if (Math.abs(gap - n * spaceAdv) > 0.75) flags++;   // narrow/odd space
      }
    }
    const ch = L.glyphs[i].ch;
    out += ch === 'ﬁ' ? 'fi' : ch === 'ﬂ' ? 'fl' : ch;  // ligatures transcribe as letters
  }
  return { text: out, oddGaps: flags };
}

// ---------------- main ----------------
async function main() {
  // '+' joins sets into one union POOL (mixed fonts on one line), ',' keeps
  // separate per-band-pick sets: --glyphs a.json+b.json,c.json = [a∪b, c].
  // Pool candidates cross-hit byte-identical fragments of a foreign font
  // (courier body 'e' lost to a times sliver), so pool only what really
  // mixes within a line; --union still merges everything (legacy).
  let sets = o.glyphs.map(g => {
    const parts = g.split('+');
    return parts.length > 1 ? Engine.unionSets(parts.map(loadSet)) : loadSet(g);
  });
  if (o.union && sets.length > 1) sets = [Engine.unionSets(sets)];
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
    const spaceAdv = Engine.spaceCalib(lines);
    const jsonLines = [];
    jsonPages.push({ pno, spaceAdv, objects, lines: jsonLines });
    for (const L of lines) {
      if (!L.set) {
        if (L.fragOnly) { totFrags++; jsonLines.push({ top: L.top, fragOnly: true }); continue; }
        totFails++; if (L.colour) totColour++;
        outLines.push(''); jsonLines.push({ top: L.top, text: '', unread: true, ...(L.colour ? { colour: true } : {}) }); continue;
      }
      totLines++; totGlyphs += L.glyphs.length; totFails += L.fails.length; totColour += (L.colourFails ?? []).length;
      totFrags += (L.frags ?? []).length;
      const sp = withSpaces(L, spaceAdv);
      outLines.push(sp.text);
      jsonLines.push({ baseline: L.baseline, phy: L.phy, font: L.font,
        text: sp.text, fails: L.fails.length,
        failCols: L.fails, boxes: L.boxes, oddGaps: sp.oddGaps,
        ...(L.frags?.length ? { boxFrags: L.frags } : {}),
        ...(L.colourFails?.length ? { colourFails: L.colourFails } : {}),
        ...(L.struck ? { struck: L.struck } : {}),
        glyphs: L.glyphs.map(g => g.clip ? [g.ch, g.pen, g.clip] : [g.ch, g.pen]) });   // 3rd = px under a redaction box
      if (truth) {
        // row index from baseline is unknown to the reader — compare against
        // the truth row whose letters match (letters-only first, then spaced)
        const letters = sp.text.replace(/ /g, '');
        const hit = truthByLetters.get(letters);
        if (hit !== undefined) { rowExact++; if (hit.trimEnd() === sp.text.trimEnd()) spacedExact++; }
        else { rowDiff++; if (diffs.length < 12) diffs.push({ pno, base: L.baseline, got: sp.text.slice(0, 70) }); }
      }
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
