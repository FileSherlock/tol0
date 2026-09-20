// gate.mjs — the byte-identical regression gate, and the reason this repo can
// be trusted. It re-reads a fixed set of documents through blind-read.mjs and
// byte-compares whole transcripts against a COMMITTED reference. The expected
// numbers ARE the files in fixtures/gate-ref/, not prose in a doc, so any
// change in any number is the signal — this is what caught every accidental
// regression in the predecessor repo.
//
//   npm run gate                                    # run + certify vs gate-ref
//   node tools/gate.mjs --out fixtures/gate-ref --ref none   # re-record, after
//                                                   #   an INTENDED change
//
// Each run's summary (lines / glyphs / □ / frags / truth rows) is written next
// to the transcript as <name>.summary and compared too.
//
// SKIPPING IS LOUD, AND NOT A PASS. The documents are real government PDFs:
// they live in a gitignored fixtures/corpus/ and are not distributed, and most
// pools need glyph sets whose faces are not redistributable either
// (tools/glyph-sets.mjs --plan regenerates those). A fresh clone therefore
// runs 0 of 7 and says exactly which fixture or which set it lacks. What it
// must never do is print a green line for a document it did not read.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { POOLS, SETS, poolSetNames } from './glyph-registry.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = f => join(REPO, 'fixtures', 'corpus', f);

// Certified family read commands come from the ONE registry
// (tools/glyph-registry.mjs), so a gate document can never drift from the
// command its family was proven with.
const LIN = POOLS.linear.glyphs;
const COURIER = POOLS.courierDoc.glyphs;
const NIMBUSROM = POOLS.nimbusrom.glyphs;

// The nimbus791 block — 11 documents from one producer, read with ONE set,
// every glyph of every one of them explained (0 □). It earns its place in the
// gate twice over: it is the only block whose glyph set is fully FREE (the
// .npz is committed and NimbusMonoPS-Regular.cff ships in fonts/), so a clone
// that has the documents but none of the licence-encumbered system faces can
// still run 11 of the 18 entries; and each document carries a truth file, so
// the summary certifies transcribed ROWS, not just counts.
const N791 = ['EFTA00751637', 'EFTA00751644', 'EFTA00751650', 'EFTA00751656',
  'EFTA00754398', 'EFTA00754462', 'EFTA00754474', 'EFTA00756928',
  'EFTA00756935', 'EFTA00756958', 'EFTA00756980'];
const n791 = f => join(REPO, 'fixtures', 'corpus', 'nimbus791', f);

// `needs` lists every fixture the document requires; `sets` every glyph set.
// Both are checked BEFORE the reader runs, so a missing one is reported as
// itself rather than as a reader crash.
const DOCS = [
  { name: 'v3', needs: [corpus('v3.pdf'), corpus('v3.txt')], sets: 'times16',
    args: ['--pdf', corpus('v3.pdf'), '--all', '--truth', corpus('v3.txt')] },
  { name: 'big', needs: [corpus('big.pdf'), corpus('big.txt')], sets: 'times16',
    args: ['--pdf', corpus('big.pdf'), '--all', '--truth', corpus('big.txt')] },
  { name: 'email', needs: [corpus('email.pdf'), corpus('email.txt')], sets: 'times16',
    args: ['--pdf', corpus('email.pdf'), '--all', '--truth', corpus('email.txt'), '--quant'] },
  // report has no PDF: only its page raster survived, which is all the reader
  // needs (and the only gate entry that exercises the --raster path)
  { name: 'report', needs: [join(REPO, 'fixtures', 'rasters', 'report.gray.gz')], sets: LIN,
    args: ['--raster', join(REPO, 'fixtures', 'rasters', 'report.gray.gz'), '--tol', '0', '--glyphs', LIN] },
  { name: 'courier_1', needs: [corpus('courier_1.pdf')], sets: COURIER,
    args: ['--pdf', corpus('courier_1.pdf'), '--all', '--glyphs', COURIER] },
  { name: 'courier_2', needs: [corpus('courier_2.pdf')], sets: COURIER,
    args: ['--pdf', corpus('courier_2.pdf'), '--all', '--glyphs', COURIER] },
  { name: 'nimbusrom', needs: [corpus('nimbusrom.pdf')], sets: NIMBUSROM,
    args: ['--pdf', corpus('nimbusrom.pdf'), '--all', '--palette', '--tol', '0', '--glyphs', NIMBUSROM] },
  ...N791.map(id => ({
    name: `n791_${id}`, needs: [n791(`${id}.pdf`), n791(`${id}.txt`)],
    sets: POOLS.nimbus791.glyphs,
    args: ['--pdf', n791(`${id}.pdf`), '--all', '--pool', 'nimbus791', '--truth', n791(`${id}.txt`)],
  })),
];

