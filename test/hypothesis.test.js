// ---------------------------------------------------------------------------
// hypothesis.test.js — engine/hypothesis.js on synthetic pages: a candidate
// string drawn where a hidden name sits, the bar composited over it bar-last
// through the law, and the page outside the bar's body judging it.
//
//     node test/hypothesis.test.js
//
// Two named cases from guide/plugins/redaction-refiner/pixel-evidence-plan.md:
// the A/Æ tie (a bar that hides the difference leaves both consistent — the
// premise of the plan, asserted) and the LAWS §8 page (an A under a 187 edge,
// the truth consistent and a decoy of equal advance contradicted).
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine/ocr-engine.js');
const R = require('../engine/render.js');
const Hy = require('../engine/hypothesis.js');

const ALPHA = { '#': 255, '+': 128, '~': 55, '.': 0 };
const gbOf = a => { const e = a + (a >> 7); return (255 * (256 - e)) >> 8; };
function makeGlyph(ch, pattern, { dy, adv, dx = 0, phx = 0 }) {
  const h = pattern.length, w = pattern[0].length;
  const bytes = new Uint8Array(w * h).fill(255), alpha = new Uint8Array(w * h);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const a = ALPHA[pattern[r][c]];
      if (a) { alpha[r * w + c] = a; bytes[r * w + c] = gbOf(a); }
    }
  const ink = []; let inkLeft = w;
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
function makeSet(name, glyphs) {
  let maxAsc = 0, maxDesc = 0;
  for (const g of glyphs) { maxAsc = Math.max(maxAsc, -g.dy); maxDesc = Math.max(maxDesc, g.dy + g.h); }
  return { name, sizePx: 16, linear: false, byPhy: new Map([[0, glyphs]]), maxAsc, maxDesc };
}
const makePage = (w, h) => ({ w, h, gray: new Uint8Array(w * h).fill(255) });
function drawGlyph(page, g, pen, baseline) {
  for (let k = 0; k < g.inkC.length; k++) {
    const x = pen + g.dx + g.inkC[k], y = baseline + g.dy + g.inkR[k];
    const a = g.inkA[k], e = a + (a >> 7);
    page.gray[y * page.w + x] = (page.gray[y * page.w + x] * (256 - e)) >> 8;
  }
}
// the bar, drawn LAST over the page: black body from xe+1, an edge column of
// byte E at xe (page byte × k, (255·k)>>8 = E), AA rows of 187 above and below
function drawBar(page, xe, x1, y0, y1, E) {
  const kOf = Ev => { for (let k = 1; k <= 256; k++) if (((255 * k) >> 8) === Ev) return k; throw new Error('k'); };
  const k = kOf(E), kAA = kOf(187);
  for (let y = y0; y < y1; y++)
    for (let x = xe; x < x1; x++) {
      const i = y * page.w + x;
      if (y === y0 || y === y1 - 1) page.gray[i] = (page.gray[i] * kAA) >> 8;
      else if (x === xe) page.gray[i] = (page.gray[i] * k) >> 8;
      else page.gray[i] = 0;
    }
}

// the 6-wide test letters, drawn in HALF ink (a pure-black pixel composites
// to 0 under any edge, which is what another bar's body looks like too, so
// black under an edge is destroyed by rule; gray pixels carry the evidence):
// A and Æ agree on their first two columns; D6 has A's advance and a
// different first column
const A6 = ['.++++.', '+....+', '++++++', '+....+', '+....+'];
const AE6 = ['.++++.', '+.++++', '++++++', '+.++++', '+.++++'];
const D6 = ['++++..', '+...+.', '+....+', '+...+.', '++++..'];
const B3 = ['##.', '#.#', '##.', '#.#', '##.'];
function testSet() {
  return makeSet('synth', [makeGlyph('A', A6, { dy: -5, adv: 8 }), makeGlyph('Æ', AE6, { dy: -5, adv: 8 }),
    makeGlyph('D', D6, { dy: -5, adv: 8 }), makeGlyph('B', B3, { dy: -5, adv: 6 })]);
}
// a row "B <hidden> B": the left B at pen 20 (advance 6, space 4 → the name
// starts at pen 30), the right B at pen 30 + advanceW + 4; the bar runs from
// its edge column xe to the right B (a box needs ≥ 9 px of body to be
// detected on the small-box path and a bar of 40 px takes the long-run path
// the reader's real bars take, so the hidden strings below are six letters)
function rowPage(set, hidden, E, xe, W = 160) {
  const page = makePage(W, 40);
  const g = ch => set.byPhy.get(0).find(r => r.ch === ch);
  const lay = R.layoutLine(set, hidden, 30, { spaceAdv: 4 });
  drawGlyph(page, g('B'), 20, 20);
  for (const gl of lay.glyphs) drawGlyph(page, g(gl.ch), gl.pen, 20);
  const penRight = 30 + lay.advanceW + 4;
  drawGlyph(page, g('B'), penRight, 20);
  drawBar(page, xe, penRight - 1, 9, 29, E);                          // the bar stops short of the right B
  const det = E_detect(page);
  const boxObj = det.objects.find(o => o.type === 'box');
  const line = { baseline: 20, phy: 0, tol: 0, spaceLine: 4, penLeft: 26, penRight, top: 15, bot: 20 };
  const neighbours = R.renderLine(set, [{ ch: 'B', pen: 20 }, { ch: 'B', pen: penRight }], 20, {});
  return { page, det, boxObj, line, neighbours, penRight };
}
const E_detect = page => E.detectObjects(page);

