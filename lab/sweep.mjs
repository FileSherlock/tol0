// sweep.mjs — when no known family matches: try every (face, em64, pen phase,
// blend law) and report what reproduces the targets byte-exactly.
//
//   node lab/sweep.mjs --targets <hunt>                       # the family faces
//   node lab/sweep.mjs --targets <hunt> --fonts all           # every face on the machine
//   node lab/sweep.mjs --targets <hunt> --fonts times.ttf,cour.ttf --ems 800..900
//   node lab/sweep.mjs --targets <hunt> --at 786              # skip stage A
//   knobs: --report out.json  --min-dim 0.75  --screen 6  --wobble [N]
//
// ## Two stages, because the full grid is 64×64 pens × 4 distinct laws per glyph
//
// **Stage A — the dimensions prefilter.** For a handful of high-observation
// characters, render at two pens and demand the ink bbox be within ±1 px of
// some target of that character. Cheap, and it collapses em64 700..1100 to a
// few survivors. It RANKS; it never decides (../docs/METHOD.md rule 8).
//
// **Stage B — the exact sweep.** On each survivor, walk the whole 64×64 pen
// lattice. Every render is cropped at the LAW'S OWN ink threshold and hashed
// against every target of that character under all four distinct laws at once. It runs
// on a screen of the most-observed characters first, and only opens up to the
// full alphabet for a configuration that already scored — a wrong config
// scores zero on the common letters and is abandoned in milliseconds.
//
// ## What a hit means, and what it does not
//
// Exactness cannot false-positive: a byte-identical reproduction of a real
// glyph raster is the answer or an outright coincidence, and coincidences do
// not repeat across characters. But this compares the TIGHT INK CROP, where
// identify.mjs compares the whole window including its white margins and the
// border. **Confirm a sweep winner with identify.mjs before believing it** —
// sweep ranks, identify decides.
//
// FTClone can place a pen on any 1/64, which is the reason this search is
// possible at all: mupdf's own fillText can only reach 4 of these 4096 phases
// (../docs/LAWS.md §1), so a sweep through the real renderer could never cover
// the lattice.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { FTClone } from '../ftclone/ftclone.mjs';
import { FAMILIES, LAWS, LAW_NAMES, covMin, FONT_DIRS, face } from './families.mjs';
import { readPgm, inkBbox, covBbox } from './pgm.mjs';

const LAB = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const args = process.argv.slice(2);
const optS = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TDIR = `${LAB}/targets/${optS('targets', 'default')}`;
const EMS = optS('ems', '700..1100').split('..').map(Number);
const AT = optS('at', null)?.split(',').map(Number) ?? null;
const REPORT = optS('report', null);
const MIN_DIM = +optS('min-dim', '0.75');
const SCREEN = +optS('screen', '6');
const XSTEP = +optS('xstep', '1'), YSTEP = +optS('ystep', '1');
// --wobble N: also accept a template when NO pixel differs by more than 1 and
// at most N% of pixels differ by exactly 1. This exists for one measured
// reason: a producer whose conic curves land ±1 off (the Cambria family) makes
// the RIGHT face score exactly zero under the exact test. Wobble hits are
// tracked separately as '<law>~' and are a lead, never a proof.
const WOBBLE = args.includes('--wobble') ? +optS('wobble', '10') : 0;

const W = 40, H = 40, PENX = 10, BASEY = 28;

// ---------------------------------------------------------------- targets
if (!existsSync(`${TDIR}/index.json`)) {
  console.error(`no targets at ${TDIR.replace(LAB, 'lab')} — run lab/harvest.mjs first`);
  process.exit(2);
}
const index = JSON.parse(readFileSync(`${TDIR}/index.json`, 'utf8'));
const rows = index.targets;
const byCp = new Map();     // cp -> { ch, sigs: Map(sig -> {id, obs}), dims, totalN }
for (const t of rows) {
  const { w, h, px } = readPgm(`${TDIR}/${t.id}.pgm`);
  const b = inkBbox(px, w, h, 250);            // the harvest ink threshold
  if (!b) continue;
  const bytes = Buffer.alloc(b.w * b.h);
  for (let r = 0; r < b.h; r++) for (let c = 0; c < b.w; c++)
    bytes[r * b.w + c] = px[(b.y0 + r) * w + b.x0 + c];
  let e = byCp.get(t.cp);
  if (!e) byCp.set(t.cp, e = { ch: t.ch, sigs: new Map(), dims: [], totalN: 0 });
  const sig = `${b.w}x${b.h}:${bytes.toString('latin1')}`;
  if (!e.sigs.has(sig)) e.sigs.set(sig, { id: t.id, obs: t.obs, bytes, w: b.w, h: b.h });
  if (!e.dims.some(d => d[0] === b.w && d[1] === b.h)) e.dims.push([b.w, b.h]);
  e.totalN += t.obs;
}
const nTmpl = [...byCp.values()].reduce((s, e) => s + e.sigs.size, 0);
if (!nTmpl) { console.error('no usable targets'); process.exit(2); }
console.log(`${nTmpl} distinct templates over ${byCp.size} chars from ${TDIR.replace(LAB, 'lab')}`);

