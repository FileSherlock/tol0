// worker.mjs — one persistent worker of the pool (pool.mjs forks it; it is
// never run by hand). Loads the job module named on its command line, starts
// it ONCE with the run's config, then answers one document at a time, in the
// order they arrive. A document that throws is an answer ({ok: false}), not a
// death: only a hang or a hard crash costs the process, and the pool sees to
// that — unless the job says the process itself is spent (poisoned), in which
// case it says so and goes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

let job = null, config = null, state = null, maxRss = Infinity, leaving = false;
// no coordinator, no worker: a killed run must not leave sixteen of these behind
process.on('disconnect', () => process.exit(0));
let chain = Promise.resolve();                      // documents are handled strictly one after another

process.on('message', m => {
  chain = chain.then(() => handle(m)).catch(e => process.send({ type: 'fatal', error: String(e?.stack || e) }));
});

async function handle(m) {
  if (m.type === 'init') {
    try {
      for (const g of m.guard ?? []) {
        const now = createHash('sha256').update(readFileSync(g.path)).digest('hex');
        if (!now.startsWith(g.sha)) throw new Error(`${g.path} changed since this run started — a run is one version of the code; start it again`);
      }
      job = await import(pathToFileURL(process.argv[2]).href);
      config = m.config; maxRss = (m.maxRssMB ?? Infinity) * 1048576;
      state = await job.init?.(config);
      process.send({ type: 'ready' });
    } catch (e) { process.send({ type: 'fatal', error: String(e?.stack || e) }); }
    return;
  }
  if (m.type === 'exit') { process.disconnect(); process.exit(0); }
  if (m.type !== 'run' || leaving) return;          // once it has said it is going, it reads nothing more: the pool has taken those back
  // a worker that has grown past its ceiling asks to be replaced: its answer
  // stands, it takes nothing more. (A leak in a wasm heap is invisible to JS's
  // GC; sixteen of them once took the desktop down with them — 2026-09-20.)
  try {
    const result = await job.run(m.item, config, state);
    leaving = process.memoryUsage().rss > maxRss;
    process.send({ type: 'done', ok: true, result, fat: leaving }, () => { if (leaving) process.exit(0); });
  }
  catch (e) {
    const spent = leaving = !!job.poisoned?.(e);
    process.send({ type: 'done', ok: false, error: String(e?.message || e).slice(0, 500), poisoned: spent }, () => { if (spent) process.exit(0); });
  }
}
