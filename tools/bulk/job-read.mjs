// job-read.mjs — the certified read, document after document in one process.
//
// Exactly blind-read.mjs's read (both stand on ../read-core.mjs: same record
// decoding, same sets, same rows), minus everything a corpus cannot afford:
// the glyph sets are materialized ONCE per worker instead of once per
// document, and a page goes from the PDF's embedded image straight to the
// reader (rasterize-mupdf pageRecord → read-core pageFromRecord) — the raster
// cache would be 60 GB for this corpus and saves 8 ms a page.
//
// config.ladder — the app's escalating read (engine/blindocr.js readPageAuto)
// instead of one flat pass: plain, palette, same-size mixed-font pools (a bold
// label and a regular value on ONE line — every e-mail header), both; the
// first rung that reads the page whole wins, and a document's pages try their
// predecessor's rung first. 'tol0' stops there: what no byte-exact rung reads
// stays unread, which is this project's to-do list. 'all' goes on to ±1, ±2,
// ±10 as the app does — such a page is READ, it is not right at tolerance 0,
// and its record says so (p[i].pass = "tol|palette|union"). The palette rungs
// get the page's own /Indexed palette from the PDF, and are skipped on a page
// that has none.
// item.skip = { pageNumber: class } — pages the inventory says are not rendered
// text (scan, small, blank, vector: tools/bulk/classify.mjs). They are not
// read; the record keeps { pno, skipped: class } so nothing is silently missing.
// config.pageBudgetS — a page is given this long (ladder only; the engine
// yields between bands, which is where the clock is looked at). Past it the
// page keeps the best rung that finished, or nothing, and says { budget: true }:
// a handful of pages cost minutes each and read nothing (2 bands, 40 s).
// config: { glyphs: [set | a+b union, …], ladder, pageBudgetS, tol, quant, palette, shadow, matchcols, union }
// One record per document:
//   { name, sha, pages, tot: { lines, clean, unread, glyphs, fails, frags, colour },
//     p: [ slim pages — tools/bulk/slim.mjs expandPage gives blind-read's JSON back;
//          { pno, vector: true } where a page has no embedded image ] }
// clean = lines read with no unexplained cluster; unread = bands no set read.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as mupdf from 'mupdf';
import Engine from '../../engine/ocr-engine.js';
import { pageRecord } from '../rasterize-mupdf.mjs';
import { loadSets, pageFromRecord, pageResult, paletteLUTs } from '../read-core.mjs';
import { slimPage } from './slim.mjs';
import { createRequire } from 'node:module';
const B = createRequire(import.meta.url)('../../engine/blindocr.js');

const passKey = p => `${p.tol}|${p.quant ? 1 : 0}|${p.union ? 1 : 0}`;
const rungs = (ladder, lut) => {
  const exact = lut ? [{ tol: 0 }, { tol: 0, quant: lut }, { tol: 0, union: true }, { tol: 0, quant: lut, union: true }]
    : [{ tol: 0 }, { tol: 0, union: true }];
  return ladder === 'all' ? [...exact, { tol: 1 }, { tol: 2 }, { tol: 2, union: true }, { tol: 10 }] : exact;
};

/** see job-inventory.mjs: a spent wasm heap fails every later document too */
export const poisoned = e => /malloc|calloc|realloc|out of memory|memory access out of bounds|table index is out of bounds|unreachable/i.test(String(e?.message || e));

export const init = config => ({ sets: loadSets(config.glyphs, { matchcols: config.matchcols, union: config.union }) });

export async function run(item, config, { sets }) {
  const bytes = readFileSync(item.path);
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf');
  try { return await read(item, config, sets, bytes, doc); } finally { doc.destroy?.(); }
}

