// ftraster.test.js — engine/ftraster.js: a set rasterized ON DEMAND from font
// bytes must be the set somebody generated in advance, record for record. The
// bundle's sets came out of tools/fontgen.mjs (the certified clone, mupdf for
// gids and advances); makeSet reads gids and advances from the font itself,
// so equality here also proves its cmap and hmtx readers.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const F = require('../engine/ftraster.js');
const R = require('../engine/render.js');
const B = require('../engine/blindocr.js');

const REPO = join(__dirname, '..');
const bundlePath = join(REPO, 'assets', 'glyphs', 'glyphs.bin');
const bundle = existsSync(bundlePath) ? B.parseBundleDir(new Uint8Array(readFileSync(bundlePath))) : null;

function sameAsBundle(setName, fontPath, em64) {
  const ref = B.materializeSet(bundle, setName);
  assert.ok(ref, `${setName} is in the bundle`);
  const face = F.loadFace(readFileSync(fontPath));
  const set = F.makeSet(face, { name: 'dyn', sizePx: ref.sizePx, em64 });
  const chars = [...new Set(ref.byPhy.get(0).map(g => g.ch))];
  const missing = set.ensure(chars.join(''));
  assert.deepStrictEqual(missing, [], 'the face has every character of the generated set');
  const idx = R.glyphIndex(set, 0), refIdx = R.glyphIndex(ref, 0);
  let n = 0;
  for (const [k, g] of refIdx) {
    const d = idx.get(k);
    assert.ok(d, `record ${k}`);
    assert.strictEqual(d.adv, g.adv, `advance of ${k}`);
    assert.deepStrictEqual([d.w, d.h, d.dx, d.dy], [g.w, g.h, g.dx, g.dy], `geometry of ${k}`);
    assert.deepStrictEqual(Array.from(d.bytes), Array.from(g.bytes), `bytes of ${k}`);
    assert.deepStrictEqual(Array.from(d.alpha), Array.from(g.alpha), `alpha of ${k}`);
    n++;
  }
  return n;
}

test('TrueType: DejaVu Serif on demand is the generated dejavuserif786 set', { skip: !bundle }, () => {
  const n = sameAsBundle('dejavuserif786', join(REPO, 'fonts', 'DejaVuSerif.ttf'), 786);
  assert.ok(n > 300, `${n} records compared`);
});

// the URW faces ship here as bare .cff (gids from mupdf); Recto serves them as
// .otf — an sfnt around the same CFF table — which is what a browser loads
const otf = join(REPO, '..', 'Recto', 'assets', 'fonts', 'NimbusMonoPS-Regular.otf');
test('OpenType CFF: Nimbus Mono PS .otf on demand is the generated nimbus791 set', { skip: !bundle || !existsSync(otf) }, () => {
  const n = sameAsBundle('nimbus791', otf, 791);
  assert.ok(n > 300, `${n} records compared`);
});

test('ensure is incremental, reports characters the face lacks, and invalidates the index', () => {
  const face = F.loadFace(readFileSync(join(REPO, 'fonts', 'DejaVuSerif.ttf')));
  const set = F.makeSet(face, { sizePx: 16 });
  assert.deepStrictEqual(set.ensure('Ye'), []);
  assert.strictEqual(R.glyphIndex(set, 0).size, 8);           // 2 characters × 4 x-phases
  assert.deepStrictEqual(set.ensure('Yes \u{10FFFF}'), ['\u{10FFFF}']);
  assert.strictEqual(R.glyphIndex(set, 0).size, 12);
  assert.strictEqual(R.advanceOf(set, 'Y'), face.advance(face.gidFor(0x59)) * 16 / face.unitsPerEm);
});

test('a bold-italic face at an off-lattice size lays and renders a line', () => {
  const face = F.loadFace(readFileSync(join(REPO, 'fonts', 'DejaVuSerif.ttf')));
  const set = F.makeSet(face, { sizePx: 13.3333 });            // 10 pt at 96 dpi: em64 = trunc(853.33) = 853
  assert.strictEqual(set.em64, 853);
  set.ensure('Hello');
  const lay = R.layoutLine(set, 'Hello', 20.3, { metrics: { quant: 1000, scale: 1 } });
  assert.deepStrictEqual(lay.missing, []);
  const r = R.renderLine(set, lay.glyphs, 40);
  assert.ok(r.w > 20 && r.gray.some(v => v < 255));
});

test('decoration rectangles come from post / OS/2, top-edge convention', () => {
  const face = F.loadFace(readFileSync(join(REPO, 'fonts', 'DejaVuSerif.ttf')));
  const set = F.makeSet(face, { sizePx: 16 });
  const u = set.decoration('underline', 10, 50, 100), s = set.decoration('strikethrough', 10, 50, 100);
  assert.ok(u.y0 > 100 && u.y1 > u.y0, 'underline sits below the baseline');
  assert.ok(s.y1 < 100 && s.y1 > s.y0, 'strikethrough sits above it');
  assert.strictEqual(u.y1 - u.y0, face.deco.underlineThickness * 16 / face.unitsPerEm);
});

test('renderLine blends decoration rectangles under the page law; layoutLine adds letter spacing', () => {
  const face = F.loadFace(readFileSync(join(REPO, 'fonts', 'DejaVuSerif.ttf')));
  const set = F.makeSet(face, { sizePx: 16 });
  set.ensure('Ye');
  const plain = R.layoutLine(set, 'Ye Ye', 10, { spaceAdv: 5 });
  const spaced = R.layoutLine(set, 'Ye Ye', 10, { spaceAdv: 5, letterSpacing: 1.5 });
  assert.strictEqual(spaced.glyphs[3].penRaw - plain.glyphs[3].penRaw, 4 * 1.5);   // Y, e, space, Y precede it
  assert.strictEqual(spaced.advanceW - plain.advanceW, 4 * 1.5);                     // no trailing spacing
  const u = set.decoration('underline', 10, 10 + plain.advanceW, 40);
  const rect = F.rectCoverage(u.x0, u.y0, u.x1, u.y1);
  const bare = R.renderLine(set, plain.glyphs, 40), r = R.renderLine(set, plain.glyphs, 40, { rects: [rect] });
  assert.ok(r.y0 + r.h >= rect.y0 + rect.h && r.w >= bare.w);
  // a pixel of the rule no glyph touches carries exactly the rule's byte
  const yy = rect.y0 + (rect.h > 1 ? 1 : 0), xx = rect.x0 + 1, a = rect.cov[(yy - rect.y0) * rect.w + 1];
  assert.strictEqual(r.gray[(yy - r.y0) * r.w + (xx - r.x0)], F.byteOfCov(a));
  // a rectangle alone still renders (an underlined run of spaces)
  const only = R.renderLine(set, [], 40, { rects: [rect] });
  assert.strictEqual(only.w, rect.w);
});
