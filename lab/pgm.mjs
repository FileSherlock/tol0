// pgm.mjs — the lab's pixel container, and the ONE definition of each
// operation every other lab tool needs. The old repo had `readPgm` copy-pasted
// into six files and `inkBbox` into five, with three different ideas about
// what counts as ink; when one copy was fixed the others quietly disagreed.
//
// P5 (binary graymap) is the format because it is the smallest thing that is
// still a file you can look at: `node lab/pgm.mjs <file>` prints it.
//
//   node lab/pgm.mjs lab/targets/courier/109_p0_v1.pgm
//   node lab/pgm.mjs lab/pages/EFTA00751637/page-0001.pgm --crop 40,100,60,20
//   node lab/pgm.mjs a.pgm --num          # the bytes, not the picture
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Ink threshold. A byte < INK is ink; 250..255 is antialias fringe or paper.
 *  This is the harvest cut threshold, and every bbox in the lab uses it, so a
 *  target's dimensions and a candidate's dimensions mean the same thing. */
export const INK = 250;

export function readPgm(path) {
  const b = readFileSync(path);
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(b.toString('latin1', 0, 64));
  if (!m) throw new Error(`not a P5 PGM: ${path}`);
  const w = +m[1], h = +m[2];
  return { w, h, px: b.subarray(m[0].length, m[0].length + w * h) };
}

export function writePgm(path, w, h, px) {
  writeFileSync(path, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.from(px)]));
}

/** Bounding box of every pixel < `min`. Returns null when there is no ink.
 *  `min` defaults to 255 (any non-white pixel) because that is what a target
 *  window means; sweeps pass a law's own covMin instead. */
export function inkBbox(px, w, h, min = 255) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (px[r * w + c] < min) {
      if (c < x0) x0 = c; if (c > x1) x1 = c;
      if (r < y0) y0 = r; if (r > y1) y1 = r;
    }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Same, over a COVERAGE buffer, where bigger means more ink. */
export function covBbox(cov, w, h, min) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++)
    if (cov[r * w + c] >= min) {
      if (c < x0) x0 = c; if (c > x1) x1 = c;
      if (r < y0) y0 = r; if (r > y1) y1 = r;
    }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** ASCII art of a window — the fastest way to see why a match failed. */
export function art(px, w, h, { num = false, x0 = 0, y0 = 0, cw = w, ch = h } = {}) {
  const rows = [];
  for (let r = y0; r < Math.min(h, y0 + ch); r++) {
    let line = '';
    for (let c = x0; c < Math.min(w, x0 + cw); c++) {
      const v = px[r * w + c];
      line += num ? String(v).padStart(4)
        : v === 255 ? '.' : v < 64 ? '#' : v < 160 ? '+' : '-';
    }
    rows.push(String(r).padStart(4) + ' ' + line);
  }
  return rows.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node lab/pgm.mjs <file.pgm> [--num] [--crop x,y,w,h]'); process.exit(2); }
  const { w, h, px } = readPgm(file);
  const ci = process.argv.indexOf('--crop');
  const [x0, y0, cw, ch] = ci > 0 ? process.argv[ci + 1].split(',').map(Number) : [0, 0, w, h];
  const bb = inkBbox(px, w, h);
  console.log(`${w}x${h}  ink bbox ${bb ? `${bb.x0},${bb.y0} ${bb.w}x${bb.h}` : 'NONE'}`);
  console.log(art(px, w, h, { num: process.argv.includes('--num'), x0, y0, cw, ch }));
}
