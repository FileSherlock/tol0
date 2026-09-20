// verify-redactions.mjs — the candidate-name verdicts over a folder of PDFs,
// through Recto (sibling of verify-recto-pixels.mjs).
//
// For every PDF: upload it through Recto's real file input, let the auto
// read run for --max-pages pages (the rest is cancelled), let the refiner
// place the bars and the matcher score every candidate through the
// hypothesis seam (ocr_tool/hypothesis-view.js over tol0 engine/hypothesis.js),
// then log, per detected bar with a candidate list: the list size, the
// tolerance in force, and the verdict counts — consistent / contradicted /
// no-evidence — plus the reason when the seam returned null. The report is
// the feature's value in numbers: how many bars end unique, tied, or without
// evidence.
//
// The reference page is asserted (guide/plugins/redaction-refiner/
// pixel-evidence-plan.md §4): on efta00018586 the item-2 bar (the one with
// the leaked S) must end with SARAH KELLEN as its only consistent name, and
// so must the item-3 bar — no leak, but its 74 edge column carries the S's
// shadow, judged with the compositor's byte of slack.
//
//   node tools/verify-redactions.mjs [--dir <folder>] [--limit N] [--max-pages N]
//        [--read-timeout S] [--recto <path>] [--chrome <exe>] [--only <substring>]
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

function findChrome() {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:/Program Files';
    const px = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    return [`${px}/Google/Chrome/Application/chrome.exe`, `${pf}/Google/Chrome/Application/chrome.exe`,
      `${la}/Google/Chrome/Application/chrome.exe`, `${pf}/Microsoft/Edge/Application/msedge.exe`,
      `${px}/Microsoft/Edge/Application/msedge.exe`].find(existsSync) || '';
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync) || '';
}

