// certify.mjs — the gate for lab/rust, and the bridge to its oracle.
//
//   npm run rust:build && npm run rust:certify
//
// The Rust engine is a clone of a clone: `lab/rust/ftclone` reproduces
// `ftclone/`, and `hunt sweep` reproduces `lab/sweep.mjs`. Neither claim is
// worth anything unasserted, so this file asserts all four of them:
//
//   1. selftest — 3,000 seeded (font, em64x, em64y, pen, cp) tuples pushed
//      through the JS FTClone; the Rust must reproduce every coverage byte
//      AND every per-law ink bbox. 0 diffs or nothing below counts.
//   2. control sweeps — two whole sweeps run by `lab/sweep.mjs`, compared
//      hit for hit (order included), summary row for summary row, and on the
//      stage-A survivor line.
//   3. harvest — the connected-component harvester has no JS counterpart, so
//      it is certified by a CLOSED LOOP instead: a page whose glyphs this
//      repo rendered itself is harvested blind, and every window it promotes
//      must come back byte-identical to the render it came from.
//
// **Everything here is synthetic and needs no corpus and no system font.**
// The control targets and the harvest page are drawn by `ftclone/` through
// faces this repo ships (`fonts/`, OFL/AFPL-free — see fonts/LICENSES.md), so
// a fresh clone can run the whole gate. That is deliberate: the corpus gate in
// `tools/gate.mjs` proves the reader against real documents, and this one
// proves the engine against arithmetic. Neither substitutes for the other.
//
// The goldens under fixtures/ are COMMITTED, which is what makes this a
// regression gate rather than a self-consistency check: if the JS oracle
// itself changes behaviour, the goldens disagree and say so. Regenerate them
// deliberately with --regen (~2 min, JS-bound), never to make a failure go away.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FTClone } from '../../ftclone/ftclone.mjs';
import { LAWS, LAW_NAMES, covMin } from '../families.mjs';
import { writePgm, inkBbox, readPgm } from '../pgm.mjs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const HERE = `${ROOT}/lab/rust`;
const HUNT = `${HERE}/target/release/hunt${process.platform === 'win32' ? '.exe' : ''}`;
const FIX = `${HERE}/fixtures`;
const REGEN = process.argv.includes('--regen');

let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fail++;
};
const hunt = (...argv) => execFileSync(HUNT, [...argv, '--root', ROOT], { encoding: 'utf8', cwd: ROOT });
const node = (script, ...argv) =>
  execFileSync(process.execPath, [`${ROOT}/${script}`, ...argv], { encoding: 'utf8', cwd: ROOT });

if (!existsSync(HUNT)) {
  console.error(`${HUNT} missing — run: npm run rust:build`);
  process.exit(2);
}
mkdirSync(FIX, { recursive: true });

// ---------------------------------------------------------------- fonts ----
// Only faces this repo may legally ship, so the whole gate runs on a clone.
const FONT = n => `${ROOT}/fonts/${n}`;
const CFFS = readdirSync(`${ROOT}/fonts`).filter(f => f.endsWith('.cff')).sort();

// A bare CFF has no cmap, so cp→gid comes from mupdf's own encodeCharacter on
// the same bytes — the runtime sidecar the Rust sweep reads, and the same map
// the JS tools build on the fly. If the two disagreed about which glyph a
// codepoint names, every byte comparison below would be comparing the wrong
// pair of glyphs and still pass.
const CPS = [];
for (let c = 33; c <= 126; c++) CPS.push(c);
CPS.push(0xE9, 0xF1, 0xFC, 0xC0, 0xE5, 0xA9);

const mupdf = await import('mupdf');
const gidMaps = new Map();
for (const f of CFFS) {
  const mf = new mupdf.Font('F', readFileSync(FONT(f)));
  gidMaps.set(f, new Map(CPS.map(cp => [cp, mf.encodeCharacter(cp)])));
}
writeFileSync(`${HERE}/gidmaps.json`, JSON.stringify(Object.fromEntries(
  [...gidMaps].map(([f, m]) => [`fonts/${f}`, Object.fromEntries(m)])), null, 1));

function clone(name, W = 40, H = 40) {
  const c = new FTClone(FONT(name), W, H);
  if (c.cff) c.setGidMap(gidMaps.get(name));
  return c;
}

