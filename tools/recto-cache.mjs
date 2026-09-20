// recto-cache.mjs — regenerate Recto's precomputed OCR cache for its startup
// document (ocr_tool/cache/<sha256>.json), which Recto commits so visitors get
// the boxes without running the engine.
//
// Django layout: the adapter writes that file itself at the end of a full
// automatic read of the startup document in DEBUG mode; this just opens the app
// headless and waits for that to happen. Static layout
// (web/plugins/ocr_tool/cache/): a read is kept in the browser's IndexedDB, so
// this takes the finished read out of the page and writes the file. Either
// way the file must be there afterwards with the current payload version. Run after a payload-shape change (OCR_CACHE_VERSION bump)
// or an engine re-sync.
//
//   node tools/recto-cache.mjs [--recto <path>] [--chrome <exe>]
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const o = { recto: resolve(REPO, '..', 'Recto'), chrome: process.env.CHROME || findChrome() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i], next = () => process.argv[++i];
  if (a === '--recto') o.recto = resolve(process.cwd(), next());
  else if (a === '--chrome') o.chrome = next();
}
const layout = rectoLayout(o.recto);
if (!layout) { console.error(`no Recto checkout at ${o.recto} — pass --recto`); process.exit(2); }
if (!o.chrome) { console.error('no Chrome found — pass --chrome <exe>'); process.exit(2); }

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
  let browser, ok = false;
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: o.chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(900000);
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof OCRTool !== 'undefined' && typeof state !== 'undefined' &&
      (state.pageImages ? state.pageImages.length : state.numPages) > 0);
    const hash = await page.evaluate(() => state.docHash);
    const file = join(layout.cacheDir, `${hash}.json`);
    // an existing file of the CURRENT version would be replayed as a hit and
    // never rewritten — remove it and reload so the engine really runs
    if (existsSync(file)) {
      rmSync(file);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => typeof OCRTool !== 'undefined' && typeof state !== 'undefined' &&
        (state.pageImages ? state.pageImages.length : state.numPages) > 0);
    }
    await page.waitForFunction(() => OCRTool.state.autoDone && !OCRTool.state.running);
    const status = await page.evaluate(() => document.getElementById('ocr-status')?.textContent ?? '');
    await new Promise(r => setTimeout(r, 500));          // the store is fire-and-forget
    if (layout.kind === 'static') {
      // the page's own cache lookup: no shipped file now, so this is the read just made (IndexedDB)
      const payload = await page.evaluate(async () => JSON.stringify(await ocrFetchCache(state.docHash)));
      if (!payload || payload === 'null') throw new Error('the page holds no finished read of the startup document');
      mkdirSync(layout.cacheDir, { recursive: true });
      writeFileSync(file, payload);
    }
    if (!existsSync(file)) throw new Error(`cache file not written: ${file}`);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const ver = await page.evaluate(() => typeof OCR_CACHE_VERSION !== 'undefined' ? OCR_CACHE_VERSION : null);
    console.log(`startup document ${hash.slice(0, 12)}: ${status}`);
    console.log(`cache ${file}: version ${data.version} (adapter expects ${ver}), ${data.pages?.length} pages`);
    if (data.version !== ver) throw new Error('cache version does not match the adapter');
    if (/precomputed/.test(status)) throw new Error('the read was replayed from a cache, not computed — nothing was regenerated');
    const stale = readdirSync(dirname(file)).filter(f => f.endsWith('.json') && f !== `${hash}.json`);
    if (stale.length) console.log(`stale cache files for other documents (safe to delete): ${stale.join(', ')}`);
    ok = true;
  } finally {
    await browser?.close();
    server.kill();
  }
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}
run().catch(e => { console.error(e); process.exit(1); });
