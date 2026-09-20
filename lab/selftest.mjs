// selftest.mjs — the lab's own gate: run a whole hunt, blind, on a document
// whose answer the main gate already proved, and demand the lab rediscover it.
//
//   npm run lab:selftest
//
// This is the lab's version of `npm run gate`, and the same rule applies: the
// expected numbers are checked, not described, so any change in any of them is
// the signal. What it proves is the only claim the lab makes — that a document
// with no priors attached comes out the far end named correctly.
//
// EFTA00751637 is used because its family (`nimbus791`) is entirely free: the
// glyph set and the CFF both ship, so this needs no licence-encumbered font.
// It still needs the PDF, which does not ship — so a fresh clone SKIPS, loudly,
// exactly like the gate. **Skipping is not a pass.**
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const LAB = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const ROOT = LAB.replace(/\/lab$/, '');
const DOC = `${ROOT}/fixtures/corpus/nimbus791/EFTA00751637.pdf`;
const HUNT = '_selftest';

if (!existsSync(DOC)) {
  console.log(`SKIP — ${DOC.replace(ROOT, '.')} is not present (the corpus is not distributed).`);
  console.log('       Nothing was verified. This is not a pass.');
  process.exit(0);
}

let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) fail++;
};
const run = (script, ...argv) =>
  execFileSync(process.execPath, [`${LAB}/${script}`, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ---- 1. ingest -------------------------------------------------------------
rmSync(`${LAB}/pages/EFTA00751637`, { recursive: true, force: true });
rmSync(`${LAB}/targets/${HUNT}`, { recursive: true, force: true });
const ing = run('ingest.mjs', DOC);
ok('ingest', /7 pages ingested/.test(ing), ing.trim().split('\n').pop());

// ---- 2. harvest ------------------------------------------------------------
// The advance is the headline number: nothing told the harvester what it is,
// and a manifest in the old repo claimed 6.001 px where the pixels measure
// 7.418. Pixels won, and they have to keep winning.
const har = run('harvest.mjs', '--doc', 'EFTA00751637', '--out', HUNT);
const adv = +(/band advance: median ([\d.]+) px/.exec(har)?.[1] ?? 0);
const nTargets = +(/-> (\d+) targets/.exec(har)?.[1] ?? 0);
ok('harvest advance fitted from ink alone', Math.abs(adv - 7.418) < 0.002, `${adv} px (expected 7.418)`);
ok('harvest yield', nTargets >= 100, `${nTargets} targets (expected >= 100)`);

// ---- 3. identify — the blind claim ----------------------------------------
const idf = run('identify.mjs', '--targets', HUNT);
const scores = [...idf.matchAll(/^ {2}(\S+) +(\d+)\/(\d+)\b/gm)].map(m => ({ name: m[1], exact: +m[2], of: +m[3] }));
const win = scores.find(s => s.name === 'nimbus791');
const others = scores.filter(s => s.name !== 'nimbus791');
ok('identify verdict', /^VERDICT: nimbus791\b/m.test(idf), win ? `${win.exact}/${win.of}` : 'no score');
ok('identify hit rate', win && win.exact / win.of >= 0.85, win ? `${(100 * win.exact / win.of).toFixed(0)}%` : '—');
// The load-bearing half: exactness cannot false-positive, so every OTHER
// family must be flat zero. A single stray hit here would mean the exact test
// has a hole in it, and every verdict this lab has ever given is suspect.
const stray = others.filter(s => s.exact > 0);
ok('no other family scores at all', stray.length === 0,
  stray.length ? stray.map(s => `${s.name}=${s.exact}`).join(', ') : `${others.length} families, all 0`);

// ---- 4. sweep — the same answer without being told the family --------------
const swp = run('sweep.mjs', '--targets', HUNT, '--fonts', 'NimbusMonoPS-Regular.cff,cour.ttf,times.ttf', '--ems', '780..800');
const top = /^ {2}(\S+) +em64 +(\d+) +(\S+)/m.exec(swp.split('top configs')[1] ?? '');
ok('sweep winner', top?.[1] === 'NimbusMonoPS-Regular.cff' && top[2] === '791' && top[3] === 'fz',
  top ? `${top[1]} em64 ${top[2]} ${top[3]}` : 'no config scored');

// ---- 5. m-bank — face and size from 4 px of one letter --------------------
if (!existsSync(`${LAB}/m-bank.json`)) {
  console.log('  (building the m bank — first run only)');
  run('mbank.mjs', 'build');
}
const scan = run('mbank.mjs', 'scan', DOC, `${ROOT}/fixtures/corpus/big.pdf`,
  `${ROOT}/fixtures/corpus/courier_1.pdf`, `${ROOT}/fixtures/corpus/nimbusrom.pdf`);
const verdictOf = doc => /(\S+)@(\d+)=/.exec(scan.split('\n').find(l => l.startsWith(doc)) ?? '')?.slice(1, 3).join('@');
ok('m-bank: EFTA00751637', verdictOf('EFTA00751637') === 'lab:NimbusMonoPS-Regular@791', verdictOf('EFTA00751637'));
ok('m-bank: big.pdf', /^times/.test(verdictOf('big') ?? '') && /@1024$/.test(verdictOf('big') ?? ''), verdictOf('big'));
ok('m-bank: courier_1.pdf', verdictOf('courier_1') === 'cour@832', verdictOf('courier_1'));
// nimbusrom is the control: its producer applies linear254 + a per-page
// palette, so its bytes are NOT a plain render and the bank must refuse it at
// tol 0. A verdict here would mean the exact-match grading is meaningless.
ok('m-bank refuses the post-law family at tol 0', /^nimbusrom\b.*no m matched/m.test(scan),
  scan.split('\n').find(l => l.startsWith('nimbusrom'))?.slice(24).trim());

rmSync(`${LAB}/targets/${HUNT}`, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nlab selftest: all green');
process.exit(fail ? 1 : 0);
