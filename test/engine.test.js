// ---------------------------------------------------------------------------
// engine.test.js — fast, isolated unit tests for the engine primitives in
// src/ocr-engine.js (detectObjects, findBands, quantMap, anchorGroups,
// scanLine, spaceCalib, readPage).
//
// Dependency-free and corpus-free: synthetic glyph sets and pages are
// fabricated in memory and rendered through the SAME proven blend law the
// scanner checks (dst = (dst·(256−e))>>8, e = cov + (cov>>7)), so every
// assertion exercises the real acceptance physics. Runs in milliseconds:
//
//     node test/engine.test.js
//
// This is the quick "did I break something" signal for engine edits; the
// full corpus gate (npm run gate) and app test remain the final
// certification. Glyph records here mirror the exact shape
// tools/glyph-bundle.mjs materializeSet produces ({ch, adv, phx, w, h, dx,
// dy, bytes, alpha, ink, inkC/R/B/A, inkLeft}).
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine/ocr-engine.js');

// ---- synthetic glyph / page helpers ----

// pattern rows: '#' = full ink (alpha 255), '+' = half ink (alpha 128),
// '.' = blank. Page byte over white is gb = (255·(256−e))>>8 by the law.
const ALPHA = { '#': 255, '+': 128, '~': 55, '.': 0 };
const gbOf = a => { const e = a + (a >> 7); return (255 * (256 - e)) >> 8; };

function makeGlyph(ch, pattern, { dy, adv, dx = 0, phx = 0 }) {
  const h = pattern.length, w = pattern[0].length;
  const bytes = new Uint8Array(w * h).fill(255);
  const alpha = new Uint8Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const a = ALPHA[pattern[r][c]];
      if (a) { alpha[r * w + c] = a; bytes[r * w + c] = gbOf(a); }
    }
  // ink in the loader's column-major order (candidate order is significant)
  const ink = [];
  let inkLeft = w;
  for (let c = 0; c < w; c++)
    for (let r = 0; r < h; r++)
      if (bytes[r * w + c] < 255) { ink.push(r * w + c); if (c < inkLeft) inkLeft = c; }
  const inkC = new Int16Array(ink.length), inkR = new Int16Array(ink.length),
    inkB = new Uint8Array(ink.length), inkA = new Uint8Array(ink.length);
  for (let k = 0; k < ink.length; k++) {
    inkC[k] = ink[k] % w; inkR[k] = (ink[k] / w) | 0;
    inkB[k] = bytes[ink[k]]; inkA[k] = alpha[ink[k]];
  }
  return { ch, adv, phx, w, h, dx, dy, bytes, alpha, ink, inkC, inkR, inkB, inkA, inkLeft };
}

function makeSet(name, glyphs, phy = 0) {
  let maxAsc = 0, maxDesc = 0;
  for (const g of glyphs) {
    maxAsc = Math.max(maxAsc, -g.dy);
    maxDesc = Math.max(maxDesc, g.dy + g.h);
  }
  return { name, sizePx: 16, linear: false, fontFile: name,
    byPhy: new Map([[phy, glyphs]]), maxAsc, maxDesc };
}

const makePage = (w, h) => ({ w, h, gray: new Uint8Array(w * h).fill(255) });
const zeroMask = page => new Uint8Array(page.w * page.h);

// composite a glyph onto the page through the blend law (over white this
// reproduces the glyph's bytes exactly — same construction as the renderer)
function drawGlyph(page, g, pen, baseline) {
  for (let k = 0; k < g.inkC.length; k++) {
    const x = pen + g.dx + g.inkC[k], y = baseline + g.dy + g.inkR[k];
    const a = g.inkA[k], e = a + (a >> 7);
    page.gray[y * page.w + x] = (page.gray[y * page.w + x] * (256 - e)) >> 8;
  }
}

// the shared 5-row test font: three distinct letters, all ink on/above the
// baseline (dy = −5), advance 6 px
const PAT = {
  A: ['.##.', '#..#', '####', '#..#', '#..#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
};
function abcSet() {
  return makeSet('synth', Object.entries(PAT).map(([ch, p]) =>
    makeGlyph(ch, p, { dy: -5, adv: 6 })));
}
function drawWord(page, set, word, pens, baseline) {
  const byCh = new Map(set.byPhy.get(0).map(g => [g.ch, g]));
  [...word].forEach((ch, i) => drawGlyph(page, byCh.get(ch), pens[i], baseline));
}

// ---- quantMap ----

test('quantMap: nearest available gray, ties toward darker, fixpoints', () => {
  const page = makePage(4, 1);
  page.gray.set([0, 100, 255, 255]);
  const Q = E.quantMap(page);
  assert.strictEqual(Q[0], 0);        // available bytes are fixpoints
  assert.strictEqual(Q[100], 100);
  assert.strictEqual(Q[255], 255);
  assert.strictEqual(Q[49], 0);       // nearest
  assert.strictEqual(Q[51], 100);
  assert.strictEqual(Q[50], 0);       // tie → darker
  assert.strictEqual(Q[200], 255);    // |200−100|=100 > |200−255|=55
});

// ---- findBands ----

test('findBands: blank-row-separated ink bands; mask pixels are invisible', () => {
  const page = makePage(20, 20);
  for (const y of [3, 4, 5, 10, 11, 12]) page.gray[y * 20 + 7] = 0;
  const mask = zeroMask(page);
  assert.deepStrictEqual(E.findBands(page, mask), [[3, 6], [10, 13]]);
  for (const y of [10, 11, 12]) mask[y * 20 + 7] = 1;   // masked → band gone
  assert.deepStrictEqual(E.findBands(page, mask), [[3, 6]]);
});

// ---- detectObjects ----

test('detectObjects: text-sized ink produces NO objects', () => {
  const page = makePage(60, 30);
  drawWord(page, abcSet(), 'ABC', [10, 16, 22], 20);
  const { objects, mask } = E.detectObjects(page);
  assert.strictEqual(objects.length, 0);
  assert.ok(mask.every(v => v === 0));
});

test('detectObjects: dark horizontal rule (≥40px run) with ±2-row mask pad', () => {
  const page = makePage(80, 30);
  for (let x = 5; x < 56; x++) page.gray[10 * 80 + x] = 0;
  const { objects, mask } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  const o = objects[0];
  assert.strictEqual(o.type, 'rule');
  assert.deepStrictEqual([o.y0, o.y1, o.x0, o.x1], [10, 11, 5, 56]);
  assert.ok(mask[8 * 80 + 30]);   // rules pad ±2 rows
  assert.ok(mask[12 * 80 + 30]);
  assert.strictEqual(mask[13 * 80 + 30], 0);
});

test('detectObjects: near-constant LIGHT run ≥40px is a rule too', () => {
  const page = makePage(80, 30);
  for (let x = 5; x < 50; x++) page.gray[10 * 80 + x] = 200;
  const { objects } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  assert.strictEqual(objects[0].type, 'rule');
});

test('detectObjects: vertical rule down a column', () => {
  const page = makePage(80, 60);
  for (let y = 5; y < 55; y++) page.gray[y * 80 + 70] = 0;
  const { objects } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  const o = objects[0];
  assert.strictEqual(o.type, 'vrule');
  assert.deepStrictEqual([o.x0, o.x1, o.y0, o.y1], [70, 71, 5, 55]);
});

test('detectObjects: small solid redaction box (10–39px runs, ≥8 rows)', () => {
  const page = makePage(80, 60);
  for (let y = 30; y < 42; y++)
    for (let x = 10; x < 30; x++) page.gray[y * 80 + x] = 0;
  const { objects, mask } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  const o = objects[0];
  assert.strictEqual(o.type, 'box');
  assert.deepStrictEqual([o.y0, o.y1, o.x0, o.x1], [30, 42, 10, 30]);
  assert.ok(mask[35 * 80 + 20]);          // interior masked
  assert.strictEqual(mask[35 * 80 + 40], 0);          // beside it: not masked
});

test('detectObjects: wide solid box goes through mode-voted segmentation', () => {
  const page = makePage(100, 60);
  for (let y = 20; y < 34; y++)
    for (let x = 10; x < 70; x++) page.gray[y * 100 + x] = 0;
  const { objects } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1);
  const o = objects[0];
  assert.strictEqual(o.type, 'box');
  assert.deepStrictEqual([o.y0, o.y1, o.x0, o.x1], [20, 34, 10, 70]);
});

