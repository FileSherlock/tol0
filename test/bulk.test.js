// bulk.test.js — the corpus runner (tools/bulk/): a pool that settles every
// document exactly once whatever a worker does, an output that survives being
// killed, a slim encoding that loses nothing, and — where a gate document is
// on this machine — a bulk read that IS blind-read's read.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const REPO = join(__dirname, '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'tol0-bulk-'));

// a job that does what the corpus does to a reader: answers, throws, never comes back, dies
const TOY = `
let started = 0;
export const init = () => { started++; return { started }; };
export async function run(item) {
  if (item.name.startsWith('hang')) for (;;) {}
  if (item.name.startsWith('crash')) process.exit(3);
  if (item.name.startsWith('throw')) throw new Error('cannot read ' + item.name);
  return { name: item.name, pid: process.pid, started };
}`;

test('pool: every document is settled exactly once — answered, thrown, timed out or crashed — and what was only queued behind a dead worker is still read', async () => {
  const { runPool } = await import('../tools/bulk/pool.mjs');
  const dir = tmp(), jobPath = join(dir, 'toy.mjs');
  writeFileSync(jobPath, TOY);
  const names = ['a', 'b', 'hang1', 'c', 'd', 'crash1', 'e', 'throw1', 'f', 'g', 'h', 'i'];
  const seen = new Map();
  const tot = await runPool({ jobPath, items: names.map(name => ({ name })), workers: 2, prefetch: 4, timeoutMs: 700,
    onResult: r => { assert.ok(!seen.has(r.item.name), `${r.item.name} settled twice`); seen.set(r.item.name, r); } });
  assert.strictEqual(seen.size, names.length);
  assert.strictEqual(seen.get('hang1').status, 'timeout');
  assert.strictEqual(seen.get('crash1').status, 'crash');
  assert.strictEqual(seen.get('throw1').status, 'error');
  assert.match(seen.get('throw1').error, /cannot read throw1/);
  for (const n of names.filter(n => /^[a-i]$/.test(n))) assert.strictEqual(seen.get(n).status, 'ok', n);
  assert.deepStrictEqual([tot.ok, tot.error, tot.timeout, tot.crash, tot.respawns], [9, 1, 1, 1, 2]);
  // persistent: a worker starts its job once, however many documents it takes
  for (const r of seen.values()) if (r.status === 'ok') assert.strictEqual(r.result.started, 1);
  rmSync(dir, { recursive: true });
});

// a process whose heap is spent fails everything after it, fast; one that grows is a leak
const SPENT = `
let n = 0;
export const poisoned = e => /malloc/.test(e.message);
export async function run(item) {
  n++;
  if (item.name === 'always') throw new Error('malloc (9 bytes) failed');
  if (n > 2) throw new Error('malloc (66000 bytes) failed');       // this process is done for after two documents
  return { name: item.name, pid: process.pid };
}`;

test('pool: a spent worker is replaced at once and its document read by a fresh one — once', async () => {
  const { runPool } = await import('../tools/bulk/pool.mjs');
  const dir = tmp(), jobPath = join(dir, 'spent.mjs');
  writeFileSync(jobPath, SPENT);
  const names = [...'abcdefghij', 'always'];
  const seen = new Map();
  const tot = await runPool({ jobPath, items: names.map(name => ({ name })), workers: 1, prefetch: 3,
    onResult: r => { assert.ok(!seen.has(r.item.name)); seen.set(r.item.name, r); } });
  for (const n of 'abcdefghij') assert.strictEqual(seen.get(n).status, 'ok', `${n} was read, by a fresh worker if need be`);
  assert.strictEqual(seen.get('always').status, 'error', 'a document that spends every worker is an error after one retry');
  assert.strictEqual(tot.error, 1);
  assert.ok(tot.poisoned >= 5, 'two documents a worker, then a new one');
  assert.strictEqual(new Set([...seen.values()].filter(r => r.result).map(r => r.result.pid)).size, 5);
  rmSync(dir, { recursive: true });
});

