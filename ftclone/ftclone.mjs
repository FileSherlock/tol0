// ftclone.mjs — faithful JS port of the EXACT glyph pipeline inside mupdf
// 1.28 wasm (FreeType 2.13 smooth rasterizer, FT_INT64 build):
//
//   outline funits --(x32 exact, ppem 1024)--> 26.6
//   FT_Outline_Transform with m = trunc(trm*64) per component (16.16),
//     each point: x' = MulFix(x, m.xx) + MulFix(y, m.xy)  [round half away]
//   FT_Outline_Translate by v = (px64, py64)  (26.6 integers)
//   ftgrays: UPSCALE<<2 (26.8), DDA conics, prod-based line walker,
//     cells (cover, area), sweep: coverage = area>>9, ~ on sign, clamp 255
//   mupdf blend per draw over white: dst = (dst*(256-(g+(g>>7))))>>8
//
// All parameters are INTEGERS in 26.6 units: em64x = trunc(emx*64) etc.
// This bypasses fz_subpixel_adjust — pens can sit on ANY 1/64 position,
// which fillText cannot do (it snaps x to 1/4 and y to 1/2).
//
// The code itself lives in engine/ftraster.js (bytes in, no node:fs) so the
// browser runs exactly what is certified here; this file is the path-taking
// wrapper the certification, fontgen and the lab use. PURE LIBRARY — no mupdf. The certification
// (must print 0 diffs before any conclusion built on it) lives beside it:
//   npm run certify:ftclone           # ftclone/certify.mjs — vs mupdf fillText
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('../engine/ftraster.js');

export const mulfix = R.mulfix, divfix = R.divfix;

// new FTClone(fontPath | bytes, W, H): a '.cff' path (or a bare CFF) takes its
// gids from the caller (setGidMap, from mupdf's encodeCharacter on the same
// bytes); anything else is TrueType, as before.
export class FTClone extends R.FTClone {
  constructor(font, W = 40, H = 40) {
    const bytes = typeof font === 'string' ? readFileSync(font) : font;
    const isCff = typeof font === 'string' ? font.endsWith('.cff') : (bytes[0] === 1 && bytes[1] === 0 && bytes[2] !== 1);
    super(isCff ? { cff: R.loadCFF(bytes) } : { ttf: R.loadTTF(bytes) }, W, H);
  }
}
