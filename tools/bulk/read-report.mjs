// read-report.mjs — a bulk read run (bulk.mjs read), as the project's score
// and its to-do list.
//
//   node tools/bulk/read-report.mjs <read run dir> [--inventory <inventory run dir>] [--json out.json]
//
// The score: how many DOCUMENTS are right at tolerance 0 — every line of every
// page read with nothing unexplained — then pages, then lines. A page is
//   clean     every band read, no unexplained cluster (□), at a tolerance-0 rung
//   tolerant  the same, but the rung that managed it allowed ±1 or more per
//             pixel (--ladder all): read, NOT right at tolerance 0
//   partial   some lines clean, some not
//   unread    ink on it and no set read any of it
//   empty     no bands at all          vector  no embedded image
//   skipped   the inventory said it is not rendered text (scan, small, blank…)
//             and the read did not try (bulk.mjs read --inventory)
// A document is RIGHT when it has a clean page and every other page is clean,
// empty or a skipped blank — a document with a scanned page in it is not.
// The to-do list: which sets did the reading, where the time went (the
// slowest documents are engine work, not set work), and — with the inventory
// of the same corpus — which WRITERS and LINE HEIGHTS hold the lines nobody
// reads yet: each such group is a glyph set to hunt, and its size is what the
// hunt is worth.
//
// Streams the parts; safe on a run that is still going.
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join, resolve } from 'node:path';
import { classOf } from './classify.mjs';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : null; };
const invDir = opt('inventory'), jsonOut = opt('json');
const dir = resolve(args[0] ?? '.');

async function* records(d) {
  for (const f of readdirSync(d).filter(f => /^part-\d{4}\.jsonl(\.gz)?$/.test(f)).sort()) {
    const src = createReadStream(join(d, f));
    const rl = createInterface({ input: f.endsWith('.gz') ? src.pipe(createGunzip()) : src, crlfDelay: Infinity });
    for await (const line of rl) { try { yield JSON.parse(line); } catch {} }
  }
}
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const top = (m, n = 12) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + ' %' : '–');

export function pageStatus(P) {
  if (P.vector) return 'vector';
  if (P.skipped) return 'skipped';
  let read = 0, clean = 0, unread = 0;
  for (const L of P.lines ?? []) { if (L.unread) unread++; else if (L.baseline !== undefined) { read++; if (!L.fails) clean++; } }
  const exact = !P.pass || +P.pass.split('|')[0] === 0;
  return !read && !unread ? 'empty' : !read ? 'unread' : clean === read && !unread ? (exact ? 'clean' : 'tolerant') : 'partial';
}

// ---- the read run ----
const byName = new Map();                                  // last record of a name wins (sink.mjs)
for await (const r of records(dir)) byName.set(r.name, r);
const T = { docs: 0, right: 0, pages: 0, status: new Map(), rungs: new Map(), skipped: new Map(), budget: 0, rightRendered: 0, lines: 0, clean: 0, unread: 0, glyphs: 0, fails: 0, fonts: new Map() };
const perPage = new Map();                                 // name → [status per page, lines, clean, unread]
for (const r of byName.values()) {
  T.docs++; T.lines += r.tot.lines; T.clean += r.tot.clean; T.unread += r.tot.unread; T.glyphs += r.tot.glyphs; T.fails += r.tot.fails;
  const st = [];
  for (const P of r.p) {
    const s = pageStatus(P); st.push({ n: P.pno, s, why: P.skipped, lines: 0, clean: 0, unread: 0 });
    T.pages++; bump(T.status, s); if (P.skipped) bump(T.skipped, P.skipped); if (P.budget) T.budget++; if (P.pass) bump(T.rungs, P.pass);
    for (const L of P.lines ?? []) {
      const e = st.at(-1);
      if (L.unread) e.unread++; else if (L.baseline !== undefined) { e.lines++; if (!L.fails) e.clean++; bump(T.fonts, L.font); }
    }
  }
  perPage.set(r.name, st);
  if (st.some(x => x.s === 'clean') && st.every(x => x.s === 'clean' || x.s === 'empty' || (x.s === 'skipped' && x.why === 'blank'))) T.right++;
  if (st.some(x => x.s === 'clean') && st.every(x => x.s === 'clean' || x.s === 'empty' || x.s === 'skipped')) T.rightRendered++;
}

// ---- time, from the index ----
const times = [], statusN = new Map();
const donePath = join(dir, 'done.tsv');
if (existsSync(donePath)) for (const row of readFileSync(donePath, 'utf8').split('\n')) {
  const c = row.split('\t'); if (!c[0]) continue;
  bump(statusN, c[1]);
  if (c[1] === 'ok') times.push({ name: c[0], ms: +c[2], pages: +c[3] || 1 });
}
const ms = times.reduce((a, t) => a + t.ms, 0), pgs = times.reduce((a, t) => a + t.pages, 0);
const perPageMs = times.map(t => t.ms / t.pages).sort((a, b) => a - b);
const q = f => perPageMs[Math.min(perPageMs.length - 1, Math.floor(perPageMs.length * f))] ?? 0;