const probeCps = [...byCp.entries()]
  .filter(([, v]) => v.dims.some(d => d[0] >= 5 && d[1] >= 5))
  .sort((a, b) => b[1].totalN - a[1].totalN).slice(0, 8).map(([cp]) => cp);
const screenCps = [...byCp.entries()].sort((a, b) => b[1].totalN - a[1].totalN)
  .slice(0, SCREEN).map(([cp]) => cp);
console.log(`dims probe: ${probeCps.map(c => String.fromCodePoint(c)).join(' ')}`
  + `   stage-B screen: ${screenCps.map(c => String.fromCodePoint(c)).join(' ')}`);

// ---------------------------------------------------------------- the roster
// Default is the faces the proven families already name — a warm start, and
// seconds rather than hours. `--fonts all` enumerates every roster directory,
// which is what METHOD rule 3 demands when you are about to claim "no match".
function roster() {
  const arg = optS('fonts', null);
  if (arg && arg !== 'all') return arg.split(',').map(s => face(s.trim()) ?? s.trim());
  if (!arg) {
    const seen = new Set();
    const out = [];
    for (const f of FAMILIES) {
      if (!f.renderable || seen.has(f.font)) continue;
      seen.add(f.font);
      const p = face(f.font);
      if (p) out.push(p);
    }
    return out;
  }
  const out = [];
  for (const d of FONT_DIRS) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort())
      if (/\.(ttf|cff)$/i.test(f)) out.push(`${d.replace(/\/$/, '')}/${f}`);
  }
  return out;
}
const FONTS = roster();
console.log(`roster: ${FONTS.length} faces${optS('fonts', null) ? '' : ' (the proven-family faces — pass --fonts all for every face on this machine)'}`);

async function gidMapFor(fontPath, cps) {
  const mupdf = await import('mupdf');
  const f = new mupdf.Font('F', readFileSync(fontPath));
  return new Map(cps.map(cp => [cp, f.encodeCharacter(cp)]));
}

// ---------------------------------------------------------------- stage A
function dimScore(clone, em64x, em64y) {
  let ok = 0, tried = 0;
  for (const cp of probeCps) {
    const { dims } = byCp.get(cp);
    tried++;
    for (const [fx, fy] of [[0, 0], [33, 31]]) {
      const cov = clone.coverage(cp, em64x, em64y, PENX * 64 + fx, BASEY * 64 + fy);
      if (!cov) break;
      const b = covBbox(cov, W, H, 6);
      if (b && dims.some(d => Math.abs(d[0] - b.w) <= 1 && Math.abs(d[1] - b.h) <= 1)) { ok++; break; }
    }
  }
  return tried ? ok / tried : 0;
}

