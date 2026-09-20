// certify.mjs — prove FTClone reproduces mupdf's fillText byte-for-byte.
//
// Nothing in this repo means anything if this prints diffs: every read is a
// claim that a re-rendered glyph equals the page's pixels, and this is the
// only thing that certifies the re-renderer. Run it before believing any
// result, and after any change to ftclone.mjs / ttf.mjs / cff.mjs.
//
//   npm run certify:ftclone
//
// Two independent pipelines are certified, because they share almost no code
// below the outline:
//   TTF — clone(Carlito-Regular.ttf) vs fillText(mupdf.Font from the same bytes)
//   CFF — clone(NimbusMonoPS-Regular.cff) vs fillText(mupdf's BUILTIN 'Courier'),
//         which IS URW Nimbus Mono PS — so this also certifies that the file in
//         fonts/ is the same font mupdf embeds.
//
// Both fonts are redistributable (Carlito = SIL OFL, Nimbus = URW/AFPL with the
// font exception) — see fonts/LICENSES.md. The cert deliberately depends on NO
// corpus pixels and NO system font: it must run on a clean clone.
//
// Pen phases: fillText cannot place a pen anywhere. x snaps to 1/4 px (4
// representable phases, the certified set); y is not subpixel-quantized at all
// and rounds to the nearest integer. That asymmetry is not assumed here — it is
// re-measured on every run by probeLattice() below and printed, so the day
// mupdf changes it, this says so. fy64=32 is therefore a REPORTED row excluded
// from the pass criterion: it is expected to differ. See docs/LAWS.md §1.
// FTClone itself has no such limit — it places pens on any 1/64, which is the
// whole reason it exists.
import { readFileSync } from 'node:fs';
import { FTClone } from './ftclone.mjs';
import * as mupdf from 'mupdf';

const HERE = new URL('.', import.meta.url);
const fontPath = (n) => new URL(`../fonts/${n}`, HERE).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// printable ASCII, minus space (no ink). No corpus dependency: this list is
// the alphabet, not a harvest.
const CPS = [];
for (let c = 0x21; c <= 0x7e; c++) CPS.push(c);

const W = 40, H = 40, PENX = 10, BASEY = 28;
const XPHASES = [0, 16, 32, 48];        // 1/4 px — fillText-representable
const YPHASES = [0, 32];                // 0 = certified; 32 = measured, reported

// Render one glyph through mupdf fillText at a 26.6 pen offset.
function fillText(font, emx, emy, fx64, fy64, cp) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const text = new mupdf.Text();
  text.showGlyph(font, [emx, 0, 0, -emy, PENX + fx64 / 64, BASEY + fy64 / 64],
    font.encodeCharacter(cp), cp, 0);
  dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  dev.close();
  const ref = Buffer.from(pix.getPixels());
  pix.destroy();
  return ref;
}

// Compare clone vs fillText across every (em config, cp, x-phase) at one
// y-phase. Returns {diffs, worst, worstKey, glyphs}.
function certify(label, clone, font, emConfigs, fy64) {
  let diffs = 0, worst = 0, worstKey = '', glyphs = 0;
  for (const [emx, emy, em64x, em64y] of emConfigs) {
    for (const cp of CPS) {
      if (!font.encodeCharacter(cp)) continue;            // glyph absent — skip
      for (const fx64 of XPHASES) {
        const ref = fillText(font, emx, emy, fx64, fy64, cp);
        const got = clone.render(cp, em64x, em64y, PENX * 64 + fx64, BASEY * 64 + fy64, 1);
        if (!got) continue;
        glyphs++;
        for (let i = 0; i < ref.length; i++) {
          const d = Math.abs(ref[i] - got[i]);
          if (d) { diffs++; if (d > worst) { worst = d; worstKey = `cp${cp} em64(${em64x},${em64y}) fx${fx64}`; } }
        }
      }
    }
  }
  return { label, diffs, worst, worstKey, glyphs };
}

// Sweep one whole pixel of pen travel in 1/64 steps and count DISTINCT rasters.
// x quantizes to 1/4 px -> 4 phases + the raster one pixel over = 5 images;
// y rounds to the nearest whole pixel -> 2. Any other pair means mupdf's glyph
// cache changed and every phasesY decision in the registry is back in play.
function probeLattice(font, cp = 0x6d, em = 16) {
  const count = (axis) => {
    const seen = new Set();
    for (let i = 0; i < 64; i++) {
      const t = i / 64;
      seen.add(fillTextAt(font, em, PENX + (axis === 'x' ? t : 0), BASEY + (axis === 'y' ? t : 0), cp)
        .toString('base64'));
    }
    return seen.size;
  };
  return { x: count('x'), y: count('y') };
}
function fillTextAt(font, em, px, py, cp) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const text = new mupdf.Text();
  text.showGlyph(font, [em, 0, 0, -em, px, py], font.encodeCharacter(cp), cp, 0);
  dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  dev.close();
  const b = Buffer.from(pix.getPixels());
  pix.destroy();
  return b;
}

const results = [];

// ---- TTF: Carlito against itself through mupdf -----------------------------
{
  const path = fontPath('Carlito-Regular.ttf');
  const font = new mupdf.Font('Carlito', readFileSync(path));
  const clone = new FTClone(path, W, H);
  const L = probeLattice(font);
  console.log(`pen lattice, measured now: x ${L.x} distinct rasters per px ` +
    `(${L.x === 5 ? '4 phases of 1/4 px + the 1-px shift' : 'UNEXPECTED'}), ` +
    `y ${L.y} (${L.y === 2 ? 'integer rounding — no subpixel y' : 'UNEXPECTED'})\n`);
  // em64 = trunc(em * 64): 1024 = 16 px, 791 = 12.359375 px (a real corpus size)
  const cfgs = [[16, 16, 1024, 1024], [12.359375, 12.359375, 791, 791], [12.359375, 12, 791, 768]];
  for (const fy64 of YPHASES) results.push({ ...certify('TTF', clone, font, cfgs, fy64), fy64 });
}

// ---- CFF: our Nimbus file against mupdf's builtin Courier ------------------
{
  const path = fontPath('NimbusMonoPS-Regular.cff');
  const font = new mupdf.Font('Courier');                 // builtin = URW Nimbus Mono PS
  const clone = new FTClone(path, W, H);
  clone.setGidMap(new Map(CPS.map(cp => [cp, font.encodeCharacter(cp)])));
  const cfgs = [[16, 16, 1024, 1024], [12.359375, 12.359375, 791, 791], [12.359375, 12, 791, 768]];
  for (const fy64 of YPHASES) results.push({ ...certify('CFF', clone, font, cfgs, fy64), fy64 });
}

// ---- report ----------------------------------------------------------------
let failed = false;
for (const r of results) {
  const certified = r.fy64 === 0;                          // the pass criterion
  const ok = r.diffs === 0;
  const tag = certified ? (ok ? 'CERTIFIED' : 'FAILED   ') : (ok ? 'ok       ' : 'differs  ');
  const note = certified ? '' : '   (measured, not part of the pass criterion)';
  console.log(`${tag} ${r.label} y-phase ${String(r.fy64).padStart(2)}/64 — ` +
    (ok ? `0 diffs over ${r.glyphs} renders` : `${r.diffs} bytes differ, worst |d|=${r.worst} at ${r.worstKey}`) + note);
  if (certified && !ok) failed = true;
}

if (failed) {
  console.log('\nftclone is NOT certified — no result computed with it can be trusted.');
  process.exit(1);
}
console.log('\nftclone certified against mupdf fillText at the 4 representable x-phases.');