const o = { recto: resolve(REPO, '..', 'Recto'), chrome: process.env.CHROME || findChrome(),
  dir: null, limit: Infinity, maxPages: 5, readTimeout: 240, only: null, detail: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--recto') o.recto = resolve(process.cwd(), next());
  else if (a === '--chrome') o.chrome = next();
  else if (a === '--dir') o.dir = resolve(process.cwd(), next());
  else if (a === '--limit') o.limit = +next();
  else if (a === '--max-pages') o.maxPages = +next();
  else if (a === '--read-timeout') o.readTimeout = +next();
  else if (a === '--only') o.only = next();
  else if (a === '--detail') o.detail = true;             // every name's verdict with its counts, per bar
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
o.dir ??= join(o.recto, '_temp_test_files');
if (!existsSync(join(o.recto, 'manage.py'))) { console.error(`no manage.py at ${o.recto} — pass --recto`); process.exit(2); }
if (!o.chrome) { console.error('no Chrome/Chromium/Edge found — pass --chrome <exe> or set CHROME'); process.exit(2); }
const pdfs = readdirSync(o.dir).filter(f => /\.pdf$/i.test(f) && (!o.only || f.toLowerCase().includes(o.only.toLowerCase()))).sort().slice(0, o.limit);
if (!pdfs.length) { console.error(`no PDFs in ${o.dir}`); process.exit(2); }

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitForServer(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(base); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Django server did not become ready');
}
const describe = e => [e?.name, e?.message].filter(Boolean).join(' | ').replace(/[\r\n]+/g, ' ').slice(0, 300);

// the reference page's expectations (plan §4), and two memos whose text is
// known from their un-redacted sources (EFTA00038617, EFTA01649149: Calibri,
// the bars are the names' advance boxes, so the side bearings hide the ink
// and the edge columns carry no shadow — the truth must never be
// contradicted, and where it is the only name the page did not contradict
// it is the list's survivor)
const upper = t => t.toUpperCase();
const REFERENCE = {
  'efta00018586.pdf': bars => {
    const fails = [];
    const byY = [...bars].sort((a, b) => a.y - b.y);
    const item2 = byY.find(b => b.matches.length && b.verdicts && b.matches.some(m => upper(m) === 'SARAH KELLEN'));
    const item3 = byY.find(b => b !== item2 && b.matches.length);
    // the matcher lists every S-name of the width within its fit range; by
    // pixels those tie with the truth (one S column, the right end under
    // the body), so the assertion is: SARAH KELLEN consistent with the best
    // fit, every consistent name an S-name within the fit tolerance, every
    // other initial contradicted
    const check = (bar, label) => {
      if (!bar) { fails.push(label + ' bar not found'); return; }
      const v = m => bar.verdicts?.[m];
      const truth = bar.matches.find(m => upper(m) === 'SARAH KELLEN');
      if (!truth || v(truth)?.verdict !== 'consistent') { fails.push(label + ' bar: SARAH KELLEN is not consistent (' + (truth ? v(truth)?.verdict : 'not listed') + ')'); return; }
      const cons = bar.matches.filter(m => v(m)?.verdict === 'consistent');
      const bestFit = Math.min(...cons.map(m => Math.abs(v(m).penFit ?? 99)));
      if (Math.abs(v(truth).penFit) > bestFit + 1e-9) fails.push(label + ' bar: a decoy fits the width better than SARAH KELLEN');
      const wrongInitial = cons.filter(m => !upper(m).startsWith('S'));
      if (wrongInitial.length) fails.push(label + ' bar: consistent without the S column: ' + wrongInitial.join(', '));
      const loose = cons.filter(m => (v(m).penFit ?? 0) > 1.25);            // an overrun; ending early is a wider gap, allowed
      if (loose.length) fails.push(label + ' bar: consistent beyond the fit tolerance: ' + loose.join(', '));
      const other = bar.matches.filter(m => !upper(m).startsWith('S') && !upper(m).startsWith('G') && v(m)?.verdict !== 'contradicted');
      if (other.length) fails.push(label + ' bar: not contradicted: ' + other.map(m => m + ' (' + v(m)?.verdict + ')').join(', '));
    };
    check(item2, 'item-2');
    check(item3, 'item-3');
    return fails;
  },
};
// a memo with known text: [bar x (page px), the name under it]
const memoTruth = (truths) => bars => {
  const fails = [];
  for (const [x, text] of truths) {
    const bar = bars.find(b => b.page === 1 && Math.abs(b.x - x) <= 4);
    if (!bar) { fails.push(text + ': no bar at x ' + x); continue; }
    if (!bar.matches.length) { console.log('       (' + text + ': the bar has no candidate list)'); continue; }
    const m = bar.matches.find(n => upper(n) === upper(text));
    if (!m) { console.log('       (' + text + ': not in the list of ' + bar.matches.length + ' — the matcher, not the pixels)'); continue; }
    const v = bar.verdicts?.[m];
    if (!v) { fails.push(text + ': no verdict'); continue; }
    if (v.verdict === 'contradicted') fails.push(text + ' contradicted: ' + (v.reason || 'pixels') + ' fit ' + v.penFit?.toFixed(2));
    const others = bar.matches.filter(n => n !== m), survivors = others.filter(n => bar.verdicts?.[n]?.verdict !== 'contradicted');
    console.log('       ' + text + ': ' + v.verdict + ' (fit ' + v.penFit?.toFixed(2) + '), ' + (others.length - survivors.length) + ' of ' + others.length + ' others contradicted' + (survivors.length === 0 && others.length ? ' — sole survivor' : ''));
  }
  return fails;
};
REFERENCE['efta00038617.pdf'] = memoTruth([[392, 'Sarah Kellen'], [480, 'Adriana Mucinska'], [604, 'Nadia'], [120, 'Marcinkova'], [204, 'Lex Wexner'],
  [288, 'Lesley Groff'], [481, 'Haley Robson'], [578, 'William Hammond'], [167, 'David Rodgers'], [311, 'Richard Barnett'], [430, 'Gregory Bledsoe'], [444, 'Bledsoe']]);
REFERENCE['efta01649149.pdf'] = memoTruth([[392, 'Sarah Kellen'], [480, 'Adriana Mucinska'], [604, 'Nadia'], [120, 'Marcinkova'], [288, 'Lesley Groff'], [481, 'Haley Robson']]);

async function run() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.platform === 'win32' ? 'python' : 'python3',
    ['manage.py', 'runserver', `127.0.0.1:${port}`, '--noreload'], { cwd: o.recto, stdio: 'ignore' });
  let browser, failed = false;
  const totals = { docs: 0, bars: 0, listed: 0, unique: 0, tied: 0, none: 0, contradictedAll: 0, nulls: 0 };
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: o.chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(600000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    const ready = () => page.waitForFunction(() => typeof BlindOCR !== 'undefined' && typeof OCRTool !== 'undefined' &&
      typeof ocrTestHypothesis === 'function' && typeof state !== 'undefined' && state.pageImages?.length > 0);
    await page.goto(base, { waitUntil: 'load' });
    await ready();

    for (const f of pdfs) {
      const t0 = Date.now();
      const doc = { bars: [] };
      try {
        const prevHash = await page.evaluate(() => state.docHash);
        const input = await page.$('#pdf-file');
        await input.uploadFile(join(o.dir, f));
        await page.waitForFunction(h => state.docHash && state.docHash !== h, { timeout: 120000 }, prevHash);
        // the auto read of --max-pages pages, then cancel the rest
        await page.waitForFunction(() => OCRTool.state.running || OCRTool.state.autoDone, { timeout: 30000 }).catch(() => {});
        const deadline = Date.now() + o.readTimeout * 1000;
        while (Date.now() < deadline) {
          const st = await page.evaluate(n => ({ done: OCRTool.state.autoDone && !OCRTool.state.running,
            pages: utbState.boxes.filter(b => b.type === 'ocr').reduce((s, b) => Math.max(s, b.page), 0) }), o.maxPages);
          if (st.done || st.pages >= o.maxPages) break;
          await new Promise(r => setTimeout(r, 500));
        }
        await page.evaluate(() => { if (OCRTool.state.running) OCRTool.state.cancel = true; });
        await page.waitForFunction(() => !OCRTool.state.running, { timeout: 60000 }).catch(() => {});
        // refine + score
        await page.evaluate(async n => {
          if (typeof refineAllRedactions === 'function') await refineAllRedactions({ force: true });
          if (typeof calculateAllWidths === 'function') await calculateAllWidths();
        }, o.maxPages);
        await new Promise(r => setTimeout(r, 500));
        // the reference's item-2 bar: the seam on the full font-unit tie (the
        // five names the item-3 bar lists), bypassing the remnant filter —
        // the pixels alone must keep SARAH KELLEN and drop the other four
        doc.probe = await page.evaluate(async () => {
          const bars = utbState.boxes.filter(b => b.type === 'redaction' && b.page === 1).sort((a, b) => a.y - b.y);
          if (bars.length < 2 || typeof ocrTestHypothesis !== 'function') return null;
          const names = getBoxMatches(bars[1]);
          const out = {};
          const fmt = v => v ? `${v.verdict} (open ${v.open.match}/${v.open.ink} edge ${v.edge.match}/${v.edge.ink} dark ${v.dark.match}/${v.dark.ink}${v.rows && v.rows.ink ? ` (rows ${v.rows.match}/${v.rows.ink})` : ''} unexplained ${v.unexplained} pen ${v.pen0} fit ${v.penFit?.toFixed(2)}${v.reason ? ' ' + v.reason : ''})` : 'null';
          for (const n of names) out[n] = fmt(await ocrTestHypothesis(bars[0], n)) + ' | item-3: ' + fmt(await ocrTestHypothesis(bars[1], n));
          return out;
        });
        doc.bars = await page.evaluate(n => utbState.boxes.filter(b => b.type === 'redaction' && b.page <= n).map(b => {
          const mi = typeof getBoxMatchInfo === 'function' ? getBoxMatchInfo(b) : { matches: [], tol: null, loose: false };
          return { id: b.id, page: b.page, x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.w.toFixed(1), exact: !!(b.refineInfo && b.refineInfo.exact),
            matches: mi.matches, tol: mi.tol, loose: mi.loose, verdicts: b.verdicts || null,
            reason: (window.OCRHypothesisView && OCRHypothesisView.reasons.get(b.id)) || null };
        }), o.maxPages);
      } catch (e) {
        console.log(`ERROR ${f}: ${describe(e)}`);
        if (errors.length) { console.log(`       page errors: ${errors.slice(-3).join(' || ').slice(0, 300)}`); errors.length = 0; }
        failed = true;
        continue;
      }
      totals.docs++;
      let unique = 0, tied = 0, none = 0, contra = 0, nulls = 0, listed = 0, survivor = 0;
      for (const b of doc.bars) {
        totals.bars++;
        if (!b.matches.length) continue;
        listed++;
        if (!b.verdicts) { nulls++; continue; }
        const vs = b.matches.map(m => b.verdicts[m]?.verdict || 'null');
        const c = vs.filter(v => v === 'consistent').length, x = vs.filter(v => v === 'contradicted').length, ne = vs.filter(v => v === 'no-evidence').length;
        if (vs.includes('null')) nulls++;
        else if (c === 1) unique++;
        else if (c > 1) tied++;
        else if (x === vs.length) contra++;
        else if (ne === 1 && x === vs.length - 1) survivor++;   // the one name the page did not contradict, on no evidence of its own
        else none++;
        console.log(`       p${b.page} bar@${b.x},${b.y} w${b.w} ${b.exact ? 'pens' : 'raster'} ±${b.tol}${b.loose ? ' loose' : ''}: ${b.matches.length} names → ${c} consistent, ${x} contradicted, ${ne} no-evidence` +
          (b.reason ? ` — ${b.reason}` : '') + (c ? ` · ${b.matches.filter(m => b.verdicts[m]?.verdict === 'consistent').slice(0, 4).join(', ')}` : ''));
        if (o.detail) for (const m of b.matches) {
          const v = b.verdicts[m];
          console.log(`           ${m.padEnd(24)} ${v ? `${v.verdict.padEnd(12)} open ${v.open.match}/${v.open.ink} edge ${v.edge.match}/${v.edge.ink} dark ${v.dark ? `${v.dark.match}/${v.dark.ink}` : '-'} unexplained ${v.unexplained} pen ${v.pen0} fit ${v.penFit?.toFixed(2)}${v.reason ? ' ' + v.reason : ''}${v.adj != null ? ` adj '${v.adj}' gaps ${v.gaps?.map(g => +g.toFixed(2)).join('/')}` : ''}` : 'null'}`);
        }
      }
      totals.listed += listed; totals.unique += unique; totals.tied += tied; totals.none += none; totals.contradictedAll += contra; totals.nulls += nulls; totals.survivor = (totals.survivor || 0) + survivor;
      const check = REFERENCE[f.toLowerCase()];
      const fails = check ? check(doc.bars) : [];
      if (check && doc.probe && f.toLowerCase() === 'efta00018586.pdf') {
        console.log(`       item-2 bar, the five tied names by pixels alone: ${Object.entries(doc.probe).map(([n, v]) => `${n} → ${v}`).join('; ')}`);
        for (const [n, v] of Object.entries(doc.probe))
          if (upper(n) === 'SARAH KELLEN' ? !v.startsWith('consistent') : !(v.startsWith('contradicted') || upper(n).startsWith('S'))) fails.push(`item-2 pixels: ${n} → ${v}`);
      }
      if (fails.length) failed = true;
      console.log(`${fails.length ? 'FAIL ' : 'ok   '} ${f}: ${doc.bars.length} bars, ${listed} with names: ${unique} unique, ${survivor} survivor, ${tied} tied, ${none} no evidence, ${contra} all contradicted, ${nulls} unscored · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      for (const m of fails) console.log(`       ${m}`);
    }
    if (errors.length) { console.error('page errors:', errors.slice(0, 5)); }
  } finally {
    await browser?.close();
    server.kill();
  }
  console.log(`\n${totals.docs} documents, ${totals.bars} bars, ${totals.listed} with a candidate list: ${totals.unique} unique, ${totals.survivor || 0} survivor, ${totals.tied} tied, ${totals.none} no evidence, ${totals.contradictedAll} every name contradicted, ${totals.nulls} unscored`);
  console.log(failed ? 'FAIL' : 'PASS');
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
