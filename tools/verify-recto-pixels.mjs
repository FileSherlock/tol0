// verify-recto-pixels.mjs — the MuPDF pixel view over a whole folder of PDFs.
//
// For every PDF: upload it through Recto's real file input, read the first
// --max-pages pages with the reader (the automatic whole-document read is
// cancelled first — a 2,400-page document must not hold the run), switch the
// MuPDF pixel view + Diff on, and collect the adapter's per-box verdicts. The
// claim under test is the one the view exists for: every line the reader
// certified byte-clean is re-rendered by engine/render.js at its measured
// pens and differs from the page in ZERO pixels (to the reader's own standard
// for the line: its y-phase, its tolerance rung, never under an object mask
// or box halo). A clean line that differs is a bug in the forward laws (or
// the adapter's pen/baseline bookkeeping) and fails the run. Lines the reader
// did NOT certify (tolerant reads, □) are reported but never counted against
// the renderer.
//
// A page whose read does not finish within --read-timeout seconds (an
// unmodelled family sends the reader through the whole tolerance ladder) is
// reported as SKIP: the app is reloaded and the run continues. A skip is
// loud but it is not a pixel-view failure.
//
//   node tools/verify-recto-pixels.mjs [--dir <folder>] [--limit N]
//        [--max-pages N] [--read-timeout S] [--recto <path>] [--chrome <exe>]
//
// Defaults: --dir ../Recto/_temp_test_files, --max-pages 5, --read-timeout
// 120. Exit 1 if any clean box differs or a document could not be opened.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { rectoLayout } from './recto-layout.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

function findChrome() {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:/Program Files';
    const px = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    return [
      `${px}/Google/Chrome/Application/chrome.exe`,
      `${pf}/Google/Chrome/Application/chrome.exe`,
      `${la}/Google/Chrome/Application/chrome.exe`,
      `${pf}/Microsoft/Edge/Application/msedge.exe`,
      `${px}/Microsoft/Edge/Application/msedge.exe`,
    ].find(existsSync) || '';
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync) || '';
}

const o = { recto: resolve(REPO, '..', 'Recto'), chrome: process.env.CHROME || findChrome(),
  dir: null, limit: Infinity, maxPages: 5, readTimeout: 120 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--recto') o.recto = resolve(process.cwd(), next());
  else if (a === '--chrome') o.chrome = next();
  else if (a === '--dir') o.dir = resolve(process.cwd(), next());
  else if (a === '--limit') o.limit = +next();
  else if (a === '--max-pages') o.maxPages = +next();
  else if (a === '--read-timeout') o.readTimeout = +next();
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}
o.dir ??= join(o.recto, '_temp_test_files');
const layout = rectoLayout(o.recto);
if (!layout) { console.error(`no Recto checkout at ${o.recto} — pass --recto`); process.exit(2); }
if (!o.chrome) { console.error('no Chrome/Chromium/Edge found — pass --chrome <exe> or set CHROME'); process.exit(2); }
const pdfs = readdirSync(o.dir).filter(f => /\.pdf$/i.test(f)).sort().slice(0, o.limit);
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
  throw new Error('the Recto server did not become ready');
}
const describe = e => [e?.name, e?.message, e?.cause?.message].filter(Boolean).join(' | ')
  .replace(/[\r\n]+/g, ' ').slice(0, 300);

