// identify.mjs — the zero-priors first move of a hunt: try EVERY answer this
// project already has (families.mjs) against harvested targets, through the
// certified ftclone.
//
//   node lab/identify.mjs --targets courier
//   node lab/identify.mjs --targets <hunt> --scan times.ttf [--ems 448..1280]
//
// Mode 1 (default) — every renderable family, ~1 s each. Ends in a verdict:
//   "VERDICT: <family>"        the producer is known; go read the document
//   "no known family matches"  with the fingerprint and the next probes
//
// Mode 2 (`--scan <face>`) — the follow-up when no family matches but the FACE
// looks right: sweep em64 over a range and report exact counts per size. A
// real config is SHARP — one spike and nothing within ±30 of it. A broad hump
// is not a weak signal, it is the wrong face.
//
// ## The exact test, and why it is this strict
//
// A candidate matches a target when, aligned on their ink bboxes:
//   - the bbox DIMENSIONS agree (measured at the law's own ink threshold, not
//     at a constant — a faint 250..254 fringe otherwise makes every glyph
//     measure 1–2 px too wide and get rejected before its bytes are compared);
//   - every byte of the FULL target window agrees, white margins included;
//   - no stray candidate ink hugs the window border.
//
// Exactness cannot false-positive, which is the whole reason this is worth
// running blind (../docs/METHOD.md rule 8: cheap screens rank, this decides).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { FTClone } from '../ftclone/ftclone.mjs';
import { FAMILIES, LAWS, covMin, SCAN_DEFAULT, face } from './families.mjs';
import { readPgm, inkBbox, covBbox } from './pgm.mjs';

const LAB = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TDIR = `${LAB}/targets/${optS('targets', 'default')}`;
const FX = [0, 16, 32, 48];                       // the ¼-px pen lattice, always
const W = 48, H = 48, PENX = 12, BASEY = 32;

if (!existsSync(`${TDIR}/index.json`)) {
  console.error(`no targets at ${TDIR.replace(LAB, 'lab')} — run: node lab/harvest.mjs --doc <DOC> --out <hunt>`);
  process.exit(2);
}
const index = JSON.parse(readFileSync(`${TDIR}/index.json`, 'utf8'));
const targets = index.targets;
for (const t of targets) {
  t.pgm = readPgm(`${TDIR}/${t.id}.pgm`);
  t.bbox = inkBbox(t.pgm.px, t.pgm.w, t.pgm.h);
}
const byCp = new Map();
for (const t of targets) {
  if (!byCp.has(t.cp)) byCp.set(t.cp, []);
  byCp.get(t.cp).push(t);
}

function exactAt(t, cand, cb) {
  if (!cb || !t.bbox) return false;
  if (cb.w !== t.bbox.w || cb.h !== t.bbox.h) return false;
  const dx = cb.x0 - t.bbox.x0, dy = cb.y0 - t.bbox.y0;
  const { w, h, px } = t.pgm;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const rr = r + dy, cc = c + dx;
    const v = rr >= 0 && rr < H && cc >= 0 && cc < W ? cand[rr * W + cc] : 255;
    if (v !== px[r * w + c]) return false;
  }
  for (let r = -1; r <= h; r++) for (const c of [-1, w]) {
    const rr = r + dy, cc = c + dx;
    if (rr >= 0 && rr < H && cc >= 0 && cc < W && cand[rr * W + cc] < 250) return false;
  }
  return true;
}

// ---------------------------------------------------------------- fingerprint
{
  const dims = new Map();
  const pagesDir = `${LAB}/pages`;
  if (existsSync(pagesDir)) for (const d of readdirSync(pagesDir)) {
    if (index.source && !index.source.includes(d)) continue;
    try {
      const m = JSON.parse(readFileSync(`${pagesDir}/${d}/meta.json`, 'utf8'));
      for (const p of Object.values(m.pages ?? {})) {
        if (!p || p.empty) continue;
        const k = `${p.w}x${p.h}`;
        dims.set(k, (dims.get(k) ?? 0) + 1);
      }
    } catch {}
  }
  const seen = new Uint32Array(256);
  let ink = 0;
  for (const t of targets) for (const v of t.pgm.px) { seen[v]++; if (v < 255) ink++; }
  const distinct = seen.reduce((s, n) => s + (n > 0 ? 1 : 0), 0);
  const advs = targets.map(t => t.adv).filter(Boolean).sort((a, b) => a - b);
  const med = advs.length ? advs[advs.length >> 1] : null;
  console.log(`targets: ${targets.length} rasters, ${byCp.size} chars`
    + (med ? `, median cell advance ${med.toFixed(3)} px` : ''));
  if (dims.size) console.log(`pages:   ${[...dims.entries()].map(([k, n]) => `${k} ×${n}`).join(', ')}`
    + '   (816x1056 = 96 dpi letter)');
  console.log(`bytes:   ${distinct} distinct values over ${ink} ink px`
    + (distinct < 64 ? '   << FEW — suspect the palette-quant page law' : ''));
  console.log('');
}

// ---------------------------------------------------------------- rendering
async function gidMapFor(fontPath, cps) {
  const mupdf = await import('mupdf');
  const f = new mupdf.Font('F', readFileSync(fontPath));
  return new Map(cps.map(cp => [cp, f.encodeCharacter(cp)]));
}

/** Exact-target count for one (font, em64, fy list, law). Skips a target's
 *  remaining pens as soon as it matches. */
