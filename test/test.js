// ---------------------------------------------------------------------------
// test.js — headless smoke tests for the DOM-free core (core.js).
//
// Dependency-free: only Node's built-in node:test + node:assert. No npm
// install, no PDF, no browser, no assets. Run with:
//
//     node test.js          (or:  node --test)
//
// It exits non-zero if anything fails. (The template-matching pixel-math
// tests left with the legacy grid/template path, removed 2026-07-13.)
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const core = require('../engine/core.js');

test('charToStem / stemToChar round-trips', () => {
  // A–Z uppercase → <letter>_UPPER and back
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const ch = String.fromCharCode(c);
    assert.strictEqual(core.charToStem(ch), ch + '_UPPER');
    assert.strictEqual(core.stemToChar(ch + '_UPPER'), ch);
  }

  // digits 0–9 map to themselves
  for (let d = 0; d <= 9; d++) {
    const ch = String(d);
    assert.strictEqual(core.charToStem(ch), ch);
    assert.strictEqual(core.stemToChar(ch), ch);
  }

  // lowercase letters map to themselves
  for (let c = 'a'.charCodeAt(0); c <= 'z'.charCodeAt(0); c++) {
    const ch = String.fromCharCode(c);
    assert.strictEqual(core.charToStem(ch), ch);
    assert.strictEqual(core.stemToChar(ch), ch);
  }

  // the symbol map round-trips both ways
  for (const [stem, ch] of Object.entries(core.STEM_TO_CHAR)) {
    assert.strictEqual(core.charToStem(ch), stem, `charToStem(${ch})`);
    assert.strictEqual(core.stemToChar(stem), ch, `stemToChar(${stem})`);
  }

  // a numbered variant still resolves to its base character
  assert.strictEqual(core.stemToChar('a_3'), 'a');
  assert.strictEqual(core.stemToChar('B_UPPER_2'), 'B');
});

test('makeRowBands produces rowCount bands with correct y0/y1', () => {
  const bands = core.makeRowBands(40, 11, 15, 65);
  assert.strictEqual(bands.length, 65);
  assert.deepStrictEqual(bands[0], { y0: 40, y1: 51 });
  assert.deepStrictEqual(bands[1], { y0: 55, y1: 66 });
  assert.deepStrictEqual(bands[64], { y0: 40 + 64 * 15, y1: 40 + 64 * 15 + 11 });

  // a second, different Config to be sure the formula isn't hard-coded
  const other = core.makeRowBands(0, 10, 10, 3);
  assert.deepStrictEqual(other, [
    { y0: 0, y1: 10 }, { y0: 10, y1: 20 }, { y0: 20, y1: 30 },
  ]);
});

test('gray maps a known RGBA buffer to the expected grayscale values', () => {
  // white, black, and (30,60,90) → averaged channels; alpha is ignored
  const data = new Uint8ClampedArray([
    255, 255, 255, 255,
    0, 0, 0, 0,
    30, 60, 90, 255,
  ]);
  const px = core.gray(data, 3);
  assert.strictEqual(px.length, 3);
  assert.strictEqual(px[0], 255);
  assert.strictEqual(px[1], 0);
  assert.strictEqual(px[2], 60); // (30 + 60 + 90) / 3
});

// ---------------------------------------------------------------------------
// Registry drift net (tools/glyph-registry.mjs is THE source of truth for
// sets/pools/rosters). The browser app cannot import Node modules, so its
// DEFAULT_SETS is a literal in engine/blindocr.js — this test fails the moment
// the two lists (or a pool's set names, or the npz manifest) drift.
// ---------------------------------------------------------------------------

// Read the set names out of the app's DEFAULT_SETS literal. A regex over the
// array body cannot do this: comments live inside the literal, so an
// apostrophe in one ("EFTA01150379's face") reads as a set name and a ']' in
// one ends the array early. Scan instead — skip // and /* */ comments, collect
// quoted strings, stop at the closing bracket. Returns null if the literal or
// its terminator is missing.
function parseDefaultSets(src) {
  const start = src.indexOf('const DEFAULT_SETS = [');
  if (start < 0) return null;
  const names = [];
  for (let i = src.indexOf('[', start) + 1; i < src.length;) {
    const c = src[i], next = src[i + 1];
    if (c === ']') return names;
    if (c === '/' && next === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) return null;                    // unterminated line comment
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return null;                  // unterminated block comment
      i = end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const end = src.indexOf(c, i + 1);         // set names carry no escapes
      if (end < 0) return null;
      names.push(src.slice(i + 1, end));
      i = end + 1;
    } else i++;
  }
  return null;                                   // never closed
}

test('DEFAULT_SETS parser ignores comments inside the literal', () => {
  const src = [
    "const DEFAULT_SETS = ['a16',       // EFTA01150379's face [see notes]",
    "  /* block ' with ] too */ 'b16'];",
  ].join('\n');
  assert.deepStrictEqual(parseDefaultSets(src), ['a16', 'b16']);
  assert.strictEqual(parseDefaultSets('const OTHER = [];'), null);
});

