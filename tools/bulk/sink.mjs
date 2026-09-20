// sink.mjs — where a bulk run's results go, written by the coordinator alone.
//
//   <out>/run.json          every start of this run: job, config, versions, counts
//   <out>/part-0000.jsonl   one JSON record per finished document, in finishing
//                           order; a part is closed at `partBytes` and gzipped
//                           (part-0000.jsonl.gz), the next one opened
//   <out>/done.tsv          name <TAB> status <TAB> ms <TAB> brief…  — the index.
//                           A name in here is never read again by this run
//                           directory: that is resume. ok | error | timeout | crash
//                           all count as done; delete a row to have it retried.
//
// The record is appended BEFORE its index row, so a kill between the two costs
// one document read twice, never one lost: whoever reads the parts takes the
// LAST record of a name (readRecords does).
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip, createGunzip, gunzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

const partName = i => `part-${String(i).padStart(4, '0')}.jsonl`;

export function openSink(outDir, { partBytes = 256 << 20 } = {}) {
  mkdirSync(outDir, { recursive: true });
  const donePath = join(outDir, 'done.tsv');
  const done = new Map();                                  // name → status
  if (existsSync(donePath))
    for (const row of readFileSync(donePath, 'utf8').split('\n')) { const c = row.split('\t'); if (c[0]) done.set(c[0], c[1]); }
  const parts = readdirSync(outDir).filter(f => /^part-\d{4}\.jsonl(\.gz)?$/.test(f)).sort();
  let idx = parts.length ? parseInt(parts.at(-1).slice(5, 9), 10) : 0;
  if (parts.length && parts.at(-1).endsWith('.gz')) idx++;   // the last part was closed: start a new one
  let path = join(outDir, partName(idx));
  let bytes = existsSync(path) ? statSync(path).size : 0;
  let fd = openSync(path, 'a');
  const doneFd = openSync(donePath, 'a');
  const zipping = [];

  function rotate() {
    closeSync(fd);
    const closed = path;
    zipping.push(pipeline(createReadStream(closed), createGzip({ level: 6 }), createWriteStream(closed + '.gz')).then(() => unlinkSync(closed)));
    idx++; path = join(outDir, partName(idx)); bytes = 0; fd = openSync(path, 'a');
  }

  return {
    done,
    /** record: the document's result (or null), brief: short strings for the index row */
    write(name, status, ms, record, brief = []) {
      if (record != null) {
        const line = JSON.stringify(record) + '\n';
        writeSync(fd, line); bytes += Buffer.byteLength(line);
        if (bytes >= partBytes) rotate();
      }
      writeSync(doneFd, [name, status, ms, ...brief].join('\t').replace(/\n/g, ' ') + '\n');
      done.set(name, status);
    },
    logRun(entry) {
      const p = join(outDir, 'run.json');
      const runs = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
      runs.push(entry); writeFileSync(p, JSON.stringify(runs, null, 1) + '\n');
    },
    async close() { closeSync(fd); closeSync(doneFd); await Promise.all(zipping); },
  };
}

/** A run directory's records, one at a time, in file order (a corpus-sized run
 *  does not fit in memory; a torn last line of a run still going is skipped). */
export async function* streamRecords(outDir) {
  for (const f of readdirSync(outDir).filter(f => /^part-\d{4}\.jsonl(\.gz)?$/.test(f)).sort()) {
    const src = createReadStream(join(outDir, f));
    const rl = createInterface({ input: f.endsWith('.gz') ? src.pipe(createGunzip()) : src, crlfDelay: Infinity });
    for await (const line of rl) { try { yield JSON.parse(line); } catch {} }
  }
}

/** Every record of a run directory, the last one of a name winning. For tools
 *  and tests; a corpus-sized run is streamed instead (one JSON per line). */
export function readRecords(outDir) {
  const byName = new Map();
  for (const f of readdirSync(outDir).filter(f => /^part-\d{4}\.jsonl(\.gz)?$/.test(f)).sort()) {
    const raw = readFileSync(join(outDir, f));
    for (const line of (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8').split('\n'))
      if (line) { const r = JSON.parse(line); byName.set(r.name, r); }
  }
  return byName;
}
