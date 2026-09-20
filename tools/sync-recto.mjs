// sync-recto.mjs — push the certified engine into the Recto PDF editor's
// ocr_tool plugin. This repo stays the ONLY place the engine is developed
// (edit -> gate -> sync); Recto's copies are verbatim and never hand-edited
// there. That direction is the whole point: Recto runs the same bytes the
// gate certified, so a read in the browser is the read the gate proved.
//
//   node tools/sync-recto.mjs             # sync (default Recto: ../Recto)
//   node tools/sync-recto.mjs --check     # report stale files, write nothing (exit 1 if stale)
//   node tools/sync-recto.mjs --recto <path-to-Recto>
//   node tools/sync-recto.mjs --allow-partial   # sync a bundle that is missing sets
//
// What syncs (the ocr_tool plugin: web/plugins/ocr_tool/ in the static Recto,
// ocr_tool/static/ocr_tool/ in the Django one — tools/recto-layout.mjs):
//   engine/{core,ocr,ocr-engine,blindocr,render,set-fonts,hypothesis,ftraster}.js -> <plugin>/engine/
//   assets/glyphs/glyphs.bin (THE dictionary) -> <plugin>/glyphs/
//     (+ index.json listing it — Recto's adapter passes the listed files to
//      BlindOCR.loadSets; a bare .bin entry loads every set in the bundle)
// Cache-busters: the static Recto's build stamps every script with its content
// hash, so nothing is rewritten there; in the Django layout the engine
// versions in ocr_tool/tool.py are rewritten to a content hash.
//
// THE PARTIAL-BUNDLE GUARD is this repo's addition, and it is not pedantry.
// glyphs.bin bundles whatever .npz you happen to have locally (most faces are
// not redistributable — see docs/FONTS.md), so a fresh clone builds a bundle
// with 13 of 77 sets. Pushing that into Recto would silently replace the app's
// dictionary with a smaller one: no error, no crash, just a reader that
// quietly stops recognizing faces it used to read. The gate would not catch it
// — it reads through named pools, not the whole bundle. So an incomplete
// bundle refuses to sync, in the same voice the gate uses for a skipped
// document: loudly, naming what is missing, and never as a pass.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS } from './glyph-registry.mjs';
import { readBundle } from './glyph-bundle.mjs';
import { rectoLayout } from './recto-layout.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const o = { check: false, allowPartial: false, recto: resolve(REPO, '..', 'Recto') };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--check') o.check = true;
  else if (a === '--allow-partial') o.allowPartial = true;
  else if (a === '--recto') o.recto = resolve(process.cwd(), process.argv[++i]);
  else { console.error(`unknown arg: ${a}`); process.exit(2); }
}

const layout = rectoLayout(o.recto);
if (!layout) {
  console.error(`no ocr_tool plugin under ${o.recto} — pass --recto <path-to-Recto>`);
  process.exit(2);
}
console.log(`Recto (${layout.kind}) — ${layout.plugin}`);

const ENGINE_FILES = ['core.js', 'ocr.js', 'ocr-engine.js', 'blindocr.js', 'render.js', 'set-fonts.js', 'hypothesis.js', 'ftraster.js'];
const { engineDir, glyphDir } = layout;

const hash8 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 8);
let stale = 0, synced = 0;

function place(src, dst) {
  const want = readFileSync(src);
  const have = existsSync(dst) ? readFileSync(dst) : null;
  if (have && have.equals(want)) return false;
  stale++;
  if (!o.check) { writeFileSync(dst, want); synced++; }
  return true;
}

// 1. engine files (verbatim)
if (!o.check) mkdirSync(engineDir, { recursive: true });
const versions = {};
for (const f of ENGINE_FILES) {
  const src = join(REPO, 'engine', f);
  const changed = place(src, join(engineDir, f));
  versions[f] = hash8(readFileSync(src));
  console.log(`${changed ? (o.check ? 'STALE ' : 'sync  ') : 'same  '} engine/${f}  v=${versions[f]}`);
}

// 2. the glyph bundle + index.json (stale per-set JSONs in Recto are removed)
const sets = ['glyphs.bin'];
const bundlePath = join(REPO, 'assets', 'glyphs', 'glyphs.bin');
if (!existsSync(bundlePath)) {
  console.error('no assets/glyphs/glyphs.bin — run: node tools/export-glyphs.mjs'); process.exit(2);
}

// The guard: the bundle must carry every set the registry names, or Recto ends
// up with a quietly weaker dictionary than the one this repo certified.
const inBundle = readBundle(bundlePath).dir;
const absent = SETS.map(([n]) => n).filter(n => !inBundle.has(n));
if (absent.length) {
  console.error(`\n${absent.length} of ${SETS.length} glyph sets are missing from glyphs.bin:`);
  console.error(`  ${absent.slice(0, 8).join(', ')}${absent.length > 8 ? `, +${absent.length - 8} more` : ''}`);
  console.error('Recto loads every set in the bundle, so syncing this would shrink the');
  console.error('app\'s dictionary without any error. Build the missing sets first:');
  console.error('  node tools/glyph-sets.mjs --plan    (then: node tools/export-glyphs.mjs)');
  if (!o.allowPartial) {
    console.error('Refusing to sync. Override with --allow-partial if that is really what you want.');
    process.exit(2);
  }
  console.error('--allow-partial given: syncing the partial bundle anyway.\n');
}

if (!o.check) mkdirSync(glyphDir, { recursive: true });
for (const f of sets)
  if (place(bundlePath, join(glyphDir, f)))
    console.log(`${o.check ? 'STALE ' : 'sync  '} glyphs/${f}  (${inBundle.size} sets)`);
const index = JSON.stringify(sets, null, 2) + '\n';
const indexPath = join(glyphDir, 'index.json');
if (!existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== index) {
  stale++;
  if (!o.check) { writeFileSync(indexPath, index); synced++; console.log('sync   glyphs/index.json'); }
  else console.log('STALE  glyphs/index.json');
}
if (existsSync(glyphDir))
  for (const f of readdirSync(glyphDir))
    if (f !== 'index.json' && !sets.includes(f)) {
      stale++;
      if (!o.check) { rmSync(join(glyphDir, f)); console.log(`remove glyphs/${f} (stale)`); }
      else console.log(`STALE  glyphs/${f} (should be removed)`);
    }

// 3. Django layout only: cache-buster versions in tool.py (content-hash of each
//    engine file). The static site's build hashes every file itself.
if (layout.toolPy) {
  let py = readFileSync(layout.toolPy, 'utf8');
  const before = py;
  for (const f of ENGINE_FILES)
    py = py.replace(
      new RegExp(`('ocr_tool/engine/${f.replace('.', '\\.')}', 'version': ')v=[^']*(')`),
      `$1v=${versions[f]}$2`);
  if (py !== before) {
    stale++;
    if (!o.check) { writeFileSync(layout.toolPy, py); synced++; console.log('sync   tool.py cache-busters'); }
    else console.log('STALE  tool.py cache-busters');
  }
}

if (o.check) {
  console.log(stale ? `\n${stale} file(s) stale — run: npm run sync:recto` : '\nRecto is in sync');
  process.exit(stale ? 1 : 0);
}
console.log(synced ? `\nsynced ${synced} file(s) -> ${PLUGIN}` : '\nnothing to do — Recto already in sync');
