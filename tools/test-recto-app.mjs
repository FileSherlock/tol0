// test-recto-app.mjs — end-to-end smoke of the Recto ocr_tool plugin (the
// synced engine running inside the Django PDF editor). Spawns the Django dev
// server, opens the app headless, uploads a CERTIFIED document through the
// real file input (fixtures/corpus/nimbus791/EFTA00751637.pdf — a gate entry,
// 0 □, read with the entirely-free nimbus791 set) — deliberately NOT Recto's
// bundled default, which is app-side and may be swapped for experiments — runs
// Auto OCR on page 1 through the plugin's own entry point, and asserts that
// byte-clean 'ocr' text boxes landed in the unified text box system — and
// that the MuPDF pixel view reproduces every clean line's pixels exactly.
//
//   node tools/test-recto-app.mjs [--recto <path-to-Recto>] [--chrome <exe>]
//
// Run after every `npm run sync:recto` (and after adapter edits in Recto).
// This is the one place a headless browser is still required, which is why
// puppeteer-core is a devDependency and not a dependency: the reader, the
// rasterizer and the gate dropped Chrome entirely.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { rectoLayout } from './recto-layout.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// First Chrome/Chromium/Edge that exists, or '' (we then error with a clear
// message; CHROME=<path> / --chrome always win).
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
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].find(existsSync) || '';
  return [                                   // linux
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].find(existsSync) || '';
}

const o = { recto: resolve(REPO, '..', 'Recto'), chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--recto') o.recto = resolve(process.cwd(), next());
  else if (a === '--chrome') o.chrome = next();
}
const layout = rectoLayout(o.recto);
if (!layout) { console.error(`no Recto checkout at ${o.recto} — pass --recto`); process.exit(2); }
if (!o.chrome) {
  console.error('no Chrome/Chromium/Edge found — pass --chrome <exe> or set CHROME');
  process.exit(2);
}

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

