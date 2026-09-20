// ---------------------------------------------------------------------------
// render.test.js — the forward renderer (engine/render.js) on synthetic sets,
// and the round trip that makes it the reader's own certificate: a page
// rendered here reads back clean with the input transcript at the input pens.
//
//     node test/render.test.js
//
// Corpus-free and asset-free like engine.test.js; glyph records mirror the
// shape tools/glyph-bundle.mjs materializeSet produces. The real-mupdf
// certification of the lattice + blend forward laws is ftclone/certify-render.mjs.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const R = require('../engine/render.js');
const E = require('../engine/ocr-engine.js');

// ---- synthetic glyph / page helpers (same construction as engine.test.js) ----
const ALPHA = { '#': 255, '+': 128, '~': 55, '.': 0 };
const gbOf = a => { const e = a + (a >> 7); return (255 * (256 - e)) >> 8; };

function record(ch, w, h, bytes, alpha, { dy, adv, dx = 0, phx = 0, lin }) {
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
  const rec = { ch, adv, phx, w, h, dx, dy, bytes, alpha, ink, inkC, inkR, inkB, inkA, inkLeft };
  if (lin !== undefined) rec.lin = lin;
  return rec;
}

// standard-law glyph from a pattern (page byte over white by the law)
function makeGlyph(ch, pattern, opts) {
  const h = pattern.length, w = pattern[0].length;
  const bytes = new Uint8Array(w * h).fill(255), alpha = new Uint8Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const a = ALPHA[pattern[r][c]];
      if (a) { alpha[r * w + c] = a; bytes[r * w + c] = gbOf(a); }
    }
  return record(ch, w, h, bytes, alpha, opts);
}

// linear-law glyph from RAW bytes: page byte = raw + 1 for raw in [128,254]
// (fontgen --linear), alpha plane = raw (glyph-bundle alphaOf)
function makeLinearGlyph(ch, raws, opts) {
  const h = raws.length, w = raws[0].length;
  const bytes = new Uint8Array(w * h).fill(255), alpha = new Uint8Array(w * h).fill(255);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const raw = raws[r][c];
      if (raw < 255) { alpha[r * w + c] = raw; bytes[r * w + c] = raw + (raw >= 128 && raw <= 254 ? 1 : 0); }
    }
  return record(ch, w, h, bytes, alpha, opts);
}

function makeSet(name, glyphs, { linear = false } = {}) {
  let maxAsc = 0, maxDesc = 0;
  for (const g of glyphs) {
    maxAsc = Math.max(maxAsc, -g.dy);
    maxDesc = Math.max(maxDesc, g.dy + g.h);
  }
  return { name, sizePx: 16, linear, fontFile: name, byPhy: new Map([[0, glyphs]]), maxAsc, maxDesc };
}
const makePage = (w, h) => ({ w, h, gray: new Uint8Array(w * h).fill(255) });