async function run() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const { command, args } = layout.server(port);
  const server = spawn(command, args, { cwd: o.recto, stdio: 'ignore' });
  let browser, failed = false;
  const totals = { docs: 0, pages: 0, drawn: 0, clean: 0, exact: 0, other: 0, fallbacks: 0, errors: 0, skips: 0 };
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: o.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(600000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    const ready = () => page.waitForFunction(() => typeof BlindOCR !== 'undefined' && typeof PixelView !== 'undefined' &&
      typeof OCRTool !== 'undefined' && typeof state !== 'undefined' && (state.pageImages ? state.pageImages.length : state.numPages) > 0);
    // pixel view + diff on; they stay on across documents
    const arm = async () => {
      await page.click('#toggle-ocr-tool');
      await page.click('#ocr-pixel-view');
      await page.waitForFunction(() => PixelView.state.on && !PixelView.state.loading && OCRTool.state.sets !== null);
      await page.click('#ocr-pixel-diff');
    };
    // cancel whatever read is going; false when the current page's read does
    // not finish within the read timeout
    const settle = async () => {
      await page.evaluate(() => { if (OCRTool.state.running) OCRTool.cancel(); });   // stops mid-page (the adapter aborts the worker read)
      try {
        await page.waitForFunction(() => !OCRTool.state.running, { timeout: o.readTimeout * 1000 });
        return true;
      } catch { return false; }
    };
    // a read that will not finish blocks everything after it: reload the app
    const recover = async () => {
      await page.reload({ waitUntil: 'load' });
      await ready();
      await arm();
      await settle();
    };

    await page.goto(base, { waitUntil: 'load' });
    await ready();
    await arm();
    await settle();

    for (const f of pdfs) {
      const path = join(o.dir, f);
      const t0 = Date.now();
      const doc = { pages: 0, drawn: 0, clean: 0, exact: 0, other: 0, fallbacks: 0, bad: [], sets: new Set(), skipped: null };
      try {
        const prevHash = await page.evaluate(() => state.docHash);
        const input = await page.$('#pdf-file');
        await input.uploadFile(path);
        await page.waitForFunction(h => state.docHash && state.docHash !== h, { timeout: 120000 }, prevHash)
          .catch(e => { throw new Error(`document did not open (docHash unchanged): ${e.message}`); });
        // the auto read starts on document:loaded; give it a moment to begin,
        // then cancel it (a document that never starts one is fine too)
        await page.waitForFunction(() => OCRTool.state.running || OCRTool.state.autoDone, { timeout: 15000 })
          .catch(() => {});
        if (!await settle()) {
          doc.skipped = `page 1 auto read exceeded ${o.readTimeout}s`;
          await recover();
        }
        const numPages = doc.skipped ? 0 : await page.evaluate(() => state.numPages);
        for (let p = 1; p <= Math.min(numPages, o.maxPages); p++) {
          await page.evaluate(async n => { await goToPage(n); }, p);
          await page.waitForFunction(n => {
            const img = document.getElementById(`page${n}`);
            return img && img.complete && img.naturalWidth > 0;
          }, {}, p).catch(e => { throw new Error(`page ${p} raster never loaded: ${e.message}`); });
          // fire and forget: awaiting the run's promise inside evaluate hits
          // puppeteer's 180 s protocol timeout on a slow page BEFORE the read
          // timeout below can call it a SKIP (6 documents came back ERROR that way)
          await page.evaluate(() => { OCRTool.run(false); });     // read THIS page
          const done = await page.waitForFunction(() => !OCRTool.state.running, { timeout: o.readTimeout * 1000 })
            .then(() => true, () => false);
          if (!done) {
            doc.skipped = `page ${p} read exceeded ${o.readTimeout}s`;
            await recover();
            break;
          }
          const rep = await page.evaluate(n => {
            renderAllTextLayers();                                // sets + raster are in: verdicts are final
            const v = PixelView.verdict(n);
            const rep = PixelView.report().filter(b => b.page === n);
            const clean = rep.filter(b => b.clean);
            return {
              drawn: v.drawn, clean: v.cert, exact: v.certExact, other: v.other,
              bad: clean.filter(b => b.count !== 0 || b.unexplained).map(b => ({ page: n, text: b.text.slice(0, 50), count: b.count, ink: b.ink, unexplained: b.unexplained || 0,
                set: b.set + (b.tol ? ` ±${b.tol}` : '') + (b.phy ? ` phy ${b.phy}` : '') + (b.quant ? ' palette' : '') + (b.union ? ' union' : '') })),
              sets: [...new Set(rep.map(b => b.set))],
              fallbacks: v.fallbacks,
            };
          }, p);
          doc.pages++; doc.drawn += rep.drawn; doc.clean += rep.clean; doc.exact += rep.exact;
          doc.other += rep.other; doc.fallbacks += rep.fallbacks; doc.bad.push(...rep.bad);
          for (const s of rep.sets) doc.sets.add(s);
        }
      } catch (e) {
        console.log(`ERROR ${f}: ${describe(e)}`);
        if (errors.length) { console.log(`       page errors: ${errors.slice(-3).join(' || ').slice(0, 300)}`); errors.length = 0; }
        totals.errors++; failed = true;
        await recover().catch(() => {});
        continue;
      }
      const ok = doc.bad.length === 0;
      if (!ok) failed = true;
      const tag = doc.skipped && !doc.pages ? 'SKIP ' : ok ? 'ok   ' : 'FAIL ';
      console.log(`${tag} ${f}: ${doc.pages} pages, ${doc.exact}/${doc.clean} clean lines exact` +
        (doc.other ? `, ${doc.other} uncertified lines drawn` : '') +
        (doc.fallbacks ? `, ${doc.fallbacks} SVG fallbacks` : '') +
        (doc.skipped ? ` — SKIPPED: ${doc.skipped} (unmodelled family? the reader ran its whole ladder)` : '') +
        ` · ${[...doc.sets].join(' ') || 'no sets'} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      for (const b of doc.bad.slice(0, 5))
        console.log(`       p${b.page} "${b.text}" — ${b.count} of ${b.ink} drawn px differ` +
          (b.unexplained ? `, ${b.unexplained} px of page ink unexplained` : '') + ` (${b.set})`);
      if (doc.skipped) totals.skips++;
      totals.docs++; totals.pages += doc.pages; totals.drawn += doc.drawn; totals.clean += doc.clean;
      totals.exact += doc.exact; totals.other += doc.other; totals.fallbacks += doc.fallbacks;
    }
    if (errors.length) { console.error('page errors:', errors.slice(0, 5)); failed = true; }
  } finally {
    await browser?.close();
    server.kill();
  }
  console.log(`\n${totals.docs} documents, ${totals.pages} pages: ${totals.exact}/${totals.clean} byte-clean lines ` +
    `reproduce the page exactly (${totals.other} uncertified lines drawn, ${totals.fallbacks} SVG fallbacks` +
    (totals.skips ? `, ${totals.skips} SKIPPED as too slow to read` : '') +
    (totals.errors ? `, ${totals.errors} ERROR` : '') + ')');
  console.log(failed ? 'FAIL' : 'PASS');
  process.exit(failed ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