async function read(item, config, sets, bytes, doc) {
  const pages = doc.countPages();
  const palLuts = config.palette || config.ladder ? await paletteLUTs(item.path) : null;
  const docCarry = {};                                // the ladder scopes its hints per rung inside this
  let lastPass = null;
  const carry = { last: null, picks: new Map() };     // cross-page layout hints, per document
  const tot = { lines: 0, clean: 0, unread: 0, glyphs: 0, fails: 0, frags: 0, colour: 0 };
  const p = [];
  for (let pno = 1; pno <= pages; pno++) {
    if (item.skip?.[pno]) { p.push({ pno, skipped: item.skip[pno] }); continue; }
    const rec = pageRecord(doc, pno);
    if (!rec) { p.push({ pno, vector: true }); continue; }
    const page = pageFromRecord(rec.mode, rec.w, rec.h, rec.body, () => {});
    if (!page) continue;
    let lines, objects, pass = null, overBudget = false;
    if (config.ladder) {
      const lut = palLuts?.get(pno), passes = rungs(config.ladder, lut);
      // A page of which the unpooled exact rungs read NOT ONE glyph — plain,
      // and palette where the page has one — is nobody's yet: the mixed-font
      // rungs pool the very same sets and cannot pin a band none of them
      // pins. They are a third of the pages and cost three reads each for
      // nothing, so the ladder is left there (tol0 only: the tolerant rungs
      // of 'all' are exactly for such pages).
      const ran = new Map();
      const NOBODY = Symbol('nobody reads this page'), BUDGET = Symbol('over its time');
      const deadline = config.pageBudgetS ? Date.now() + config.pageBudgetS * 1000 : Infinity;
      let got;
      try {
        got = await B.readPageAuto(page, sets, { passes, carry: docCarry, passHint: lastPass && passes.find(p => passKey(p) === lastPass),
          progress() { if (Date.now() > deadline) throw BUDGET; },
          onPass(p, r) {
            ran.set(passKey(p), { p, r, glyphs: r.lines.reduce((n, L) => n + L.glyphs.length, 0),
              fails: r.lines.reduce((n, L) => n + L.fails.length, 0) + r.lines.filter(L => !L.set && !L.fragOnly).length });
            if (config.ladder === 'tol0' && ran.has('0|0|0') && (!lut || ran.has('0|1|0')) && [...ran.values()].every(x => !x.glyphs)) throw NOBODY;
          } });
      } catch (e) {
        if (e !== NOBODY && e !== BUDGET) throw e;
        overBudget = e === BUDGET;
        // the best rung that FINISHED (most ink explained, earliest on a tie), if any did
        const best = [...ran.values()].sort((x, y) => (y.glyphs - y.fails) - (x.glyphs - x.fails))[0];
        if (!best) { p.push({ pno, budget: true, lines: [] }); continue; }
        got = { res: best.r, pass: best.p };
      }
      ({ lines, objects } = got.res); pass = passKey(got.pass);
      if (lines.some(L => L.glyphs?.length)) lastPass = pass;       // only a rung that read something is a hint worth passing on
    } else
      ({ lines, objects } = await Engine.readPage(page, sets,
        { tol: config.tol ?? 0, quant: (config.palette && palLuts?.get(pno)) || config.quant, shadow: config.shadow, carry }));
    const r = pageResult(pno, lines, objects);
    if (pass) r.json.pass = pass;
    if (overBudget) r.json.budget = true;
    for (const k of ['lines', 'glyphs', 'fails', 'frags', 'colour']) tot[k] += r.tot[k];
    for (const L of r.json.lines) { if (L.unread) tot.unread++; else if (L.baseline !== undefined && !L.fails) tot.clean++; }
    p.push(slimPage(r.json));
  }
  return { name: item.name, sha: createHash('sha256').update(bytes).digest('hex').slice(0, 16), pages, tot, p };
}

/** the index row: pages, lines, clean lines, unread bands, glyphs, unexplained clusters */
export const brief = r => [r.pages, r.tot.lines, r.tot.clean, r.tot.unread, r.tot.glyphs, r.tot.fails];