const PAT = {
  A: ['.##.', '#..#', '####', '#..#', '#..#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
};
// every phase carries the same bitmap (a phase-invariant "boxy" face): the
// layout tests need all four phases to exist, the round trip uses integer pens
function abcSet() {
  const glyphs = [];
  for (const [ch, p] of Object.entries(PAT))
    for (let ph = 0; ph < 4; ph++) glyphs.push(makeGlyph(ch, p, { dy: -5, adv: 6, phx: ph / 4 }));
  return makeSet('synth', glyphs);
}

// ---- the lattice ----

test('snapX: nearest ¼ px, ties round up; snapY: nearest whole px, ties round up', () => {
  assert.strictEqual(R.snapX(10), 10);
  assert.strictEqual(R.snapX(10.1), 10);
  assert.strictEqual(R.snapX(10.124), 10);
  assert.strictEqual(R.snapX(10.125), 10.25);       // the tie
  assert.strictEqual(R.snapX(10.3), 10.25);
  assert.strictEqual(R.snapX(10.375), 10.5);
  assert.strictEqual(R.snapX(10.9), 11);
  assert.strictEqual(R.snapX(37.25), 37.25);        // lattice values are fixpoints
  // mupdf rounds the float32 pen: a double just under a tie IS the tie there
  // (45.87499999999999 = 8 + 51/64 + 5 × 7.415625 accumulated in doubles)
  assert.strictEqual(R.snapX(45.87499999999999), 46);
  assert.strictEqual(R.snapX(45.87), 45.75);         // clearly below the tie: still ¾
  assert.strictEqual(R.snapY(28), 28);
  assert.strictEqual(R.snapY(28.49), 28);
  assert.strictEqual(R.snapY(28.5), 29);            // LAWS §1: 28.5 ≡ 29
  assert.strictEqual(R.snapY(28.75), 29);
});

// ---- layout ----

test('layoutLine: float accumulation, per-glyph snap, advanceW, spaces, missing', () => {
  const set = abcSet();
  const L = R.layoutLine(set, 'ABC', 10.1);
  assert.deepStrictEqual(L.glyphs.map(g => g.ch), ['A', 'B', 'C']);
  assert.deepStrictEqual(L.glyphs.map(g => g.penRaw), [10.1, 16.1, 22.1]);
  assert.deepStrictEqual(L.glyphs.map(g => g.pen), [10, 16, 22]);
  assert.ok(Math.abs(L.advanceW - 18) < 1e-9);
  assert.deepStrictEqual(L.missing, []);

  // a snapped pen never feeds the next one: raw accumulation stays exact
  const L2 = R.layoutLine(set, 'AAAA', 0.2);
  assert.deepStrictEqual(L2.glyphs.map(g => g.pen), [0.25, 6.25, 12.25, 18.25]);

  // spaces come from spaceAdv; without one they are reported, not guessed
  const L3 = R.layoutLine(set, 'A B', 0, { spaceAdv: 3.5 });
  assert.deepStrictEqual(L3.glyphs.map(g => g.penRaw), [0, 9.5]);
  assert.ok(Math.abs(L3.advanceW - 15.5) < 1e-9);
  const L4 = R.layoutLine(set, 'A B', 0);
  assert.deepStrictEqual(L4.missing, [' ']);
  assert.deepStrictEqual(L4.glyphs.map(g => g.penRaw), [0, 6]);

  // an unknown character is reported once and contributes no advance
  const L5 = R.layoutLine(set, 'AxxB', 0);
  assert.deepStrictEqual(L5.missing, ['x']);
  assert.deepStrictEqual(L5.glyphs.map(g => g.penRaw), [0, 6]);
});

test('advanceOf / glyphIndex: per-char advance, phase records indexed once', () => {
  const set = abcSet();
  assert.strictEqual(R.advanceOf(set, 'A'), 6);
  assert.strictEqual(R.advanceOf(set, 'z'), null);
  const idx = R.glyphIndex(set);
  assert.strictEqual(idx.get('A|2').phx, 0.5);
  assert.strictEqual(R.glyphIndex(set), idx, 'index is cached on the set');
});

// ---- compositing ----

test('renderLine: a lone glyph reproduces its stored bytes at scanLine placement', () => {
  const set = abcSet();
  const r = R.renderLine(set, [{ ch: 'A', pen: 10.25 }], 20);
  const g = R.glyphIndex(set).get('A|1');
  assert.deepStrictEqual([r.x0, r.y0, r.w, r.h], [10 + g.dx, 20 + g.dy, g.w, g.h]);
  assert.deepStrictEqual(Array.from(r.gray), Array.from(g.bytes));
  assert.strictEqual(r.glyphs, 1);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.baseline, 20);
});

test('renderLine: baseline snaps, pens snap, missing phases are reported', () => {
  const set = makeSet('p0only', [makeGlyph('A', PAT.A, { dy: -5, adv: 6 })]);
  const r = R.renderLine(set, [{ ch: 'A', pen: 10.1 }], 19.5);
  assert.strictEqual(r.baseline, 20);
  assert.strictEqual(r.y0, 15);
  const r2 = R.renderLine(set, [{ ch: 'A', pen: 10.4 }], 20);   // phase 2 does not exist
  assert.deepStrictEqual(r2.missing, ['A']);
  assert.strictEqual(r2.glyphs, 0);
});

