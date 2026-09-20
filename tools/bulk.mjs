// bulk.mjs — a job over a corpus: every core, persistent workers, resumable.
//
//   node tools/bulk.mjs inventory --in <dir> --out <run dir>
//   node tools/bulk.mjs read      --in <dir> --out <run dir> --roster app --ladder tol0
//   node tools/bulk.mjs read      --in <dir> --out <run dir> --pool nimbus791
//   node tools/bulk.mjs read      --list names.txt --out <run dir> --glyphs cour13,times16+timesbd16
//   node tools/bulk.mjs status    --out <run dir>
//
// inventory  what every page IS — image size, colour, how white, how many text
//            bands, the same pixels elsewhere, the PDF's producer and text
//            layer (tools/bulk/job-inventory.mjs). No glyph set is loaded:
//            milliseconds a page. Run it over everything first; it says where
//            a read is worth its seconds.
// read       the certified read (tools/bulk/job-read.mjs — blind-read.mjs's
//            read on the same core, read-core.mjs), its results kept slim and
//            lossless (tools/bulk/slim.mjs).
//            --ladder tol0 | all   the app's escalating read instead of one
//            flat pass: palette and mixed-font rungs, byte-exact only (tol0) or
//            on to the tolerant rungs (all) — tools/bulk/job-read.mjs.
//            --inventory <inventory run dir>   read only what is rendered text:
//            pages the inventory classes as scan, small, blank or vector are
//            skipped (and recorded as skipped), a document with no rendered
//            page is not opened at all.
//            --page-budget S   seconds a page may take under --ladder (default
//            120; 0 = none): it keeps the best rung that finished.
//
// Which documents:  --in <dir> [--recursive] | --list <file of paths>, then
//   --sample N [--seed S]   N of them, drawn reproducibly (a benchmark is the
//                           same documents every time)
//   --limit N               the first N
//   --shard i/n             every n-th from the i-th (i = 1…n): one corpus
//                           over several machines, no coordination needed
// How:  --workers N (default: every logical CPU)   --timeout <s per document>
//   (default: inventory 120; read 120 + 45 per estimated page)
//   --recycle N   replace a worker after N documents (default 2000)
// On a machine someone is using (defaults chosen after a leak in sixteen
// workers took a desktop session down, 2026-09-20):
//   --nice N          workers' CPU priority (default 10: the desktop wins)
//   --max-rss-mb N    a worker larger than this is replaced (default 1000)
//   --big-mb N        a file larger than this is read one at a time, in a worker
//                     that is replaced afterwards (default 16) — see pool.mjs
//   --cap-gb N        the whole run — coordinator and workers — lives in a
//                     systemd scope the KERNEL holds to N GB (default: half the
//                     machine's RAM; 0 = no scope). Past it, the kernel kills a
//                     worker of THIS run, which the pool replaces; it can no
//                     longer be the desktop that pays. Skipped, with a remark,
//                     where there is no systemd user session.
//   --min-free-gb N   hand out nothing new while the system has less than this
//                     available (default 4); the run waits, it does not die
//
// A run directory is resumable: start the same command again and every name in
// its done.tsv is skipped — finished, failed, timed out or crashed alike. Kill
// it whenever you like. Layout and guarantees: tools/bulk/sink.mjs; the pool
// itself: tools/bulk/pool.mjs.
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { availableParallelism, hostname, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPool } from './bulk/pool.mjs';
import { openSink, streamRecords } from './bulk/sink.mjs';
import { classOf } from './bulk/classify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const JOBS = { inventory: join(HERE, 'bulk', 'job-inventory.mjs'), read: join(HERE, 'bulk', 'job-read.mjs') };

