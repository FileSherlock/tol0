# gate-ref — the expected numbers

These files **are** the expected output. `npm run gate` re-reads every gate
document and byte-compares its whole transcript (`<name>.txt`) and its counts
(`<name>.summary`) against the file next to this one. There is no assertion to
tune and no threshold to argue about: any change in any number is the signal.

Recorded 2026-07-26 (step 4 of the port), 18 documents (`email` re-recorded
2026-09-21 — see below):

| | lines | glyphs | □ |
|---|---:|---:|---:|
| v3 | 1,785 | 122,886 | 0 |
| big | 18,307 | 1,338,833 | 0 |
| email | 1,908 | 113,745 | 7 (7 coloured) |
| report | 34 | 2,034 | 2 |
| courier_1 | 1,552 | 114,817 | 0 |
| courier_2 | 4,899 | 374,462 | 0 |
| nimbusrom | 223 | 13,034 | 161 (135 coloured) |
| nimbus791 block (11 docs) | 5,028 | 356,579 | 0 |
| **total** | **33,736** | **2,436,390** | **170 (142 coloured)** |

~55 s — the one number here that is *not* compared, because it is the machine's,
not the reader's. The 11 `nimbus791` documents also carry truth transcripts, and every one
of them matches **every row, including spacing** — 5,028 of 5,028 rows
letter-exact and space-exact, 0 rows differing.

## The □, one by one

