// job-inventory.mjs — what every page of a corpus IS, before anyone reads it.
//
// A year of reading is steered by this table: which pages are rendered and
// which are scans (tolerance 0 only ever reads the first kind), which pages
// are the same pixels under another name (an e-mail chain repeats its tail in
// every reply), which producer wrote a document, how tall its lines are. It
// costs milliseconds a page — no glyph set is loaded — so it is run over
// everything, once, and re-run when a column is added.
//
// One record per document:
//   { name, bytes, sha (sha256[:16] of the file — the raster cache's key),
//     pages, hdr (the file's first line), format (the version mupdf settles on),
//     mark (the comment on the 2nd line — with hdr, a writer's signature), producer, creator, created (absent where the PDF has
//     no Info dictionary), fonts: [text-layer BaseFonts, ≤ 12], p: [ per page ] }
// per page, measured on the SAME record the reader is given (rasterize-mupdf
// pageRecord: the producer's embedded image, decoded, never rendered):
//   n        page number
//   box      [w, h] of the page in pt        img  [w, h] of the image, px
//   imgs     images on the page              f    the image's /Filter
//   cs       its /ColorSpace                 bpc  bits per component
//   mode     1 gray | 4 colour (R,G,B kept)  px   sha256[:16] of the decoded pixels
//   white    share of pixels that are exactly white
//   bg, bgShare   the commonest level and its share (a scan's paper is not 255)
//   levels   distinct gray levels            colour  share of pixels whose channels
//                                                    differ by ≥ 4 (LAWS §9; less is jitter)
//   ink      [x0, y0, x1, y1] of pixels darker than 128, or null
//   bands    runs of rows holding such pixels (≈ text lines; a vertical rule's
//            constant share of every row is discounted), bandH their median height
//   tl       characters in the PDF's own text layer, th a hash of it, head its first 64
//   vector: true  when the page has no embedded image (out of scope: rendering
//            it would invent pixels)      error  when the page could not be decoded
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as mupdf from 'mupdf';
import { pageImageRef, pageRecord } from '../rasterize-mupdf.mjs';

const hex = (algo, data, n) => createHash(algo).update(data).digest('hex').slice(0, n);
const nameOf = o => { try { const r = o?.isIndirect?.() ? o.resolve() : o; return r?.isName?.() ? r.asName() : r?.isArray?.() ? nameOf(r.get(0)) : undefined; } catch { return undefined; } };
const meta = (doc, k) => { try { return doc.getMetaData(k) || undefined; } catch { return undefined; } };