// The registry landed in step 3, so this is live. The guard stays: it costs a
// line and keeps the suite runnable if the registry is ever absent.
const REGISTRY = require('node:path').join(__dirname, '..', 'tools', 'glyph-registry.mjs');
const noRegistry = !require('node:fs').existsSync(REGISTRY);

test('glyph registry: rosters, pools and npz manifest agree',
  { skip: noRegistry && 'tools/glyph-registry.mjs absent' },
  async () => {
  const { readFileSync, existsSync } = require('node:fs');
  const { join } = require('node:path');
  const REPO = join(__dirname, '..');
  const { SETS, POOLS, BATCH_LADDER, APP_ROSTER, PROVENANCE, poolSetNames } =
    await import('../tools/glyph-registry.mjs');
  const names = new Set(SETS.map(([n]) => n));

  // every set records where its pixels came from
  for (const [n] of SETS)
    assert.ok(PROVENANCE[n], `${n}: no PROVENANCE entry — record its source before adding it`);
  for (const n of Object.keys(PROVENANCE))
    assert.ok(names.has(n), `PROVENANCE has "${n}" but SETS does not`);

  // Only the 'free' class may be committed (a .npz inherits its face's
  // licence). Assert exactly that: every free set present, and no assertion at
  // all about the rest — those are regenerated locally from your own fonts and
  // are legitimately absent on a fresh clone.
  for (const [n, npz] of SETS)
    if (PROVENANCE[n].src === 'free')
      assert.ok(existsSync(join(REPO, 'assets', 'fonts', npz)),
        `${n}: assets/fonts/${npz} missing — 'free' sets ship with the repo`);

  // every pool references only known sets; ladder references only known pools
  for (const [pn, pool] of Object.entries(POOLS))
    for (const s of poolSetNames(pool))
      assert.ok(names.has(s), `pool ${pn}: unknown set "${s}"`);
  for (const r of BATCH_LADDER) {
    const pn = typeof r === 'string' ? r : r.pool;
    assert.ok(POOLS[pn], `BATCH_LADDER: unknown pool "${pn}"`);
  }
  for (const s of APP_ROSTER)
    assert.ok(names.has(s), `APP_ROSTER: unknown set "${s}"`);

  // the app's literal DEFAULT_SETS must equal APP_ROSTER exactly
  const src = readFileSync(join(REPO, 'engine', 'blindocr.js'), 'utf8');
  const appSets = parseDefaultSets(src);
  assert.ok(appSets, 'DEFAULT_SETS literal not found in engine/blindocr.js');
  assert.deepStrictEqual(appSets, APP_ROSTER,
    'engine/blindocr.js DEFAULT_SETS drifted from registry APP_ROSTER');
});

// engine/set-fonts.js is generated from the registry's PROVENANCE and synced
// into Recto with the engine: it must be current, and name a face (or null,
// for page cuts) for every set.
test('engine/set-fonts.js is generated from the registry and covers every set',
  { skip: noRegistry && 'tools/glyph-registry.mjs absent' },
  async () => {
  const { readFileSync } = require('node:fs');
  const { buildSetFonts, OUT } = await import('../tools/export-set-fonts.mjs');
  assert.strictEqual(readFileSync(OUT, 'utf8'), buildSetFonts(),
    'engine/set-fonts.js is stale — run: node tools/export-set-fonts.mjs');
  const { SETS, PROVENANCE } = await import('../tools/glyph-registry.mjs');
  const table = require('../engine/set-fonts.js');
  for (const [n] of SETS) {
    assert.ok(n in table, `set-fonts.js lacks ${n}`);
    if (PROVENANCE[n].src === 'corpus') assert.strictEqual(table[n], null, `${n} is a page cut: no face`);
    else assert.ok(table[n] && table[n].family, `${n} has no family`);
  }
});

// ---------------------------------------------------------------------------
// The lab boundary. `ftclone/` is a top-level package precisely so that both
// halves of the repo can use it without either importing the other: the reader
// must never depend on hunt tooling, and hunt tooling must never be pinned by
// the reader's refactors. That rule was aspirational in the old repo — where
// tools/fontgen.mjs imported ../ocr/tools/ftclone.mjs — so assert it here
// rather than write it down.
// ---------------------------------------------------------------------------
test('no root <-> lab imports', () => {
  const { readdirSync } = require('node:fs');
  const files = f => { try { return readdirSync(join(REPO, f)); } catch { return []; } };
  const src = (dir, f) => readFileSync(join(REPO, dir, f), 'utf8');

  for (const f of files('lab').filter(f => f.endsWith('.mjs')))
    for (const [, spec] of src('lab', f).matchAll(/\bfrom\s+'([^']+)'/g))
      assert.ok(!/^\.\.\/(tools|engine|test)\//.test(spec),
        `lab/${f} imports "${spec}" — the lab may only reach into ftclone/`);

  for (const dir of ['tools', 'engine', 'ftclone'])
    for (const f of files(dir).filter(f => /\.(mjs|js)$/.test(f)))
      for (const [, spec] of src(dir, f).matchAll(/\bfrom\s+'([^']+)'|\brequire\('([^']+)'\)/g))
        assert.ok(!/(^|\/)lab\//.test(spec ?? ''),
          `${dir}/${f} imports "${spec}" — the reader must not depend on the lab`);
});