// Redaction-block absorption (2026-07-26) — three separate ways a solid box
// used to escape the mask. Each case FAILS on the pre-fix engine.

test('detectObjects: small box survives one glyph-bridged ≥40px row', () => {
  // A glyph one blank column off the right edge bridges that row's dark run
  // past 40 (the rule bridges ≤1px gaps), putting the row in `rows[]` — which
  // used to make the box-extent pass replace the 12-row box with a 1-row rule.
  const page = makePage(80, 60);
  for (let y = 30; y < 42; y++)
    for (let x = 10; x < 48; x++) page.gray[y * 80 + x] = 0;
  for (let x = 49; x < 52; x++) page.gray[35 * 80 + x] = 0;   // the bridging glyph
  const { objects, mask } = E.detectObjects(page);
  const box = objects.find(o => o.type === 'box');
  assert.ok(box, 'the box must survive as a box');
  assert.deepStrictEqual([box.y0, box.y1, box.x0, box.x1], [30, 42, 10, 48]);
  assert.ok(mask[31 * 80 + 20]);          // top of box masked
  assert.ok(mask[41 * 80 + 20]);          // bottom of box masked
});

test('detectObjects: a box row fused to a touching glyph still holds the stack', () => {
  // Glyph TOUCHING the edge (0 gap) makes one strict run ≥40, which used to
  // drop out of shortRuns entirely and split the stack into two short ones.
  const page = makePage(80, 60);
  for (let y = 30; y < 48; y++)
    for (let x = 10; x < 48; x++) page.gray[y * 80 + x] = 0;
  for (let x = 48; x < 52; x++) page.gray[40 * 80 + x] = 0;   // touches the edge
  const { objects, mask } = E.detectObjects(page);
  const box = objects.find(o => o.type === 'box');
  assert.ok(box);
  assert.deepStrictEqual([box.y0, box.y1], [30, 48], 'stack must span the whole box');
  assert.ok(mask[47 * 80 + 20]);          // bottom rows still masked
});

test('detectObjects: stacked boxes do not split each other AA-padding vote', () => {
  // Two boxes sharing a boundary row: that row is BOTH boxes' AA edge, so its
  // composite value differs across the overlap and the constancy vote failed.
  // The lower box must still pad over the row it solely owns.
  const page = makePage(120, 80);
  const put = (y0, y1, x0, x1, v) => { for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) page.gray[y * 120 + x] = v; };
  put(20, 40, 40, 100, 0);                            // upper box
  put(41, 60, 10, 70, 0);                             // lower box, offset left
  put(40, 41, 10, 40, 187);                           // lower box's own AA row
  put(40, 41, 40, 100, 112);                          // both boxes' AA composited
  const { mask } = E.detectObjects(page);
  assert.ok(mask[40 * 120 + 20], 'shared AA row must be masked');
  assert.ok(mask[40 * 120 + 60]);
});

// Glyphs fused to a redaction bar (2026-09-03). The pixels are EFTA00434905
// p1 y90 (`To: "…" <…`), transcribed: a 16px Times '"' whose last column
// sits against the bar's own AA edge column, so on one row the two are
// strictly contiguous and on the others a ≤1px gap bridges them into the
// bar's dark run. Pre-fix those rows split the box into 1–2 row slices,
// typed RULE and padded ±2 rows — the quote vanished under the mask and the
// line read `To: < >`. FAILS on the pre-fix engine.

test('detectObjects: a quote glued to a bar keeps its pixels, the bar keeps its body', () => {
  const W = 140, page = makePage(W, 60);
  const put = (y0, y1, x0, x1, v) => { for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) page.gray[y * W + x] = v; };
  put(20, 37, 40, 100, 0);                            // the bar body
  put(20, 37, 39, 40, 119);                           // its dark AA edge (as on the page)
  put(20, 37, 100, 101, 210);                         // its light AA edge
  put(19, 20, 40, 100, 187); put(37, 38, 40, 100, 153); // top/bottom AA rows
  page.gray[19 * W + 39] = 219; page.gray[37 * W + 39] = 201;   // AA corners
  page.gray[19 * W + 100] = 243; page.gray[37 * W + 100] = 237;
  // the opening quote (times16 '"' phx 0) against the dark edge, the closing
  // one (phx ¼) against the light edge — a one-sided bridge is a burst the
  // segmentation already absorbs; the page has both, and that is the split
  const open = [[90, 171, 248, 68, 195], [21, 113, 236, 0, 149],
    [59, 156, 255, 21, 177], [105, 203, 255, 68, 226], [177, 246, 255, 161, 255]];
  const close = [[143, 119, 255, 111, 146], [85, 49, 255, 43, 84],
    [123, 91, 255, 85, 112], [170, 139, 255, 133, 162], [223, 201, 255, 197, 220]];
  open.forEach((row, r) => row.forEach((v, c) => { page.gray[(24 + r) * W + 34 + c] = v; }));
  close.forEach((row, r) => row.forEach((v, c) => { page.gray[(24 + r) * W + 101 + c] = v; }));
  const { objects, mask } = E.detectObjects(page);
  assert.strictEqual(objects.length, 1, 'one object, not slices');
  const o = objects[0];
  assert.strictEqual(o.type, 'box');
  assert.deepStrictEqual([o.y0, o.y1, o.x0, o.x1], [19, 38, 39, 100]);
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 5; c++) {
      assert.strictEqual(mask[(24 + r) * W + 34 + c], 0, `quote pixel (${34 + c},${24 + r}) must stay readable`);
      assert.strictEqual(mask[(24 + r) * W + 101 + c], 0, `quote pixel (${101 + c},${24 + r}) must stay readable`);
    }
  assert.ok(mask[25 * W + 39]);           // the bar's edges are the bar's
  assert.ok(mask[25 * W + 100]);
});

