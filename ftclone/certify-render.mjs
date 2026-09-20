// certify-render.mjs — prove engine/render.js draws what mupdf draws.
//
// certify.mjs proves the rasterizer clone: one glyph, one pen, byte-exact.
// This proves the two laws the FORWARD renderer adds on top of a certified
// glyph set — the pen lattice (where a float pen lands) and repeated blending
// (what overlapping glyphs do to each other) — by laying whole strings out at
// float pens, handing the SAME float pens to mupdf's own Text/fillText, and
// byte-comparing the pixmaps.
//
//   npm run certify:render
//
// Like certify.mjs it needs no corpus and no system font: the glyph sets are
// generated on the fly by tools/fontgen.mjs from the two redistributable faces
// in fonts/ (Carlito TTF at em64 1024, Nimbus Mono PS CFF at em64 791 — a
// real corpus size), into a temp directory that is removed afterwards.
//
// Pens sweep every 1/64 px of one pixel in x (the ¼-px lattice and its tie
// points, 8/64 etc.) and the y phases that matter (0, ¼, ½ − 1/64, ½, ½ + 1/64,
// ¾), so the rounding rule at the boundaries is measured, not believed. A
// third case draws glyphs on top of each other at 55 % of their advance to
// force composite pixels through the blend law in drawing order.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import { materializeSet } from '../tools/glyph-bundle.mjs';
import R from '../engine/render.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const STRINGS = [
  'Received: by 10.229.235.4 with SMTP id ke4mr6853629qcb.201',
  'AVATAR Wavy fly Tj rV LT To Ya',                 // overlap-prone pairs
  'The quick brown fox jumps over the lazy dog 0123456789',
  '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
];
const CHARS = [...new Set(STRINGS.join('').replace(/ /g, ''))].join('');

const PENX = 8, BASEY = 28, H = 44;
const XSWEEP = Array.from({ length: 64 }, (_, i) => i);          // 1/64 steps
const YSWEEP = [0, 16, 31, 32, 33, 48];                           // /64

function genSet(fontFile, em64, out) {
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'fontgen.mjs'),
    '--font', fontFile, '--em64', String(em64), '--phases-y', '0',
    '--chars', CHARS, '--out', out], { encoding: 'utf8', cwd: REPO });
  if (r.status !== 0) throw new Error(`fontgen failed:\n${r.stdout}\n${r.stderr}`);
  return materializeSet(out);
}

// mupdf reference: every glyph of the string in ONE Text object at its raw
// float pen — the way a producer's text run reaches fillText.
function refRender(font, em, items, y, W) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false);
  pix.clear(255);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const text = new mupdf.Text();
  for (const it of items)
    text.showGlyph(font, [em, 0, 0, -em, it.x, y], font.encodeCharacter(it.cp), it.cp, 0);
  dev.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1.0);
  dev.close();
  const b = Buffer.from(pix.getPixels());
  pix.destroy();
  return b;
}

function ourRender(set, glyphs, y, W) {
  const r = R.renderLine(set, glyphs, y);
  const out = Buffer.alloc(W * H, 255);
  for (let yy = 0; yy < r.h; yy++)
    for (let xx = 0; xx < r.w; xx++) {
      const X = r.x0 + xx, Y = r.y0 + yy;
      if (X < 0 || Y < 0 || X >= W || Y >= H) throw new Error(`render window leaves the pixmap at (${X},${Y})`);
      out[Y * W + X] = r.gray[yy * r.w + xx];
    }
  return { out, missing: r.missing };
}

function compare(ref, got) {
  let diffs = 0, worst = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(ref[i] - got[i]);
    if (d) { diffs++; if (d > worst) worst = d; }
  }
  return { diffs, worst };
}