// ---------------------------------------------------- 1. golden fixtures ---
// Seeded, so the same 3,000 cases every time. The interesting ones are the
// fringes: pens that clip every edge of the frame, fractional em64 (the ×32
// scale-trick path), anisotropic em64, and the composite-glyph accents whose
// component transforms are FLOAT arithmetic in JS.
const FIXTURE_FONTS = [
  { path: 'fonts/Carlito-Regular.ttf' },
  { path: 'fonts/DejaVuSerif.ttf' },
  ...CFFS.map(f => ({ path: `fonts/${f}` })),
];
const FRAMES = [[40, 40], [40, 40], [40, 40], [60, 60], [32, 48]];
const EM_SPECIAL = [640, 704, 768, 791, 832, 938, 983, 1024, 1194, 1198, 1536];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genFixtures(count = 3000) {
  const rnd = mulberry32(0x5EED);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const clones = new Map();
  const cloneFor = (fi, W, H) => {
    const k = `${fi}|${W}|${H}`;
    if (!clones.has(k)) {
      const name = FIXTURE_FONTS[fi].path.replace('fonts/', '');
      clones.set(k, clone(name, W, H));
    }
    return clones.get(k);
  };
  const lawNames = LAW_NAMES;   // the DISTINCT laws — see families.mjs
  const cases = [];
  let nNull = 0;
  for (let i = 0; i < count; i++) {
    const fi = i % FIXTURE_FONTS.length;
    const isCff = FIXTURE_FONTS[fi].path.endsWith('.cff');
    const [W, H] = pick(FRAMES);
    const cp = pick(CPS);
    let em64x = rnd() < 0.5 ? pick(EM_SPECIAL) : rint(448, 1280);
    if (!isCff && rnd() < 0.1) em64x += rint(1, 31) / 32;
    const em64y = rnd() < 0.3 ? (rnd() < 0.5 ? pick(EM_SPECIAL) : rint(448, 1280)) : em64x;
    let px64, py64;
    const r = rnd();
    if (r < 0.7) { px64 = 10 * 64 + rint(0, 63); py64 = (H - 12) * 64 + rint(0, 63); }
    else if (r < 0.85) { px64 = rint(-64, 3 * 64); py64 = rint(0, 8 * 64); }                    // clip left/top
    else { px64 = (W - 4) * 64 + rint(0, 5 * 64); py64 = (H - 2) * 64 + rint(0, 4 * 64); }      // clip right/bottom
    const c = cloneFor(fi, W, H);
    let cov = null;
    try { cov = c.coverage(cp, em64x, em64y, px64, py64); }
    catch (e) { console.error(`SKIP case ${i}: ${e.message}`); continue; }
    c.cache.clear();
    if (!cov) nNull++;
    const boxes = cov ? lawNames.map(law => inkBboxCov(cov, W, H, covMin[law])) : null;
    cases.push({ fi, cp, em64x, em64y, px64, py64, W, H, cov, boxes });
  }

  const parts = [];
  const u8 = v => Buffer.from([v]);
  const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const i16 = v => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; };
  const i32 = v => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const f64 = v => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };
  parts.push(Buffer.from('HUNTFIX1', 'latin1'));
  parts.push(u16(lawNames.length));
  for (const name of lawNames) {
    const nb = Buffer.from(name, 'latin1');
    parts.push(u8(nb.length), nb, Buffer.from(LAWS[name]), u8(covMin[name]));
  }
  parts.push(u16(FIXTURE_FONTS.length));
  for (const f of FIXTURE_FONTS) {
    const pb = Buffer.from(f.path, 'utf8');
    const isCff = f.path.endsWith('.cff');
    parts.push(u16(pb.length), pb, u8(isCff ? 1 : 0));
    const gm = isCff ? [...gidMaps.get(f.path.replace('fonts/', ''))] : [];
    parts.push(u32(gm.length));
    for (const [cp, gid] of gm) parts.push(u32(cp), u32(gid));
  }
  parts.push(u32(cases.length));
  for (const c of cases) {
    parts.push(u16(c.fi), u32(c.cp), f64(c.em64x), f64(c.em64y),
      i32(c.px64), i32(c.py64), u16(c.W), u16(c.H), u8(c.cov ? 1 : 0));
    if (c.cov) {
      parts.push(Buffer.from(c.cov));
      for (const b of c.boxes)
        parts.push(...(b ? [i16(b.x0), i16(b.y0), i16(b.w), i16(b.h)] : [i16(-1), i16(-1), i16(-1), i16(-1)]));
    }
  }
  writeFileSync(`${FIX}/golden.bin`, Buffer.concat(parts));
  console.log(`  ${cases.length} cases (${nNull} null-outline) over ${FIXTURE_FONTS.length} shipped faces`);
}