test('detectObjects: a glyph tip fused to a bar edge does not cost the edge its padding', () => {
  // The right bar of the same line: a '<' whose tip is dark on two rows of
  // the bar's light AA edge column split the box at those rows, and the
  // lower slice's 7-row constancy vote over that column then failed (2 of 7
  // rows are the glyph's) — the bar's own AA edge stayed unmasked as 6 px of
  // residual on an otherwise byte-exact line. One box, one 19-row vote.
  const W = 140, page = makePage(W, 60);
  const put = (y0, y1, x0, x1, v) => { for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) page.gray[y * W + x] = v; };
  put(20, 37, 40, 100, 0);
  put(20, 37, 39, 40, 180);                           // light AA edge column
  put(19, 20, 40, 100, 187); put(37, 38, 40, 100, 153);
  page.gray[19 * W + 39] = 235; page.gray[37 * W + 39] = 225;   // AA corners
  page.gray[32 * W + 37] = 92; page.gray[32 * W + 38] = 106; page.gray[32 * W + 39] = 158;
  page.gray[33 * W + 38] = 223; page.gray[33 * W + 39] = 144;   // the tip, two rows
  const { objects, mask } = E.detectObjects(page);
  assert.strictEqual(objects.filter(o => o.type === 'box').length, 1, 'one box, not two slices');
  const o = objects.find(o => o.type === 'box');
  assert.deepStrictEqual([o.y0, o.y1, o.x0, o.x1], [19, 38, 40, 100]);
  for (let y = 20; y < 37; y++)
    assert.ok(mask[y * W + 39], `AA edge (39,${y}) must be padded`);
  assert.strictEqual(mask[32 * W + 38], 0);           // the tip itself stays readable
});

test('detectObjects: stacked boxes of different widths keep the wider protrusion', () => {
  // The column profile clips only what is dark on fewer than 8 rows; a wider
  // box under a narrower one is dark on all of its own rows and must still
  // come out of the segmentation as its own full-width box.
  const W = 160, page = makePage(W, 80);
  const put = (y0, y1, x0, x1, v) => { for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) page.gray[y * W + x] = v; };
  put(20, 38, 40, 100, 0);                            // upper, narrow
  put(38, 56, 40, 140, 0);                            // lower, wider
  const { objects, mask } = E.detectObjects(page);
  const boxes = objects.filter(o => o.type === 'box').sort((a, b) => a.y0 - b.y0);
  assert.strictEqual(boxes.length, 2);
  assert.deepStrictEqual([boxes[0].y0, boxes[0].y1, boxes[0].x0, boxes[0].x1], [20, 38, 40, 100]);
  assert.deepStrictEqual([boxes[1].y0, boxes[1].y1, boxes[1].x0, boxes[1].x1], [38, 56, 40, 140]);
  assert.ok(mask[45 * W + 120], 'the protrusion is masked');
  assert.strictEqual(mask[25 * W + 120], 0);
});

test("scanLine: the pieces an underline leaves at a descender are the rule's own, not a □", () => {
  // "ABC" on an underline that a descender broke at x 27–31: the 17-px
  // piece before the break is ink no glyph explains — with the rules known
  // it is absorbed and the line stays clean
  // the set needs a descender so the scan window reaches the underline row
  const set = makeSet('synth', [...abcSet().byPhy.get(0), makeGlyph('p', ['#..', '#..', '##.', '#..', '#..', '#..'], { dy: -3, adv: 4 })]);
  const page = makePage(140, 30);
  drawWord(page, set, 'ABC', [10, 16, 22], 20);
  for (let x = 10; x < 27; x++) page.gray[22 * 140 + x] = 0;
  page.gray[22 * 140 + 27] = 181; page.gray[22 * 140 + 28] = 238; page.gray[22 * 140 + 29] = 0;
  page.gray[22 * 140 + 30] = 195; page.gray[22 * 140 + 31] = 211;
  for (let x = 32; x < 120; x++) page.gray[22 * 140 + x] = 0;
  const det = E.detectObjects(page);
  const rules = det.objects.filter(o => o.type === 'rule');
  assert.ok(rules.length >= 1 && rules[0].x0 >= 32, 'the long piece is a rule, the short one is not');
  const bare = E.scanLine(page, det.mask, set, 0, 20, 0, 140);
  assert.ok(bare.fails.length >= 1, 'without the rules the piece is a fail');
  const L = E.scanLine(page, det.mask, set, 0, 20, 0, 140, Infinity, Infinity, 0, null, null, null, null, null, { rules });
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'B', 'C']);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

test("scanLine: a rule's pieces on a page that cannot hold their byte are retired, not spun on", () => {
  // The same broken underline, on a palettized page whose palette has no 0:
  // the absorbed byte is never accepted, so only an explicit retire takes the
  // piece's columns off the books. The rule branch forgot the ones past
  // col+2, and the scan came back to them for good (EFTA00039989 p4: any set,
  // one probe, no end — a worker's whole heap in flood-cache steps). A scan
  // that returns at all is the test; node:test has no clock for one that does not.
  const set = makeSet('synth', [...abcSet().byPhy.get(0), makeGlyph('p', ['#..', '#..', '##.', '#..', '#..', '#..'], { dy: -3, adv: 4 })]);
  const page = makePage(140, 30);
  for (let x = 10; x < 27; x++) page.gray[22 * 140 + x] = 0;
  for (let x = 32; x < 120; x++) page.gray[22 * 140 + x] = 0;
  const det = E.detectObjects(page);
  const rules = det.objects.filter(o => o.type === 'rule');
  const Q = new Uint8Array(256).map((_, v) => (v < 8 ? 8 : v));          // no entry below 8: a 0 on the page is nobody's fixpoint
  const L = E.scanLine(page, det.mask, set, 0, 20, 0, 140, Infinity, Infinity, 0, Q, null, null, null, null, { rules });
  assert.strictEqual(L.glyphs.length, 0);
  assert.strictEqual(L.fails.length, 0, "the piece is the rule's own: absorbed, no □");
});

