// ingest.mjs — put a mystery document into the lab, one folder per document:
//
//   lab/pages/<DOC>/page-0001.pgm         the producer's own page raster (P5)
//   lab/pages/<DOC>/page-0001.words.json  the hidden OCR overlay, as CLAIMS
//   lab/pages/<DOC>/meta.json             source pdf, sha256, dims, placement
//
//   node lab/ingest.mjs path/to/DOC.pdf
//   node lab/ingest.mjs <pdf> --pages 1,3-5
//   node lab/ingest.mjs <pdf> --doc MYID
//
// The page image is NOT rendered: the largest image XObject's samples are
// decoded directly, so the PGM is the producer's own raster byte for byte.
// That is ../docs/LAWS.md §7, and it is the reason anything downstream can
// claim to be exact.
//
// This duplicates ~15 lines of tools/rasterize-mupdf.mjs (find the biggest
// image, toPixmap) on purpose. The two diverge immediately after: the reader's
// cache keeps the channel spread and gzips a GRY1 record, the lab wants a flat
// gray PGM you can open. Twelve duplicated lines is cheaper than a root ↔ lab
// import, which is the coupling this repo's layout exists to prevent.
//
// ## The overlay is evidence, not truth
//
// `words.json` is the PRODUCER'S OWN OCR. It misreads (O/0, l/I, whole base64
// walls), and its per-character advances are Tz-stretched to fit the ink, so
// only word STARTS are anchors worth anything. Everything geometric downstream
// is derived from pixels; the overlay only attaches label claims.
import * as mupdf from 'mupdf';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { writePgm } from './pgm.mjs';

const LAB = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const args = process.argv.slice(2);
const pdfPath = args.find(a => !a.startsWith('--'));
const optS = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
if (!pdfPath) { console.error('usage: node lab/ingest.mjs <pdf> [--doc ID] [--pages 1,3-5]'); process.exit(2); }

const pdfBytes = readFileSync(pdfPath);
const docId = optS('doc') ?? basename(pdfPath).replace(/\.pdf$/i, '');
const sha256 = createHash('sha256').update(pdfBytes).digest('hex');

const doc = mupdf.PDFDocument.openDocument(pdfBytes, 'application/pdf');
const numPages = doc.countPages();
let pageNums = Array.from({ length: numPages }, (_, i) => i + 1);
if (optS('pages')) {
  pageNums = [];
  for (const part of optS('pages').split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) { console.error(`bad --pages part: ${part}`); process.exit(2); }
    for (let p = +m[1]; p <= +(m[2] ?? m[1]); p++) pageNums.push(p);
  }
}

const outDir = `${LAB}/pages/${docId}`;
mkdirSync(outDir, { recursive: true });
const metaPath = `${outDir}/meta.json`;
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8'))
  : { doc: docId, pdf: basename(pdfPath), sha256, numPages, pages: {} };
if (meta.sha256 !== sha256) {
  console.error(`meta.json is for a different PDF (sha mismatch) — remove ${outDir} first`);
  process.exit(2);
}

// ---- placement: the ctm at each "/Name Do" ---------------------------------
// Needed to map overlay coordinates into image pixels. Do NOT assume 4/3: some
// pages carry extra media-box margin (a 612x810 pt page holding a 612x792 pt
// image), and assuming the ratio silently shifts every label claim.
function contentText(page) {
  const obj = page.getObject().get('Contents');
  const r = obj.resolve();
  const parts = [];
  if (r.isArray()) for (let i = 0; i < r.length; i++) parts.push(Buffer.from(r.get(i).readStream().asUint8Array()));
  else parts.push(Buffer.from(obj.readStream().asUint8Array()));
  return Buffer.concat(parts).toString('latin1');
}
function placements(page) {
  const toks = contentText(page).split(/\s+/).filter(Boolean);
  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [], out = {};
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'q') stack.push(ctm);
    else if (t === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (t === 'cm') ctm = mul(toks.slice(i - 6, i).map(Number), ctm);
    else if (t === 'Do' && toks[i - 1]?.startsWith('/')) out[toks[i - 1].slice(1)] ??= ctm;
  }
  return out;
}