/** covBbox over a coverage buffer — ../pgm.mjs covBbox, in the fixture's shape. */
function inkBboxCov(cov, W, H, min) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (cov[r * W + c] >= min) {
    if (c < x0) x0 = c; if (c > x1) x1 = c;
    if (r < y0) y0 = r; if (r > y1) y1 = r;
  }
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

if (REGEN || !existsSync(`${FIX}/golden.bin`)) {
  console.log('generating golden fixtures through the JS FTClone…');
  genFixtures();
}
const st = hunt('selftest');
process.stdout.write(st.split('\n').filter(l => l.trim()).map(l => `  ${l}`).join('\n') + '\n');
ok('selftest — every coverage byte and per-law bbox', st.includes('SELFTEST CERTIFIED: 0 diffs'));

// ------------------------------------------------- 2. the control sweeps ---
// Targets are RENDERED, not harvested, so the answer is known and the whole
// thing runs with no corpus. Each control exercises a different half of the
// engine: `ctrl` is the TTF/cmap path at the first law, `ctrl2` the bare-CFF
// gid-map path at the third — and the law index is what orders the hit list,
// so ctrl2 is also what catches a law reordering.
//
// **Each roster carries decoys, and that is the load-bearing part.** A sweep
// that agrees with the JS on which face won proves the port; only a sweep that
// scores the wrong faces at flat zero proves the search. Exactness cannot
// false-positive, so a single stray hit from a decoy would mean the byte test
// has a hole in it — the same assertion `lab/selftest.mjs` leans on.
const W = 40, H = 40, PENX = 10, BASEY = 28;
const CONTROLS = [
  { name: 'ctrl',  font: 'Carlito-Regular.ttf',      em64: 832, law: 'fz',    ems: '826..838',
    decoys: ['DejaVuSerif.ttf', 'NimbusSans-Regular.cff'], chars: 'aemnorstuABEHMNORS' },
  { name: 'ctrl2', font: 'NimbusMonoPS-Regular.cff', em64: 791, law: 'fzLin', ems: '785..797',
    decoys: ['Carlito-Regular.ttf', 'NimbusRoman-Regular.cff'], chars: 'aemnorstuABEHMNORS' },
];

/** Draw the control's own answer as targets: one window per (char, ¼-px pen
 *  phase), ink bbox plus a one-pixel white guard, exactly the shape a harvest
 *  emits. Deterministic, so the committed goldens stay valid. */