test("scanLine: a dot resting on an underline is read — a byte that sits in the rule's pad as on white paper is evidence", () => {
  // "AB.C" underlined as a browser underlines a link: the rule one row under
  // the glyphs' feet. Letters are rows 15–19, the dot rows 17–19, the rule row
  // 20, its ±2 pad rows 18–19 and 21–22: the letters keep three open rows of
  // five, the dot ONE of three — 2 open pixels of 6, as the real one has 2 of
  // 9. Masked cells were no evidence either way, so the dot had too little
  // and was refused: every underlined "gmail.com" of the corpus lost its dot
  // to this, and the line its certificate.
  const dot = makeGlyph('.', ['##', '##', '##'], { dy: -3, adv: 4 });
  const set = makeSet('synth', [...abcSet().byPhy.get(0), dot]);
  const draw = () => {
    const page = makePage(140, 30);
    drawWord(page, set, 'AB', [10, 16], 20);
    drawGlyph(page, dot, 22, 20);
    drawWord(page, set, 'C', [26], 20);
    for (let x = 6; x < 70; x++) page.gray[20 * 140 + x] = 0;
    return page;
  };
  const read = page => {
    const det = E.detectObjects(page);
    const rules = det.objects.filter(o => o.type === 'rule');
    assert.deepStrictEqual([rules[0].y0, rules[0].y1], [20, 21]);
    assert.ok(det.mask[19 * 140 + 22] && det.mask[18 * 140 + 22] && !det.mask[17 * 140 + 22], "rows 18–19 are the rule's pad, 17 is open");
    return E.scanLine(page, det.mask, set, 0, 20, 0, 140, Infinity, Infinity, 0, null, null, null, null, null, { rules });
  };
  const L = read(draw());
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'B', '.', 'C']);
  assert.strictEqual(L.fails.length, 0);
  // a pad byte that is NOT the glyph's is what it always was — don't-care, no
  // evidence: the composite zone over a real underline costs nothing new
  const off = draw();
  for (const y of [18, 19]) for (const x of [22, 23]) off.gray[y * 140 + x] -= 3;      // every pad pixel of the dot a composite's worth off
  const L2 = read(off);
  assert.ok(!L2.glyphs.some(g => g.ch === '.'), 'too little evidence again: refused, as before');
  assert.deepStrictEqual(L2.glyphs.map(g => g.ch), ['A', 'B', 'C']);
});

// ---- colourInk (LAWS §9) ----
// A coloured pen composites over white per channel, page_c = (65280 −
// (255 − C_c)·e) >> 8 — so a blue word is the black word seen through the
// pen. Draw "ABC" in blue and in black by that law, and a three-colour blob
// that is nobody's ramp.
function colourPage() {
  const W = 90, H = 30, rgb = new Uint8Array(W * H * 3).fill(255);
  const set = abcSet(), byCh = new Map(set.byPhy.get(0).map(g => [g.ch, g]));
  const draw = (ch, pen, C) => {
    const g = byCh.get(ch);
    for (let k = 0; k < g.inkC.length; k++) {
      const x = pen + g.dx + g.inkC[k], y = 16 + g.dy + g.inkR[k], a = g.inkA[k], e = a + (a >> 7);
      for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] = (65280 - (255 - C[c]) * e) >> 8;
    }
  };
  byCh.set('M', makeGlyph('M', ['+~+', '#+#', '~#~', '+.+'], { dy: -5, adv: 4 }));   // anti-aliased pixels too
  [...'ABCM'].forEach((ch, i) => draw(ch, 4 + 6 * i, [31, 73, 124]));     // blue
  [...'ABCM'].forEach((ch, i) => draw(ch, 30 + 6 * i, [0, 0, 0]));        // black twin
  for (let y = 4; y < 20; y++) for (let x = 60; x < 84; x++) {          // the blob
    const C = [[200, 30, 30], [30, 200, 30], [30, 30, 200]][(x + y) % 3];
    for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] = C[c];
  }
  // the pen's whole ramp, so the page's own colours are dense along it — the
  // evidence a real anti-aliased page carries and a 3-level synthetic one
  // does not (colourInk reads the palette off the page, LAWS §9)
  for (let e = 0; e <= 256; e++) {
    const x = 4 + (e & 63), y = 24 + (e >> 6);
    for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] = (65280 - (255 - [31, 73, 124][c]) * e) >> 8;
  }
  return { W, H, rgb };
}

test('colourInk: a blue word becomes its black twin byte for byte, flagged as converted', () => {
  const { W, H, rgb } = colourPage();
  const c = E.colourInk(W, H, rgb, 3);
  assert.ok(c.pens.some(p => p[0] === 31 && p[1] === 73 && p[2] === 124), 'the blue pen is found: ' + JSON.stringify(c.pens));
  let compared = 0;
  for (let y = 0; y < 22; y++) for (let x = 0; x < 26; x++) {
    const blue = c.gray[y * W + x], black = c.gray[y * W + x + 26];
    if (black !== 255 || blue !== 255) { assert.strictEqual(blue, black, `(${x},${y})`); compared++; }
    if (blue !== 255) assert.strictEqual(c.converted[y * W + x], 1);
  }
  assert.ok(compared >= 38, 'compared ' + compared);   // 12 + 10 + 7 + 10 ink pixels
  assert.strictEqual(c.converted[16 * W + 30], 0, 'black ink is not "converted"');
  // the palette map of a page leaves converted bytes out of the available set,
  // and snapConverted puts them into that space once
  const page = { w: W, h: H, gray: Uint8Array.from(c.gray), converted: c.converted };
  page.gray[12 * W + 4] = 7;                                // a converted pixel, a byte no neutral pixel holds
  const Q = E.quantMap(page);
  assert.notStrictEqual(Q[7], 7, 'a converted-only byte is not "available"');
  E.snapConverted(page, Q);
  assert.strictEqual(page.gray[12 * W + 4], Q[7]);
  assert.ok(page._snapped, 'snapped once');
});

test("colourInk: a multicolour blob is nobody's ramp and is whitened, neutral ink untouched", () => {
  const { W, H, rgb } = colourPage();
  const c = E.colourInk(W, H, rgb, 3);
  for (let y = 4; y < 20; y++) for (let x = 60; x < 84; x++) assert.strictEqual(c.gray[y * W + x], 255);
  assert.ok(c.removed >= 16 * 24, 'removed ' + c.removed);
  assert.ok(c.convertedN > 0 && c.convertedN < 400, 'converted ' + c.convertedN);   // the word + the ramp strip
});

// A page the producer QUANTIZED after compositing: the same blue word, with
// every channel snapped to a multiple of 16. Several coverages then share one
// colour, so a single recovered byte is a guess and the band is the answer.
function quantColourPage() {
  const { W, H, rgb } = colourPage();
  const out = Uint8Array.from(rgb, v => Math.min(255, Math.round(v / 32) * 32));
  return { W, H, rgb: out };
}

