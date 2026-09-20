// pool.mjs — one job over many documents, on every core, for as long as it takes.
//
// blind-read.mjs is one document in one process: it pays the process start and
// the glyph sets again for every document (1.3 s with the app's 22 sets,
// measured 2026-09 — a quarter of a pass over a corpus whose median document is
// one page) and uses one core of sixteen. The pool forks N PERSISTENT workers
// (worker.mjs): each loads its job once — sets, tables, wasm — and then takes
// documents until the list is empty.
//
// What a year-long run needs, and why each is here:
//   processes, not threads   a worker that stops answering is KILLED and
//                            replaced. The reader has met pages it does not
//                            come back from (a garbage palette LUT, EFTA00039421);
//                            a thread stuck in a loop can be terminated too, but
//                            a process also gives its wasm heap back.
//   a timeout per document   the document a worker was ON when it timed out or
//                            died is recorded as such and never retried by this
//                            run; what it had only been handed goes back in the
//                            queue.
//   recycling                a worker is replaced after `recycleAfter`
//                            documents, so a slow leak cannot grow for a week.
//   one writer               workers return results over IPC; only the
//                            coordinator touches the output (sink.mjs), so
//                            a line is never torn and the index never lies.
//   resume                   the caller passes the names already done; they are
//                            skipped. Kill the run whenever you like.
//   poisoned workers         a job may export poisoned(error): "this process is
//                            spent" — mupdf's wasm heap exhausted, say, after
//                            which EVERY document fails in milliseconds and one
//                            worker can burn through thousands (2026-09: 1,400
//                            of the first 17,000). Such a worker is retired at
//                            once, and the document it failed gets ONE more try
//                            on a fresh one; failing there too, it is an error.
//   a machine someone uses   workers run at `nice` (default 10: the desktop
//                            always wins the CPU), are replaced when their
//                            resident memory passes `maxRssMB` (default 1000),
//                            and nothing new is handed out while the system
//                            has less than `minFreeMB` available (default 4096)
//                            — a leak must never again reach the OOM killer,
//                            which does not kill the leak, it kills the session.
//                            Workers exit when the coordinator does.
//   huge documents           mupdf copies a file whole into its wasm heap, and a
//                            wasm heap grows but never shrinks: a 100 MB PDF
//                            costs ~600 MB that the process keeps, and a few of
//                            them in one worker fragment the heap to its 2 GB
//                            end. An item marked `big` is read ONE at a time,
//                            alone in its worker, and that worker is replaced
//                            afterwards — its memory goes back to the system.
//   one version per run      `guard` lists the files a run stands on with their
//                            hashes. Workers are forked all through a run
//                            (recycling, crashes) and import what is on disk
//                            THEN — edit a job mid-run and half the results come
//                            from other code. A worker whose files do not match
//                            refuses to start, and the run stops, loudly.
//
// runPool({ jobPath, config, items, workers, prefetch, recycleAfter, timeoutMs,
//           guard, onResult, onProgress, stderrFd }) → totals
//   guard       [{ path, sha }] — sha256 hex prefixes; see "one version per run"
//   items       [{ name, path, ... }] — `name` is the identity (resume key)
//   timeoutMs   number | item => number
//   onResult    ({ item, status: 'ok'|'error'|'timeout'|'crash', ms, result?, error? }) — sync
// A job module exports  init(config) → anything  and  run(item, config) → result
// (JSON-serializable). See job-inventory.mjs and job-read.mjs.
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'worker.mjs');

