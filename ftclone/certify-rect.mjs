// certify-rect.mjs — engine/ftraster.js rectCoverage against mupdf's own
// fillPath, byte for byte. An underline or a strikethrough is a filled
// rectangle in the PDF (`re f`), which mupdf antialiases on a 17 × 15
// sub-sample grid — not the glyph pipeline — so it is certified on its own.
//
//   npm run certify:rect
import * as mupdf from 'mupdf';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('../engine/ftraster.js');

const W = 40, H = 20;
function mu(x0, y0, x1, y1) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const p = new mupdf.Path(); p.rect(x0, y0, x1, y1);
  dev.fillPath(p, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
  dev.close();
  return pix.getPixels().slice(0, W * H);
}
function ours(x0, y0, x1, y1) {
  const out = new Uint8Array(W * H).fill(255);
  const r = R.rectCoverage(x0, y0, x1, y1);
  if (r) for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const X = r.x0 + x, Y = r.y0 + y;
    if (X >= 0 && X < W && Y >= 0 && Y < H) out[Y * W + X] = R.byteOfCov(r.cov[y * r.w + x]);
  }
  return out;
}
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let n = 0, bad = 0, worst = null;
const check = (x0, y0, x1, y1) => {
  const a = mu(x0, y0, x1, y1), b = ours(x0, y0, x1, y1);
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  n++; if (d) { bad++; worst ??= { x0, y0, x1, y1, d }; }
};
// every 1/64 phase of each edge, thin rules (an underline is 0.5–2 px tall)
for (let k = 0; k < 64; k++) { check(3 + k / 64, 5.3, 21.7, 6.1); check(3.2, 5 + k / 64, 21.7, 5 + k / 64 + 0.78); check(3.2, 5.3, 20 + k / 64, 6.4); check(3.2, 5.1, 21.7, 5.1 + (k + 1) / 64 * 2); }
// hairlines: thinner than one sub-sample in either direction
for (let k = 0; k < 64; k++) { check(3 + k / 64, 5.3, 3 + k / 64 + 0.01, 9.2); check(3.2, 5 + k / 64, 21.7, 5 + k / 64 + 0.004); }
// random rectangles at float positions (a producer's coordinates are arbitrary floats)
for (let i = 0; i < 4000; i++) {
  const x0 = 1 + rnd() * 20, y0 = 1 + rnd() * 12, w = 0.002 + rnd() * 16, h = 0.002 + rnd() * 5;
  check(x0, y0, x0 + w, y0 + h);
}
if (bad) { console.log(`FAILED — ${bad} of ${n} rectangles differ; first:`, worst); process.exit(1); }
console.log(`CERTIFIED rectCoverage — 0 differing bytes over ${n} rectangles against mupdf fillPath`);