test('colourInk: a quantized colour ramp yields a BAND that holds the true byte', () => {
  const plain = colourPage(), quant = quantColourPage();
  const a = E.colourInk(plain.W, plain.H, plain.rgb, 3);
  const b = E.colourInk(quant.W, quant.H, quant.rgb, 3);
  let widened = 0, holds = 0, ink = 0;
  for (let i = 0; i < quant.W * quant.H; i++) {
    if (!b.converted[i] || !a.converted[i]) continue;
    ink++;
    assert.ok(b.bandLo[i] <= b.bandHi[i], 'a band is an interval');
    if (b.bandHi[i] - b.bandLo[i] > 0) widened++;
    // the byte the UNquantized page gives is the truth; the band must hold it
    if (a.gray[i] >= b.bandLo[i] && a.gray[i] <= b.bandHi[i]) holds++;
  }
  assert.ok(ink >= 20, 'ink ' + ink);
  assert.strictEqual(holds, ink, 'every true byte is inside its band');
  assert.ok(widened >= ink / 2, 'quantization widens most bands: ' + widened + '/' + ink);
  // …and where the page's own colours ARE the ramp, the band is one byte:
  // the width is the evidence the producer destroyed, nothing else
  let tight = 0, n = 0;
  for (let i = 0; i < plain.W * plain.H; i++)
    if (a.converted[i]) { n++; if (a.bandLo[i] === a.bandHi[i]) tight++; }
  assert.ok(tight >= 0.9 * n, 'dense ramp, no slack: ' + tight + '/' + n);
});

test('scanLine: a quantized blue word reads byte-exactly through the band', () => {
  const { W, H, rgb } = quantColourPage();
  const c = E.colourInk(W, H, rgb, 3);
  const page = { w: W, h: H, gray: c.gray, converted: c.converted, bandLo: c.bandLo, bandHi: c.bandHi };
  const L = E.scanLine(page, zeroMask(page), abcSet(), 0, 16, 0, 26);
  assert.deepStrictEqual(L.glyphs.map(g => [g.ch, g.pen]), [['A', 4], ['B', 10], ['C', 16]]);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
  // The control for "the band is what makes it exact" cannot live in a
  // fixture: this font has three ink levels, far enough apart that the
  // best-fit byte survives even coarse quantization. On a real page the ramp
  // is dense and it does not — that control is the gate, where the band took
  // the email document's links from 37 unread clusters to 14 and added 137
  // glyphs (fixtures/gate-ref/README.md).
});

test('colourInk: a dot beside converted text is that text, not noise', () => {
  // an 'i' dot is 1–2 dark pixels — under the dark-core rule — and was
  // whitened while its own word was read ("visacentral.com" came back
  // "v sacentral com" on the email gate document)
  const { W, H, rgb } = colourPage();
  const C = [31, 73, 124], pen = e => (65280 - (255 - C[0]) * e) >> 8;
  const put = (x, y, e) => { const o = (y * W + x) * 3;
    rgb[o] = (65280 - (255 - C[0]) * e) >> 8; rgb[o + 1] = (65280 - (255 - C[1]) * e) >> 8; rgb[o + 2] = (65280 - (255 - C[2]) * e) >> 8; };
  put(8, 8, 256); put(9, 8, 200); put(8, 9, 190);      // a dot two rows above the word
  const c = E.colourInk(W, H, rgb, 3);
  assert.strictEqual(c.converted[8 * W + 8], 1, 'the dot is read as ink');
  assert.strictEqual(c.gray[8 * W + 8], 0, 'at its own coverage');
  assert.ok(c.bandLo[8 * W + 8] <= 0 && c.bandHi[8 * W + 8] >= 0);
  // a speck of a colour no pen explains stays whitened
  const o2 = (8 * W + 12) * 3; rgb[o2] = 200; rgb[o2 + 1] = 40; rgb[o2 + 2] = 40;
  const c2 = E.colourInk(W, H, rgb, 3);
  assert.strictEqual(c2.converted[8 * W + 12], 0, 'a colour no pen explains stays out');
  assert.strictEqual(c2.gray[8 * W + 12], 255);
});

test('colourInk: an all-neutral page is returned as its gray, nothing converted or removed', () => {
  const W = 20, H = 10, rgb = new Uint8Array(W * H * 3).fill(255);
  for (let x = 2; x < 12; x++) for (let c = 0; c < 3; c++) rgb[(5 * W + x) * 3 + c] = 40;
  const c = E.colourInk(W, H, rgb, 3);
  assert.strictEqual(c.gray[5 * W + 5], 40);
  assert.strictEqual(c.convertedN + c.removed, 0);
  assert.deepStrictEqual(c.pens, []);
});

// ---- boxBetween: a redaction box always separates the glyphs on its two sides ----

test('boxBetween: a bar between two pens splits, whatever the advances do; a bar elsewhere does not', () => {
  const B = E.boxBetween;
  // Recto's startup line: opening quote flush against the bar (its advance
  // overlaps the bar by half a pixel), closing quote flush against its end
  const openQ = { pen: 124, adv: 6.53 }, closeQ = { pen: 272.25, adv: 6.53 }, bar = [[128, 274]];
  assert.ok(B(bar, openQ, closeQ), 'quotes on both sides of the bar');
  assert.ok(!B(bar, { pen: 114.75, adv: 4.44 }, openQ), 'the colon and the opening quote are both left of it');
  // a clipped glyph whose advance runs on under the bar, then the word after
  assert.ok(B([[233, 359]], { pen: 232.5, adv: 8.9 }, { pen: 357, adv: 7 }));
  // a right-clipped glyph whose pen sits under the bar's end
  assert.ok(B([[318, 446]], { pen: 307.5, adv: 8 }, { pen: 440, adv: 12 }));
  // two glyphs left of a bar that starts after the second one's pen
  assert.ok(!B([[108, 160]], { pen: 100, adv: 6 }, { pen: 106, adv: 6 }));
  assert.ok(!B([], openQ, closeQ));
  // a left-clipped J whose pen sits within 2 px of the bar: the split comes
  // AFTER it, not before (EFTA00754474 y595: "yscIJ" | bar | "<")
  const I = { pen: 475.5, adv: 7.4 }, J = { pen: 482.25, adv: 7.4 }, lt = { pen: 700, adv: 7.4 };
  assert.ok(!B([[482, 678]], I, J));
  assert.ok(B([[482, 678]], J, lt));
});

test("readPage: a line's boxes are its redaction boxes, not its rules", async () => {
  const set = abcSet(), page = makePage(160, 40);
  drawWord(page, set, 'AB', [10, 16], 20);
  drawWord(page, set, 'C', [110], 20);
  for (let y = 12; y < 24; y++) for (let x = 40; x < 100; x++) page.gray[y * 160 + x] = 0;   // a box between B and C
  for (let x = 10; x < 60; x++) page.gray[23 * 160 + x] = 0;                                 // an underline under AB…
  const { lines } = await E.readPage(page, [set], {});
  const L = lines.find(l => l.set);
  assert.ok(L);
  assert.deepStrictEqual(L.boxes, [[38, 102]], 'the box, padded ±2; the rule is not a box');
  assert.ok(E.boxBetween(L.boxes, L.glyphs[1], L.glyphs[2]));
  assert.ok(!E.boxBetween(L.boxes, L.glyphs[0], L.glyphs[1]));
  // a second line right under the box (its band starts where the box ends)
  // must not list it: a neighbour's bar is not this line's bar
  const page2 = makePage(160, 60);
  drawWord(page2, set, 'AB', [10, 16], 20);
  drawWord(page2, set, 'ABC', [10, 16, 60], 34);     // baseline 34 → rows 29–33
  for (let y = 12; y < 26; y++) for (let x = 40; x < 100; x++) page2.gray[y * 160 + x] = 0;   // box rows 12–25
  const r2 = await E.readPage(page2, [set], {});
  const below = r2.lines.find(l => l.set && l.baseline === 34);
  assert.ok(below);
  assert.deepStrictEqual(below.boxes, [], 'the box overlaps only the line above');
});