const r2 = v => Math.round(v * 100) / 100;
function overlayWords(page, toPx) {
  const words = [];
  let cur = null, prev = null;
  const flush = () => { if (cur && cur.text.trim()) words.push(cur); cur = null; };
  page.toStructuredText('preserve-whitespace').walk({
    onChar(c, origin, font, size, quad) {
      const gap = prev && (Math.abs(origin[1] - prev.y) > 0.1 || origin[0] - prev.xEnd > 0.6 * size);
      if (c === ' ' || gap) flush();
      if (c !== ' ') {
        const px = toPx(origin[0], origin[1]);
        if (!cur) cur = { text: '', x: r2(origin[0]), yBase: r2(origin[1]),
          px: { x: r2(px.x), yBase: r2(px.y) },
          font: font?.getName?.() ?? null, size: r2(size), chars: [] };
        cur.text += c;
        cur.chars.push(r2(px.x));
      }
      prev = { y: origin[1], xEnd: quad ? quad[2] : origin[0] };
    },
  });
  flush();
  return words;
}

let done = 0, skipped = 0, empty = 0;
for (const pno of pageNums) {
  const tag = String(pno).padStart(4, '0');
  if (existsSync(`${outDir}/page-${tag}.pgm`)) { skipped++; continue; }
  const page = doc.loadPage(pno - 1);
  // structured-text coords are y-down from the top of the page box; convert
  // through the RAW MediaBox — boxes like [0 -18 612 792] exist, so never
  // assume the origin is 0.
  const mbObj = page.getObject().getInheritable('MediaBox');
  const mb = [0, 1, 2, 3].map(i => mbObj.get(i).asNumber());

  const xobjs = page.getObject().get('Resources')?.get('XObject');
  let best = null;
  xobjs?.forEach((v, k) => {
    const d = v.resolve();
    if (String(d.get('Subtype')) !== '/Image') return;
    const w = d.get('Width').asNumber(), h = d.get('Height').asNumber();
    if (!best || w * h > best.w * best.h) best = { name: String(k), ref: v, w, h };
  });
  if (!best) { meta.pages[pno] = { empty: true }; empty++; continue; }

  const pix = doc.loadImage(best.ref).toPixmap();
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents();
  const src = pix.getPixels();
  let gray;
  // COPY, never alias: getPixels() is a view into the live wasm heap and the
  // next page's decode reuses it.
  if (n === 1) gray = Buffer.from(src.slice(0, w * h));
  else {
    // Colour ink is not body text. Reduce a coloured pixel to paper rather
    // than to a gray the reader would then try to explain (../docs/LAWS.md §5).
    gray = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = src[i * n], g = src[i * n + 1], b = src[i * n + 2];
      gray[i] = Math.max(r, g, b) - Math.min(r, g, b) >= 4 ? 255 : Math.round((r + g + b) / 3);
    }
  }

  const cm = placements(page)[best.name];
  if (!cm) console.warn(`p${pno}: no Do placement for ${best.name}; overlay px assume a full-page image`);
  const [a, b, c, d, e, f] = cm ?? [mb[2] - mb[0], 0, 0, mb[3] - mb[1], mb[0], mb[1]];
  if (b || c) console.warn(`p${pno}: rotated/skewed image placement — px mapping unsupported`);
  const toPx = (x, yDown) => {
    const yUp = mb[3] - yDown;
    return { x: (x + mb[0] - e) / a * w, y: (1 - (yUp - f) / d) * h };
  };

  writePgm(`${outDir}/page-${tag}.pgm`, w, h, gray);
  const words = overlayWords(page, toPx);
  writeFileSync(`${outDir}/page-${tag}.words.json`, JSON.stringify({
    page: pno,
    note: "the PRODUCER'S OWN OCR: has errors, and is Tz-stretched so only word STARTS align with the render. Label claims only — all geometry downstream comes from pixels.",
    words,
  }, null, 1));
  meta.pages[pno] = { w, h, comps: n, cm: (cm ?? null)?.map(r2), words: words.length };
  done++;
  process.stderr.write(`\r  p${pno} (${done} done)   `);
  pix.destroy?.();
  page.destroy?.();
}
writeFileSync(metaPath, JSON.stringify(meta, null, 1));
if (done) process.stderr.write('\n');
console.log(`${docId}: ${done} pages ingested, ${skipped} already present`
  + (empty ? `, ${empty} with no embedded image (vector — out of scope, LAWS §7)` : '')
  + ` -> lab/pages/${docId}/`);