function makeTargets(c) {
  const dir = `${ROOT}/lab/targets/_rust${c.name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cl = clone(c.font);
  const lut = LAWS[c.law], min = covMin[c.law];
  const targets = [];
  for (const ch of c.chars) {
    const cp = ch.codePointAt(0);
    for (const [slot, fx] of [[0, 0], [1, 16], [2, 32], [3, 48]]) {
      const cov = cl.coverage(cp, c.em64, c.em64, PENX * 64 + fx, BASEY * 64);
      if (!cov) continue;
      const b = inkBboxCov(cov, W, H, min);
      if (!b) continue;
      const [tw, th] = [b.w + 2, b.h + 2];
      const px = Buffer.alloc(tw * th, 255);
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++)
        px[(y + 1) * tw + x + 1] = lut[cov[(b.y0 + y) * W + b.x0 + x]];
      const id = `${cp}_p${slot}_v1`;
      // obs varies per phase so the weight ranking is not a tie everywhere
      targets.push({ id, ch, cp, phaseSlot: slot, w: tw, h: th, obs: 3 + slot });
      writePgm(`${dir}/${id}.pgm`, tw, th, px);
    }
    cl.cache.clear();
  }
  writeFileSync(`${dir}/index.json`, JSON.stringify({
    note: `synthetic control: ${c.font} em64 ${c.em64} law ${c.law}, the ¼-px pen lattice. `
      + 'Rendered by ftclone/, so the answer is known and no corpus is needed.',
    targets,
  }, null, 1));
  const h = createHash('sha256');
  for (const t of targets.sort((a, b) => (a.id < b.id ? -1 : 1)))
    h.update(readFileSync(`${dir}/${t.id}.pgm`));
  return { n: targets.length, hash: h.digest('hex').slice(0, 16) };
}

const normHits = hits => hits.map(h => JSON.stringify([h.font, h.em64, h.law, h.ch, h.id, h.obs, h.fx, h.fy, h.wob ?? null]));
const normSum = rows => rows.map(r => JSON.stringify([r.font, r.em64, r.law, r.tmpl, r.weight, r.chars]));
// every font's stage-A line, in roster order — a decoy that survives stage A
// and is then refused by stage B is exactly the sequence worth comparing
const survivorLine = s => (s.match(/^\S+: \d+ dims survivors.*$/gm) ?? []).join(' | ');

for (const c of CONTROLS) {
  const t = makeTargets(c);
  const roster = [c.font, ...c.decoys].join(',');
  const goldenPath = `${FIX}/golden-${c.name}.json`;
  const logPath = `${FIX}/golden-${c.name}.log`;
  if (REGEN || !existsSync(goldenPath)) {
    console.log(`running the JS oracle for ${c.name} (lab/sweep.mjs — slow, this is the point)…`);
    const t0 = Date.now();
    const log = node('lab/sweep.mjs', '--targets', `_rust${c.name}`, '--fonts', roster,
      '--ems', c.ems, '--report', goldenPath);
    const oracleSecs = +((Date.now() - t0) / 1000).toFixed(1);
    writeFileSync(logPath, log);
    const g = JSON.parse(readFileSync(goldenPath, 'utf8'));
    // recorded here so the speedup below is a MEASUREMENT of the same work on
    // the same machine, not a number someone once wrote in a README
    writeFileSync(goldenPath, JSON.stringify({ targetsHash: t.hash, nTargets: t.n, oracleSecs, ...g }, null, 1));
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  // The golden is the oracle's output for THESE pixels. If the targets are
  // not the ones it saw, the comparison below is meaningless — so say so
  // rather than reporting a pass or a mysterious diff.
  if (golden.targetsHash !== t.hash) {
    ok(`${c.name} control targets`, false,
      `regenerated targets hash ${t.hash} ≠ golden ${golden.targetsHash} — the oracle's input changed; re-run with --regen`);
    continue;
  }

  const outPath = `${FIX}/rust-${c.name}.json`;
  rmSync(outPath, { force: true });
  const t0 = Date.now();
  const out = hunt('sweep', '--targets', `_rust${c.name}`, '--fonts', roster, '--ems', c.ems, '--report', outPath);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const rust = JSON.parse(readFileSync(outPath, 'utf8'));
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';

  ok(`${c.name} stage-A survivors`, survivorLine(out) === survivorLine(log),
    survivorLine(out) ?? 'no survivor line');
  const gh = normHits(golden.hits), rh = normHits(rust.hits);
  let firstDiff = -1;
  for (let i = 0; i < Math.max(gh.length, rh.length); i++) if (gh[i] !== rh[i]) { firstDiff = i; break; }
  const speed = golden.oracleSecs ? `, ${dt}s vs ${golden.oracleSecs}s in JS (${(golden.oracleSecs / dt).toFixed(0)}×)` : `, rust ${dt}s`;
  ok(`${c.name} hits (${gh.length})`, firstDiff === -1,
    firstDiff === -1 ? `identical${speed}` : `first diff at #${firstDiff}: JS ${gh[firstDiff]} vs RUST ${rh[firstDiff]}`);
  const gs = normSum(golden.summary), rs = normSum(rust.summary);
  ok(`${c.name} summary (${gs.length} rows)`, JSON.stringify(gs) === JSON.stringify(rs));
  // and the sweep must actually FIND the config the targets were drawn at —
  // a gate that only proves two engines agree would pass on two broken ones
  const top = rust.summary[0];
  ok(`${c.name} winner is the truth`,
    top?.font === c.font && top?.em64 === c.em64 && top?.law === c.law && top?.tmpl === golden.nTargets,
    top ? `${top.font} em64 ${top.em64} ${top.law} — ${top.tmpl}/${golden.nTargets} templates` : 'nothing scored');
  // The load-bearing one. Exactness cannot false-positive, so every decoy must
  // be flat zero; one stray hit would mean the byte test has a hole and every
  // verdict this engine gives is suspect.
  const stray = rust.summary.filter(r => r.font !== c.font || r.em64 !== c.em64);
  ok(`${c.name} no decoy and no wrong size scores at all`, stray.length === 0,
    stray.length ? stray.map(r => `${r.font}@${r.em64}=${r.tmpl}`).join(', ')
      : `${c.decoys.length} decoy faces × 13 sizes, all 0`);
}