// ---- unionSets ----

test('unionSets: merges pools, tags per-glyph src and lin', () => {
  const a = makeSet('a', [makeGlyph('A', PAT.A, { dy: -5, adv: 6 })]);
  const b = makeSet('b', [makeGlyph('B', PAT.B, { dy: -5, adv: 6 })]);
  b.linear = true;
  const u = E.unionSets([a, b]);
  assert.strictEqual(u.name, 'a+b');
  assert.strictEqual(u.linear, true);
  const pool = u.byPhy.get(0);
  assert.deepStrictEqual(pool.map(g => [g.ch, g.src, g.lin]),
    [['A', 'a', false], ['B', 'b', true]]);
  assert.strictEqual(u.maxAsc, 5);
});

// ---- anchorGroups ----

test('anchorGroups: builds group + chain index; span > 64 falls back to null', () => {
  const set = abcSet();
  const idx = E.anchorGroups(set, 0, null, 0);
  assert.ok(idx && idx.groups.length >= 1);
  const members = idx.groups.flatMap(g => g.subs.flatMap(s => s.members));
  assert.strictEqual(members.length, 3);
  assert.ok(idx.chain[0]);                             // phx 0 → phase bucket 0
  const tall = { byPhy: new Map([[0, []]]), maxAsc: 40, maxDesc: 30 };
  assert.strictEqual(E.anchorGroups(tall, 0, null, 0), null);
});

// ---- scanLine ----

test('scanLine: reads back a rendered word byte-exactly, clean certificate', () => {
  const set = abcSet(), page = makePage(60, 30);
  drawWord(page, set, 'ABC', [10, 16, 22], 20);
  const L = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60);
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'B', 'C']);
  assert.deepStrictEqual(L.glyphs.map(g => g.pen), [10, 16, 22]);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

test('scanLine: unknown ink becomes ONE □ fail, no hallucinated glyphs', () => {
  const set = abcSet(), page = makePage(60, 30);
  for (let y = 15; y < 20; y++)                        // checkerboard blob ∉ dict
    for (let x = 30; x < 34; x++)
      if ((x + y) & 1) page.gray[y * 60 + x] = 0;
  const L = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60);
  assert.strictEqual(L.glyphs.length, 0);
  assert.strictEqual(L.fails.length, 1);
});

test('scanLine: a bad glyph mid-word fails alone — neighbours still read', () => {
  const set = abcSet(), page = makePage(60, 30);
  drawWord(page, set, 'AC', [10, 22], 20);
  for (let y = 15; y < 20; y++)                        // blob where B would sit
    for (let x = 16; x < 20; x++)
      if ((x + y) & 1) page.gray[y * 60 + x] = 0;
  const L = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60);
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'C']);
  assert.strictEqual(L.fails.length, 1);
});

test('scanLine: object-mask pixels are don\'t-care, not fails', () => {
  const set = abcSet(), page = makePage(60, 30);
  drawWord(page, set, 'AC', [10, 22], 20);
  const mask = zeroMask(page);
  for (let y = 14; y < 21; y++)                        // pretend a box covers 16..20
    for (let x = 16; x < 21; x++) {
      page.gray[y * 60 + x] = 0;
      mask[y * 60 + x] = 1;
    }
  const L = E.scanLine(page, mask, set, 0, 20, 0, 60);
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'C']);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

// ---- redaction boxes: the EDGE MODEL (2026-09-03) ----
// A box is a black rectangle drawn LAST over the text (LAWS §8): the body
// destroys, the anti-aliased edge line keeps the glyph as a composite
// (gb·k)>>8 with (255·k)>>8 = edge byte, and a glyph flush against the box
// leaves a column or two of its own ink outside. The page below is built
// exactly that way: a 6-wide 'A' (16 ink px) whose right two thirds are under
// a box with a 187 edge.
const A6 = ['.####.', '#....#', '######', '#....#', '#....#'];
function boxPage(pen, extra = [], drawCh = 'A') {
  const set = makeSet('synth', [makeGlyph('A', A6, { dy: -5, adv: 8 }),
    ...['B', 'C'].map(ch => makeGlyph(ch, PAT[ch], { dy: -5, adv: 6 })), ...extra]);
  const page = makePage(120, 40), W = 120;
  drawGlyph(page, set.byPhy.get(0).find(g => g.ch === drawCh), pen, 20);
  for (let y = 9; y < 29; y++)                          // the box: rows 10–27 black,
    for (let x = 39; x < 100; x++) {                    // 187 AA rows above/below
      const i = y * W + x;                              // and a 187 AA column on the left
      if (x >= 40) page.gray[i] = y === 9 || y === 28 ? 187 : 0;
      else page.gray[i] = y === 9 || y === 28 ? 187 : (page.gray[i] * 188) >> 8;   // bar-last: (255·188)>>8 = 187
    }
  const det = E.detectObjects(page);
  return { set, page, det, halos: [[37, 102, 6, 32]] };
}

test('edge model: detectObjects marks the light AA lines as edges with their byte, the body as none', () => {
  const { det } = boxPage(38);
  const edge = det.mask._edge, W = 120;
  assert.strictEqual(edge[15 * W + 39], 187, 'left edge column carries the bar byte');
  assert.strictEqual(edge[9 * W + 60], 187, 'top AA row too');
  assert.strictEqual(edge[15 * W + 60], 0, 'the black body is not an edge');
  assert.strictEqual(edge[15 * W + 38], 0, 'the open page is not an edge');
  assert.strictEqual(det.mask[15 * W + 60], 2, 'box cells are mask 2');
});

test('edge model: a glyph clipped by a box reads from its open column plus its edge composite', () => {
  const { set, page, det, halos } = boxPage(38);      // A: column 0 open, 1 under the edge, 2–5 under the body
  assert.strictEqual(page.gray[15 * 120 + 39], 0);     // the edge composite: (0·188)>>8
  assert.strictEqual(page.gray[19 * 120 + 39], 187);   // the edge alone where A is blank
  const L = E.scanLine(page, det.mask, set, 0, 20, 0, 120, Infinity, Infinity, 0, null, halos);
  assert.deepStrictEqual(L.glyphs.map(g => [g.ch, g.pen, g.clip]), [['A', 38, 10]]);  // 16 ink px, 10 destroyed
  assert.strictEqual(L.glyphs[0].exact, 6, '4 open + 2 edge pixels, all exact');
  assert.strictEqual(L.fails.length + L.frags.length, 0);
  assert.strictEqual(L.residual, 0);
});