test('the A/Æ tie: a bar that hides the difference leaves both consistent, and the tie is reported', () => {
  const set = testSet();
  // the page holds "ÆB…"; the bar starts at column 31 with a DARK edge (74)
  // on the letters' shared second column, one open column — the differing
  // columns 32–35 are under the body (a dark edge judges too, with a byte of
  // slack, so it must sit where the letters agree for the tie to hold)
  const { page, det, boxObj, line, neighbours } = rowPage(set, 'ÆBABAB', 74, 31);
  assert.ok(boxObj, 'the bar is detected as a box');
  const opts = { explained: [neighbours], minInk: 4 };
  const a = Hy.testHypothesis(page, det, set, line, boxObj, 'ABABAB', opts);
  const ae = Hy.testHypothesis(page, det, set, line, boxObj, 'ÆBABAB', opts);
  assert.strictEqual(a.verdict, 'consistent', JSON.stringify(a.open) + ' ' + a.unexplained);
  assert.strictEqual(ae.verdict, 'consistent');
  assert.deepStrictEqual(a.open, ae.open, 'the same open pixels judge both');
  assert.strictEqual(a.edge.ink, 0, 'a dark edge is not a light edge');
  assert.ok(a.dark.ink > 0 && a.dark.differ === 0, 'the dark edge judged the shared column and agreed');
  // a name whose first column differs is contradicted on the open page
  const d = Hy.testHypothesis(page, det, set, line, boxObj, 'DBABAB', opts);
  assert.strictEqual(d.verdict, 'contradicted');
  assert.ok(d.open.differ > 0);
  // the width equation: all three fit the pens to the lattice
  for (const v of [a, ae, d]) assert.ok(Math.abs(v.penFit) < 1e-9, 'penFit ' + v.penFit);
});

test('the §8 page: A under a 187 edge — the truth consistent, a decoy of equal advance contradicted', () => {
  const set = testSet();
  // two open columns (30, 31), the light edge at 32: A's third column composites
  const { page, det, boxObj, line, neighbours } = rowPage(set, 'ABABAB', 187, 32);
  const opts = { explained: [neighbours], minInk: 6 };
  const a = Hy.testHypothesis(page, det, set, line, boxObj, 'ABABAB', opts);
  assert.strictEqual(a.verdict, 'consistent', JSON.stringify({ open: a.open, edge: a.edge, un: a.unexplained }));
  assert.ok(a.edge.ink > 0 && a.edge.differ === 0, 'the edge composite judges and matches');
  assert.strictEqual(a.unexplained, 0);
  const d = Hy.testHypothesis(page, det, set, line, boxObj, 'DBABAB', opts);
  assert.strictEqual(d.verdict, 'contradicted');
  // Æ differs from A only under the edge here: its column 2 has ink on rows
  // 1, 3, 4 where the page holds the bare edge byte — the light edge tells
  const ae = Hy.testHypothesis(page, det, set, line, boxObj, 'ÆBABAB', opts);
  assert.strictEqual(ae.verdict, 'contradicted');
  assert.ok(ae.edge.differ > 0);
});

test('the evidence floor: little ink is no-evidence, and a set without the glyph says so', () => {
  const set = testSet();
  const { page, det, boxObj, line, neighbours } = rowPage(set, 'ABABAB', 187, 32);
  const a = Hy.testHypothesis(page, det, set, line, boxObj, 'ABABAB', { explained: [neighbours], minInk: 12 });   // 8 px judged, under a floor of 12
  assert.strictEqual(a.verdict, 'no-evidence');
  assert.strictEqual(a.reason, 'below-floor');
  assert.strictEqual(a.open.differ + a.edge.differ + a.unexplained, 0);
  const z = Hy.testHypothesis(page, det, set, line, boxObj, 'ZBABAB', { explained: [neighbours] });
  assert.strictEqual(z.verdict, 'no-evidence');
  assert.deepStrictEqual(z.missing, ['Z']);
});

test('hidden ink the candidate does not draw is unexplained: a shorter name is contradicted', () => {
  const set = testSet();
  // the page holds "AB" with two open columns; the candidate "A" is one B
  // short of the right neighbour — the width equation (penFit) reports it,
  // the pixels alone cannot (B is under the body)
  const { page, det, boxObj, line, neighbours } = rowPage(set, 'ABABAB', 187, 32);
  const one = Hy.testHypothesis(page, det, set, line, boxObj, 'ABABA', { explained: [neighbours], minInk: 6 });
  assert.ok(Math.abs(one.penFit + 6) < 1e-9, 'one B short of the right neighbour: ' + one.penFit);
  const two = Hy.testHypothesis(page, det, set, line, boxObj, 'ABABAB', { explained: [neighbours], minInk: 6 });
  assert.strictEqual(two.verdict, 'consistent');
  assert.ok(Math.abs(two.penFit) < 1e-9);
});

test('edgePreds: white under a light edge predicts the edge byte; linear law keeps the shifts', () => {
  assert.deepStrictEqual(Hy.edgePreds(255, 187, false), [187]);
  assert.deepStrictEqual(Hy.edgePreds(255, 196, true), [196, 195]);
  // report's clipped S under its 196 edge (LAWS §8): 223 → 171, 31 → 24, 49 → 38, 0 → 0, 231 → 177
  assert.ok(Hy.edgePreds(223, 196, true).includes(171));
  assert.ok(Hy.edgePreds(31, 196, true).includes(24));
  assert.ok(Hy.edgePreds(49, 196, true).includes(38));
  assert.ok(Hy.edgePreds(0, 196, true).includes(0));
  assert.ok(Hy.edgePreds(231, 196, true).includes(177));
});
