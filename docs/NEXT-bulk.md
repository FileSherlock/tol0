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

- `bulk-out/read-baseline-s15000/` — **all 15,000, finished** (engine
  `eec39a2`, 10.4 h on 12 workers, 0 errors / timeouts / crashes; memory never
  above 10 GB in total, the system never below 17 GB free). Full report:
  `bulk-out/read-baseline-s15000.report.json`.
- `bulk-out/read-before-padevidence/` — the first 2,363 of the same sample on
  the engine BEFORE the underline fixes; `bulk-out/read-after-padevidence/` —
  the first 1,375 with the dot fix only (`a173aeb`). Same seed, drawn order:
  any two are a before/after on their common prefix.

(An early "77 % of lines clean" of mine was wrong: that script counted unread
bands as clean. Use `read-report.mjs`.)

## THE SCORE (fair sample of 15,000 documents, 34,416 pages)

| | |
|---|---:|
| **documents right at tolerance 0** | **5,359 of 15,000 — 35.7 %** (±0.8 at 95 %) |
| pages clean | 8,838 of 34,416 — 25.7 % (28.9 % of the 30,557 rendered ones) |
| lines clean | 376,661 of 752,262 — 50.1 % |
| pages no set reads a glyph of | 10,761 |
| pages skipped as not text | 3,859 (scan 2,209 · small 1,277 · blank 291 · vector 77) |
| pages that ran out their CPU budget | 444 |

Documents are mostly one page and the short ones are the e-mails that read, so
the document score runs ahead of the page score, and the page score ahead of
the line score (long documents in unread families weigh on lines).

What the two underline fixes did, on the 2,363 documents both engines read:
**documents right 20.2 % → 35.1 %**, pages clean 19.7 % → 33.7 %, 1,909 lines
better. 11 lines of 100,000 carry one □ MORE than before — none of them was
clean before; each is an address line that gained its dot and shows a small □
elsewhere (same rung; the band's set pick shifts once the dot counts).

Where the unread lines are (pages · lines clean) — each a set, or a law, to hunt:

| group | pages | lines clean |
|---|---:|---:|
| 14 px colour (Times 16 e-mails) | 10,265 | 80.8 % — 4,149 pages clean; the rest: item 2 below |
| 13 px colour | 2,000 | 16.6 % |
| 12 px colour | 1,199 | 21.2 % |
| 13 px gray | 1,010 | 10.9 % |
| 10 px colour | 760 | 6.5 % |
| 9 px colour | 621 | 2.3 % |
| writers with `ArialMT` / `CourierNewPSMT` in the text layer | ~3,100 | 0–2 % — nothing reads: whole families missing |

Cost: 10.8 s a page per worker on average (median 3.9 s; the 8 slowest documents
are 16 % of all the time) with the 22-set roster and the ladder — 103 worker-
hours for this sample. A whole-corpus ladder pass is ~5 weeks on this machine
as things stand: **reading
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
   - **the sliver at `@g` — DONE** (`eec39a2`, LAWS §9 "The underline is broken
     where a descender crosses it…"): it was NOT a glyph question. A 64-phase
     pen sweep with the rasterizer clone put `@` and `g` exactly on the ¼
     lattice; the leftover pixel is a sliver of underline between two skip-ink
     breaks. `scanLine` judges a recorded fail again at line end by its dead
     survivors. Documents right 18.3 % → 33.0 % on 300 documents.
   - still open inside links: `/` and a few letters (`email`'s last 4 □).
2. **The sans-serif e-mail body — the next big lever, and a real hunt.** Of
   ~4,000 pages read, **358 have unread bands as their ONLY defect**, 206 of
   them just one or two: a Times header that reads (`From: … Sent: …`) over a
   body nobody reads. Cropped, the body is a sans face of the Arial/Helvetica
   kind with ~13 px lines (EFTA00432247 p1 y207, EFTA00414609 p1 y185,
   EFTA00841850 p1). What is known:
   - not `arial.ttf` at em64 832, 853 or 896 (sets generated to scratch and
     handed to `blind-read` as `.npz` paths: nothing reads);
   - `lab/mbank.mjs scan`, bank of 380 + 19 Windows faces × 23 sizes × 4
     phases: **no `m` matches, exact or `--tol1`**, on 5 of 6 such documents
     (the 6th names the Times header);
   - `hunt harvest` on one page gives 16 targets but merged components among
     them (an `o` 16 px wide — sans glyphs touch, and the text layer's labels
     are loose), so `hunt sweep`'s dimension probe rejects every face,
     including Times. A proper hunt needs targets from MANY pages of the
     family, and probably the anisotropic probe (`hunt probe --ex --ey`): no
     isotropic size of any face has these dimensions, which smells like text
     scaled after rendering — check against the old page-downscale work
     (branches `downscale-repro-08-04` / `page-downscale-payload` live only on
     the retired JaguarM remote and in `~/Desktop/tol0-old-git-history-2026-09-20`).
   The lab now runs under Linux: `TOL0_WINDOWS_FONTS` / `TOL0_USER_FONTS` stand
   in for the two Windows font folders (same positions, same bank names):
   ```bash
   export TOL0_WINDOWS_FONTS=/run/media/jaguarm/System2/Windows/Fonts
   export TOL0_USER_FONTS=/run/media/jaguarm/System2/Users/yanni/AppData/Local/Microsoft/Windows/Fonts
   node lab/mbank.mjs build        # 11 s, 38,548 templates
   ```
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
- **What is left of an underline between two descenders is still the underline** — item 1.

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