test('edge model: two glyphs that agree on the visible columns are ambiguous — refused, never guessed', () => {
  // D shares A's first two columns and differs only under the body
  const D = makeGlyph('D', ['.####.', '#.####', '######', '#.####', '#.####'], { dy: -5, adv: 8 });
  const { set, page, det, halos } = boxPage(38, [D]);
  const L = E.scanLine(page, det.mask, set, 0, 20, 0, 120, Infinity, Infinity, 0, null, halos);
  assert.strictEqual(L.glyphs.length, 0);
  assert.strictEqual(L.fails.length + L.frags.length, 1, 'the leak stays a box fragment');
});

test('edge model: a shadow-only fit is refused by default, and reads flagged under opts.shadow', () => {
  const { set, page, det, halos } = boxPage(39);      // A's column 0 under the edge, the rest under the body
  const off = E.scanLine(page, det.mask, set, 0, 20, 0, 120, Infinity, Infinity, 0, null, halos);
  assert.strictEqual(off.glyphs.length, 0, 'no ink on the open page: refused');
  assert.strictEqual(off.fails.length + off.residual, 0, 'edge cells never seed a fail or residual');
  const L = E.scanLine(page, det.mask, set, 0, 20, 0, 120, Infinity, Infinity, 0, null, halos, null, null, null, { shadow: true });
  assert.deepStrictEqual(L.glyphs.map(g => [g.ch, g.pen, g.clip, g.shadow]), [['A', 39, 12, true]]);
  assert.strictEqual(L.glyphs[0].exact, 4, 'the four shadow pixels of the first column');
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

test('edge model: a shadow under 3 pixels is refused — edge cells never seed a fail or residual', () => {
  // a 2-wide glyph whose first column holds ONE pixel, that column under the edge
  const j = makeGlyph('j', ['.#', '.#', '.#', '##', '.#'], { dy: -5, adv: 3 });
  const { set, page, det, halos } = boxPage(39, [j], 'j');
  const L = E.scanLine(page, det.mask, set, 0, 20, 0, 120, Infinity, Infinity, 0, null, halos, null, null, null, { shadow: true });
  assert.strictEqual(L.glyphs.length, 0);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

test('edge model: a glyph merely touching the edge is judged on the composite, exact and unclipped', () => {
  const { set, page, det, halos } = boxPage(36);      // A columns 0–2 open, 3 under the edge, 4–5 under the body
  const L = E.scanLine(page, det.mask, set, 0, 20, 0, 120, Infinity, Infinity, 0, null, halos);
  assert.deepStrictEqual(L.glyphs.map(g => [g.ch, g.pen, g.clip ?? null]), [['A', 36, null]]);
  assert.strictEqual(L.glyphs[0].exact, 10, '8 open + 2 edge pixels');
  assert.strictEqual(L.glyphs[0].pending, 0);
  assert.strictEqual(L.residual, 0);
});

test('scanLine: kerned AA overlap composites through the blend law', () => {
  // two half-ink glyphs overlapping one column: the shared pixels are a true
  // composite (126 over 126 → 62), so this exercises tryCand's non-fresh
  // branch AND the accept-blend prediction — the paths the fresh-canvas fast
  // path skips (a wrong e/shift here is invisible to non-overlapping text)
  // alphas 55 (gb 200) and 128 (gb 126) chosen so the composite 200·127>>8
  // = 99 actually moves if e is off by one (126-over-126 wouldn't — both
  // floor to 62 and a wrong e passes unseen)
  const n = makeGlyph('n', ['~~~', '~~~', '~~~'], { dy: -3, adv: 2 });
  const m = makeGlyph('m', ['+++', '+++', '+++'], { dy: -3, adv: 2 });
  const set = makeSet('ov', [n, m]);
  const page = makePage(40, 30);
  drawGlyph(page, n, 10, 20);
  drawGlyph(page, m, 12, 20);                          // overlap column 12
  assert.strictEqual(page.gray[18 * 40 + 12], 99);     // composite by the law
  const L = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 40);
  assert.deepStrictEqual(L.glyphs.map(g => [g.ch, g.pen]), [['n', 10], ['m', 12]]);
  assert.strictEqual(L.fails.length, 0);
  assert.strictEqual(L.residual, 0);
});

test('scanLine: TOL relaxes byte-exactness; 0 stays strict', () => {
  const set = abcSet(), page = makePage(60, 30);
  drawWord(page, set, 'ABC', [10, 16, 22], 20);
  page.gray[17 * 60 + 10]++;                           // one A ink byte off by +1
  const strict = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60);
  assert.ok(strict.fails.length > 0);
  const tol = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 60,
    Infinity, Infinity, 1);
  assert.deepStrictEqual(tol.glyphs.map(g => g.ch), ['A', 'B', 'C']);
  assert.strictEqual(tol.fails.length, 0);
  assert.strictEqual(tol.residual, 0);
});

test('scanLine: palette-quantized page reads through QUANT, fails without', () => {
  const d = makeGlyph('d', ['+##+', '#..#', '+##+'], { dy: -3, adv: 6 });
  const set = makeSet('q', [d]);
  const page = makePage(40, 30);
  drawGlyph(page, d, 10, 20);
  for (let i = 0; i < page.gray.length; i++)           // producer palettizes to {0,255}
    page.gray[i] = page.gray[i] < 128 ? 0 : 255;
  const bare = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 40);
  assert.ok(bare.fails.length > 0);                    // AA bytes ≠ law without the map
  const Q = E.quantMap(page);
  const q = E.scanLine(page, zeroMask(page), set, 0, 20, 0, 40,
    Infinity, Infinity, 0, Q);
  assert.deepStrictEqual(q.glyphs.map(g => g.ch), ['d']);
  assert.strictEqual(q.fails.length, 0);
  assert.strictEqual(q.residual, 0);
});

// ---- spaceCalib ----

test('spaceCalib: recovers the space width from clustered gaps', () => {
  const glyphs = [];
  let pen = 0;
  for (const gap of [0, 4, 4, 0, 4, 0]) {              // adv 6 + measured gaps
    glyphs.push({ pen, adv: 6 });
    pen += 6 + gap;
  }
  glyphs.push({ pen, adv: 6 });
  const sp = E.spaceCalib([{ glyphs }]);
  assert.ok(Math.abs(sp - 4) < 1e-9, `space ${sp}`);
  assert.strictEqual(E.spaceCalib([{ glyphs: glyphs.slice(0, 2) }]), null);
});

// ---- readPage ----