Since 2026-09-03 coloured ink is read as coverage ([LAWS §9](../../docs/LAWS.md#9-coloured-ink-is-coverage))
instead of being whitened, and the summary counts the clusters that lie in
coloured ink apart: **142 of the 170 □ are coloured** — the blue Helvetica-bold
section headings of `nimbusrom` (a face its pool does not carry) and the
underlined blue links of `email` (a palette-quantized ramp, exact only at the
ladder's tolerant rungs). They were always on the page; before, the reader
said nothing about them. The 29 neutral □ are the 40 of the census below minus
the letterhead clusters that the census itself called coloured (they are now
counted as such; 28 with the two phantom bands below removed). The census
stands as written for the neutral ink.

**2026-09-21: `email` 14 □ → 7.** Half of `email`'s □ were not the palette's
doing at all: they were the **dots** of its underlined links. A browser draws a
link's underline one row under the glyphs' feet, a rule is masked with a ±2-row
don't-care pad, and a `.` has 7 of its 9 pixels in that pad — too little
evidence, and it was refused. A byte that sits in a lone rule's pad exactly as
on white paper now counts as evidence for a glyph that touches nothing else
(`detectObjects` mask 4, `scanLine` tryCand). Four lines changed, each gaining
its dots and nothing else — `visacentral.com`, `www.americanexpress.com`,
`www.adobe.com/…/readstep.html`, `jeevacation@gmail.com` — and the other 17
documents are byte-identical. On 300 randomly drawn corpus documents: 272
lines better, none that read clean lost, 307 dots gained, no glyph lost. The 7
that remain are `/` and letters inside the same links, and one pixel where the
tail of `@` meets `g`.

A □ is ink the reader refused to guess at, so the count is only meaningful if
someone has looked at what is under it. Censused from page pixels 2026-07-26.
**24 of the 40 are ordinary black text** — this is unfinished reading, not
inherently unreadable ink, and the older record said otherwise (below).

`report` — **2**

- **1 glyph: a `b`** at baseline y313, column 229 (`…1843kb4f‸e4d30c69…`). It
  reads at `--tol 1` and at no cost elsewhere, so it misses by a single byte.
  It sits where the preceding `f`'s top hook overhangs the `b`'s stem — the
  reader accepted that `f` with 3 pixels still pending — so this is the known
  AA-overlap ±1 at a composite junction, not an unknown glyph.
- **1 band** at y≈996: an 18-glyph footer of digits in a face the `linear` pool
  does not contain. Raising tolerance does **not** find it — at `--tol 16` it
  decays into `"......   . ..'  ..'....."`, which is what a *wrong face* looks
  like, as opposed to a close one. It needs an identification, not slack.

`nimbusrom` — **38**

| where | □ | what the pixels say |
|---|---:|---|
| P1 y131, y152 | 10 | letterhead clusters beside the DOJ seal — genuinely **coloured**: 111–180 of each cluster's ~200 ink px have channel spread up to 117 |
| P1 bands y158/179/188/948 | 4 | bands containing the seal graphic and the P1 footer. Charged per band, and the band really does contain a graphic — but each also carries ~1,100 px of *neutral* ink surviving colour-whitening (x86–350), i.e. real text rides along |
| P2–P12 band y982 | 11 | **the correction.** The red legend is there (1,345 coloured px) and is whitened away exactly as designed. What blocks the read is a *separate* **1,276 px of neutral black text**, x96–719, in an unidentified face |
| P5 y745 | 8 | a bold heading, `3. CLOSE OBSERVATION` — pure neutral ink, channel spread **0** |
| P10 y830 · P12 y301, y343, y407 | 5 | in-text clusters on ordinary body lines — neutral, spread 0 |

**What this supersedes.** `char_training`'s `ocr/FINDINGS-nimbusrom.md` says
"every remaining □ being the red footer legend or the P1 seal graphic". That
holds for the 10 coloured letterhead clusters and is defensible for the 4 P1
bands, but it is wrong for the other 24: 11 footer bands whose blocking ink is
neutral rather than red, and 13 in-text clusters the census never mentioned at
all. Those 24 are unread *text*, and they are the honest next target.

The distinction matters because it changes what to do. Colour and graphics are
correctly refused and always will be. Neutral unread text means a face is
missing from the pool — which is a hunt, and a winnable one.

## Re-recording

Only after an **intended** output change, and say what changed:

```bash
node tools/gate.mjs --out fixtures/gate-ref --ref none
```

## What this reference has already caught

**Dropping the headless-Chrome rasterizer was not free** (2026-07-26). Swapping
in `rasterize-mupdf.mjs` — certified on `courier_1`'s 25 pages, and measured on
all 18 documents before Chrome was deleted — moved exactly two:

- **`nimbusrom` broke outright**, 223 lines / 13,034 glyphs / 38 □ becoming
  203 / 4,957 / **472 □**, because mupdf wrote a mode-2 raster where Chrome
  wrote mode 3 ([../../docs/LAWS.md §5](../../docs/LAWS.md#5-colour-and-why-the-raster-mode-is-not-a-detail)).
  Fixed in the writer; the document then reproduced exactly.
- **`email` gained one glyph** — 113,599 → 113,600, still 0 □: a comma on P36
  (`…by e-mail to <redacted>,`) that the legacy colour flood had erased. This is
  the one place the reference was deliberately re-recorded — a strictly better
  raster reading one more real character, at tolerance 0.

The other five of those seven were byte-identical through the change — `report`
trivially so, since it has no PDF at all, only a surviving page raster. (The 11
`nimbus791` documents were rastered by mupdf from the start.) Net: Chrome is
gone, no transcript was lost, and the repo has one rasterizer.

**Glyphs fused to redaction bars** (2026-09-03). `detectObjects` took a box
row's extent from its ≤1px-bridged dark run, so a glyph flush against a bar
was part of the bar for those rows, split the box into rule-typed slivers and
vanished under their ±2-row padding. Bounding the bar body by its column
profile (dark on ≥ min(8, body rows) rows) moved exactly three lines, all of
them glyphs glued to a bar, and each row now matches its truth transcript
letter for letter:

- **`v3` P5 y176** — `href=3D >https://w=` → `href=3D" ">https://w=` (two
  quotes; 122,883 → 122,886 glyphs, truth rows differing 6 → 4)
- **`v3` P6 y303** — `<br><br> br><br>Thank =` → `<br><br> <br><br>Thank =`
  (the `<` of the second `<br>`)
- **`big` line 18247** — `"> /a>&gt;` → `"> </a>&gt;` (one `<`; 1,338,832 →
  1,338,833, one box fragment fewer, truth rows differing 34 → 33)

The other 15 documents were byte-identical, summaries included.

**Glyphs clipped by redaction boxes** (2026-09-03, [LAWS §8](../../docs/LAWS.md#8-redaction-boxes-a-black-body-and-edges-that-keep-the-glyph)).
A glyph mostly under a black box now reads from the column or two it leaks
outside plus its composite in the box's edge line, when it is the only
character in the pool that fits. Three glyphs, on two documents:

- **`report` y695** — `EPSTEIN, including and GHISLAINE MAXWELL.` →
  `EPSTEIN, including S … and GHISLAINE MAXWELL.`: the S's first column is
  outside the bar and its second under the bar's 196 edge, 18 pixels exact, 44
  destroyed; 2,033 → 2,034 glyphs, the box fragment gone.
- **`n791_EFTA00754474` P1 y558 and y595** — `…decombobulator_bl` gained its
  `a` (12 open pixels exact, 18 destroyed) and `…yscI <` gained a `J` (the 4
  pixels of its hook, 23 destroyed; among 4,407 (glyph, pen) pairs covering
  that column only the J fits). 30,607 → 30,609 glyphs, 17 → 15 box fragments.
  The truth transcript had been written without the two leaked letters and was
  corrected to carry them, so the document stays 432 of 432 rows exact.

The J is the least evidence the rule has accepted so far, and it is recorded
here for that reason: if a 4-pixel unique fit is ever shown wrong, this is the
entry to revisit.

**A bar always splits the line** (2026-09-05). The separator rule asked
whether the padded bar fitted inside the gap between one glyph's advance end
and the next glyph's pen, so a quote flush against the bar (its advance
overlaps the bar by half a pixel) or a clipped glyph (its advance runs on
under the bar) failed it, and those lines came out as one run of measured
spaces — `From: "                                    "` — where the bar is;
Recto then drew one text box across the bar instead of two. The rule is now
`boxBetween`, shared by the transcripts and Recto's adapter: the bar's own
edge starts between the two pens and the bar reaches past the previous
glyph's advance; and a line's bars are only the boxes that cover its
x-height, not a neighbour's bar touching its descender rows. Every changed
transcript line is a run of spaces across a bar becoming one space — 14
documents, no glyph moved; the 11 Courier truth transcripts were re-spaced on
exactly those rows (33 rows) and stay 5,028 of 5,028 rows exact. In Recto
every bar now yields two boxes, left and right, with no spaces.

**Coloured ink is coverage** (2026-09-03, [LAWS §9](../../docs/LAWS.md#9-coloured-ink-is-coverage)).
Rasters carry RGB now and coloured text is converted to the black-ink
coverage it was drawn as, instead of whitened. Two documents moved, in the
direction of honesty and one glyph:

- **`email`** — 1,908 → 1,907 lines, 113,600 → 113,601 glyphs, 0 → 38 □ all
  in coloured ink: the underlined blue links (`www.americanexpress.com/…`, a
  phone number) are ink now; a palette-quantized colour ramp reads exactly only
  where the palette happens to hold it, so most of them stay □ at tolerance 0.
  The one glyph gained is a hyphen of the phone number; the line lost is a
  `>` that merged with a link band. No neutral text changed.
- **`nimbusrom`** — 38 → 162 □, of which 135 coloured: the blue Helvetica-bold
  section headings of every page (a face the pool does not carry) and the
  letterhead clusters the census already called coloured. All 223 text lines
  are byte-identical; only empty (unread, coloured) lines were added.

The other 16 documents were byte-identical, summaries included — after a
first draft of the law had moved twelve of them: a rule-extension step meant
for underlines also widened the thin slices of redaction boxes and grew a
false "rule" along a line of base64 serifs. Underline pieces are now absorbed
in the scanner with the rules known, and the detector is untouched.

**The below-band baseline sweep, guarded** (2026-09-03). Every unread band used
to pay for a sweep of baselines *below* the band (bot+1 … bot+maxAsc, every set
and phase) that exists for separator rows whose ink lies entirely above their
baseline. On a page of coloured lines no set reads it was half of all probe
time (EFTA00009865 p1: 3.4 of 6.4 s per pass). It now runs only for bands too
short to hold a text line, bands with a rule starting just under them, and the
upper segment of a split band — the last one measured: without it nimbusrom's
`U.S. Department of Justice` (y131, a segment ending at 129 beside the seal) was
lost. Net effect on the reference: one empty line fewer on `email` and one on
`nimbusrom` — an unread coloured band each that the sweep had been pinning to a
phantom baseline and reporting twice; 37 and 161 □, every text line identical.

**Coloured text compared in colour space** (2026-09-04, [LAWS §9](../../docs/LAWS.md#9-coloured-ink-is-coverage)).
A palette page quantizes the pen's ramp, so several coverages share the colour
that survives and the single byte the reader recovered was a guess. It now
compares against the RANGE of coverages that colour admits, and a dot beside
converted ink is adopted as that ink. `email` moved, alone:

- 1,907 → 1,908 lines, 113,601 → 113,738 glyphs, 37 → 14 □ (all coloured).
  The links read: `http://visacentral com amex`, `866-529-  553`,
  `http://www americanexpress com/privacy.`,
  `return e-mail or by e-mail to jeevacation@gmail com`.
- Rows letter-exact against truth are unchanged at 1,897; rows differing go
  10 → 11, because a row that used to be blank now carries partial text. No
  character changed from right to wrong: every glyph gained matches the page,
  and what is missing is a □.
- The 14 that remain are periods and commas lying entirely inside an
  underline's ±2-row padding, which rules keep blanket on purpose.

The other 17 documents are byte-identical, summaries included.