test('renderLine: opts.phy selects the y-phase records the reader pinned the line to', () => {
  const g0 = makeGlyph('A', PAT.A, { dy: -5, adv: 6 });
  const g5 = makeGlyph('A', PAT.A, { dy: -4, adv: 6 });              // the ½-phase raster sits a row lower
  const set = makeSet('legacy', [g0]);
  set.byPhy.set(0.5, [g5]);
  const r0 = R.renderLine(set, [{ ch: 'A', pen: 10 }], 20);
  const r5 = R.renderLine(set, [{ ch: 'A', pen: 10 }], 20, { phy: 0.5 });
  assert.strictEqual(r0.y0, 15);
  assert.strictEqual(r5.y0, 16);
  assert.deepStrictEqual(Array.from(r5.gray), Array.from(g5.bytes));
  const r7 = R.renderLine(set, [{ ch: 'A', pen: 10 }], 20, { phy: 0.25 });   // no such phase
  assert.deepStrictEqual(r7.missing, ['A']);
});

test('renderLine: overlapping glyphs composite through the law in drawing order', () => {
  const set = abcSet();
  // two half-ink bars drawn on top of each other: fresh = gb(128); composite
  // = (gb · (256 − e)) >> 8 with e = 128 + 1
  const bar = makeGlyph('|', ['+', '+', '+'], { dy: -3, adv: 1 });
  const set2 = makeSet('bars', [bar]);
  const r = R.renderLine(set2, [{ ch: '|', pen: 5 }, { ch: '|', pen: 5 }], 10);
  const first = gbOf(128), second = (first * (256 - (128 + 1))) >> 8;
  assert.deepStrictEqual(Array.from(r.gray), [second, second, second]);
  assert.deepStrictEqual(Array.from(r.hits), [2, 2, 2]);       // composite pixels
  assert.notStrictEqual(first, second);
  // disjoint glyphs stay their own bytes
  const r2 = R.renderLine(set, [{ ch: 'A', pen: 0 }, { ch: 'B', pen: 6 }], 10);
  const A = R.glyphIndex(set).get('A|0'), B = R.glyphIndex(set).get('B|0');
  assert.strictEqual(r2.w, 9);                                // A spans 0..4, B 6..9
  assert.strictEqual(r2.gray[0 * 9 + 1], A.bytes[1]);         // top row of A
  assert.strictEqual(r2.gray[0 * 9 + 6], B.bytes[0]);         // top row of B
  assert.strictEqual(r2.gray[0 * 9 + 4], 255);                // the gap stays white
});

test('renderLine: linear law — multiplicative raw composite plus one shift per light contributor', () => {
  const g1 = makeLinearGlyph('a', [[200]], { dy: -1, adv: 1 });   // raw 200 → page 201 (light)
  const g2 = makeLinearGlyph('b', [[150]], { dy: -1, adv: 1 });   // raw 150 → page 151 (light)
  const g3 = makeLinearGlyph('c', [[60]], { dy: -1, adv: 1 });    // raw 60 → page 60 (dark, no shift)
  const set = makeSet('lin', [g1, g2, g3], { linear: true });
  const lone = R.renderLine(set, [{ ch: 'a', pen: 3 }], 5);
  assert.deepStrictEqual(Array.from(lone.gray), [201]);
  const two = R.renderLine(set, [{ ch: 'a', pen: 3 }, { ch: 'b', pen: 3 }], 5);
  assert.deepStrictEqual(Array.from(two.gray), [((200 * 150) / 255 | 0) + 1 + 1]);
  const three = R.renderLine(set, [{ ch: 'a', pen: 3 }, { ch: 'b', pen: 3 }, { ch: 'c', pen: 3 }], 5);
  const raw2 = (200 * 150) / 255 | 0;
  assert.deepStrictEqual(Array.from(three.gray), [((raw2 * 60) / 255 | 0) + 2]);
});

// ---- diff + paste ----

