// ladder-bench.mjs — time Recto's ladder (engine/blindocr.js readPageAuto)
// on one cached page, in Node, exactly as the app runs it: every set of the
// bundle unless --sets names a list, colour pages through Engine.colourInk,
// each pass timed. This is the bench a speed change is measured with; the
// app itself has no clock.
//
//   node tools/ladder-bench.mjs --pdf X.pdf [--page N] [--sets a,b,c | --default]
//        [--bundle path/to/glyphs.bin] [--json out.json]
//
// --default = blindocr's DEFAULT_SETS (22); the app (Recto's index.json is a
// bare glyphs.bin) loads ALL sets. BR_PROF=1 adds the per-sweep probe profile
// under each pass.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { materializeSet, readBundle, BUNDLE_PATH } from './glyph-bundle.mjs';
import { cacheDirFor, pageFile } from './raster-cache.mjs';
const require = createRequire(import.meta.url);
const B = require('../engine/blindocr.js'), E = require('../engine/ocr-engine.js');

const o = { pdf: null, page: 1, sets: null, dflt: false, bundle: BUNDLE_PATH, json: null, hint: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--pdf') o.pdf = resolve(process.cwd(), next());
  else if (a === '--page') o.page = +next();
  else if (a === '--sets') o.sets = next().split(',');
  else if (a === '--default') o.dflt = true;
  else if (a === '--bundle') o.bundle = resolve(process.cwd(), next());
  else if (a === '--json') o.json = resolve(process.cwd(), next());
  else if (a === '--hint') { const [t, q, u] = next().split('|'); o.hint = { tol: +t, quant: q === '1', union: u === '1' }; }
  else throw new Error(`unknown arg ${a}`);
}
if (!o.pdf) throw new Error('--pdf required');
const DEFAULT_SETS = ['times16', 'timesbd16', 'timesi16', 'tnr8_16', 'arial16', 'georgia16', 'cour13',
  'timeslin16', 'timesbdlin16', 'timesilin16', 'tnr8lin16', 'tnr8lin10',
  'tahoma832', 'tahomabd832', 'tahoma853', 'tahomabd853', 'tahoma1024', 'tahomabd1024', 'segoeui853', 'segoeuib853',
  'dejavuserif786', 'dejavuserif786law'];
const bundle = readBundle(o.bundle);
const names = o.sets ?? (o.dflt ? DEFAULT_SETS : [...bundle.dir.keys()]);
const t0 = Date.now();
const sets = names.filter(n => bundle.dir.has(n)).map(n => materializeSet(n, null, o.bundle));
console.log(`${sets.length} sets loaded in ${Date.now() - t0} ms (${o.bundle})`);

const { dir } = cacheDirFor(o.pdf);
const raw = gunzipSync(readFileSync(join(dir, pageFile(o.page))));
const h = new Uint32Array(raw.buffer, raw.byteOffset, 4), mode = h[1], W = h[2], H = h[3];
let page;
const t1 = Date.now();
if (mode === 1) page = { w: W, h: H, gray: Float32Array.from(new Uint8Array(raw.buffer, raw.byteOffset + 16, W * H)) };
else if (mode === 4) {
  const c = E.colourInk(W, H, new Uint8Array(raw.buffer, raw.byteOffset + 16, W * H * 3), 3);
  page = { w: W, h: H, gray: Float32Array.from(c.gray), converted: c.converted };
} else throw new Error(`mode ${mode} not handled here`);
console.log(`page ${o.page}: ${W}x${H} mode ${mode}, colour convert ${Date.now() - t1} ms`);

const key = p => `${p.tol}|${p.quant ? 1 : 0}|${p.union ? 1 : 0}`;
const passLog = [];
const onPass = (pass, r, ms) => {
  const fails = r.lines.reduce((s, L) => s + L.fails.length, 0) + r.lines.filter(L => !L.set && !L.fragOnly).length;
  const glyphs = r.lines.reduce((s, L) => s + L.glyphs.length, 0);
  const unread = r.lines.filter(L => !L.set && !L.fragOnly).length;
  passLog.push({ pass: key(pass), ms, glyphs, fails, unread, lines: r.lines.length });
  console.log(`  pass ${key(pass).padEnd(6)} ${String(ms).padStart(6)} ms  glyphs ${glyphs} fails ${fails} (unread bands ${unread}) lines ${r.lines.length}`);
};
const t2 = Date.now();
const { res, pass } = await B.readPageAuto(page, sets, { passHint: o.hint, onPass });
const total = Date.now() - t2;
const fails = res.lines.reduce((s, L) => s + L.fails.length, 0) + res.lines.filter(L => !L.set && !L.fragOnly).length;
const glyphs = res.lines.reduce((s, L) => s + L.glyphs.length, 0);
console.log(`ladder ${total} ms, winner ${key(pass)}: ${glyphs} glyphs, ${fails} fails, ${res.lines.length} lines`);
if (o.json) writeFileSync(o.json, JSON.stringify({ pdf: o.pdf, page: o.page, sets: sets.map(s => s.name), total, winner: key(pass), glyphs, fails, passes: passLog,
  lines: res.lines.map(L => ({ baseline: L.baseline, top: L.top, bot: L.bot, font: L.font ?? null, fails: L.fails.length, text: L.text })) }, null, 1));