// ---------------------------------------------------------------- stage B
const hits = [], summary = new Map();
function sweepConfig(clone, fontName, em64, cps) {
  const t0 = Date.now();
  const tmplByDims = new Map();
  if (WOBBLE) for (const [cp, T] of byCp) {
    const m = new Map();
    for (const v of T.sigs.values()) {
      const k = `${v.w}x${v.h}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(v);
    }
    tmplByDims.set(cp, m);
  }
  for (const cp of cps) {
    const T = byCp.get(cp);
    for (let fy = 0; fy < 64; fy += YSTEP) {
      for (let fx = 0; fx < 64; fx += XSTEP) {
        const cov = clone.coverage(cp, em64, em64, PENX * 64 + fx, BASEY * 64 + fy);
        if (!cov) { fy = 64; break; }
        // LAW_NAMES, not Object.keys(LAWS): three of the six names are the
        // same LUT, and enumerating all six triple-counted every linear hit.
        for (const law of LAW_NAMES) {
          const lut = LAWS[law];
          const b = covBbox(cov, W, H, covMin[law]);
          if (!b || b.w > 30 || b.h > 30) continue;
          if (!T.dims.some(d => d[0] === b.w && d[1] === b.h)) continue;
          const bytes = Buffer.alloc(b.w * b.h);
          for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++)
            bytes[y * b.w + x] = lut[cov[(b.y0 + y) * W + b.x0 + x]];
          const record = (t, lawName, wob) => {
            hits.push({ font: fontName, em64, law: lawName, ch: T.ch, id: t.id, obs: t.obs, fx, fy, ...(wob ? { wob } : {}) });
            const key = `${fontName}|${em64}|${lawName}`;
            let s = summary.get(key);
            if (!s) summary.set(key, s = { font: fontName, em64, law: lawName, tmpl: new Set(), weight: 0, chars: new Set() });
            if (!s.tmpl.has(t.id)) { s.tmpl.add(t.id); s.weight += t.obs; }
            s.chars.add(T.ch);
          };
          const hit = T.sigs.get(`${b.w}x${b.h}:${bytes.toString('latin1')}`);
          if (hit) record(hit, law);
          else if (WOBBLE) {
            const cands = tmplByDims.get(cp)?.get(`${b.w}x${b.h}`) ?? [];
            const maxWob = Math.ceil(bytes.length * WOBBLE / 100);
            for (const t of cands) {
              let wob = 0, ok = true;
              for (let i = 0; i < bytes.length; i++) {
                const d = bytes[i] - t.bytes[i];
                if (d > 1 || d < -1) { ok = false; break; }
                if (d && ++wob > maxWob) { ok = false; break; }
              }
              if (ok && wob) { record(t, law + '~', wob); break; }
            }
          }
        }
      }
    }
    clone.cache.clear();
  }
  return (Date.now() - t0) / 1000;
}

// ---------------------------------------------------------------- run
const totalObs = rows.reduce((s, t) => s + t.obs, 0);
for (const font of FONTS) {
  let clone;
  try { clone = new FTClone(font, W, H); }
  catch (e) { console.log(`SKIP ${font}: ${e.message}`); continue; }
  if (clone.cff) {
    try { clone.setGidMap(await gidMapFor(font, [...byCp.keys()])); }
    catch (e) { console.log(`SKIP ${font}: gid map — ${e.message}`); continue; }
  }
  const short = font.split(/[\\/]/).pop();
  let ems = AT;
  if (!ems) {
    ems = [];
    for (let em = EMS[0]; em <= EMS[1]; em++) {
      if (dimScore(clone, em, em) >= MIN_DIM) ems.push(em);
      clone.cache.clear();
    }
    console.log(`${short}: ${ems.length} dims survivors${ems.length && ems.length <= 24 ? ` [${ems.join(',')}]` : ''}`);
  }
  if (args.includes('--dims-only')) continue;
  const t0 = Date.now();
  for (const em of ems) {
    const before = hits.length;
    sweepConfig(clone, short, em, screenCps);
    if (hits.length === before) continue;
    const dt = sweepConfig(clone, short, em, [...byCp.keys()].filter(cp => !screenCps.includes(cp)));
    const best = [...summary.values()].filter(s => s.font === short && s.em64 === em)
      .sort((a, b) => b.tmpl.size - a.tmpl.size)[0];
    console.log(`  *** ${short} em64=${em}: ${best.law} — ${best.tmpl.size} templates / ${best.chars.size} chars / weight ${best.weight}  [${dt.toFixed(0)}s]`);
  }
  if (ems.length) console.log(`  ${short}: ${ems.length} configs in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const ranked = [...summary.values()].sort((a, b) => b.weight - a.weight);
console.log(`\ntop configs by observation weight (of ${totalObs} target observations):`);
for (const r of ranked.slice(0, 12))
  console.log(`  ${r.font.padEnd(22)} em64 ${String(r.em64).padStart(4)} ${r.law.padEnd(9)} `
    + `${String(r.tmpl.size).padStart(4)} templates / ${r.chars.size} chars / weight ${r.weight} `
    + `(${(100 * r.weight / totalObs).toFixed(1)}%)`);
if (!ranked.length) {
  console.log('  NONE — no (face, em64, pen, law) in this roster reproduces one target byte-exactly.');
  console.log('  That is a statement about THIS ROSTER (../docs/METHOD.md rule 3). Say what it enumerated:');
  console.log(`    ${FONTS.length} faces, em64 ${AT ? AT.join(',') : `${EMS[0]}..${EMS[1]}`}, all 4096 pens, ${LAW_NAMES.length} laws.`);
} else {
  console.log(`\nconfirm the winner before believing it:  node lab/identify.mjs --targets <hunt> --scan ${ranked[0].font} --ems ${ranked[0].em64}..${ranked[0].em64} --law ${ranked[0].law.replace('~', '')}`);
}
if (REPORT) {
  const p = /^([A-Za-z]:[\\/]|[\\/])/.test(REPORT) ? REPORT : `${LAB}/${REPORT}`;
  writeFileSync(p, JSON.stringify({ targets: TDIR.replace(LAB, 'lab'), ems: AT ?? EMS, fonts: FONTS, hits,
    summary: ranked.map(r => ({ ...r, tmpl: r.tmpl.size, chars: [...r.chars].join('') })) }, null, 1));
  console.log(`wrote ${p}`);
}