test('readPage: blind end-to-end — bands, baseline pinning, objects, clean lines', async () => {
  const set = abcSet(), page = makePage(80, 70);
  drawWord(page, set, 'ABC', [10, 16, 22], 20);        // band 15..20
  drawWord(page, set, 'CBA', [10, 16, 22], 40);        // band 35..40
  for (let x = 10; x < 60; x++) page.gray[50 * 80 + x] = 0;   // a rule object
  const { lines, objects } = await E.readPage(page, [set]);
  assert.strictEqual(objects.length, 1);
  assert.strictEqual(objects[0].type, 'rule');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map(L => L.glyphs.map(g => g.ch).join('')),
    ['ABC', 'CBA']);
  assert.deepStrictEqual(lines.map(L => L.baseline), [20, 40]);
  for (const L of lines) {
    assert.strictEqual(L.clean, true);
    assert.strictEqual(L.font, 'synth');
  }
});

test('readPage: unreadable band is an honest □ line, not silence', async () => {
  const set = abcSet(), page = makePage(80, 40);
  for (let y = 15; y < 20; y++)
    for (let x = 30; x < 34; x++)
      if ((x + y) & 1) page.gray[y * 80 + x] = 0;
  const { lines } = await E.readPage(page, [set]);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].set, null);
  assert.strictEqual(lines[0].fails.length, 1);
});

// ---- stacked bands (line pitch < maxAsc + maxDesc: rows interleave) ----

// tall/descender font: maxAsc 8 ('J'/'T'), maxDesc 4 ('q', unused on page,
// present so the scan window reaches a neighbour line's glued rows)
function tallSet() {
  return makeSet('tall', [
    makeGlyph('A', ['.##.', '#..#', '####', '#..#', '#..#'], { dy: -5, adv: 6 }),
    makeGlyph('y', ['#.#', '#.#', '#.#', '.##', '..#', '..#', '..#', '##.'], { dy: -5, adv: 6 }),
    makeGlyph('q', ['###', '#.#', '###', '..#', '..#', '..#', '..#', '..#', '..#'], { dy: -5, adv: 6 }),
    makeGlyph('J', ['###', '...', '.#.', '.#.', '.#.', '.#.', '#.#', '.#.'], { dy: -8, adv: 6 }),
    makeGlyph('T', ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '.#.', '.#.'], { dy: -8, adv: 6 }),
  ]);
}

test('readPage: one band holding two stacked lines splits and reads both', async () => {
  // 'yy' baseline 50 (ink 45..52) touches 'TT' baseline 61 (ink 53..60):
  // ONE contiguous band; the picked bottom line cannot reach rows 45..52,
  // so the band must split and read the upper line first — and the upper
  // segment's judging must stop at the split boundary (T's top row 53).
  const set = tallSet(), page = makePage(60, 80);
  drawWord(page, set, 'yy', [5, 11], 50);
  drawWord(page, set, 'TT', [5, 11], 61);
  assert.strictEqual(E.findBands(page, zeroMask(page)).length, 1);
  const { lines } = await E.readPage(page, [set]);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map(L => L.glyphs.map(g => g.ch).join('')), ['yy', 'TT']);
  assert.deepStrictEqual(lines.map(L => L.baseline), [50, 61]);
  for (const L of lines) {
    assert.strictEqual(L.clean, true);
    assert.deepStrictEqual(L.fails, []);
  }
});

test('readPage: packed band — bottom line indented past the probe window still pins', async () => {
  // PACKED LINES (printed-MIME dumps: ~12px pitch, 10-12px ink, so several
  // text lines land in ONE band). The baseline sweeps aim a 160px probe
  // window at the densest ink cluster of the WHOLE band — here the long 'y'
  // row at x5. The line the sweeps are actually trying to pin is the one at
  // the band BOTTOM, and it sits at x200, far outside that window: every
  // baseline reads blank page, scores 0, and the whole band (both lines) used
  // to be reported as one □. The bottom line must be re-probed with an anchor
  // measured from its OWN window rows.
  const set = tallSet(), page = makePage(240, 60);
  drawWord(page, set, 'yyyyyyyyyy', [5, 11, 17, 23, 29, 35, 41, 47, 53, 59], 20);
  drawWord(page, set, 'TT', [200, 206], 31);
  assert.deepStrictEqual(E.findBands(page, zeroMask(page)), [[15, 31]]);
  const { lines } = await E.readPage(page, [set]);
  assert.deepStrictEqual(lines.map(L => L.glyphs.map(g => g.ch).join('')), ['yyyyyyyyyy', 'TT']);
  assert.deepStrictEqual(lines.map(L => L.baseline), [20, 31]);
  for (const L of lines) {
    assert.strictEqual(L.clean, true);
    assert.deepStrictEqual(L.fails, []);
  }
});

test('readPage: packed band — bottom line unpinnable, an upper line breaks the deadlock', async () => {
  // Same packed geometry, second failure mode: at this pitch the scan window
  // (maxAsc+maxDesc = 12) is TALLER than the line pitch (11), so the 'q'
  // descenders on row 23 sit inside the bottom line's window — and the peel
  // runs bottom-first, so that ink is not in `explained` yet and counts as
  // unread. The bottom line cannot pin at any anchor. Pinning whichever line
  // in the band CAN be proven (the 'qqqq' row) breaks the deadlock: the
  // below-split queues the rest as its own band, and the page-end retro-check
  // retracts the 'T' tips the upper line failed on once the lower line reads
  // them.
  const set = tallSet(), page = makePage(100, 60);
  drawWord(page, set, 'qqqq', [48, 54, 60, 66], 20);
  drawWord(page, set, 'TT', [5, 11], 31);
  assert.deepStrictEqual(E.findBands(page, zeroMask(page)), [[15, 31]]);
  const { lines } = await E.readPage(page, [set]);
  assert.deepStrictEqual(lines.map(L => L.glyphs.map(g => g.ch).join('')), ['qqqq', 'TT']);
  assert.deepStrictEqual(lines.map(L => L.baseline), [20, 31]);
  for (const L of lines) {
    assert.strictEqual(L.clean, true);
    assert.deepStrictEqual(L.fails, []);
  }
});

test('readPage: neighbour ascender tip glued to the band above is retracted, not a □', async () => {
  // 'Ay' baseline 20 (ink 15..22); 'JA' baseline 31 below. J's detached top
  // row (row 23) is contiguous with the upper band while J's body (25..30,
  // row 24 blank) is its own band. The upper line's scan window (maxDesc 4)
  // judges row 23, fails on the tip — then the lower line explains it and
  // the page-end retro-check must retract the fail.
  const set = tallSet(), page = makePage(60, 60);
  drawWord(page, set, 'Ay', [5, 11], 20);
  drawWord(page, set, 'JA', [5, 11], 31);
  assert.deepStrictEqual(E.findBands(page, zeroMask(page)), [[15, 24], [25, 31]]);
  const { lines } = await E.readPage(page, [set]);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map(L => L.glyphs.map(g => g.ch).join('')), ['Ay', 'JA']);
  for (const L of lines) {
    assert.strictEqual(L.clean, true);
    assert.deepStrictEqual(L.fails, []);
  }
});