async function run() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const { command, args } = layout.server(port);
  const server = spawn(command, args, { cwd: o.recto, stdio: 'ignore' });
  let browser, failed = false;
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: o.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(base, { waitUntil: 'load' });
    // engine + adapter present, default document loaded. NB: state is a
    // top-level const (global lexical binding, NOT a window property).
    try {
      await page.waitForFunction(() => typeof BlindOCR !== 'undefined' &&
        typeof OCRTool !== 'undefined' && typeof utbState !== 'undefined' &&
        typeof state !== 'undefined' && (state.pageImages ? state.pageImages.length : state.numPages) > 0);
    } catch (e) {
      const diag = await page.evaluate(() => ({
        BlindOCR: typeof BlindOCR, OCRTool: typeof OCRTool,
        utbState: typeof utbState, state: typeof state,
        pages: typeof state !== 'undefined' ? (state.pageImages ? state.pageImages.length : state.numPages) : null,
      }));
      console.error('startup diagnostics:', diag);
      if (errors.length) console.error('page errors:', errors.slice(0, 8));
      throw e;
    }

    // Upload the certified test document through the real file input — the
    // OCR verdict must not depend on whatever document the app opens by
    // default (that is Recto-side and swappable).
    const TEST_PDF = join(REPO, 'fixtures', 'corpus', 'nimbus791', 'EFTA00751637.pdf');
    if (!existsSync(TEST_PDF)) throw new Error(`test document missing: ${TEST_PDF}`);
    const fileInput = await page.$('#pdf-file');
    if (!fileInput) throw new Error('#pdf-file input not found');
    await fileInput.uploadFile(TEST_PDF);
    await page.waitForFunction(() => state.numPages === 7 && (state.pageImages ? state.pageImages.length : state.numPages) === 7);

    // The adapter auto-reads every loaded document and then picks the shown
    // text layer. Wait for that cycle to settle FIRST — clicking the manual
    // buttons mid-auto-run would race it — then assert the choice: this is a
    // scanned document (no embedded text), so the OCR layer must be shown.
    await page.waitForFunction(() => OCRTool.state.autoDone && !OCRTool.state.running);
    const auto = await page.evaluate(() => ({
      ocrBoxes: utbState.boxes.filter(b => b.type === 'ocr').length,
      ocrHidden: document.body.classList.contains('hide-ocr-text'),
      embeddedHidden: document.body.classList.contains('hide-embedded-text'),
      status: document.getElementById('ocr-status')?.textContent ?? '',
    }));
    if (!(auto.ocrBoxes > 0 && !auto.ocrHidden && auto.embeddedHidden)) {
      console.error(`  FAIL: auto OCR/layer choice — ${auto.ocrBoxes} boxes, ` +
        `ocrHidden=${auto.ocrHidden}, embeddedHidden=${auto.embeddedHidden}`);
      console.error(`  status: ${auto.status}`);
      failed = true;
    }

    // Drive the REAL UI (a programmatic OCRTool.run() would mask dead button
    // wiring — that bug happened): toggle the subtoolbar, press "This page",
    // then wait for actual 'ocr' boxes — a dead button times out here.
    await page.click('#toggle-ocr-tool');
    await page.waitForFunction(() =>
      !document.getElementById('ocr-tool-bar')?.classList.contains('hidden'));
    await page.click('#ocr-run-page');
    await page.waitForFunction(() => typeof OCRTool !== 'undefined' &&
      !OCRTool.state.running && utbState.boxes.some(b => b.type === 'ocr'));

    const r = await page.evaluate(() => {
      const ocr = utbState.boxes.filter(b => b.type === 'ocr');
      return {
        status: document.getElementById('ocr-status')?.textContent ?? '',
        boxes: ocr.length,
        clean: ocr.filter(b => b.ocr?.clean).length,
        unread: ocr.filter(b => b.ocr?.unread).length,
        redactions: utbState.boxes.filter(b => b.type === 'redaction' && b.ocrSource).length,
        rendered: document.querySelectorAll('.utb-group[data-type="ocr"]').length,
        sample: ocr.find(b => b.ocr?.clean)?.text ?? '',
      };
    });

    // The OCR-text visibility toggle must actually hide/show the rendered
    // groups (drive the real button, like the run button above).
    const visibleOcrGroups = () => page.evaluate(() =>
      [...document.querySelectorAll('.utb-group[data-type="ocr"]')]
        .filter(g => getComputedStyle(g).display !== 'none').length);
    await page.click('#ocr-toggle-text');
    const hiddenCount = await visibleOcrGroups();
    await page.click('#ocr-toggle-text');
    const shownCount = await visibleOcrGroups();
    if (!(hiddenCount === 0 && shownCount > 0)) {
      console.error(`  FAIL: ocr-toggle-text — ${hiddenCount} visible while hidden, ` +
        `${shownCount} after re-show`);
      failed = true;
    }

    // MuPDF pixel view: drive the real toggles, then ask the adapter for its
    // per-box verdicts. Every byte-clean OCR box must reproduce the page with
    // ZERO differing pixels — the overlay IS the page — measured against the
    // raster the viewer actually shows, through the same whitening the reader
    // used. Then toggling off must restore the SVG text.
    await page.click('#ocr-pixel-view');
    await page.waitForFunction(() => PixelView.state.on && !PixelView.state.loading &&
      OCRTool.state.sets !== null && document.querySelectorAll('.utb-pixel').length > 0);
    await page.click('#ocr-pixel-diff');
    await page.waitForFunction(() => PixelView.state.diff);
    const pv = await page.evaluate(() => {
      const v = PixelView.verdict(state.currentPage);
      const rep = PixelView.report().filter(b => b.page === state.currentPage && b.clean);
      return {
        drawn: v.drawn, clean: v.cert, exact: v.certExact,
        bad: rep.filter(b => b.count !== 0).slice(0, 3)
          .map(b => ({ text: b.text.slice(0, 40), count: b.count, ink: b.ink })),
        images: document.querySelectorAll('.utb-pixel').length,
        fallbacks: v.fallbacks,
        status: document.getElementById('ocr-status')?.textContent ?? '',
      };
    });
    console.log(`  pixel view: ${pv.drawn} boxes as pixels, ${pv.exact}/${pv.clean} clean boxes ` +
      `reproduce the page exactly, ${pv.images} images, ${pv.fallbacks} SVG fallbacks`);
    if (!(pv.drawn > 0 && pv.clean > 0 && pv.exact === pv.clean && pv.images === pv.drawn)) {
      console.error('  FAIL: MuPDF pixel view —', JSON.stringify(pv.bad), pv.status);
      failed = true;
    }
    await page.click('#ocr-pixel-view');
    const leftOver = await page.evaluate(() => document.querySelectorAll('.utb-pixel').length);
    if (leftOver !== 0) { console.error(`  FAIL: ${leftOver} pixel images left after toggling off`); failed = true; }

    console.log(`Recto ocr_tool: ${r.boxes} ocr boxes (${r.clean} byte-clean, ` +
      `${r.unread} unread), ${r.redactions} redaction boxes, ${r.rendered} rendered`);
    console.log(`  status: ${r.status}`);
    console.log(`  sample: "${r.sample.slice(0, 70)}"`);
    // the read must have gone through the adapter's Worker (ocr-worker.js):
    // an inline fallback still produces boxes but freezes the page
    const via = await page.evaluate(() => OCRTool.state.readVia);
    if (via !== 'worker') { console.error(`  FAIL: the read ran ${via || 'nowhere'}, not in the OCR worker`); failed = true; }
    if (errors.length) { console.error('  page errors:', errors.slice(0, 5)); failed = true; }
    if (!(r.boxes > 0 && r.clean > 0 && r.rendered > 0)) {
      console.error('  FAIL: expected >0 boxes, >0 byte-clean, >0 rendered');
      failed = true;
    }
    console.log(failed ? 'FAIL' : 'PASS');
  } finally {
    await browser?.close();
    server.kill();
  }
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