test('pool: a worker over its memory ceiling is replaced, its answer kept; a changed file stops the run; workers die with the coordinator', async () => {
  const { runPool } = await import('../tools/bulk/pool.mjs');
  const dir = tmp(), jobPath = join(dir, 'toy.mjs');
  writeFileSync(jobPath, TOY);
  const pids = new Set();
  const tot = await runPool({ jobPath, items: Array.from({ length: 6 }, (_, i) => ({ name: 'n' + i })), workers: 1, maxRssMB: 1,
    onResult: r => { assert.strictEqual(r.status, 'ok'); pids.add(r.result.pid); } });
  assert.deepStrictEqual([tot.ok, tot.fat, pids.size], [6, 6, 6], 'every document answered, every answer from a new process');
  // one version per run
  await assert.rejects(runPool({ jobPath, items: [{ name: 'a' }], workers: 1, guard: [{ path: jobPath, sha: '0000' }] }), /changed since this run started/);
  // orphans: kill a coordinator mid-run, its workers must not outlive it
  const script = join(dir, 'coord.mjs');
  writeFileSync(script, `import { runPool } from ${JSON.stringify(join(REPO, 'tools', 'bulk', 'pool.mjs'))};
    runPool({ jobPath: ${JSON.stringify(jobPath)}, items: [{ name: 'hang-forever' }], workers: 2, timeoutMs: 600000 });
    setTimeout(() => process.exit(0), 600000);`);
  const { spawn } = require('node:child_process');
  const coord = spawn(process.execPath, [script], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
  const kids = () => execFileSync('pgrep', ['-P', String(coord.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const workers = kids();
  assert.ok(workers.length >= 1, 'the coordinator forked workers');
  coord.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 1500));
  // the hanging one cannot hear the disconnect (it never yields) — that is what the timeout is for in a live run; the idle one must be gone
  const alive = workers.filter(pid => { try { process.kill(+pid, 0); return true; } catch { return false; } });
  for (const pid of alive) process.kill(+pid, 'SIGKILL');
  assert.ok(alive.length <= 1, `idle workers exit with their coordinator (left: ${alive.length})`);
  rmSync(dir, { recursive: true });
});

test('pool: huge documents are read one at a time, each alone in a worker that is then replaced — beside the rest, not after it', async () => {
  const { runPool } = await import('../tools/bulk/pool.mjs');
  const dir = tmp(), jobPath = join(dir, 'lane.mjs');
  writeFileSync(jobPath, `export async function run(item) { const t0 = Date.now(); await new Promise(r => setTimeout(r, item.big ? 120 : 15)); return { name: item.name, pid: process.pid, t0, t1: Date.now() }; }`);
  const items = Array.from({ length: 60 }, (_, i) => ({ name: 'n' + i, big: i % 20 === 5 }));      // three big ones among sixty
  const res = [];
  const tot = await runPool({ jobPath, items, workers: 3, prefetch: 4, onResult: r => res.push({ ...r.result, big: r.item.big, at: res.length }) });
  assert.deepStrictEqual([tot.ok, tot.big], [60, 3]);
  const big = res.filter(r => r.big), small = res.filter(r => !r.big);
  for (const b of big) {
    assert.ok(!small.some(s => s.pid === b.pid && s.t0 >= b.t0), 'nothing is read by that worker after a big document');
    assert.ok(!big.some(o => o !== b && o.t0 < b.t1 && b.t0 < o.t1), 'never two big documents at once');
    assert.ok(small.some(s => s.t0 < b.t1 && b.t0 < s.t1), 'the rest goes on beside it');
  }
  assert.ok(big[0].at < 40, 'the lane starts early, it is not a tail');
  rmSync(dir, { recursive: true });
});

test('pool: a worker is replaced after recycleAfter documents', async () => {
  const { runPool } = await import('../tools/bulk/pool.mjs');
  const dir = tmp(), jobPath = join(dir, 'toy.mjs');
  writeFileSync(jobPath, TOY);
  const pids = new Set();
  const tot = await runPool({ jobPath, items: Array.from({ length: 10 }, (_, i) => ({ name: 'n' + i })), workers: 1, recycleAfter: 3,
    onResult: r => pids.add(r.result.pid) });
  assert.strictEqual(tot.ok, 10);
  assert.strictEqual(pids.size, 4, '3 + 3 + 3 + 1');
  assert.strictEqual(tot.respawns, 0, 'a recycled worker is not a crash');
  rmSync(dir, { recursive: true });
});

test('sink: parts rotate and gzip, the index is the resume list, the last record of a name wins', async () => {
  const { openSink, readRecords } = await import('../tools/bulk/sink.mjs');
  const dir = tmp();
  let s = openSink(dir, { partBytes: 200 });
  for (let i = 0; i < 6; i++) s.write('d' + i, 'ok', 5, { name: 'd' + i, v: 'x'.repeat(60), run: 1 }, [1]);
  s.write('bad', 'timeout', 700, null, ['']);
  await s.close();
  assert.ok(readdirSync(dir).some(f => f.endsWith('.jsonl.gz')), 'a closed part is gzipped');
  // killed after the record, before its index row: the document is read again
  s = openSink(dir, { partBytes: 200 });
  assert.deepStrictEqual([...s.done.keys()].sort(), ['bad', 'd0', 'd1', 'd2', 'd3', 'd4', 'd5']);
  assert.strictEqual(s.done.get('bad'), 'timeout', 'a timed-out document is done too — not retried forever');
  s.write('d2', 'ok', 5, { name: 'd2', v: 'again', run: 2 }, [1]);
  await s.close();
  const recs = readRecords(dir);
  assert.strictEqual(recs.size, 6);
  assert.strictEqual(recs.get('d2').run, 2);
  rmSync(dir, { recursive: true });
});

test('slim: a page comes back exactly — keys, order, pens, clips — and what does not fit the mould is left alone', async () => {
  const { slimPage, expandPage } = await import('../tools/bulk/slim.mjs');
  const page = { pno: 3, spaceAdv: 7.75, objects: [{ y0: 1, y1: 2, x0: 3, x1: 4, type: 'box' }], lines: [
    { baseline: 68, phy: 0, font: 'timesbd16', text: 'From: fi', fails: 0, failCols: [], boxes: [[128, 315]], oddGaps: 0,
      boxFrags: [125], glyphs: [['F', 76.75], ['r', 86.5], ['o', 93.25, 3], ['m', 101], ['ﬁ', 120.5]] },
    { top: 90, text: '', unread: true, colour: true },
    { top: 95, fragOnly: true },
    { baseline: 120, phy: 0.5, font: 'x', text: 'a', fails: 1, failCols: [[5, 9]], boxes: [], oddGaps: 0, glyphs: [['a', 10.1], ['b', 12]] },   // off the lattice
    { baseline: 140, phy: 0, font: 'x', text: '', fails: 0, failCols: [], boxes: [], oddGaps: 0, glyphs: [] },
  ] };
  const slim = slimPage(page);
  assert.ok(slim.lines[0].g === 'Fromﬁ' && !slim.lines[0].glyphs, 'a lattice line is slimmed');
  assert.deepStrictEqual(slim.lines[0].c, { 2: 3 });
  assert.ok(slim.lines[3].glyphs, 'a pen off the ¼-px lattice keeps its glyphs');
  assert.strictEqual(JSON.stringify(expandPage(JSON.parse(JSON.stringify(slim)))), JSON.stringify(page));
  assert.ok(JSON.stringify(slim).length < JSON.stringify(page).length);
});

const doc = join(REPO, 'fixtures', 'corpus', 'nimbus791', 'EFTA00751637.pdf');
const bundle = join(REPO, 'assets', 'glyphs', 'glyphs.bin');
test('bulk read IS blind-read: same pages from a persistent worker, no raster cache in between', { skip: !existsSync(doc) || !existsSync(bundle) ? 'needs fixtures/corpus/nimbus791/EFTA00751637.pdf and the bundle' : false }, async () => {
  const { readRecords } = await import('../tools/bulk/sink.mjs');
  const { expandPage } = await import('../tools/bulk/slim.mjs');
  const dir = tmp(), list = join(dir, 'list.txt');
  writeFileSync(list, doc + '\n');
  execFileSync(process.execPath, ['tools/bulk.mjs', 'read', '--list', list, '--out', join(dir, 'run'), '--pool', 'nimbus791', '--workers', '1'], { cwd: REPO, stdio: 'ignore' });
  execFileSync(process.execPath, ['tools/rasterize-mupdf.mjs', '--pdf', doc, '--quiet'], { cwd: REPO, stdio: 'ignore' });
  execFileSync(process.execPath, ['tools/blind-read.mjs', '--pdf', doc, '--all', '--pool', 'nimbus791', '--json', join(dir, 'cli.json')], { cwd: REPO, stdio: 'ignore' });
  const rec = readRecords(join(dir, 'run')).get('EFTA00751637.pdf');
  const cli = JSON.parse(readFileSync(join(dir, 'cli.json'), 'utf8')).pages;
  assert.strictEqual(JSON.stringify(rec.p.map(expandPage)), JSON.stringify(cli));
  assert.strictEqual(rec.tot.fails, 0, 'a gate document with 0 □');
  assert.strictEqual(rec.tot.clean, rec.tot.lines);
  // the ladder on a page the first rung reads whole: the same lines, and the record says which rung
  execFileSync(process.execPath, ['tools/bulk.mjs', 'read', '--list', list, '--out', join(dir, 'ladder'), '--glyphs', 'nimbus791', '--ladder', 'tol0', '--workers', '1', '--cap-gb', '0'], { cwd: REPO, stdio: 'ignore' });
  const lad = readRecords(join(dir, 'ladder')).get('EFTA00751637.pdf');
  assert.ok(lad.p.every(P => P.pass === '0|0|0'), 'the plain rung reads it; nothing stronger was tried');
  assert.strictEqual(JSON.stringify(lad.p.map(expandPage).map(P => P.lines.map(L => [L.baseline, L.text, L.fails]))),
    JSON.stringify(cli.map(P => P.lines.map(L => [L.baseline, L.text, L.fails]))));
  const again = execFileSync(process.execPath, ['tools/bulk.mjs', 'read', '--list', list, '--out', join(dir, 'run'), '--pool', 'nimbus791', '--workers', '1'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(again, /read: 0 ok/);
  rmSync(dir, { recursive: true });
});
