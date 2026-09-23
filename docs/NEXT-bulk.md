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

## EFTA00173953 — the "multiple days" document (2026-09-23)

A 69-page FBI OCDETF memo the app roster read nothing of. Two days, one family:
**a Word document whose Times New Roman was never embedded**, so the eDiscovery
chain's mupdf drew its builtin URW Nimbus Roman — `nimbusromlin942` in
`lab/families.mjs` (11 pt body = em64 942; 10 pt = 849; small caps 768; the red
8 pt warning = 685), linear law, a palette per page. Registry pool
`nimbusrom942`; gate entry `fbimemo` holds the read still: **1,075 lines,
47,583 glyphs, 3,014 □** (5,598 before the residue rule; 3,807 before LAWS
§13). Not a clean document — a family, seven free sets, two reader rules,
and a method:

- **Every lab prefilter was blind.** `mbank scan`, `identify`, `sweep` compare
  `law(coverage)` to the page; a palettized page holds `Q(law(coverage))`, and
  62 % of the corpus is palettized. `lab/palettesweep.mjs` applies the page's
  own palette before comparing (lab/README.md, METHOD rule 9). **Re-run the
  item-2 hunt (the sans e-mail body) through it before believing its "no `m`
  matches".**
- **The law-free fit** (isotonic residual of coverage → byte, each target at its
  own ¼-px phase) named Nimbus Roman out of 792 faces at 0.0–0.1 bytes; the
  nearest impostor was at 3. Refuted on the way, with the numbers in the
  transcript: hinted FreeType (v35/v40/light/auto), GDI, high-resolution
  render + downscale, Liberation Serif, three Times New Roman builds,
  Ghostscript and poppler renders.
- **Graphic residue** (LAWS §9): the agency seal was 2,700 of the 5,598 □.
  What survives whitening inside an emblem is masked now; `nimbusrom` 161 → 155.
- **Black text, by cause** (`census`: every □ classed by the pixels around
  it and labelled by the text layer, 2026-09-24): 1,105 black-text □ before,
  **435** after — ~900 of them were the date and count columns of the tables
  on pages 20–26, cells on their own baselines in one band (LAWS §13 side
  lines), and 148 → 36 were the tables' horizontal borders, lost where they
  crossed a redacted column (LAWS §13 crossing rules). Corpus A/B, 300
  documents: 4 better, 0 worse, 212 lines better, time unchanged.

What is still □ in it — black text first, as asked:

