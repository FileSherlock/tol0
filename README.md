# tol0

**Read government documents at tolerance 0 — every line certified, never sampled.**

This is not fuzzy OCR. It **re-renders** candidate glyphs with a byte-exact clone
of the producer's rasterizer and demands the pixels match *exactly*. When they
do, the read comes with a **certificate**: every non-object ink pixel of the line
was explained by the proven blend law, so the transcript is not a guess. Unread
ink becomes an honest `□` with coordinates — errors cannot pass silently.

The honest limit is the same sentence: a document that will not read at
tolerance 0 is one this toolkit says **no** to, loudly, rather than guessing at.

To read a document this way you must first know its **(face, size, pen lattice,
blend law)** — so the other half of the toolkit is machinery for identifying that
tuple from pixels alone.

## Where to read next

| | |
|---|---|
| [docs/LAWS.md](docs/LAWS.md) | the measured physics every claim rests on — pen lattice, blend, producer post-laws, colour |
| [docs/METHOD.md](docs/METHOD.md) | how this kind of problem is worked: eight rules that cost real time |
| [docs/FONTS.md](docs/FONTS.md) | what ships, what you regenerate, and why a fresh clone has 13 of 77 glyph sets |
| [fixtures/gate-ref/README.md](fixtures/gate-ref/README.md) | the gate's expected numbers, and every □ looked at one by one |
| [lab/README.md](lab/README.md) | the other half — finding the producer of a document nobody has read yet |

## What runs with nothing installed

```bash
npm install
npm run certify:ftclone   # the rasterizer clone vs the real mupdf
npm run certify:render    # the forward renderer (lattice + blend, whole lines) vs the real mupdf
npm test                  # engine primitives + render round trip on synthetic pages
npm run rust:build && npm run rust:certify   # the lab's fast engine (needs cargo)
```

```
pen lattice, measured now: x 5 distinct rasters per px (4 phases of 1/4 px + the 1-px shift), y 2 (integer rounding — no subpixel y)

CERTIFIED TTF y-phase  0/64 — 0 diffs over 1128 renders
CERTIFIED CFF y-phase  0/64 — 0 diffs over 1128 renders
```

None of those needs a PDF, a corpus document, or a system font — a deliberate
constraint, not a convenience. `ftclone/` is a JS port of the glyph pipeline
inside **mupdf 1.28 wasm** (FreeType 2.13 smooth rasterizer, integer 26.6
throughout); everything else depends on it, so it certifies itself against the
real thing, in two pipelines that share almost no code below the outline. The
third line holds the same line one level further out: `lab/rust/` is a port of
*that* port, and it proves itself against it over 3,000 seeded tuples and two
whole control sweeps drawn from the faces this repo ships.

## A read, end to end

```bash
node tools/rasterize-mupdf.mjs --pdf fixtures/corpus/nimbus791/EFTA00751637.pdf
node tools/blind-read.mjs --pdf fixtures/corpus/nimbus791/EFTA00751637.pdf \
     --page 1 --pool nimbus791 --truth fixtures/corpus/nimbus791/EFTA00751637.txt \
     --json p1.json
```

```
  page 1: 76 bands

76 lines, 4612 glyphs, 0 unreadable clusters (□), 0.4s
vs truth: 76 rows letter-exact (76 also space-exact), 0 rows differ
```

`--pool` names a **certified family read command** — the glyph sets, tolerance
and blend flags that family was actually proven with, taken from
`tools/glyph-registry.mjs` so it cannot drift. `--truth` is a check, not an
input: the reader never sees it.

One line of `p1.json`, which is where the certificate lives:

```json
{ "baseline": 101, "phy": 0, "font": "nimbus791", "fails": 0,
  "text": "Received: by 10.229.235.4 with SMTP id ke4mr6853629qcb.201.1291165934346;",
  "glyphs": [["R", 37.25], ["e", 44.5], ["c", 52], ["e", 59.5], ["i", 66.75], … ] }
```