test('diffLine: zero on the page it was pasted into, counts a perturbed pixel, counts outside', () => {
  const set = abcSet();
  const page = makePage(40, 30);
  const r = R.renderLine(set, R.layoutLine(set, 'ABC', 10).glyphs, 20);
  R.paste(page, r, set);
  const d = R.diffLine(r, page, null);
  assert.strictEqual(d.count, 0);
  assert.ok(d.ink > 0);
  assert.strictEqual(d.outside, 0);
  page.gray[15 * 40 + 11] = 7;                                  // one pixel of A
  const d2 = R.diffLine(r, page, null);
  assert.strictEqual(d2.count, 1);
  assert.strictEqual(d2.mism[(15 - r.y0) * r.w + (11 - r.x0)], 1);
  // through a palette: predictions are mapped before the compare
  const Q = new Uint8Array(256).map((_, i) => i);
  Q[7] = 7;
  page.gray[15 * 40 + 11] = r.gray[(15 - r.y0) * r.w + (11 - r.x0)];
  assert.strictEqual(R.diffLine(r, page, Q).count, 0);
  // a tolerant rung: |Δ| ≤ tol is within, 2·tol on composite pixels
  page.gray[15 * 40 + 11] = r.gray[(15 - r.y0) * r.w + (11 - r.x0)] + 1;
  assert.strictEqual(R.diffLine(r, page, null, null, 0).count, 1);
  const dt = R.diffLine(r, page, null, null, 1);
  assert.strictEqual(dt.count, 0);
  assert.strictEqual(dt.within, 1);
  page.gray[15 * 40 + 11] = r.gray[(15 - r.y0) * r.w + (11 - r.x0)];
  const bar = makeGlyph('|', ['+'], { dy: -1, adv: 1 });
  const bars = makeSet('bars', [bar]);
  const rb = R.renderLine(bars, [{ ch: '|', pen: 3 }, { ch: '|', pen: 3 }], 5);
  const pageB = makePage(10, 10);
  pageB.gray[4 * 10 + 3] = rb.gray[0] + 2;                    // composite pixel off by 2
  assert.strictEqual(R.diffLine(rb, pageB, null, null, 1).count, 0);   // 2·tol allows it
  assert.strictEqual(R.diffLine(rb, pageB, null, null, 0).count, 1);
  // pixels under the reader's object mask are never compared (a descender in
  // a redaction box's padded rows): masked, not mismatched
  const mask = new Uint8Array(40 * 30);
  mask[15 * 40 + 11] = 1;
  page.gray[15 * 40 + 11] = 7;
  const dm = R.diffLine(r, page, null, mask);
  assert.strictEqual(dm.count, 0);
  assert.strictEqual(dm.masked, 1);
  page.gray[15 * 40 + 11] = r.gray[(15 - r.y0) * r.w + (11 - r.x0)];
  // a window off the page edge: pixels beyond the page count as outside, the
  // ones on the page are compared as usual (pasted → zero mismatches)
  const r3 = R.renderLine(set, [{ ch: 'A', pen: 38 }], 20);
  R.paste(page, r3, set);
  const d3 = R.diffLine(r3, page, null);
  assert.ok(d3.outside > 0);
  assert.strictEqual(d3.count, 0);
  assert.strictEqual(d3.ink, d3.outside + 6);                  // A's first two columns are on the page
});

test('objectMask: detectObjects mask plus ±2-column/±3-row box halos, slices included', () => {
  const w = 40, h = 30;
  const det = { mask: new Uint8Array(w * h), objects: [
    { type: 'box', x0: 20, x1: 30, y0: 10, y1: 20 },
    { type: 'rule', x0: 22, x1: 28, y0: 21, y1: 22 },      // a thin bottom slice of that box
    { type: 'rule', x0: 0, x1: 40, y0: 27, y1: 28 },       // an unrelated rule: no halo
  ] };
  det.mask[5 * w + 5] = 1;
  const m = R.objectMask(det, w, h);
  assert.strictEqual(m[5 * w + 5], 1);                      // the base mask survives
  assert.strictEqual(m[10 * w + 18], 1);                    // 2 columns left of the box
  assert.strictEqual(m[10 * w + 17], 0);
  assert.strictEqual(m[7 * w + 25], 1);                     // 3 rows above
  assert.strictEqual(m[6 * w + 25], 0);
  assert.strictEqual(m[24 * w + 25], 1);                    // the slice's halo reaches row 24
  assert.strictEqual(m[27 * w + 5], 0);                     // the lone rule gets no halo
});

test('residualInk: page ink no window inks and no mask covers, within the band', () => {
  const set = abcSet();
  const page = makePage(40, 30);
  const r = R.renderLine(set, R.layoutLine(set, 'AB', 10).glyphs, 20);
  R.paste(page, r, set);
  const band = { top: 15, bot: 21, x0: 8, x1: 30 };
  assert.strictEqual(R.residualInk(page, null, band, [r]).count, 0);   // every ink pixel is drawn
  page.gray[17 * 40 + 24] = 0;                                          // a stray mark the OCR missed
  const res = R.residualInk(page, null, band, [r]);
  assert.strictEqual(res.count, 1);
  assert.deepStrictEqual(res.pixels[0], [24, 17, 0]);
  const mask = new Uint8Array(40 * 30); mask[17 * 40 + 24] = 1;
  assert.strictEqual(R.residualInk(page, mask, band, [r]).count, 0);   // masked ink is don't-care
  page.gray[25 * 40 + 24] = 0;                                          // outside the band: not this line's
  assert.strictEqual(R.residualInk(page, mask, band, [r]).count, 0);
});