0. **Black text, 435 □:** bullets (56: Word's `■`, a Symbol/Dingbats glyph
   no set has — mupdf's URW Dingbats is inside its wasm, not in `fonts/`);
   single-glyph cells (the count column `1`, `S`/`P`/`F` on p26 — one fail
   is not a run, so the side probe skips it; relax to isolated single fails
   beside the line and measure the probe cost); p26's right-hand column
   (111 □, a table whose cells the side probe does not yet reach — look);
   the bold header/footer line on p55+ reads garbled (`SSl'VEBUUNS`: a
   different phase or a scan?); the p1 agency strip (no text layer: logos).
   The coloured and residue classes below are not black text and wait.

1. **Coloured text through the linear law** — the red warning blocks (415 □).
   Nimbus at em64 685 reads 481 of their glyphs at ±2 and none at 0:
   `colourInk` converts colour to a gray pen but does not apply this family's
   +1 post-law on the colour channels. LAWS §9 needs a paragraph and the
   converter a flag the pool can set.
2. **The seal's converted parts** (~900 □, ~13 a page): its colours that DO
   convert through some pen survive as ink no set reads. The residue rule
   only sees what was whitened.
3. **Checkboxes** — Zapf Dingbats. mupdf's builtin URW Dingbats is inside
   `node_modules/mupdf/dist/mupdf-wasm.wasm`, not in `fonts/`; extract, verify
   the licence (it is URW base-35, free), generate at 942.
4. **Black redaction blocks** with text beneath: the text layer has words
   there; `hunt harvest` returns their bytes as targets — a harvest must skip
   components that are one dark rectangle (the "fbi2" harvest was all that).
5. Table borders and a few touching italic pairs.

The sibling search — 741 corpus documents with the same text-layer font
signature, first pages read — found no second document of this family; the
signature is the OCR tool's, not the producer's. This family is a method
result more than a corpus lever.

## Speed — where the time goes, and what would change it (2026-09-24)

Measured on the 15,000-document baseline run (103 worker-hours, 16 logical
CPUs; `done.tsv` has the ms per document, the slim records the outcome):

| | documents | share of all reading time |
|---|---:|---:|
| over 10 s | 3,625 (24 %) | 90 % |
| over 30 s | 1,484 (10 %) | 81 % |
| over 120 s | 479 (3 %) | 65 % |
| over 300 s | 177 (1 %) | 50 % |
| with a page that hit the 120-s CPU budget | 230 | 38 % |
| **right at tolerance 0** (5,390) | | **4 %** |
| right AND over 30 s | 14 | 0.2 % |
| right AND over 120 s | 0 | 0 |

Read that table twice. The reader spends 96 % of its time on documents it
does not get right, and **a document that needs more than 30 s is right 14
times in 1,484**. The time is the sweep: a band nothing reads is probed at
every set × phase × baseline of every rung, and the same page then gets the
same treatment at the next rung. Nothing about the constant factor of the
inner loop matters as much as this tail.

What would change it, in order of gain per hour of work:

1. **A 30-s page budget, and a slow lane.** `--page-budget 30` (the switch
   exists) costs at most 14 of 5,390 right documents in this sample and
   drops the run to roughly a fifth of its time — 103 h → ~20 h per 15,000,
   the whole corpus from ~10 days to ~2 on this machine. The budgeted pages
   are recorded (`budget: true`), so a second, resumable pass with a bigger
   budget over ONLY those pages recovers the 14 later, at leisure. Measure it
   first on the 300-sample: same command, `--page-budget 30`, `abcmp`.
2. **Stop sweeping a page whose family is not in the roster.** 10,189 of the
   34,416 pages read no glyph at all, and each paid the full sweep at every
   rung. After the first K text-like bands (≥ 9 rows, ≥ 40 px of ink) fail
   at every set, phase and baseline, the page is not ours: report the rest
   unread without probing. Measure K on the sample first — how many pages
   read a line AFTER three consecutive fully-failed bands (a letterhead
   graphic over readable text is the case to protect).
3. **Order the sets, do not enumerate them.** The fast path already tries
   the previous band's winner first. A cheap per-band screen (line height
   from the band's rows, the `mbank` 4-px `m` signature) would rank the
   roster before the sweep; METHOD rule 8 — a screen ranks, it does not
   eliminate — so the full sweep stays as the fallback, but the clean read
   arrives after one or two sets instead of twenty-two.
4. **Rust for the inner loop, not for the reader.** `hunt` got 92–106× over
   the JavaScript sweep, and the reader's time is the same kind of loop
   (`scanLine` / `tryCand`, hundreds of thousands of probes a page). A port
   of readPage is weeks; a port of the probe alone, called from readPage
   through N-API, is days, and the gate certifies it byte for byte. Do this
   AFTER 1–3: it multiplies whatever is left, and 1–3 remove most of it.
5. **More machines, not more cores.** The runner is resumable and shards
   (`--shard k/n`); the roster is Windows fonts but the machine that reads
   need not be (`cc76612`). A second box halves the calendar.

Today's side-line probes (LAWS §13) add work only on bands that read
something and failed the rest. Measured on 300 documents of the sample,
committed engine vs this one, each run alone on the machine: total reading
time ×0.99 (6,085 s → 6,027 s), per document median ×1.03 and 90th
percentile ×1.44 — the partially read documents pay, the tail does not
notice. Documents right 100 → 101, □ 7,889 → 7,481, 212 lines better and
none worse. (The residue rule of `271fd78`, measured the same way against
the Sept-21 engine: 98 → 100 right, 17 better, 7 "worse" — every one of the
seven a whitened emblem whose leftover pieces now count as two unread bands
instead of one, not a line lost.)

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
- `fixtures/corpus/EFTA00173953.pdf` is gitignored (the memo is public, but not
  ours to redistribute here); the `fbimemo` gate entry skips without it.
