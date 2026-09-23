// palettesweep.mjs — the exact sweep, through the page's palette.
//
// A palettized page (LAWS §4 — 62 % of this corpus) writes Q(law(coverage)):
// Q is the page's own nearest-gray map, read off its /Indexed palette. An
// exact-byte sweep of law(coverage) alone is BLIND to such a page — mbank.mjs,
// identify.mjs and sweep.mjs all are, and said "no m matched" to a document
// that turned out to be a known family (EFTA00173953, 2026-09-23). This one
// applies Q per target page before comparing, and searches the ¼-px lattice
// (x 0,16,32,48 of 64; y integer — LAWS §1) under the four laws, exactly.
//
//   node lab/palettesweep.mjs --pdf X.pdf --targets <hunt> --fonts a.cff,b.ttf [--ems 700..1300] [--laws fzLin,fz]
//       every harvested target (lab/harvest.mjs or hunt harvest) against every
//       face × em64 × phase × law — prints per target what matched and the tally
//   node lab/palettesweep.mjs --pdf X.pdf --page N --y0 A --y1 B --fonts … [--ems …]
//       one band of one page, no harvest: every ink component of the band is
//       tried as every character of the PDF's text-layer line(s) there (both
//       cases — small caps); glyphs that touch stay unmatched (the reader
//       composites; a window cannot)
//
// Laws are lab/families.mjs LAWS. A hit is a whole-window byte match; with an
// unknown law start law-free (a monotone fit — see docs/METHOD.md) to pin the
// face and size, then come here for the law. Output faces are named by file.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as mupdf from 'mupdf';
import { FTClone } from '../ftclone/ftclone.mjs';
import { readPgm, inkBbox } from './pgm.mjs';
import { LAWS } from './families.mjs';
import { paletteLUTs } from '../tools/read-core.mjs';
import { pageRecord } from '../tools/rasterize-mupdf.mjs';
const E = createRequire(import.meta.url)('../engine/ocr-engine.js');

const LAB = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PDF = opt('pdf'), FONTS = (opt('fonts') ?? '').split(',').filter(Boolean);
const [E0, E1] = opt('ems', '700..1300').split('..').map(Number), LAWN = opt('laws', 'fzLin,fz').split(',');
const PHASES = opt('phases', '0,16,32,48').split(',').map(Number);
if (!PDF || !FONTS.length) { console.error('need --pdf and --fonts; then --targets <hunt> or --page N --y0 A --y1 B'); process.exit(2); }
const W = 40, H = 40, PENX = 10, BASEY = 28;
const doc = mupdf.PDFDocument.openDocument(readFileSync(PDF), 'application/pdf');
const Qs = await paletteLUTs(PDF);