let outDir = join(REPO, 'gate-out'), refDir = null, refGiven = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--out') outDir = resolve(process.cwd(), next());
  else if (a === '--ref') { refGiven = true; const v = next(); refDir = v === 'none' ? null : resolve(process.cwd(), v); }
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
if (!refGiven && existsSync(join(REPO, 'fixtures', 'gate-ref'))) refDir = join(REPO, 'fixtures', 'gate-ref');
mkdirSync(outDir, { recursive: true });

// missing pieces, named precisely — a set name means "run glyph-sets --plan",
// a fixture path means "you do not have this document"
const npzFor = name => SETS.find(([n]) => n === name)?.[1];
function missing(d) {
  const out = d.needs.filter(f => !existsSync(f)).map(f => f.slice(REPO.length + 1).replace(/\\/g, '/'));
  for (const s of new Set(poolSetNames({ glyphs: d.sets })))
    if (!npzFor(s) || !existsSync(join(REPO, 'assets', 'fonts', npzFor(s)))) out.push(`set:${s}`);
  return out;
}

let fail = 0, skip = 0, ran = 0;
const t0 = Date.now();
for (const d of DOCS) {
  const gone = missing(d);
  if (gone.length) {
    console.log(`SKIP  ${d.name.padEnd(10)} missing ${gone.join(', ')}`);
    skip++; continue;
  }
  const outTxt = join(outDir, `${d.name}.txt`);
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'blind-read.mjs'), ...d.args, '--out', outTxt],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  ran++;
  if (r.status !== 0) {
    console.log(`FAIL  ${d.name}: reader exited ${r.status}\n${(r.stderr || '').slice(-2000)}`);
    fail++; continue;
  }
  // summary = everything the run certifies (counts + truth diff rows), minus
  // the timing figure and the transcript path
  const summary = r.stdout.split('\n')
    .filter(l => l.trim() && !l.startsWith('wrote '))
    .map(l => l.replace(/, \d+\.\d+s$/, '')).join('\n') + '\n';
  writeFileSync(join(outDir, `${d.name}.summary`), summary);
  let verdict = `${secs}s`;
  if (refDir) {
    const same = (f) => existsSync(join(refDir, f)) &&
      readFileSync(join(outDir, f), 'utf8') === readFileSync(join(refDir, f), 'utf8');
    const txtOk = same(`${d.name}.txt`), sumOk = same(`${d.name}.summary`);
    if (txtOk && sumOk) verdict += '  BYTE-IDENTICAL';
    else { verdict += `  DIFFERS (${txtOk ? '' : 'transcript'}${!txtOk && !sumOk ? '+' : ''}${sumOk ? '' : 'summary'})`; fail++; }
  }
  console.log(`${d.name.padEnd(10)} ${summary.split('\n')[0]}  [${verdict}]`);
}
console.log(`\ngate: ${ran - fail}/${DOCS.length} ok` + (skip ? `, ${skip} SKIPPED (see above)` : '') +
  `, ${((Date.now() - t0) / 1000).toFixed(0)}s total` + (refDir ? ` (vs ${refDir})` : ''));
process.exit(fail ? 1 : 0);