// ---- the round trip: render → readPage → clean, same text, same pens ----

test('round trip: a rendered page reads back byte-clean with the input transcript and pens', async () => {
  const set = abcSet();
  const page = makePage(120, 70);
  const lines = [
    { text: 'ABC', x0: 10, baseline: 20 },
    { text: 'CAB', x0: 14, baseline: 45 },
  ];
  for (const L of lines) {
    const lay = R.layoutLine(set, L.text, L.x0);
    assert.deepStrictEqual(lay.missing, []);
    R.paste(page, R.renderLine(set, lay.glyphs, L.baseline, {}), set);
  }
  const { lines: read } = await E.readPage(page, [set], {});
  assert.strictEqual(read.length, 2);
  read.sort((a, b) => a.baseline - b.baseline);
  for (let i = 0; i < 2; i++) {
    const L = read[i];
    assert.ok(L.clean, `line ${i} not clean: fails=${L.fails.length} residual=${L.residual}`);
    assert.strictEqual(L.baseline, lines[i].baseline);
    assert.strictEqual(L.glyphs.map(g => g.ch).join(''), lines[i].text);
    const pens = L.glyphs.map(g => Math.floor(g.pen));
    assert.deepStrictEqual(pens, [0, 6, 12].map(d => lines[i].x0 + d));
  }
});

// ---- the producer's law ----

// the pens a producer leaves: words laid from float starts under a law, each
// pen snapped as mupdf snaps it. Advances are hmtx-like at 16 px (Times A,
// B, C, D), so 1/1000-em rounding moves them by up to 0.003 px a glyph.
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const HM = { A: 909 / 2048 * 16, B: 8, C: 569 / 2048 * 16, D: 1024 / 2048 * 16 };
const TABLE = { AB: -0.75, CA: -1.25, DB: 0.5 };
function producerPage(law, nWords, seed, minLen = 3, maxLen = 8) {
  const rnd = lcg(seed), chars = Object.keys(HM);
  const q = a => law.quant ? Math.round(a / 16 * law.quant) / law.quant * 16 : a;
  const lines = [];
  let pen = 20 + rnd();
  for (let i = 0; i < nWords; i++) {
    const len = minLen + Math.floor(rnd() * (maxLen - minLen + 1));
    const entries = [];
    let x = pen, prev = null;
    for (let k = 0; k < len; k++) {
      const ch = chars[Math.floor(rnd() * chars.length)];
      if (prev && law.kern?.[prev + ch]) x += q(law.kern[prev + ch]) * law.scale;
      entries.push({ i: k, ch, pen: R.snapX(x), adv: HM[ch] });
      x += q(HM[ch]) * law.scale; prev = ch;
    }
    lines.push({ entries });
    pen = x + 3 + rnd() * 4;
    if (pen > 700) pen = 20 + rnd();
  }
  return lines;
}
const hmSet = () => ({ name: 'hm', sizePx: 16, byPhy: new Map([[0, Object.entries(HM).map(([ch, adv]) => ({ ch, adv, phx: 0 }))]]) });

test('solveStart: the starts that write a word are an interval intersection', () => {
  // laid from 10.07: pens 10, 17.25, 25.25 — the start is not the snapped first pen
  const ok = R.solveStart([{ S: 0, p: 10 }, { S: 7.1, p: 17.25 }, { S: 15.1, p: 25.25 }], 10);
  assert.ok(ok.feasible && ok.hit === 3);
  assert.ok(ok.delta >= 0.025 && ok.delta < 0.125);
  const lay = [10, 17.1, 25.1].map(S => R.snapX(10 + ok.delta + (S - 10)));
  assert.deepStrictEqual(lay, [10, 17.25, 25.25]);
  // a pen no start can reach: the best start still writes the other two
  const no = R.solveStart([{ S: 0, p: 10 }, { S: 7.1, p: 17.25 }, { S: 15.1, p: 25.5 }], 10);
  assert.ok(!no.feasible && no.hit === 2);
  // a grid restricts the start to the producer's lattice
  const g = R.solveStart([{ S: 0, p: 10 }, { S: 7.1, p: 17.25 }], 10, 15);
  assert.ok(g.feasible && Math.abs(((10 + g.delta) * 15) % 1) < 1e-9);
});