const out = [];
out.push(dir);
out.push(`documents ${T.docs} (${[...statusN].map(([k, v]) => `${k} ${v}`).join(' · ')}) · pages ${T.pages}`);
out.push('');
out.push(`RIGHT AT TOLERANCE 0   documents ${T.right} of ${T.docs} (${pct(T.right, T.docs)}) · pages ${T.status.get('clean') ?? 0} of ${T.pages} (${pct(T.status.get('clean') ?? 0, T.pages)})` +
  ` · lines ${T.clean} of ${T.lines + T.unread} (${pct(T.clean, T.lines + T.unread)})`);
out.push('pages                  ' + ['clean', 'tolerant', 'partial', 'unread', 'empty', 'vector', 'skipped'].map(k => `${k} ${T.status.get(k) ?? 0}`).join(' · '));
if (T.skipped.size || T.budget) out.push(`                       skipped: ${[...T.skipped].map(([k, v]) => `${k} ${v}`).join(' · ') || '–'} · pages that ran out their time budget: ${T.budget}`);
const readable = T.pages - (T.status.get('skipped') ?? 0) - (T.status.get('vector') ?? 0);
out.push(`of what is rendered text: documents right on every rendered page ${T.rightRendered} of ${T.docs} (${pct(T.rightRendered, T.docs)}) · pages ${T.status.get('clean') ?? 0} of ${readable} (${pct(T.status.get('clean') ?? 0, readable)})`);
out.push(`lines read ${T.lines} (clean ${T.clean}) · bands no set read ${T.unread} · glyphs ${T.glyphs} · unexplained clusters ${T.fails}`);
if (T.rungs.size) out.push('rung that read the page (tol|palette|mixed-font): ' + top(T.rungs).map(([k, v]) => `${k} ${v}`).join(' · '));
out.push('');
out.push('sets that did the reading (lines): ' + top(T.fonts, 14).map(([k, v]) => `${k} ${v}`).join(' · '));
out.push('');
out.push(`time: ${(ms / 3.6e6).toFixed(2)} worker-hours for ${pgs} pages → ${(ms / (pgs || 1)).toFixed(0)} ms/page mean · p50 ${q(.5).toFixed(0)} · p90 ${q(.9).toFixed(0)} · p99 ${q(.99).toFixed(0)} · max ${(perPageMs.at(-1) ?? 0).toFixed(0)}`);
const slow = times.slice().sort((a, b) => b.ms - a.ms).slice(0, 8);
const slowShare = slow.reduce((a, t) => a + t.ms, 0);
out.push(`  the 8 slowest documents are ${pct(slowShare, ms)} of all the time: ` + slow.map(t => `${t.name} ${(t.ms / 1000).toFixed(0)} s/${t.pages} p`).join(' · '));

// ---- against the inventory: who wrote the lines nobody reads ----
let groups = null;
if (invDir) {
  const G = new Map();                                     // group → { pages, clean, lines, cleanLines, unread }
  const add = (key, e) => { const g = G.get(key) ?? { pages: 0, cleanPages: 0, lines: 0, cleanLines: 0, unread: 0 }; g.pages++; if (e.s === 'clean') g.cleanPages++; g.lines += e.lines + e.unread; g.cleanLines += e.clean; g.unread += e.unread; G.set(key, g); };
  let matched = 0;
  for await (const r of records(resolve(invDir))) {
    const st = perPage.get(r.name); if (!st) continue;
    matched++;
    const writer = `${r.hdr ?? '?'} ${r.mark ? '+marker' : 'no marker'} · ${r.fonts.slice().sort().join(',') || '—'}`;
    for (const e of st) {
      const ip = r.p.find(x => x.n === e.n); if (!ip) continue;
      const c = classOf(ip);
      add(`class   ${c}`, e);
      if (c !== 'rendered') continue;
      add(`writer  ${writer}`, e);
      add(`height  ${String(ip.bandH).padStart(2)} px${ip.mode === 4 ? ' colour' : ''}`, e);
    }
  }
  groups = [...G].map(([k, g]) => ({ group: k, ...g, open: g.lines - g.cleanLines }));
  out.push('');
  out.push(`against the inventory (${matched} of ${T.docs} documents found there) — lines not yet clean, by group; the biggest are the sets to hunt`);
  for (const kind of ['class ', 'height', 'writer']) {
    out.push(`  by ${kind.trim()}`);
    for (const g of groups.filter(g => g.group.startsWith(kind)).sort((a, b) => b.open - a.open).slice(0, kind === 'writer' ? 10 : 12))
      out.push(`    ${String(g.open).padStart(8)} open of ${String(g.lines).padStart(8)} lines (${pct(g.cleanLines, g.lines).padStart(7)} clean) · ${String(g.cleanPages).padStart(6)}/${String(g.pages).padEnd(6)} pages clean · ${g.group.slice(8)}`);
  }
}
console.log(out.join('\n'));
if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify({ dir, docs: T.docs, right: T.right, pages: T.pages, status: Object.fromEntries(T.status),
  lines: T.lines, clean: T.clean, unread: T.unread, glyphs: T.glyphs, fails: T.fails, fonts: top(T.fonts, 100), workerHours: ms / 3.6e6, msPerPage: ms / (pgs || 1), groups }, null, 1) + '\n');
