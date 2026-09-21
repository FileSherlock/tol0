# The bulk project — where it stands

*Session brief, written for whoever picks this up next (2026-09-21). Delete it
when its open items are closed; the durable parts belong in README / LAWS.*

The goal: tolerance-0 reads across the whole corpus —
`/run/media/jaguarm/Volume/_Epstein/dataset9-more-complete`, 531,238 PDFs,
1,196,048 pages — with **documents right at tolerance 0** as the score
(target: 30 % in a year).

## What exists now

| | |
|---|---|
| `tools/bulk.mjs` | a job over a corpus: persistent workers, one writer, resumable, safe on a desk machine (`tools/bulk/pool.mjs` says why each safeguard is there) |
| `inventory` job | what every page IS, in ms a page. **Done for the whole corpus**: `bulk-out/inventory-dataset9/` (35 min, 0 errors) |
| `read` job | `blind-read`'s read on `tools/read-core.mjs`, byte-identical JSON (40/40 sampled + a gate document). `--ladder tol0` = the app's escalating read at the byte-exact rungs only |
| `tools/bulk/inventory-report.mjs` | the corpus in numbers |
| `tools/bulk/read-report.mjs` | the score, and — joined with the inventory — which writers / line heights hold the unread lines |

`bulk-out/` is gitignored. A run directory is resumable: the same command
again skips every name in its `done.tsv`.

## The corpus (inventory, all of it)

- **88.3 % rendered** pages (1,055,587) — readable in principle; 7.4 % scans,
  3.6 % thumbnails, 0.2 % vector. 956,065 *distinct* rendered pages (9.4 % are
  the same pixels again).
- **61.6 % of pages are `/Indexed` palette images.** The palette law is not an
  option here, it is the main road (`--ladder` gives the palette rungs the
  page's true palette from the PDF).
- **48 % of rendered pages have 14 px lines** (Times 16 px e-mails).
- No PDF has an Info dictionary. A writer's signature is header + marker +
  text-layer fonts: `%PDF-1.5 +marker` ≈ 2/3, `%PDF-1.3 no marker` ≈ 1/3.

## The baseline (fair random sample, app roster, tolerance-0 ladder)

Drawn with `--seed 2026` and read **in the order drawn**, so whatever part of a
run is done is itself a fair sample — report on it any time:

```bash
node tools/bulk/read-report.mjs bulk-out/read-baseline-s15000 --inventory bulk-out/inventory-dataset9
```

- `bulk-out/read-before-padevidence/` — the first **2,363** documents of that
  sample on the engine BEFORE the underline fix (stopped on purpose: it is the
  "before").
- `bulk-out/read-baseline-s15000/` — the same sample, all 15,000, on the
  engine after it. Started 02:17 on 2026-09-21, ~5 h. Its first 2,363 names
  are the very same documents, so the two directories are a before/after.

On the old engine, first 379 documents: **18.2 % of documents right at
tolerance 0**, 16.4 % of pages (18.9 % of rendered ones), 64.7 % of lines. (An
earlier "77 % of lines" of mine was wrong: that script counted unread bands as
clean.)

Cost: ~6.6 s a page per worker with the 22-set roster and the ladder. A whole-
corpus ladder pass is ~3 weeks on this machine as things stand: **reading
speed, not storage, is the bottleneck** — the Rust port of the reader (the
hunt got 92–106×) is the investment that changes this.

## The to-do list the reports produced

1. **Underlined links — the biggest single lever.** On the dominant group
   (14 px colour pages: 82 % of lines clean, 7 of 260 pages clean) a partial
   page has a median of **2** bad lines, and they are overwhelmingly the blue,
   underlined e-mail address / URL: `…by e-mail to jeevacation@gmail com, and`.
   - **the dot — DONE** (`a173aeb`, LAWS §9 "A pad is don't-care, not blind"):
     a byte in a lone rule's pad that is exactly the glyph's is evidence.
     Gate: `email` 14 □ → 7, 17 documents identical. 300 corpus documents:
     272 lines better, none lost, 307 dots gained, no glyph lost.
     Two variants were tried and REJECTED on corpus evidence the gate did not
     show: shrinking the pad to rows that vote as the rule's AA (12 lines
     worse, two of them clean — the old "link rows regressed"), and the same
     evidence unfenced (it read a `)` under a redaction bar).
   - **`@g` — OPEN, and now the one thing between most of those lines and
     clean**: one pixel at (x, baseline+1) where the tail of `@` meets `g` —
     page 247, predicted 255 (EFTA00943243 p1 y431, col 317). No rule there
     (browsers skip ink under descenders): a glyph-raster question, probably
     the `@` of the producer's Times build, or the `@`+`g` composite. Every
     `…@gmail.com` has it.
2. **Unread bands** on the same pages (634 in the first 379 documents) — not
   yet looked at (headers in other faces? signatures?). `read-report` groups
   them by writer and line height.
3. **Slow pages**: the 8 slowest documents are ~30 % of all read time; unread
   bands are the most expensive thing the reader does (every set × phase ×
   baseline, and nothing to show for it).
4. Colour groups at 11/12/13/17 px read 6–48 % — sets to hunt, sized in the report.

## Engine fixes made on the way (all gate-certified, committed)

- `producerMetrics` skips a search that cannot win.
- The flood cache is bounded (typed components, a per-band budget that counts
  steps as well as pixels): one page held 1.3 GB.
- **A livelock**: the "rule's own pieces" branch absorbed pixels without
  retiring them; on an `/Indexed` page one probe span for ever and took the
  heap with it (EFTA00039989 p4). Fixed, with a forced-retire last resort and
  a synthetic regression test.
- mupdf objects are destroyed explicitly (a worker that reads a million pages
  cannot wait for GC finalizers).
- **A rule's pad is don't-care, not blind** — see the to-do list, item 1.

## Rules for running things here

The first full inventory took the desktop session down (16 leaking workers,
`systemd-oomd` killed gnome-shell). Everything heavy goes through
`tools/bulk.mjs`: kernel memory cap (systemd scope), niced workers, memory
ceiling, low-memory brake, big-file lane, one version of the code per run (a
run stops itself if a file it stands on changes — so **do not edit
`engine/*.js`, `tools/read-core.mjs`, `tools/bulk/job-*.mjs`, `worker.mjs`,
`rasterize-mupdf.mjs` while a run is going**). New parallel job: small and
watched first. To try an engine idea while a run is going, work in a scratch
copy of `engine/ tools/ test/` with `node_modules assets fixtures` symlinked in
— the real gate runs there — and judge it by the gate AND a line-by-line A/B
on a few hundred corpus documents (leave out pages marked `budget`).

## Open

- Recto's copies of `engine/blindocr.js` and `engine/ocr-engine.js` are stale
  (`npm run sync:recto:check`). Not synced — that is the user's call.
- Nothing from this work is pushed.