test('wordsOf: entries split at spaces (text offsets), bare glyphs at gaps, both at a set change', () => {
  const L = { entries: [{ i: 0, ch: 'A', pen: 0, adv: 6 }, { i: 1, ch: 'B', pen: 6, adv: 6 }, { i: 3, ch: 'C', pen: 16, adv: 6 }, { i: 4, ch: 'ﬁ', pen: 22, adv: 6 }, { i: 6, ch: 'A', pen: 28, adv: 6, src: 'bold' }] };
  assert.deepStrictEqual(R.wordsOf(L).map(w => w.map(e => e.ch).join('')), ['AB', 'Cﬁ', 'A']);
  const G = { glyphs: [{ ch: 'A', pen: 0, adv: 6 }, { ch: 'B', pen: 6.25, adv: 6 }, { ch: 'C', pen: 16, adv: 6 }] };
  assert.deepStrictEqual(R.wordsOf(G, 4).map(w => w.map(e => e.ch).join('')), ['AB', 'C']);
});

test('producerMetrics: 1/1000-em advances, the laid size and kerning are told apart from the pens', () => {
  const set = hmSet();
  const laws = [
    { quant: 1000, scale: 1, kern: null },
    { quant: 1000, scale: 1.0006, kern: null },
    { quant: null, scale: 1, kern: null },
    { quant: 1000, scale: 0.9994, kern: TABLE },
    { quant: null, scale: 1, kern: TABLE },
  ];
  // the scale searches each page costs: none past the first hypothesis, in
  // tie order (1000, hmtx, 1000 kerned, hmtx kerned), that writes every pen —
  // a later one can only tie it, and a tie goes to the earlier
  const searches = [0, 1, 1, 3, 3];
  for (const law of laws) {
    const lines = producerPage(law, 150, 7, 10, 60);   // long words (base64 lines, e-mail addresses) are what tells 1/2048 from 1/1000
    const m = R.producerMetrics(lines, { sizePx: 16, kernTable: TABLE });
    const tag = JSON.stringify(law);
    assert.strictEqual(m.alternatives.length, 4, `every hypothesis reported under ${tag}`);
    assert.strictEqual(m.alternatives.filter(a => a.searched).length, searches[laws.indexOf(law)], `scale searches under ${tag}`);
    assert.strictEqual(m.hit, m.glyphs, `every pen written under ${tag}`);
    assert.strictEqual(m.exact, m.words, `every word written under ${tag}`);
    assert.strictEqual(m.quant, law.quant, `quantization under ${tag}: got ${m.quant}`);
    assert.strictEqual(m.kerned, !!law.kern, `kerning under ${tag}`);
    assert.ok(Math.abs(m.scale - law.scale) < 5e-5, `scale ${m.scale} under ${tag}`);
    if (law.kern) assert.ok(Math.abs(m.kern.get('AB') - (-0.75 * law.scale)) < 0.02);
    // a whole line of several words, re-laid through lineLayout, returns every pen
    {
      const ents = [];
      let off = 0;
      for (const L of lines.slice(0, 6)) { for (const e of L.entries) ents.push({ ...e, i: off + e.i }); off += L.entries.length + 2; }
      const text = ents.map((e, k) => (k && ents[k - 1].i + 1 < e.i ? '  ' : '') + e.ch).join('');
      const ll = R.lineLayout({ entries: ents }, 16, m);
      assert.ok(ll.feasible && ll.words === 6, `lineLayout feasible under ${tag}`);
      const lay = R.layoutLine(set, text, ents[0].pen + ll.delta, { metrics: m, spaceWidths: ll.spaceWidths });
      assert.deepStrictEqual(lay.glyphs.map(g => g.pen), ents.map(e => e.pen), `whole line reproduced under ${tag}`);
    }
    // and layoutLine, from each word's solved start, reproduces its pens
    for (const L of lines) {
      const st = R.lineStart(L, 16, m);
      assert.ok(st.feasible, `start solvable under ${tag}`);
      const lay = R.layoutLine(set, L.entries.map(e => e.ch).join(''), L.entries[0].pen + st.delta, { metrics: m });
      assert.deepStrictEqual(lay.glyphs.map(g => g.pen), L.entries.map(e => e.pen), `pens reproduced under ${tag}`);
    }
  }
  // no table known: the page can still be written, and no kerning is claimed
  const m0 = R.producerMetrics(producerPage(laws[0], 60, 3), { sizePx: 16 });
  assert.ok(m0.hit === m0.glyphs && !m0.kerned && m0.kern.size === 0 && m0.kernable === 0);
  // nothing certified: the least assumption, and nothing pretended
  const e = R.producerMetrics([], { sizePx: 16 });
  assert.ok(e.quant === 1000 && e.scale === 1 && !e.kerned && e.words === 0);
});

