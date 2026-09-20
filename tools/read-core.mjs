// read-core.mjs — what every front end of the reader shares: a raster record
// becomes the page the engine takes, glyph sets are materialized from the
// bundle, a page's palette is read out of its PDF, and a page's read becomes
// the JSON and the transcript rows. blind-read.mjs (one document, one process)
// and the bulk runner (tools/bulk/ — persistent workers over a corpus) both
// stand on it, so a bulk read IS the certified read: same decoding, same
// sets, same rows. The scanning physics stay where they were,
// ../engine/ocr-engine.js.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { materializeSet } from './glyph-bundle.mjs';
import Engine from '../engine/ocr-engine.js';

// ---------------- raster records -> what the reader takes ----------------
// A GRY1 record (tools/raster-cache.mjs) or the same four fields straight from
// the rasterizer (rasterize-mupdf.mjs pageRecord — the bulk runner decodes a
// page and reads it without the cache in between). `body` is the record past
// its 16-byte header. `note` takes the colour remarks the CLI prints.
export function decodeRecord(raw, what = 'record', note) {
  const hdr = new Uint32Array(raw.buffer, raw.byteOffset, 4);
  if (hdr[0] !== 0x31595247) throw new Error(`bad GRY1 magic: ${what}`);
  return pageFromRecord(hdr[1], hdr[2], hdr[3], raw.subarray(16), note);
}
export const readGray = (path, note) => decodeRecord(gunzipSync(readFileSync(path)), path, note);

export function pageFromRecord(mode, w, h, body, note = m => console.error(m)) {
  if (mode === 0) return null;
  if (mode === 1) return { w, h, gray: new Uint8Array(body.buffer, body.byteOffset, w * h) };
  if (mode === 2) {
    // mode 2 (legacy sum-only color page). Achromatic ink (R=G=B — plain
    // black text) has sum ≡ 0 (mod 3) at every pixel, so gray = sum/3 is
    // exact there; colored ink (hyperlink blue) is non-neutral at least on
    // its AA edges. Whiten every ink component connected to a non-neutral
    // pixel — the reader then sees only the plain text, byte-exactly.
    // (Sum-only is BLIND to colors whose sum is a multiple of 3 — pure blue
    // (0,0,237) reads as "neutral 79" — and floods whole letters over JPEG
    // channel jitter; mode 3 rasters carry a spread plane instead.)
    const sums = new Uint16Array(body.buffer, body.byteOffset, w * h);
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
    if (removed) note(`  (color page: ${removed} colored-ink px removed)`);
    return { w, h, gray };
  }
  if (mode === 4) {
    // mode 4: u8 R,G,B. ONE implementation of the colour law (LAWS §9):
    // coloured TEXT becomes the black-ink coverage it was drawn as, through
    // the page's own pens; what no pen explains is whitened as before.
    const rgb = new Uint8Array(body.buffer, body.byteOffset, w * h * 3);
    const c = Engine.colourInk(w, h, rgb, 3);
    if (c.convertedN || c.removed)
      note(`  (colour page: ${c.convertedN} coloured px read as coverage through ${c.pens.length} pen${c.pens.length === 1 ? '' : 's'}` +
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
  const sums = new Uint16Array(body.buffer, body.byteOffset, w * h);
  const spread = new Uint8Array(body.buffer, body.byteOffset + 2 * w * h, w * h);
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
  if (removed || jitter) note(
    `  (color page: ${removed} colored px removed, ${jitter} jittered px neutralized)`);
  return { w, h, gray };
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
export async function paletteLUTs(pdfPath) {
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
  doc.destroy?.();                             // a persistent worker opens a million of these
  return luts;
}

// ---------------- glyph sets ----------------
// All sets live in ONE committed binary bundle (assets/glyphs/glyphs.bin,
// built + byte-certified from the .npz rasters by export-glyphs.mjs);
// glyph-bundle.mjs materializes a set by name — legacy "glyphs_x.json"
// spellings still work. Only the bench-side extras live here.
export function loadSet(file, matchcols = 0) {
  // --matchcols N (EXPERIMENT): the candidate trial only sees the middle N
  // ink columns; acceptance still subtracts the FULL raster (g.ink/g.bytes)
  // so the certification canvas is untouched. Window is centered on the
  // median ink column (extent-centering can land in a hollow middle — '"').
  const trim = matchcols > 0 ? (rec) => {
    const cols = [...rec.inkC].sort((a, b) => a - b);
    const med = cols[cols.length >> 1];
    const lo = med - ((matchcols - 1) >> 1), hi = lo + matchcols - 1;
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

// '+' joins sets into one union POOL (mixed fonts on one line), ',' keeps
// separate per-band-pick sets: a+b,c = [a∪b, c]. Pool candidates cross-hit
// byte-identical fragments of a foreign font (courier body 'e' lost to a times
// sliver), so pool only what really mixes within a line; union merges
// everything (legacy).
export function loadSets(specs, { matchcols = 0, union = false } = {}) {
  let sets = specs.map(g => {
    const parts = g.split('+');
    return parts.length > 1 ? Engine.unionSets(parts.map(f => loadSet(f, matchcols))) : loadSet(g, matchcols);
  });
  if (union && sets.length > 1) sets = [Engine.unionSets(sets)];
  return sets;
}

// ---------------- spaces from measured gaps ----------------
export function withSpaces(L, spaceAdv) {
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

// ---------------- one page's read, as the JSON and the transcript carry it ----------------
// lines, objects: Engine.readPage's. Returns {json: {pno, spaceAdv, objects,
// lines}, texts: one transcript row per line that is not a bare box fragment,
// tot: {lines, glyphs, fails, frags, colour}} — the CLI sums tot over a
// document, the bulk runner keeps json.
export function pageResult(pno, lines, objects) {
  const spaceAdv = Engine.spaceCalib(lines);
  const jsonLines = [], texts = [];
  const tot = { lines: 0, glyphs: 0, fails: 0, frags: 0, colour: 0 };
  for (const L of lines) {
    if (!L.set) {
      if (L.fragOnly) { tot.frags++; jsonLines.push({ top: L.top, fragOnly: true }); continue; }
      tot.fails++; if (L.colour) tot.colour++;
      texts.push(''); jsonLines.push({ top: L.top, text: '', unread: true, ...(L.colour ? { colour: true } : {}) }); continue;
    }
    tot.lines++; tot.glyphs += L.glyphs.length; tot.fails += L.fails.length; tot.colour += (L.colourFails ?? []).length;
    tot.frags += (L.frags ?? []).length;
    const sp = withSpaces(L, spaceAdv);
    texts.push(sp.text);
    jsonLines.push({ baseline: L.baseline, phy: L.phy, font: L.font,
      text: sp.text, fails: L.fails.length,
      failCols: L.fails, boxes: L.boxes, oddGaps: sp.oddGaps,
      ...(L.frags?.length ? { boxFrags: L.frags } : {}),
      ...(L.colourFails?.length ? { colourFails: L.colourFails } : {}),
      ...(L.struck ? { struck: L.struck } : {}),
      glyphs: L.glyphs.map(g => g.clip ? [g.ch, g.pen, g.clip] : [g.ch, g.pen]) });   // 3rd = px under a redaction box
  }
  return { json: { pno, spaceAdv, objects, lines: jsonLines }, texts, tot };
}