const [cmd, ...argv] = process.argv.slice(2);
const o = { in: null, list: null, out: null, recursive: false, sample: 0, seed: 1, limit: 0, shard: null,
  workers: availableParallelism(), timeout: 0, recycle: 2000, glyphs: null, tol: 0, nice: 10, maxRssMB: 1000, minFreeGB: 4, bigMB: 16, capGB: Math.max(2, Math.floor(totalmem() / 2 ** 31)) };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => argv[++i];
  if (a === '--in') o.in = resolve(next());
  else if (a === '--list') o.list = resolve(next());
  else if (a === '--out') o.out = resolve(next());
  else if (a === '--recursive') o.recursive = true;
  else if (a === '--sample') o.sample = +next();
  else if (a === '--seed') o.seed = +next();
  else if (a === '--limit') o.limit = +next();
  else if (a === '--shard') o.shard = next().split('/').map(Number);
  else if (a === '--workers') o.workers = +next();
  else if (a === '--timeout') o.timeout = +next();
  else if (a === '--recycle') o.recycle = +next();
  else if (a === '--nice') o.nice = +next();
  else if (a === '--max-rss-mb') o.maxRssMB = +next();
  else if (a === '--min-free-gb') o.minFreeGB = +next();
  else if (a === '--big-mb') o.bigMB = +next();
  else if (a === '--cap-gb') o.capGB = +next();
  else if (a === '--glyphs') o.glyphs = next().split(',');
  else if (a === '--tol') o.tol = +next();
  else if (a === '--roster') { const r = next(); if (r !== 'app') die(`unknown roster ${r}; have: app`); o.roster = r; }
  else if (a === '--pool') o.pool = next();
  else if (a === '--shadow') o.shadow = true;
  else if (a === '--quant') o.quant = true;
  else if (a === '--palette') o.palette = true;
  else if (a === '--inventory') o.inventory = resolve(next());
  else if (a === '--page-budget') o.pageBudget = +next();
  else if (a === '--ladder') { o.ladder = next(); if (!['tol0', 'all'].includes(o.ladder)) die('--ladder tol0 | all'); }
  else die(`unknown arg ${a}`);
}
function die(msg) { console.error(msg); process.exit(2); }
if (!['inventory', 'read', 'status'].includes(cmd)) die('usage: node tools/bulk.mjs inventory|read|status --out <run dir> [--in <dir> | --list <file>] …  (see the header)');
if (!o.out) die('need --out <run dir>');

// ---------------- the kernel's cap: run again, inside a scope ----------------
if (cmd !== 'status' && o.capGB > 0 && !process.env.TOL0_BULK_SCOPED && process.platform === 'linux') {
  const scope = ['--user', '--scope', '--quiet'];
  if (spawnSync('systemd-run', [...scope, '--', 'true'], { stdio: 'ignore' }).status === 0) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {});      // the run inside hears it too, and tidies up
    const r = spawnSync('systemd-run', [...scope, '-p', `MemoryMax=${o.capGB}G`, '-p', 'MemorySwapMax=0', '--', process.execPath, ...process.argv.slice(1)],
      { stdio: 'inherit', env: { ...process.env, TOL0_BULK_SCOPED: '1' } });
    process.exit(r.status ?? 1);
  }
  console.error('(no systemd user scope here: running without the kernel memory cap — the pool\'s own limits still hold)');
}

// ---------------- status ----------------
if (cmd === 'status') {
  const p = join(o.out, 'done.tsv');
  if (!existsSync(p)) die(`no done.tsv in ${o.out}`);
  const n = {}; let ms = 0, pages = 0;
  for (const row of readFileSync(p, 'utf8').split('\n')) { const c = row.split('\t'); if (!c[0]) continue; n[c[1]] = (n[c[1]] || 0) + 1; ms += +c[2] || 0; pages += +c[3] || 0; }
  console.log(`${o.out}\n  ` + Object.entries(n).map(([k, v]) => `${k} ${v}`).join(' · ') + ` · ${pages} pages · ${(ms / 3.6e6).toFixed(2)} worker-hours`);
  process.exit(0);
}

