// ---------------------------------------------------------------------------
// export-glyphs.mjs — build assets/glyphs/glyphs.bin, THE glyph dictionary
// (every fontgen set in one binary file), from the committed .npz rasters
// (assets/fonts/, zero corpus pixels). Layout: tools/glyph-bundle.mjs.
// Zero dependencies (own zip/npy parser).
//
//   node tools/export-glyphs.mjs            # (re)build glyphs.bin
//   node tools/export-glyphs.mjs --check    # rebuild in memory and byte-
//         compare against the committed bundle — proves it is a pure
//         derivation of the committed rasters (npm run glyphs-check)
//
// The set manifest lives in tools/glyph-registry.mjs (a new font = new line there).
// Both y-phases are exported (integer and half-px baselines); rasters are
// the raw uint8 MuPDF gray windows plus the true rasterizer alpha derived
// through the set's compositor law (see COV), with (dx, dy) offsets
// relative to the integer pen / baseline and the exact dyadic freetype
// advance. The per-set JSON era (glyphs_*.json) ended 2026-07-16; the one
// parked _OFF experiment keeps its JSON as provenance.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSetFromNpz } from './glyph-bundle.mjs';
import { SETS } from './glyph-registry.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(REPO, 'assets', 'fonts');
const BUNDLE = join(REPO, 'assets', 'glyphs', 'glyphs.bin');

// The name → npz manifest is SETS in tools/glyph-registry.mjs — ONE registry
// for sets, family pools, and rosters (a new font = one line there).


// zip/npy parsing, the alpha law, and payload building are SHARED with the
// readers' direct-.npz loading path — one implementation, glyph-bundle.mjs.
const buildSet = npzBase => buildSetFromNpz(join(FONTS, npzBase));

// Only the 'free' sets are committed (a .npz inherits its face's licence —
// tools/glyph-registry.mjs PROVENANCE). Everything else is regenerated locally
// from your own fonts, so the bundle is built from whatever you actually have
// rather than failing on the first absent set. That makes glyphs.bin a LOCAL
// artifact whose contents depend on your machine — which is why it is
// gitignored, and why --check compares it against your own npz, not a
// committed reference.
const AVAILABLE = SETS.filter(([, npz]) => existsSync(join(FONTS, npz)));
const MISSING = SETS.filter(([, npz]) => !existsSync(join(FONTS, npz)));

function buildBundle() {
  const built = AVAILABLE.map(([name, npz]) => ({ name, npz, ...buildSet(npz) }));
  let dirLen = 8;
  for (const s of built) dirLen += 1 + Buffer.byteLength(s.name) + 1 + Buffer.byteLength(s.npz) + 1 + 8 + 8;
  const dir = [Buffer.from('GBF1')];
  const cnt = Buffer.alloc(4);
  cnt.writeUInt32LE(built.length, 0);
  dir.push(cnt);
  let off = dirLen;
  for (const s of built) {
    const nameB = Buffer.from(s.name), npzB = Buffer.from(s.npz);
    const e = Buffer.alloc(1 + nameB.length + 1 + npzB.length + 1 + 8 + 8);
    let p = 0;
    e.writeUInt8(nameB.length, p); nameB.copy(e, p + 1); p += 1 + nameB.length;
    e.writeUInt8(npzB.length, p); npzB.copy(e, p + 1); p += 1 + npzB.length;
    e.writeUInt8(s.linear ? 1 : 0, p); p += 1;
    e.writeDoubleLE(s.sizePx, p); p += 8;
    e.writeUInt32LE(off, p); e.writeUInt32LE(s.payload.length, p + 4);
    dir.push(e);
    off += s.payload.length;
  }
  return Buffer.concat([...dir, ...built.map(s => s.payload)]);
}

if (MISSING.length)
  console.log(`note  ${MISSING.length} of ${SETS.length} sets are not present locally — ` +
    'see: node tools/glyph-sets.mjs');

const argv = process.argv.slice(2);
const want = buildBundle();
if (argv[0] === '--check') {
  let have = null;
  try { have = readFileSync(BUNDLE); } catch {}
  if (have && have.equals(want)) {
    console.log(`ok    glyphs.bin ⇔ ${AVAILABLE.length} npz sets (${Math.round(want.length / 1024)} KB)`);
  } else {
    console.log(have ? `FAIL  glyphs.bin differs from npz rebuild (${have.length} vs ${want.length} bytes)`
      : 'FAIL  glyphs.bin missing — run: node tools/export-glyphs.mjs');
    process.exit(1);
  }
} else if (argv.length === 0) {
  mkdirSync(dirname(BUNDLE), { recursive: true });
  writeFileSync(BUNDLE, want);
  console.log(`${BUNDLE}: ${AVAILABLE.length} sets, ${Math.round(want.length / 1024)} KB`);
} else {
  console.error('usage: node tools/export-glyphs.mjs [--check]');
  process.exit(1);
}
