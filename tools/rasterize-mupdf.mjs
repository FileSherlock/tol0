// rasterize-mupdf.mjs — fill the reader's raster cache. This is the ONLY
// rasterizer in this repo; the previous one also had a headless-Chrome +
// pdf.js path, and cut 1 dropped it (see DROPPING CHROME below).
//
// mupdf decodes the page's embedded image DIRECTLY (Image.toPixmap = raw
// decode of the stored stream) rather than rendering the page. That
// distinction is the whole point: rendering would invent pixels the producer
// never emitted, and this toolkit certifies against the producer's own bytes.
// It is also the more robust path — pdf.js throws InvalidPDFException on a
// real slice of the eDiscovery corpus (broken xref subsections that mupdf
// repairs and reads happily), so those documents could not be cached at all.
//
//   node tools/rasterize-mupdf.mjs --pdf fixtures/corpus/v3.pdf
//   node tools/rasterize-mupdf.mjs --pdf x.pdf --force        # re-write cache
//
// Also importable: cacheDoc(pdfPath, opts) runs the same pipeline in-process
// and returns { key, numPages, written, cached, vector } — vector > 0 means
// some pages carry no embedded image, which this tool cannot serve.
//
// Writes fixtures/raster-cache/<sha256[:16]>/page-NNNN.gray.gz + meta.json;
// the record format lives in tools/raster-cache.mjs. Written here:
//   mode 1 = u8 gray (1-component images — the corpus/courier/nimbus families)
//   mode 4 = u8 R,G,B per pixel (any multi-component image with colour in it)
//            — the reader needs the CHANNELS to read coloured text as the
//            coverage it is (docs/LAWS.md §9); modes 2 and 3 (sums, sums +
//            spread) are still read from old caches but no longer written
//
// DROPPING CHROME WAS MEASURED, NOT ASSUMED. All 7 gate documents were
// re-rasterized through this path and their transcripts byte-compared against
// fixtures/gate-ref/, which was recorded from the old Chrome caches — see
// fixtures/gate-ref/README.md for what moved and what did not.
//
// A page whose content is VECTOR text (no embedded image) is left uncached and
// reported: rendering it would invent pixels, which is exactly what byte-exact
// certification forbids. Such a document is simply out of scope here.
import * as mupdf from 'mupdf';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDirFor, pageFile } from './raster-cache.mjs';

// largest embedded image on the page — the producer's page raster
export function pageImageRef(page) {
  const xo = page.getObject()?.get('Resources')?.get('XObject');
  let best = null, bestPx = -1;
  xo?.forEach?.(val => {
    try {
      const im = val.isIndirect?.() ? val.resolve() : val;
      if (im.get('Subtype')?.asName?.() !== 'Image') return;
      const px = (im.get('Width')?.asNumber?.() ?? 0) * (im.get('Height')?.asNumber?.() ?? 0);
      if (px > bestPx) { bestPx = px; best = val; }
    } catch {}
  });
  return best;
}

function encode(mode, w, h, body) {
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(0x31595247, 0);          // 'GRY1'
  hdr.writeUInt32LE(mode, 4);
  hdr.writeUInt32LE(w, 8);
  hdr.writeUInt32LE(h, 12);
  return gzipSync(Buffer.concat([hdr, body]));
}

/** One page as the record it is cached as, before the gzip: {mode, w, h, body}
 *  (mode 1 = u8 gray, mode 4 = u8 R,G,B — see the header), or null for a page
 *  with no embedded image. cacheDoc writes it; the bulk runner (tools/bulk/)
 *  hands it straight to the reader, so a bulk read sees the cached bytes
 *  without the cache. */
export function pageRecord(doc, pno) {
  const page = doc.loadPage(pno - 1);
  const ref = pageImageRef(page);
  if (!ref) { page.destroy?.(); return null; }
  // mupdf's objects live in the wasm heap and are only collected when JS's GC
  // gets round to their wrappers — which, in a worker that decodes a million
  // pages and allocates almost nothing on the JS side, is never soon enough
  // (2026-09: the heap filled and every later document failed with "malloc
  // failed"). Everything made here is destroyed here.
  const img = doc.loadImage(ref);
  let pix = null, rec;
  try {
  pix = img.toPixmap();
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents();
  const px = pix.getPixels();
  if (n === 1) {
    rec = { mode: 1, w, h, body: Buffer.from(Buffer.from(px.buffer ?? px, px.byteOffset ?? 0, w * h)) };
  } else {
    // Multi-component: keep the CHANNELS. The reader reads coloured text as
    // coverage through its pen and needs R, G, B per pixel to recover it
    // (LAWS §9); the retired mode 3 carried only sum + spread, enough to
    // whiten colour but not to read it. Emit mode 1 when every pixel really
    // is neutral, so an all-gray RGB page keeps the compact form.
    const rgb = Buffer.alloc(w * h * 3);
    let anySpread = false;
    for (let i = 0; i < w * h; i++) {
      const r = px[i * n], g = px[i * n + 1], b = px[i * n + 2];
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      if (r !== g || g !== b) anySpread = true;
    }
    if (anySpread) rec = { mode: 4, w, h, body: rgb };
    else {
      const gray = Buffer.alloc(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = px[i * n];
      rec = { mode: 1, w, h, body: gray };
    }
  }
  } finally { pix?.destroy?.(); img.destroy?.(); page.destroy?.(); }
  return rec;
}

/** Cache every embedded-image page of pdfPath; identical bytes to the CLI. */
export function cacheDoc(pdfPath, { force = false, quiet = true } = {}) {
  const bytes = readFileSync(pdfPath);
  const { sha, key, dir } = cacheDirFor(pdfPath);
  mkdirSync(dir, { recursive: true });
  const pagePath = pno => join(dir, pageFile(pno));

  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
  const numPages = doc.countPages();

  let written = 0, cached = 0, vector = 0;
  for (let pno = 1; pno <= numPages; pno++) {
    if (!force && existsSync(pagePath(pno))) { cached++; continue; }
    const rec = pageRecord(doc, pno);
    if (!rec) { vector++; continue; }
    const buf = encode(rec.mode, rec.w, rec.h, rec.body);
    writeFileSync(pagePath(pno), buf);
    written++;
    if (!quiet && written % 25 === 0) process.stderr.write(`\r  ${written} pages written…   `);
  }
  if (!quiet && written >= 25) process.stderr.write('\n');
  doc.destroy?.();

  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    pdf: basename(pdfPath), sha256: sha, numPages,
    format: 'gzip(GRY1 mode 1 u8 gray | mode 4 u8 R,G,B) — written by rasterize-mupdf.mjs (embedded-image decode; see tools/raster-cache.mjs)',
  }, null, 2));
  return { key, numPages, written, cached, vector };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const PDF = opt('pdf', null);
  if (!PDF) { console.error('usage: node tools/rasterize-mupdf.mjs --pdf <file.pdf> [--force] [--quiet]'); process.exit(2); }
  const r = cacheDoc(PDF, { force: args.includes('--force'), quiet: args.includes('--quiet') });
  console.log(`${r.key}: ${r.written} rasterized, ${r.cached} already cached` +
    (r.vector ? `, ${r.vector} VECTOR pages skipped (no embedded image to decode)` : ''));
}