// ---------------- which documents ----------------
function listDir(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (o.recursive) listDir(join(dir, e.name), out); }
    else if (/\.pdf$/i.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}
if (!o.in && !o.list) die('need --in <dir> or --list <file of paths>');
let paths = o.list ? readFileSync(o.list, 'utf8').split('\n').map(s => s.trim()).filter(Boolean).map(s => resolve(dirname(o.list), s)) : listDir(o.in);
paths.sort();
if (o.shard) { const [i, n] = o.shard; if (!(i >= 1 && i <= n)) die('--shard i/n needs 1 ≤ i ≤ n'); paths = paths.filter((_, k) => k % n === i - 1); }
if (o.sample && o.sample < paths.length) {
  let s = o.seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = new Set(); while (pick.size < o.sample) pick.add(Math.floor(rnd() * paths.length));
  paths = [...pick].sort((a, b) => a - b).map(k => paths[k]);
}
if (o.limit) paths = paths.slice(0, o.limit);
// the name is the identity (the resume key): the path under --in, or the base name
const nameOf = p => (o.in && p.startsWith(o.in + '/') ? p.slice(o.in.length + 1) : basename(p));

// ---------------- the job's config ----------------
const config = {};
if (cmd === 'read') {
  const reg = await import('./glyph-registry.mjs');
  if (o.pool) {
    const pool = reg.POOLS[o.pool]; if (!pool) die(`unknown pool; have: ${Object.keys(reg.POOLS).join(' ')}`);
    config.glyphs = pool.glyphs.split(','); config.tol = pool.tol ?? o.tol; config.palette = !!pool.palette || o.palette; config.quant = !!pool.quant || o.quant;
  } else {
    config.glyphs = o.glyphs ?? (o.roster === 'app' ? reg.APP_ROSTER : null);
    if (!config.glyphs) die('read needs --roster app, --pool <name> or --glyphs a,b+c');
    config.tol = o.tol; config.palette = o.palette; config.quant = o.quant;
  }
  config.shadow = o.shadow; config.ladder = o.ladder;
  config.pageBudgetS = o.ladder ? (o.pageBudget ?? 120) : 0;
}

const sink = openSink(o.out);
const items = paths.filter(p => !sink.done.has(nameOf(p))).map(p => { const bytes = statSync(p).size; return { name: nameOf(p), path: p, bytes, big: bytes > o.bigMB * 1048576 }; });
const skipped = paths.length - items.length;
// the inventory's word on each page: what is not rendered text is not read
let notText = 0;
if (cmd === 'read' && o.inventory) {
  const want = new Map(items.map(it => [it.name, it]));
  for await (const r of streamRecords(o.inventory)) {
    const it = want.get(r.name); if (!it) continue;
    it.skip = {};
    for (const pg of r.p) { const c = classOf(pg); if (c !== 'rendered') { it.skip[pg.n] = c; notText++; } }
    it.allSkipped = r.p.length > 0 && Object.keys(it.skip).length === r.p.length;
  }
  console.error(`inventory: ${notText} pages of the selected documents are not rendered text and will be skipped`);
}
const timeoutMs = o.timeout ? o.timeout * 1000
  : cmd === 'read' ? it => Math.min(4 * 3600e3, 120e3 + 45e3 * Math.ceil(it.bytes / 15000)) : 120e3;

const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
const bundle = join(REPO, 'assets', 'glyphs', 'glyphs.bin');
// everything a worker imports or loads: checked again by every worker that is
// forked, so one run is one version of the code (tools/bulk/pool.mjs)
const guard = [JOBS[cmd], join(HERE, 'bulk', 'worker.mjs'), join(HERE, 'rasterize-mupdf.mjs'),
  ...(cmd === 'read' ? [join(HERE, 'read-core.mjs'), join(HERE, 'bulk', 'slim.mjs'), join(HERE, 'glyph-bundle.mjs'), join(REPO, 'engine', 'ocr-engine.js'), join(REPO, 'engine', 'blindocr.js'), bundle] : [])]
  .filter(existsSync).map(path => ({ path, sha: sha(path) }));