test('layoutLine + lineLayout: a union line — each glyph its own set and law', () => {
  const reg = hmSet(), bold = { ...hmSet(), name: 'hmbd', byPhy: new Map([[0, Object.entries(HM).map(([ch, adv]) => ({ ch, adv: adv * 1.1, phx: 0 }))]]) };
  const mReg = { quant: 1000, scale: 1, kern: new Map([['AB', -0.75]]) }, mBold = { quant: 1000, scale: 1.001, kern: new Map() };
  // "AB" bold, then "BA" regular, laid by the producer as such
  const ents = [];
  let x = 30.07;
  for (const [ch, src, m, st] of [['A', 'hmbd', mBold, bold], ['B', 'hmbd', mBold, bold], [' '], ['B', 'hm', mReg, reg], ['A', 'hm', mReg, reg]]) {
    if (!src) { x += 3.9; continue; }
    if (ents.length && ents[ents.length - 1].src === src && m.kern.get(ents[ents.length - 1].ch + ch)) x += m.kern.get(ents[ents.length - 1].ch + ch);
    ents.push({ i: ents.length < 2 ? ents.length : ents.length + 1, ch, pen: R.snapX(x), adv: R.advanceOf(st, ch), src });
    x += R.lawAdv(R.advanceOf(st, ch), 16, m);
  }
  const bySrc = new Map([['hmbd', { sizePx: 16, m: mBold }], ['hm', { sizePx: 16, m: mReg }]]);
  const ll = R.lineLayout({ entries: ents }, 16, mReg, 4, bySrc);
  assert.ok(ll.feasible && ll.words === 2);
  const lay = R.layoutLine(reg, 'AB BA', ents[0].pen + ll.delta, { metrics: mReg, spaceWidths: ll.spaceWidths,
    glyphSets: [bold, bold, reg, reg], metricsBySet: new Map([['hmbd', mBold], ['hm', mReg]]) });
  assert.deepStrictEqual(lay.glyphs.map(g => g.pen), ents.map(e => e.pen));
  assert.deepStrictEqual(lay.glyphs.map(g => g.set.name), ['hmbd', 'hmbd', 'hm', 'hm']);
});

test('layoutLine: a law (quantization, scale, kern) and per-space widths', () => {
  const set = abcSet();   // adv 6 at 16 px = 375/1000 em exactly: quant leaves it, scale moves it
  const L = R.layoutLine(set, 'AB', 0, { metrics: { quant: 1000, scale: 1.01, kern: new Map([['AB', -0.5]]) } });
  assert.deepStrictEqual(L.glyphs.map(g => +g.penRaw.toFixed(6)), [0, 5.56]);
  assert.deepStrictEqual(L.glyphs.map(g => g.pen), [0, 5.5]);
  const hm = hmSet();
  const Q = R.layoutLine(hm, 'AA', 0, { metrics: { quant: 1000 } });
  assert.ok(Math.abs(Q.glyphs[1].penRaw - 7.104) < 1e-9);          // 444/1000 × 16, not 909/2048 × 16
  const S = R.layoutLine(set, 'A B C A', 0, { spaceAdv: 3, spaceWidths: [4, 2.5] });
  assert.deepStrictEqual(S.glyphs.map(g => g.penRaw), [0, 10, 18.5, 27.5]);   // measured gaps first, spaceAdv after
});