`"fails": 0` is the claim: every ink pixel of that band was reproduced exactly.
Note the pens — 37.25, 44.5, 66.75. Nobody told the reader that this producer
places pens on a ¼-px lattice; it fell out of the search, and it is
[law §1](docs/LAWS.md#1-the-pen-lattice) turning up in a real document. Word
spacing is measured the same way: the space advance here is **7.4077 px**,
self-calibrated from the gap histogram rather than assumed, which is how narrow
styled spaces become measurements instead of errors.

Reading is not rendering: the rasterizer decodes the producer's own embedded
page image, because rendering would invent pixels and leave nothing to certify
against ([law §7](docs/LAWS.md#7-the-page-is-decoded-never-rendered)).

## A corpus, not a document

`blind-read.mjs` is one document in one process. A corpus of half a million
is `tools/bulk.mjs`: persistent workers on every core (the glyph sets are
loaded once per worker, not once per document), results written by one
process into a run directory you can kill and restart at will, and a page
read straight from the PDF's embedded image — no raster cache in between.

```bash
node tools/bulk.mjs inventory --in <dir of PDFs> --out bulk-out/inventory     # what every page IS: ms a page
node tools/bulk/inventory-report.mjs bulk-out/inventory                      # …read as the questions that steer a year
node tools/bulk.mjs read --in <dir> --out bulk-out/read-app --roster app      # the certified read, kept slim and lossless
node tools/bulk.mjs status --out bulk-out/read-app
```

A bulk read **is** `blind-read`'s read — both stand on `tools/read-core.mjs`,
and `test/bulk.test.js` holds a gate document to byte-identical JSON. It is
also built for a machine someone is sitting at: the run lives in a systemd
scope the kernel caps at half the RAM, workers are niced, replaced when they
grow, and huge files take a lane of their own — the reasons are in
`tools/bulk/pool.mjs`, and one of them is a desktop session that did not
survive the first attempt.

## The gate

The gate is what makes this repo trustworthy. It re-reads a fixed set of
documents and byte-compares whole transcripts against committed references:
**the expected numbers are the files in `fixtures/gate-ref/`, not prose**, so
any change in any number is the signal.

```bash
npm run gate
```

```
gate: 18/18 ok, 55s total
```

18 documents · **33,736 lines · 2,436,383 glyphs · 177 □, of which 149 are
coloured ink** (blue headings and links the sets cannot read yet — visible
since [law §9](docs/LAWS.md#9-coloured-ink-is-coverage) stopped whitening
them; 28 are neutral text). The 11 `nimbus791`
documents also carry truth transcripts and match **5,028 of 5,028 rows, spacing
included**. All 40 neutral □ of the first census have been looked at rather than assumed away — **24 are
ordinary black text**, i.e. a face missing from a pool, which is a hunt and a
winnable one; the rest is colour and graphics the reader is right to refuse.
Census, and what the reference has already caught:
[fixtures/gate-ref/README.md](fixtures/gate-ref/README.md).

The documents are real government PDFs and are not distributed (gitignored
`fixtures/corpus/`), and most pools need glyph sets whose faces are not
redistributable either — so a fresh clone runs 0 of 18, and says so per document,
naming the missing fixture or set. **Skipping is loud, and it is not a pass.**
The `nimbus791` block is the cheap way in: its pool is entirely free.

## Recto — the same bytes, in a browser

[Recto](../Recto) is a Django PDF editor whose `ocr_tool` plugin runs this
engine client-side. It has no copy of the engine; it has *these* files:

```bash
npm run sync:recto           # -> ../Recto/ocr_tool (default; --recto <path>)
npm run sync:recto:check     # report stale, write nothing, exit 1 if stale
npm run recto-test           # end-to-end: Django + headless Chrome + a real upload
```

The direction is the whole point: the engine is developed **only here**, where
the gate can certify it, so a read in the browser is the read the gate proved.
`--check` makes that auditable instead of assumed — it byte-compares and exits
non-zero. Two things the sync refuses to do quietly:

- **push an incomplete `glyphs.bin`.** The bundle holds whatever `.npz` you have
  locally, so a fresh clone would push 13 of 77 sets and swap Recto's dictionary
  for a smaller one with no error and no crash. The gate cannot catch it either
  — it reads through *named pools*, never the whole bundle. So the sync names
  the missing sets and stops (`--allow-partial` if you mean it).
- **let a UI bug hide.** `recto-test` uploads a gate document through the real
  file input and clicks the real buttons; a programmatic call would mask dead
  wiring, and that bug has happened. It is the only thing here that needs a
  browser, which is why `puppeteer-core` is a **devDependency**.

## Layout

```
ftclone/    the rasterizer clone's certification (vs mupdf: glyphs, render, rectangles) and
            its path-taking wrappers — the code itself is engine/ftraster.js
engine/     the DOM-free matcher: ink bands, baseline pin, the composite-aware
            scan, object/redaction detection, the per-line certificate;
            render.js runs the same laws FORWARDS (layout → composite → diff);
            set-fonts.js (generated from the registry) names every set's face
            ftraster.js is the certified rasterizer + font parsers (bytes in, so a
            browser runs what is certified) and makes glyph sets on demand
tools/      fontgen · glyph registry/bundle · rasterizer · reader CLI · gate · sync ·
            bulk (tools/bulk/: the corpus runner — pool, sink, inventory and read jobs) ·
            the clip and hypothesis benches · the Recto verifiers
            · ladder-bench (Recto's escalating read, timed per rung — the speed bench)
lab/        the other half: what produced these pixels? (see lab/README.md)
lab/rust/   optional: that half's exhaustive search, 40–45× and certified against it
fixtures/   gate documents (gitignored) + the reference transcripts
fonts/      the source faces this repo may legally ship
docs/       the laws, the method, the font/licence story
```

`ftclone/` is a top-level package rather than a detail of either half, and that
is load-bearing: `tools/` and `lab/` both need it, and neither may import the
other. `npm test` asserts that boundary instead of describing it. Since
2026-09-18 the rasterizer's code lives in `engine/ftraster.js` so the browser
can make glyph sets itself; `ftclone/*.mjs` wrap it, which means the lab now
reaches one engine file through `ftclone/` — and that file is exactly the one
`npm run certify:ftclone` holds still.

`engine/` is shared verbatim by the CLI and the browser app, so the scanning
physics has exactly one implementation; `test/engine.test.js` covers it on
**synthetic** pages only — 43 tests, ~40 ms, no assets, which is why they run
before the slow document gate.

## Status

Ported from a larger private working repo, one certified layer at a time.

- [x] **1. ftclone** — the rasterizer clone + font parsers, self-certifying
- [x] **2. engine** — the reader core + unit suite
- [x] **3. glyph pipeline** — registry · bundle · fontgen, with the licence split
- [x] **4. reader CLI + the byte-identical gate** — 18 documents, 2.44 M glyphs;
      Chrome dropped
- [x] **5. `sync:recto`** — this repo is now the source of the engine Recto runs
- [x] **6. docs** — the laws, the method, one worked example
- [x] **7. `lab/`** — the hunt half in 8 files, with its own end-to-end gate:
      a gate document is re-identified blind, 93/107 targets, every other
      family flat zero
- [x] **8. `lab/rust/`** — the sweep at 40–45×, the anisotropic probe and the
      connected-component harvester, certified against the JS as its oracle
      and running that gate **with no corpus at all**
- [x] **9. glyphs fused to redaction bars** — a quote mark or `<` flush against
      a bar used to be bridged into the bar's dark run, slice the box into
      rule-typed slivers and vanish under their padding; the bar body is now
      bounded by its column profile, so those glyphs read (`To: " " < >` on
      Recto's startup document, residual 0) and the gate re-recorded exactly
      four gained glyphs, every other transcript byte-identical
- [x] **10. glyphs clipped by redaction boxes** — the box is black inside and
      keeps a glyph as a composite in its anti-aliased edge
      ([law §8](docs/LAWS.md#8-redaction-boxes-a-black-body-and-edges-that-keep-the-glyph));
      a glyph mostly under a box now reads when every visible pixel is exact
      and it is the only character in the pool that fits (`including S████`
      on `report`, an `a` and a `J` on one Courier document), and is refused as
      ambiguous otherwise. The JSON marks such glyphs with the count of pixels
      the box destroyed. A bar always splits a line: one separator space in
      the transcript, two text boxes in Recto, the same `boxBetween` rule in
      both. `tools/clip-bench.mjs` measures the rule on certified
      pages (158 right, 0 wrong, 1,777 refused over two pages); shadow-only reads under boxes are
      opt-in (`--shadow`) because on real boxes they came back wrong more often
      than right.
- [x] **11. string hypotheses under a bar** — `engine/hypothesis.js` draws a
      candidate name where a redaction hid one, composites the bar over it
      (law §8, bar last) and lets the page outside the body return consistent,
      contradicted or no-evidence; the producer's advances and kern pairs are
      measured from the page's own pens (`pageMetrics`). Certified by
      `tools/hypothesis-bench.mjs` (truth contradicted 0 on a Courier and a
      Times page over 960 trials, dark edges judged with a byte of slack);
      Recto's `redaction_matching` shows
      the verdict on every candidate chip and `tools/verify-redactions.mjs`
      reports the corpus; `tools/hypothesis-truth.mjs` runs the tester on real
      bars with known text (two Calibri memos: the truth never contradicted,
      and the bars — the names' advance boxes — leave no shadow to read).
- [x] **11. coloured ink is coverage** — a blue glyph is its black twin seen
      through the pen ([law §9](docs/LAWS.md#9-coloured-ink-is-coverage)), so
      coloured text is recovered and read with the sets the reader has instead
      of being whitened away; rasters carry RGB (mode 4). What is nobody's pen
      is still whitened, and coloured ink that stays unread is an honest □,
      counted apart. On a page the producer quantized, a coverage is a
      **range** rather than a byte, so the reader compares in colour space and
      the links read: `email`'s 37 coloured □ became 14, and 137 glyphs of
      URLs and addresses came back.

Open, and known: the **reader's** gate still needs documents that cannot be
shipped, so a stranger can run `certify:ftclone`, `test` and `rust:certify` but
0 of 18 gate documents; the synthetic half of that problem is solved for the
rasterizer and the lab, not yet for a whole page whose transcript is known.
Also unsettled: whether `ftclone` still certifies against a *different* mupdf
build — i.e. what exactly the compatibility claim is.