export function runPool({ jobPath, config = {}, items, workers = availableParallelism(), prefetch = 4,
  recycleAfter = 2000, timeoutMs = 120000, guard = [], nice = 10, maxRssMB = 1000, minFreeMB = 4096,
  onResult, onProgress, stderrFd = 'ignore' }) {
  const timeoutOf = typeof timeoutMs === 'function' ? timeoutMs : () => timeoutMs;
  const queue = items.filter(it => !it.big).reverse();  // pop() takes them in order
  const bigQueue = items.filter(it => it.big).reverse();
  let bigInFlight = 0, draining = null;                // draining: the worker emptying its window to take the next big one
  const left = () => queue.length + bigQueue.length;
  const tot = { items: items.length, done: 0, ok: 0, error: 0, timeout: 0, crash: 0, respawns: 0, poisoned: 0, fat: 0, big: 0, paused: false, startedAt: Date.now() };
  const live = new Set();
  let finish, failed = null;
  const whenDone = new Promise((res, rej) => { finish = () => { clearInterval(nudge); failed ? rej(failed) : res(tot); }; });

  // MemAvailable, not MemFree: what the kernel says it can still give out
  const availableMB = () => { try { return +/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))[1] / 1024; } catch { return Infinity; } };
  let lastMemCheck = 0, lowMem = false;
  const memoryOk = () => {
    const now = Date.now();
    if (now - lastMemCheck > 500) { lastMemCheck = now; lowMem = availableMB() < minFreeMB; tot.paused = lowMem; }
    return !lowMem;
  };
  const nudge = setInterval(() => { if (memoryOk()) for (const w of live) feed(w); }, 2000);

  const putBack = it => (it.big ? bigQueue : queue).push(it);
  const settle = (item, status, ms, extra) => {
    tot.done++; tot[status]++;
    if (item.big) bigInFlight--;
    try { onResult?.({ item, status, ms, ...extra }); } catch (e) { failed ??= e; }
    onProgress?.(tot);
  };

  function spawn() {
    const child = fork(WORKER, [jobPath], { stdio: ['ignore', 'ignore', stderrFd, 'ipc'], serialization: 'advanced' });
    try { if (nice) setPriority(child.pid, nice); } catch {}
    const w = { child, inflight: [], taken: 0, ready: false, timer: null, startedItemAt: 0, retiring: false, dead: false, timedOut: false };
    live.add(w);
    child.on('message', m => {
      if (m.type === 'ready') { w.ready = true; feed(w); return; }
      if (m.type === 'fatal') { failed ??= new Error(`job failed to start: ${m.error}`); retire(w); return; }
      if (m.type !== 'done' || w.retiring || !w.inflight.length) return;   // a worker on its way out has nothing left to say
      const item = w.inflight.shift();
      const ms = Date.now() - w.startedItemAt;
      if (m.poisoned) {
        // the process is spent: what it was handed goes back, it goes away
        tot.poisoned++;
        for (const it of w.inflight.reverse()) putBack(it);
        w.inflight = [];
        if (item.retried) settle(item, 'error', ms, { error: m.error });
        else { item.retried = true; if (item.big) bigInFlight--; putBack(item); }
        retire(w);
        return;
      }
      arm(w);
      settle(item, m.ok ? 'ok' : 'error', ms, m.ok ? { result: m.result } : { error: m.error });
      if (failed) { for (const o of live) retire(o); return; }   // the sink refused a result: stop, loudly
      if (item.big) { tot.big++; retire(w); return; }    // its heap has grown for good: give the memory back
      if (m.fat) {                                       // over its memory ceiling: what it holds goes back
        tot.fat++;
        for (const it of w.inflight.reverse()) putBack(it);
        w.inflight = []; retire(w); return;
      }
      if (w.taken >= recycleAfter && !w.inflight.length) { retire(w); return; }
      feed(w);
    });
    child.on('exit', () => {
      if (w.dead) return;
      w.dead = true; clearTimeout(w.timer); live.delete(w);
      if (draining === w) draining = null;
      if (!w.retiring) {
        // it died on the document at the head; the rest had only been handed over
        const [head, ...rest] = w.inflight;
        if (head) settle(head, w.timedOut ? 'timeout' : 'crash', Date.now() - w.startedItemAt);
        for (const it of rest.reverse()) putBack(it);
        tot.respawns++;
      }
      w.inflight = [];
      if (failed) { for (const o of live) retire(o); if (!live.size) finish(); return; }
      if (left()) { spawn(); for (const o of live) feed(o); }
      else if (!live.size) finish();
    });
    child.send({ type: 'init', config, guard, maxRssMB });
  }

  // the clock runs for the document at the head of a worker's window
  function arm(w) {
    clearTimeout(w.timer);
    if (!w.inflight.length) return;
    w.startedItemAt = Date.now();
    w.timer = setTimeout(() => { w.timedOut = true; w.child.kill('SIGKILL'); }, timeoutOf(w.inflight[0]));
  }

  function feed(w) {
    if (!w.ready || w.retiring || w.dead) return;
    const wasIdle = !w.inflight.length;
    // a huge document: one in the whole pool, alone in an idle worker. Windows
    // are topped up after every answer, so no worker is ever idle by chance:
    // ONE is told to drain — it takes nothing more until it is empty, then the
    // big one — and the lane runs beside the rest, not as a tail after it.
    if (bigQueue.length && !bigInFlight && (!draining || draining === w) && w.taken < recycleAfter) {
      draining = w;
      if (!wasIdle || !memoryOk()) return;
      draining = null;
      const item = bigQueue.pop();
      bigInFlight++; w.inflight.push(item); w.taken++;
      w.child.send({ type: 'run', item });
      arm(w); return;
    }
    if (w.inflight[0]?.big) return;                       // it has its hands full
    while (w.inflight.length < prefetch && queue.length && w.taken < recycleAfter && memoryOk()) {
      const item = queue.pop();
      w.inflight.push(item); w.taken++;
      w.child.send({ type: 'run', item });
    }
    if (wasIdle) arm(w);
    if (!w.inflight.length && !(left() && (lowMem || !queue.length))) retire(w);   // nothing left for it (a paused worker, or one waiting for the big lane, stays)
  }

  function retire(w) {
    if (w.retiring || w.dead) return;
    w.retiring = true; clearTimeout(w.timer);
    if (draining === w) draining = null;
    try { w.child.send({ type: 'exit' }); } catch {}
    setTimeout(() => { if (!w.dead) w.child.kill('SIGKILL'); }, 5000).unref();
  }

  whenDone.abort = () => { failed ??= new Error('stopped'); queue.length = 0; bigQueue.length = 0; for (const w of live) { w.retiring = true; w.child.kill('SIGKILL'); } if (!live.size) finish(); };
  if (!left()) { finish(); return whenDone; }
  for (let i = 0, n = Math.max(1, Math.min(workers, left())); i < n; i++) spawn();
  return whenDone;
}