function tryConfig(clone, em64, fys, lawName) {
  const lut = LAWS[lawName] ?? LAWS.fz;
  const min = covMin[lawName] ?? covMin.fz;
  const hit = new Set(), chars = new Set();
  const cand = new Uint8Array(W * H);
  for (const [cp, list] of byCp) {
    outer: for (const fy of fys) for (const fx of FX) {
      if (list.every(t => hit.has(t.id))) break outer;
      const cov = clone.coverage(cp, em64, em64, PENX * 64 + fx, BASEY * 64 + fy);
      if (!cov) break outer;                       // no outline for this codepoint
      for (let i = 0; i < cand.length; i++) cand[i] = lut[cov[i]];
      const cb = covBbox(cov, W, H, min);
      for (const t of list) if (!hit.has(t.id) && exactAt(t, cand, cb)) { hit.add(t.id); chars.add(cp); }
    }
    clone.cache.clear();
  }
  return { exact: hit.size, chars: chars.size };
}

function openFace(path) {
  const clone = new FTClone(path, W, H);
  return clone;
}

// ---------------------------------------------------------- mode: em64 scan
const scanFont = optS('scan', null);
if (scanFont) {
  const path = face(scanFont);
  if (!path) { console.error(`no such face in any roster directory: ${scanFont}`); process.exit(2); }
  const [a, b] = optS('ems', `${SCAN_DEFAULT.from}..${SCAN_DEFAULT.to}`).split('..').map(Number);
  const fys = optS('fy', '0').split(',').map(Number);
  const lawName = optS('law', 'fz');
  const clone = openFace(path);
  if (clone.cff) clone.setGidMap(await gidMapFor(path, [...byCp.keys()]));
  const rows = [];
  const t0 = Date.now();
  for (let em = a; em <= b; em++) {
    const r = tryConfig(clone, em, fys, lawName);
    if (r.exact) rows.push({ em, ...r });
    if ((em - a) % 64 === 63) process.stderr.write(`\r  ${em - a + 1}/${b - a + 1} ems`);
  }
  process.stderr.write('\r');
  rows.sort((x, y) => y.exact - x.exact);
  console.log(`em64 scan ${a}..${b} of ${path} (law ${lawName}, fy ${fys.join(',')})  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  if (!rows.length) console.log('  no em64 in range produces one byte-exact target — wrong face, wrong law, or not this pipeline');
  for (const r of rows.slice(0, 12))
    console.log(`  em64 ${String(r.em).padStart(4)} = ${(r.em / 64).toFixed(6)} px  ${String(r.exact).padStart(4)} exact (${r.chars} chars)`);
  if (rows.length > 1 && rows[0].exact < 2 * rows[1].exact)
    console.log('  NOTE: no sharp spike — a broad hump across sizes is the wrong face, not a weak right one.');
  process.exit(0);
}

// ------------------------------------------------------ mode: every family
const results = [];
for (const f of FAMILIES) {
  if (!f.renderable) continue;
  const path = face(f.font);
  if (!path) { results.push({ f, skipped: `no ${f.font} in any roster dir` }); continue; }
  let clone;
  try { clone = openFace(path); } catch (e) { results.push({ f, skipped: e.message }); continue; }
  if (clone.cff) clone.setGidMap(await gidMapFor(path, [...byCp.keys()]));
  const t0 = Date.now();
  const r = tryConfig(clone, f.em64, f.fy, f.law);
  results.push({ f, ...r, secs: (Date.now() - t0) / 1000 });
}
results.sort((a, b) => (b.exact ?? -1) - (a.exact ?? -1));
console.log(`known renderable families — byte-exact targets of ${targets.length}:`);
for (const r of results) {
  if (r.skipped) { console.log(`  ${r.f.name.padEnd(20)} skipped: ${r.skipped}`); continue; }
  console.log(`  ${r.f.name.padEnd(20)} ${String(r.exact).padStart(4)}/${targets.length}  (${r.chars} chars, ${r.secs.toFixed(1)}s)`);
}
const skipped = results.filter(r => r.skipped).length;
console.log('');
const top = results.find(r => !r.skipped);
if (top && top.exact >= Math.max(5, targets.length * 0.03) && top.chars >= 4) {
  console.log(`VERDICT: ${top.f.name}${top.f.record ? ` — proven by ${top.f.record}` : ''}`);
  console.log(`  glyph set: ${top.f.set ?? '(none — this family has no certified pool)'}`);
  console.log('  The non-exact remainder is normally neighbour-AA and drawn-rule composition,');
  console.log('  which the reader handles but an isolated-window test cannot. Read the document:');
  console.log(`    node tools/rasterize-mupdf.mjs --pdf <doc.pdf>`);
  console.log(`    node tools/blind-read.mjs --pdf <doc.pdf> --page 1 --glyphs ${top.f.set ?? '<set>'}`);
} else {
  console.log('VERDICT: no known family matches.');
  if (skipped) console.log(`  ${skipped} families could not even be TRIED — a missing face is a statement`);
  if (skipped) console.log('  about this machine, not about the document (../docs/METHOD.md rule 3).');
  console.log('  Next, in cost order:');
  console.log('  1. face on the machine, size unknown:  node lab/identify.mjs --scan <face.ttf> --targets <hunt>');
  console.log('  2. face unknown:                       node lab/mbank.mjs scan <doc.pdf>');
  console.log('  3. neither:                            node lab/sweep.mjs --targets <hunt> --fonts <a,b,c>');
  console.log('  4. few distinct bytes above?           it is a page law, not a face — see families.mjs pageLaw entries');
}