// one pipeline: {label, font (mupdf), em, set, spaceAdv}
function certifyPipeline(P) {
  const rows = [];
  const run = (caseLabel, jobs) => {
    let diffs = 0, worst = 0, worstKey = '', renders = 0, glyphs = 0;
    for (const job of jobs) {
      const W = Math.ceil(PENX + job.width) + 16;
      const items = job.glyphs.map(g => ({ cp: g.ch.codePointAt(0), x: g.penRaw }));
      const ref = refRender(P.font, P.em, items, job.y, W);
      const { out, missing } = ourRender(P.set, job.glyphs, job.y, W);
      if (missing.length) throw new Error(`${P.label}: set lacks ${JSON.stringify(missing)}`);
      const c = compare(ref, out);
      renders++; glyphs += job.glyphs.length;
      diffs += c.diffs;
      if (c.worst > worst) { worst = c.worst; worstKey = job.key; }
    }
    rows.push({ label: `${P.label} ${caseLabel}`, diffs, worst, worstKey, renders, glyphs });
  };

  // 1. x lattice sweep, integer baseline
  const xs = [];
  for (const i of XSWEEP) for (const s of STRINGS) {
    const lay = R.layoutLine(P.set, s, PENX + i / 64, { spaceAdv: P.spaceAdv });
    xs.push({ glyphs: lay.glyphs, y: BASEY, width: lay.advanceW, key: `x+${i}/64 "${s.slice(0, 12)}…"` });
  }
  run('x lattice (64 phases)', xs);

  // 2. y phases at a few x phases
  const ys = [];
  for (const j of YSWEEP) for (const i of [0, 8, 16, 40]) for (const s of STRINGS) {
    const lay = R.layoutLine(P.set, s, PENX + i / 64, { spaceAdv: P.spaceAdv });
    ys.push({ glyphs: lay.glyphs, y: BASEY + j / 64, width: lay.advanceW, key: `y+${j}/64 x+${i}/64 "${s.slice(0, 12)}…"` });
  }
  run('y rounding', ys);

  // 3. forced overlaps: glyphs at 55 % of their advance, composite pixels
  //    everywhere, drawing order = text order
  const ov = [];
  for (const i of [0, 8, 16, 24, 32, 40, 48, 56]) for (const s of STRINGS) {
    let x = PENX + i / 64;
    const glyphs = [];
    for (const ch of s) {
      if (ch === ' ') { x += P.spaceAdv * 0.55; continue; }
      const adv = R.advanceOf(P.set, ch);
      glyphs.push({ ch, pen: R.snapX(x), penRaw: x, adv });
      x += adv * 0.55;
    }
    ov.push({ glyphs, y: BASEY, width: x - PENX, key: `overlap x+${i}/64 "${s.slice(0, 12)}…"` });
  }
  run('overlap (55 % advance)', ov);
  return rows;
}

const tmp = mkdtempSync(join(tmpdir(), 'tol0-certify-render-'));
const results = [];
try {
  // ---- TTF: Carlito, mupdf font from the same bytes -------------------------
  {
    const file = join(REPO, 'fonts', 'Carlito-Regular.ttf');
    const font = new mupdf.Font('Carlito', readFileSync(file));
    const set = genSet(file, 1024, join(tmp, 'carlito_1024.npz'));
    const spaceAdv = font.advanceGlyph(font.encodeCharacter(32), 0) * 16;
    results.push(...certifyPipeline({ label: 'TTF', font, em: 16, set, spaceAdv }));
  }
  // ---- CFF: our Nimbus Mono file vs mupdf's builtin Courier ------------------
  {
    const file = join(REPO, 'fonts', 'NimbusMonoPS-Regular.cff');
    const font = new mupdf.Font('Courier');
    const set = genSet(file, 791, join(tmp, 'nimbus_791.npz'));
    const em = 791 / 64;
    const spaceAdv = font.advanceGlyph(font.encodeCharacter(32), 0) * em;
    results.push(...certifyPipeline({ label: 'CFF', font, em, set, spaceAdv }));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

let failed = false;
for (const r of results) {
  const ok = r.diffs === 0;
  console.log(`${ok ? 'CERTIFIED' : 'FAILED   '} ${r.label} — ` +
    (ok ? `0 diffs over ${r.renders} lines (${r.glyphs} glyphs)`
        : `${r.diffs} bytes differ, worst |d|=${r.worst} at ${r.worstKey}`));
  if (!ok) failed = true;
}
if (failed) {
  console.log('\nrender.js is NOT certified — a rendered line is not what mupdf would draw.');
  process.exit(1);
}
console.log('\nrender.js certified against mupdf: pens round to the nearest ¼ px (ties up), ' +
  'baselines to the nearest whole px (ties up), overlaps blend in drawing order.');