// ---- targets: a harvest, or the components of one band with the text layer's characters as candidates ----
let targets = [], byCp = null;
if (opt('targets')) {
  const TDIR = `${LAB}/targets/${opt('targets')}`;
  const index = JSON.parse(readFileSync(`${TDIR}/index.json`, 'utf8'));
  for (const t of index.targets) {
    const { w, h, px } = readPgm(`${TDIR}/${t.id}.pgm`); const b = inkBbox(px, w, h, 255); if (!b) continue;
    const page = t.srcs?.[0]?.page ?? 1, Q = Qs.get(page); if (!Q) continue;
    const bytes = new Uint8Array(b.w * b.h); for (let r = 0; r < b.h; r++) for (let c = 0; c < b.w; c++) bytes[r * b.w + c] = px[(b.y0 + r) * w + b.x0 + c];
    targets.push({ id: t.id, label: `p${page} y${String(t.srcs[0].y).padStart(4)} '${t.ch}' ${t.id}`, cps: [t.cp], obs: t.obs, w: b.w, h: b.h, bytes, Q, hits: [] });
  }
  console.log(`${targets.length} harvested targets from ${opt('targets')}`);
} else {
  const PNO = +opt('page'), Y0 = +opt('y0'), Y1 = +opt('y1'), Q = Qs.get(PNO);
  if (!Q) { console.error(`page ${PNO} has no /Indexed palette — use lab/sweep.mjs`); process.exit(2); }
  const rec = pageRecord(doc, PNO), PW = rec.w;
  const c = rec.mode === 4 ? E.colourInk(rec.w, rec.h, new Uint8Array(rec.body.buffer, rec.body.byteOffset, PW * rec.h * 3), 3) : { gray: rec.body };
  const gray = c.gray;
  const st = JSON.parse(doc.loadPage(PNO - 1).toStructuredText('preserve-whitespace').asJSON());
  const lines = [];
  for (const b of st.blocks ?? []) for (const l of b.lines ?? []) { const y0 = l.bbox.y * 4 / 3, y1 = (l.bbox.y + l.bbox.h) * 4 / 3; if (y1 > Y0 - 2 && y0 < Y1 + 2 && l.text?.trim()) lines.push(l); }
  const cands = [...new Set(lines.flatMap(l => [...l.text].flatMap(ch => ch.trim() ? [ch, ch.toUpperCase(), ch.toLowerCase()] : [])))].filter(ch => [...ch].length === 1);
  const cps = cands.map(ch => ch.codePointAt(0));
  const seen = new Uint8Array(PW * rec.h);
  for (let y = Y0; y < Y1; y++) for (let x = 0; x < PW; x++) {
    const i = y * PW + x; if (gray[i] === 255 || seen[i]) continue;
    const stack = [i], px = []; seen[i] = 1;
    while (stack.length) { const k = stack.pop(); px.push(k); const kx = k % PW, ky = (k / PW) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = kx + dx, ny = ky + dy; if (nx < 0 || nx >= PW || ny < Y0 - 4 || ny >= Y1 + 4) continue; const n = ny * PW + nx; if (!seen[n] && gray[n] !== 255) { seen[n] = 1; stack.push(n); } } }
    let x0 = PW, y0 = rec.h, x1 = -1, y1 = -1; for (const k of px) { const kx = k % PW, ky = (k / PW) | 0; if (kx < x0) x0 = kx; if (kx > x1) x1 = kx; if (ky < y0) y0 = ky; if (ky > y1) y1 = ky; }
    const w = x1 - x0 + 1, h = y1 - y0 + 1; if (w > 30 || h > 30 || px.length < 6) continue;
    const bytes = new Uint8Array(w * h); for (let r = 0; r < h; r++) for (let cc = 0; cc < w; cc++) bytes[r * w + cc] = gray[(y0 + r) * PW + x0 + cc];
    targets.push({ id: `x${x0}y${y0}`, label: `x${String(x0).padStart(3)} y${y0} ${w}x${h}`, cps, obs: 1, w, h, bytes, Q, hits: [] });
  }
  console.log(`p${PNO} y${Y0}–${Y1}: ${lines.length} text-layer line(s) ${lines.map(l => `"${l.text.trim().slice(0, 40)}"`).join(' · ')} → ${cands.length} candidate chars, ${targets.length} ink components`);
}
targets.sort((a, b) => a.label.localeCompare(b.label));
const allCps = [...new Set(targets.flatMap(t => t.cps))];

// ---- the search ----
const q = new Uint8Array(W * H);
for (const font of FONTS) {
  const clone = new FTClone(font, W, H), name = font.split('/').pop().replace(/\.(cff|ttf|otf)$/i, '');
  if (clone.cff) { const mf = new mupdf.Font('F', readFileSync(font)); clone.setGidMap(new Map(allCps.map(cp => [cp, mf.encodeCharacter(cp)]))); }
  for (let em64 = E0; em64 <= E1; em64++) for (const fx of PHASES) for (const cp of allCps) {
    const cov = clone.coverage(cp, em64, em64, PENX * 64 + fx, BASEY * 64); if (!cov) continue;
    for (const law of LAWN) {
      const lut = LAWS[law]; if (!lut) continue;
      for (const t of targets) {
        if (!t.cps.includes(cp)) continue;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = t.Q[lut[cov[y * W + x]]]; q[y * W + x] = v; if (v < 255) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
        if (x1 < 0 || x1 - x0 + 1 !== t.w || y1 - y0 + 1 !== t.h) continue;
        let ok = true; for (let r = 0; r < t.h && ok; r++) for (let c = 0; c < t.w; c++) if (q[(y0 + r) * W + x0 + c] !== t.bytes[r * t.w + c]) { ok = false; break; }
        if (ok) t.hits.push(`${t.cps.length > 1 ? String.fromCodePoint(cp) + '=' : ''}${name}@${em64}${law === LAWN[0] ? '' : '/' + law}`);
      }
    }
  }
}
const tally = new Map();
for (const t of targets) { const hs = [...new Set(t.hits)]; console.log(`  ${t.label}: ${hs.length ? hs.join(' ') : '—'}`); for (const h of hs) { const k = h.replace(/^.*=/, ''); tally.set(k, (tally.get(k) ?? 0) + t.obs); } }
console.log(`\n(face@em64: weight) ${[...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ') || 'nothing matched'}`);
