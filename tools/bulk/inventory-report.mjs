// inventory-report.mjs — an inventory run (bulk.mjs inventory), read as the
// questions a year of reading keeps asking:
//   how much is there, and how much of it can tolerance 0 ever read
//     (a RENDERED page — exact white paper — against a scan of one)
//   how much is the same pixels again (read once, credited everywhere)
//   who wrote it (header + marker + text-layer fonts: a writer's signature
//     where, as here, no PDF has an Info dictionary)
//   what it looks like (image size, colour, palette, how tall a line is)
//
//   node tools/bulk/inventory-report.mjs <run dir> [--json out.json] [--pages pages.tsv]
//
// Streams the parts (a corpus-sized run does not fit in a string); safe on a
// run that is still going — a torn last line is skipped. --pages writes one
// row per page (name, n, class, px, img, mode, cs, white, levels, colour,
// bands, bandH, tl) for whatever comes next: clustering, picking a sample,
// joining against a read run's done.tsv.
//
// Classes, from the pixels alone (classify.mjs):
//   rendered   the commonest level is exact white and covers ≥ 60 % of the page
//   blank      rendered, and nothing on it darker than 128
//   scan       anything else with an image: paper that is not 255, or a photo
//   small      the largest image is under 600 px wide — a thumbnail or a logo,
//              not a page
//   vector     no embedded image (out of scope: rendering would invent pixels)
import { createReadStream, createWriteStream, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join, resolve } from 'node:path';
import { classOf } from './classify.mjs';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : null; };
const jsonOut = opt('json'), pagesOut = opt('pages');
const dir = resolve(args[0] ?? '.');


const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m, n = 10) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + ' %' : '–');

const T = { docs: 0, pages: 0, bytes: 0, classes: new Map(), writers: new Map(), writerRendered: new Map(), sizes: new Map(), modes: new Map(),
  cs: new Map(), bandH: new Map(), pagesPerDoc: [], textLayer: 0, px: new Map(), sha: new Map(), renderedPx: new Map(), colourPages: 0 };
const pagesTsv = pagesOut ? createWriteStream(resolve(pagesOut)) : null;
pagesTsv?.write('name\tn\tclass\tpx\timgW\timgH\tmode\tcs\twhite\tlevels\tcolour\tbands\tbandH\ttl\n');

for (const f of readdirSync(dir).filter(f => /^part-\d{4}\.jsonl(\.gz)?$/.test(f)).sort()) {
  const src = createReadStream(join(dir, f));
  const rl = createInterface({ input: f.endsWith('.gz') ? src.pipe(createGunzip()) : src, crlfDelay: Infinity });
  for await (const line of rl) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    T.docs++; T.pages += r.pages; T.bytes += r.bytes; T.pagesPerDoc.push(r.pages); bump(T.sha, r.sha);
    const writer = `${r.hdr ?? '?'} ${r.mark ? '+' + r.mark : 'no marker'} · ${r.fonts.slice().sort().join(',') || 'no text-layer fonts'}`;
    bump(T.writers, writer, r.pages);
    for (const p of r.p) {
      const c = classOf(p);
      bump(T.classes, c);
      if (p.tl) T.textLayer++;
      if (p.px) bump(T.px, p.px);
      if (p.img) { bump(T.sizes, p.img.join('×')); bump(T.modes, p.mode === 4 ? 'colour (R,G,B kept)' : 'gray'); bump(T.cs, p.cs ?? '?'); }
      if (c === 'rendered') { bump(T.writerRendered, writer); bump(T.renderedPx, p.px); bump(T.bandH, p.bandH); if (p.colour > 0.0005) T.colourPages++; }
      pagesTsv?.write([r.name, p.n, c, p.px ?? '', p.img?.[0] ?? '', p.img?.[1] ?? '', p.mode ?? '', p.cs ?? '', p.white ?? '', p.levels ?? '', p.colour ?? '', p.bands ?? '', p.bandH ?? '', p.tl ?? 0].join('\t') + '\n');
    }
  }
}
pagesTsv?.end();

const cls = k => T.classes.get(k) ?? 0;
const rendered = cls('rendered');
const dupPages = T.pages - cls('vector') - cls('error') - T.px.size;
const uniqueRendered = T.renderedPx.size;
T.pagesPerDoc.sort((a, b) => a - b);
const q = f => T.pagesPerDoc[Math.min(T.pagesPerDoc.length - 1, Math.floor(T.pagesPerDoc.length * f))] ?? 0;

const out = [];
out.push(`${dir}`);
out.push(`documents ${T.docs} · pages ${T.pages} · ${(T.bytes / 1e9).toFixed(1)} GB · pages/doc mean ${(T.pages / (T.docs || 1)).toFixed(2)}, p50 ${q(.5)}, p90 ${q(.9)}, p99 ${q(.99)}, max ${T.pagesPerDoc.at(-1) ?? 0}`);
out.push(`identical documents (same bytes under another name): ${T.docs - T.sha.size}`);
out.push('');
out.push('what a page is');
for (const k of ['rendered', 'blank', 'scan', 'small', 'vector', 'error']) out.push(`  ${k.padEnd(9)} ${String(cls(k)).padStart(9)}  ${pct(cls(k), T.pages)}`);
out.push(`  with a text layer of its own: ${T.textLayer} (${pct(T.textLayer, T.pages)})`);
out.push('');
out.push(`the same pixels again: ${dupPages} of ${T.px.size + dupPages} image pages are repeats (${pct(dupPages, T.px.size + dupPages)})`);
out.push(`  → rendered pages worth reading: ${uniqueRendered} distinct of ${rendered} (${pct(rendered - uniqueRendered, rendered)} saved by reading a page once)`);
out.push(`  rendered pages carrying colour: ${T.colourPages} (${pct(T.colourPages, rendered)})`);
out.push('');
out.push('writers (pages; of which rendered)');
for (const [k, v] of top(T.writers, 12)) out.push(`  ${String(v).padStart(9)}  ${String(T.writerRendered.get(k) ?? 0).padStart(9)}  ${k}`);
out.push('');
out.push('image size            ' + top(T.sizes, 8).map(([k, v]) => `${k}: ${v}`).join(' · '));
out.push('kept as               ' + top(T.modes).map(([k, v]) => `${k}: ${v}`).join(' · '));
out.push('colour space          ' + top(T.cs, 6).map(([k, v]) => `${k}: ${v}`).join(' · '));
out.push('line height (median band, rendered pages, px: pages)');
out.push('  ' + top(T.bandH, 14).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${v}`).join(' · '));
console.log(out.join('\n'));

if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify({ dir, docs: T.docs, pages: T.pages, bytes: T.bytes, classes: Object.fromEntries(T.classes),
  textLayer: T.textLayer, distinctImagePages: T.px.size, repeatedImagePages: dupPages, rendered, distinctRendered: uniqueRendered,
  writers: top(T.writers, 50), sizes: top(T.sizes, 30), colourSpaces: top(T.cs, 10), bandH: [...T.bandH].sort((a, b) => a[0] - b[0]) }, null, 1) + '\n');