// -------------------------------------------------- 3. the harvest loop ----
// No JS counterpart exists for the connected-component harvester, so the
// oracle is the page itself: this repo draws it, so it knows what every glyph
// on it is and what its pixels are. The harvester is told none of that.
const HDOC = '_rustcert';
{
  const font = 'Carlito-Regular.ttf', em64 = 832, law = 'fz';
  const cl = clone(font), lut = LAWS[law];
  const alphabet = 'abcdehmnorstu';
  const ADV = 13, GAP = 9, LEFT = 12, TOP = 22, LINEH = 20, PER_LINE = 6, WORDS = 4, LINES = 10;
  const pw = LEFT * 2 + WORDS * (PER_LINE * ADV + GAP), ph = TOP + LINES * LINEH + 12;
  const page = Buffer.alloc(pw * ph, 255);
  const words = [];
  const rnd = mulberry32(0xC0FFEE);
  for (let li = 0; li < LINES; li++) {
    const baseY = TOP + li * LINEH;
    let x = LEFT;
    for (let wi = 0; wi < WORDS; wi++) {
      let text = '', chars = [];
      for (let k = 0; k < PER_LINE; k++) {
        const ch = alphabet[Math.floor(rnd() * alphabet.length)];
        const cov = cl.coverage(ch.codePointAt(0), em64, em64, PENX * 64, BASEY * 64);
        if (cov) for (let y = 0; y < H; y++) for (let c = 0; c < W; c++) {
          const v = lut[cov[y * W + c]];
          if (v >= 255) continue;
          const py = baseY - BASEY + y, px = x - PENX + c;
          if (py >= 0 && py < ph && px >= 0 && px < pw) {
            const i = py * pw + px;
            if (v < page[i]) page[i] = v;
          }
        }
        text += ch;
        chars.push(x);
        x += ADV;
      }
      words.push({ text, chars, px: { yBase: baseY } });
      x += GAP;
    }
    cl.cache.clear();
  }
  const pdir = `${ROOT}/lab/pages/${HDOC}`;
  rmSync(pdir, { recursive: true, force: true });
  rmSync(`${ROOT}/lab/targets/${HDOC}`, { recursive: true, force: true });
  mkdirSync(pdir, { recursive: true });
  writePgm(`${pdir}/page-0001.pgm`, pw, ph, page);
  writeFileSync(`${pdir}/page-0001.words.json`, JSON.stringify({ words }, null, 1));
  writeFileSync(`${pdir}/meta.json`, JSON.stringify({ doc: HDOC, pages: { 1: { w: pw, h: ph } },
    note: 'synthetic page drawn by lab/rust/certify.mjs — not a document' }, null, 1));

  const hout = hunt('harvest', '--doc', HDOC, '--out', HDOC);
  const tdir = `${ROOT}/lab/targets/${HDOC}`;
  const idx = existsSync(`${tdir}/index.json`) ? JSON.parse(readFileSync(`${tdir}/index.json`, 'utf8')) : { targets: [] };

  // the reference: what THIS repo drew, cropped the way a component cut is
  const want = new Map();
  for (const ch of alphabet) {
    const cov = cl.coverage(ch.codePointAt(0), em64, em64, PENX * 64, BASEY * 64);
    const cand = Buffer.alloc(W * H);
    for (let i = 0; i < cand.length; i++) cand[i] = lut[cov[i]];
    const b = inkBbox(cand, W, H, 250);
    const px = Buffer.alloc(b.w * b.h);
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) px[y * b.w + x] = cand[(b.y0 + y) * W + b.x0 + x];
    want.set(ch, { w: b.w, h: b.h, px });
  }
  cl.cache.clear();

  const got = new Map(idx.targets.map(t => [t.ch, t]));
  const missing = [...alphabet].filter(ch => !got.has(ch));
  ok('harvest finds every drawn glyph', missing.length === 0,
    `${got.size}/${alphabet.length} chars${missing.length ? `, missing ${missing.join('')}` : ''}`);
  let bad = [];
  for (const t of idx.targets) {
    const w = want.get(t.ch);
    if (!w) { bad.push(`${t.ch}?`); continue; }
    const p = readPgm(`${tdir}/${t.id}.pgm`);
    if (p.w !== w.w || p.h !== w.h || !Buffer.from(p.px).equals(w.px)) bad.push(t.id);
  }
  ok('harvest windows are byte-identical to the render', bad.length === 0,
    bad.length ? `${bad.length} differ: ${bad.slice(0, 6).join(' ')}` : `${idx.targets.length} windows`);
  const promoted = /promoted (\d+) /.exec(hout)?.[1];
  console.log(`  ${(/pages .*clusters \d+/.exec(hout) ?? [''])[0]}, promoted ${promoted}`);
  rmSync(pdir, { recursive: true, force: true });
  rmSync(tdir, { recursive: true, force: true });
}

for (const c of CONTROLS) rmSync(`${ROOT}/lab/targets/_rust${c.name}`, { recursive: true, force: true });
console.log(fail
  ? `\nRUST NOT CERTIFIED: ${fail} check(s) failed`
  : '\nRUST CERTIFIED: the rasterizer, both control sweeps and the harvest loop reproduced exactly');
process.exit(fail ? 1 : 0);