function pixelStats(rec) {
  const { mode, w, h, body } = rec, N = w * h, step = mode === 4 ? 3 : 1;
  const hist = new Uint32Array(256), rowDark = new Uint32Array(h);
  let white = 0, colour = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += step) {
    let v = body[i];
    if (step === 3) {
      const g = body[i + 1], b = body[i + 2];
      const mx = v > g ? (v > b ? v : b) : (g > b ? g : b), mn = v < g ? (v < b ? v : b) : (g < b ? g : b);
      if (mx - mn >= 4) colour++;
      v = ((v + g + b) / 3) | 0;
    }
    hist[v]++;
    if (v === 255) white++;
    else if (v < 128) { rowDark[y]++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  let levels = 0, bg = 255, bgN = -1;
  for (let v = 0; v < 256; v++) if (hist[v]) { levels++; if (hist[v] > bgN) { bgN = hist[v]; bg = v; } }
  // a text band is a run of rows holding MORE dark pixels than the least any
  // inked row holds: a vertical rule or a page border puts the same few dark
  // pixels in every row, and without this the whole page is one band 960 tall
  let base = Infinity;
  if (y1 >= 0) for (let y = y0; y <= y1; y++) if (rowDark[y] < base) base = rowDark[y];
  const heights = [];
  for (let y = 0, run = 0; y <= h; y++) { if (y < h && y1 >= 0 && rowDark[y] > base) run++; else if (run) { heights.push(run); run = 0; } }
  heights.sort((a, b) => a - b);
  const r3 = v => Math.round(v * 1000) / 1000;
  return { white: r3(white / N), bg, bgShare: r3(bgN / N), levels, colour: r3(colour / N),
    ink: x1 < 0 ? null : [x0, y0, x1, y1], bands: heights.length, bandH: heights.length ? heights[heights.length >> 1] : 0 };
}

/** The wasm heap is exhausted or corrupt: every document this process touches
 *  from here on fails the same way. The pool retires the worker and gives the
 *  document to a fresh one (pool.mjs). */
export const poisoned = e => /malloc|calloc|realloc|out of memory|memory access out of bounds|table index is out of bounds|unreachable/i.test(String(e?.message || e));

export function run(item) {
  const bytes = readFileSync(item.path);
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
  try { return inventory(item, bytes, doc); } finally { doc.destroy?.(); }
}

function inventory(item, bytes, doc) {
  const pages = doc.countPages();
  const fonts = new Set(), p = [];
  for (let pno = 1; pno <= pages; pno++) {
    const rec = { n: pno };
    let page = null, ref = null;
    try {
      page = doc.loadPage(pno - 1);
      const b = page.getBounds(); rec.box = [Math.round(b[2] - b[0]), Math.round(b[3] - b[1])];
      const res = page.getObject().getInheritable('Resources');
      let imgs = 0;
      res?.get?.('XObject')?.forEach?.(v => { try { const o = v.isIndirect?.() ? v.resolve() : v; if (o.get('Subtype')?.asName?.() === 'Image') imgs++; } catch {} });
      if (fonts.size < 12) res?.get?.('Font')?.forEach?.(v => { try { const o = v.isIndirect?.() ? v.resolve() : v; const bf = o.get('BaseFont')?.asName?.(); if (bf && fonts.size < 12) fonts.add(bf); } catch {} });
      rec.imgs = imgs;
      ref = pageImageRef(page);
      if (!ref) rec.vector = true;
      else {
        const im = ref.isIndirect?.() ? ref.resolve() : ref;
        rec.f = nameOf(im.get('Filter')); rec.cs = nameOf(im.get('ColorSpace')); rec.bpc = im.get('BitsPerComponent')?.asNumber?.();
      }
      const st = page.toStructuredText();
      let text; try { text = st.asText().replace(/\s+/g, ' ').trim(); } finally { st.destroy?.(); }
      rec.tl = text.replace(/ /g, '').length;
      if (rec.tl) { rec.th = hex('sha1', text, 8); rec.head = text.slice(0, 64); }
      page.destroy?.(); page = null;
      if (ref) {
        const r = pageRecord(doc, pno);
        rec.img = [r.w, r.h]; rec.mode = r.mode; rec.px = hex('sha256', r.body, 16);
        Object.assign(rec, pixelStats(r));
      }
    } catch (e) { rec.error = String(e?.message || e).slice(0, 120); if (poisoned(e)) throw e; }
    finally { page?.destroy?.(); }
    p.push(rec);
  }
  // the comment on the file's second line: a writer's signature where there is
  // no Info dictionary (this corpus has none) — "%WB0AiUxr" names the OmniPage
  // CSDK assembly. Kept as latin-1 text when printable, else as hex.
  let mark, e0 = 0;
  while (e0 < 24 && e0 < bytes.length && bytes[e0] !== 10 && bytes[e0] !== 13) e0++;
  const hdr = bytes.subarray(0, e0).toString('latin1').trimEnd();        // "%PDF-1.3" — the header's own version
  let m0 = e0; while (m0 < e0 + 3 && (bytes[m0] === 10 || bytes[m0] === 13)) m0++;
  if (bytes[m0] === 0x25) {
    let e = m0 + 1; while (e < bytes.length && e < m0 + 17 && bytes[e] !== 10 && bytes[e] !== 13) e++;
    const m = bytes.subarray(m0 + 1, e);
    mark = m.every(c => c >= 32 && c < 127) ? m.toString('latin1') : 'x' + m.toString('hex');
  }
  const out = { name: item.name, bytes: bytes.length, sha: hex('sha256', bytes, 16), pages,
    hdr, format: meta(doc, 'format'), mark,
    producer: meta(doc, 'info:Producer'), creator: meta(doc, 'info:Creator'), created: meta(doc, 'info:CreationDate'),
    fonts: [...fonts], p };
  return out;
}

/** the index row: pages, image pages, vector pages, pages with a text layer */
export const brief = r => [r.pages, r.p.filter(x => x.img).length, r.p.filter(x => x.vector).length, r.p.filter(x => x.tl).length];