sink.logRun({ job: cmd, started: new Date().toISOString(), host: hostname(), node: process.version, workers: o.workers,
  limits: { nice: o.nice, maxRssMB: o.maxRssMB, minFreeGB: o.minFreeGB, bigMB: o.bigMB, capGB: process.env.TOL0_BULK_SCOPED ? o.capGB : 0 },
  source: o.in ?? o.list, selection: { sample: o.sample || undefined, seed: o.sample ? o.seed : undefined, limit: o.limit || undefined, shard: o.shard?.join('/') },
  documents: paths.length, alreadyDone: skipped, config,
  versions: { job: sha(JOBS[cmd]), engine: sha(join(REPO, 'engine', 'ocr-engine.js')), readCore: sha(join(HERE, 'read-core.mjs')),
    ...(cmd === 'read' && existsSync(bundle) ? { bundle: sha(bundle) } : {}) } });

console.error(`${cmd}: ${paths.length} documents${skipped ? `, ${skipped} already done` : ''}, ${items.length} to go · ${o.workers} workers → ${o.out}`);
const { brief } = await import(JOBS[cmd]);
const errFd = openSync(join(o.out, 'workers.log'), 'a');
let pages = 0, lastPrint = 0;
const fmt = s => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(0)} s`);
let tot, stopped = false;
try { const run = runPool({
  jobPath: JOBS[cmd], config, items, workers: o.workers, recycleAfter: o.recycle, timeoutMs, guard, stderrFd: errFd,
  nice: o.nice, maxRssMB: o.maxRssMB, minFreeMB: o.minFreeGB * 1024,
  onResult({ item, status, ms, result, error }) {
    const b = result ? brief(result) : [error ?? ''];
    if (result) pages += +b[0] || 0;
    sink.write(item.name, status, ms, result ?? null, b);
  },
  onProgress(t) {
    const now = Date.now(); if (now - lastPrint < 1000 && t.done < t.items) return; lastPrint = now;
    const el = (now - t.startedAt) / 1000, rate = t.done / el;
    process.stderr.write(`\r  ${t.done}/${t.items}  ${rate.toFixed(1)} docs/s  ${(pages / el).toFixed(1)} pages/s  ETA ${fmt((t.items - t.done) / (rate || 1))}` +
      `  · error ${t.error} timeout ${t.timeout} crash ${t.crash}` + (t.poisoned + t.fat ? ` · ${t.poisoned + t.fat} workers replaced` : '') +
      (t.paused ? ' · PAUSED: memory low' : '') + '   ');
  },
});
  // Ctrl-C / kill: take the workers down with us, keep what finished
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopped = true; run.abort(); });
  tot = await run;
} catch (e) {
  await sink.close(); closeSync(errFd);
  console.error(`\n${cmd} stopped${stopped ? '' : ': ' + e.message}\n  what finished is kept — the same command resumes it`);
  process.exit(stopped ? 130 : 2);
}
await sink.close(); closeSync(errFd);
const el = (Date.now() - tot.startedAt) / 1000;
process.stderr.write('\n');
console.log(`${cmd}: ${tot.ok} ok, ${tot.error} error, ${tot.timeout} timeout, ${tot.crash} crash` + (tot.poisoned + tot.fat ? `, ${tot.poisoned + tot.fat} workers replaced (${tot.poisoned} spent, ${tot.fat} over the memory ceiling)` : '') + ` — ${pages} pages in ${fmt(el)}` +
  ` (${(tot.done / el).toFixed(1)} docs/s, ${(pages / el).toFixed(1)} pages/s, ${o.workers} workers)`);
process.exit(tot.error || tot.timeout || tot.crash ? 1 : 0);
