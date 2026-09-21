# The laws

Every read this toolkit certifies is a claim that a re-rendered glyph equals the
page's pixels. That claim rests entirely on the handful of laws below. They were
measured, not read off a specification, and each one names how to measure it
again — because a written constant is a copy, and copies go stale.

## 1. The pen lattice

mupdf's `fillText` cannot place a pen anywhere. Sweeping one whole pixel of pen
travel in 1/64 steps and counting **distinct rasters** (Carlito `m` at 16 px,
mupdf 1.28, 2026-07-26):

| axis | distinct rasters over 1 px | means |
|---|---:|---|
| x | 5 | snaps to the nearest **¼ px** — 4 phases, and the 5th image is phase 0 one pixel over |
| y | 2 | rounds to the nearest **whole pixel** — no subpixel y at all |

SAD against the on-integer render, same glyph:

| offset | +⅛ | +¼ | +½ | +¾ | +1 |
|---|---:|---:|---:|---:|---:|
| x | 2856 | 2856 | 5774 | 8239 | 9978 |
| y | — | **0** | 4538 | 4538 | 4538 |

y = 28.5 is byte-identical to y = 29 (SAD 0) and differs from y = 28. The
asymmetry is real, and it **supersedes the "8 snap phases" this project worked
from for months: it is 4.**

Consequences that are load-bearing elsewhere: `fontgen --phases-y 0` is the
producer-certified setting (see [FONTS.md](FONTS.md) for what a legacy
`0,0.5` set is, and why it will not regenerate); the `y-phase 32/64` row of the
cert is *expected* to differ, and the day it stops, mupdf changed.

FTClone has no such limit — it places pens on any 1/64, which is the whole
reason it exists: a real search over pen lattices is impossible through
`fillText`.

**Re-measure:** `npm run certify:ftclone` prints the lattice on every run
(`probeLattice` in [../ftclone/certify.mjs](../ftclone/certify.mjs)) and names
any pair other than 5 / 2 as UNEXPECTED.

## 2. Coverage → alpha → page byte

The FreeType smooth rasterizer produces 8-bit coverage per pixel; mupdf
composites black over the canvas in integer math:

```
e   = cov + (cov >> 7)         // 0..256 — the >>7 is what makes cov=255 opaque
dst = (dst * (256 - e)) >> 8
```

That is the whole blend law. It is certified rather than believed:
`npm run certify:ftclone` renders **1,128 glyphs per pipeline** — TTF against
mupdf and CFF against mupdf's builtin Courier — with **0 differing bytes**.

Two properties the reader depends on:

- **Repeated draws just apply it again.** Measured 12/12 exact over 4 glyphs × 1,
  2, 3 draws. This is what lets the scanner blend an accepted glyph into its
  canvas and keep matching against real composites.
- **It is monotone in `dst`.** A pixel that stays under the dark threshold for
  every possible canvas state can be settled without knowing what comes next.

## 3. The law, read backwards

Reading is that law inverted, one glyph at a time, left to right:

> at the leftmost unexplained ink column, try every (glyph, ¼-px x-phase) whose
> first ink column lands there; `predicted = blend(explained canvas, coverage)`;
> accept only if `predicted == page byte` **exactly**, on every ink pixel of the
> glyph. Pixels a later glyph may darken are held *pending* and settled when it
> is blended in. Accept whichever candidate explains the most ink.

The pen positions come out on the ¼-px lattice for free — nobody tells the
reader §1; it falls out of the search. A line is **CLEAN** when every non-object
ink pixel in its band was explained this way: `fails.length === 0` and
`residual === 0`. That is the certificate, and it is the only thing this project
sells.

`TOL` relaxes the compare to `|Δ| ≤ TOL`, and to `2 × TOL` on composite pixels,
where two curves' rasterizer deviations compound. It defaults to 0. It is part
of the proof and not a knob — see [METHOD.md](METHOD.md) rule 5.

## 4. Producer post-laws

The blend law is the producer's rasterizer. Some producers then do one more
thing to the page, and the reader has to model it or nothing matches.

**Linear (the eDiscovery producer).** Glyph raw alpha bytes composite
multiplicatively in 255-space with floor, and the page byte carries **+1 per
contributing light pixel** — light iff the raw byte ∈ [128, 254]. Sets that need
it are tagged `linear` in the registry and baked at generation time
(`fontgen --linear`); the scanner keeps a per-pixel shift count so raw space
stays recoverable from page space.

**Palette quantization.** Some pages (v4, `email` P1) are palettized at the end:
the page byte is the **nearest available gray** to the ideal render, ties toward
darker. The available set is read off the page itself — every actual page byte
is in it by construction, so palette grays are fixpoints. Scan canvases stay in
original space, because the producer quantized *once, at the end*, and every
prediction-vs-page compare goes through the map.

## 5. Colour, and why the raster mode is not a detail

The certificate only means something over ink the producer drew in neutral
black, so colour is whitened away before band-finding. How well that works is
decided by the raster the cache holds:

| mode | payload | colour test |
|---|---|---|
| 1 | u8 gray | none needed |
| 3 | u16 R+G+B sums **+ u8 per-pixel channel spread** | real colour = spread ≥ 4; the whitening flood then spreads only through spread ≥ 1 pixels (coloured AA fringes); spread 1–3 is channel jitter and rounds back to neutral. **Read, no longer written** since §9 |
| 4 | u8 R, G, B per pixel | §9: coloured text is read as coverage through its pen; the rest is whitened by the mode-3 rule |
| 2 | u16 sums only | forces the legacy test *neutral iff sum ≡ 0 (mod 3)* |

Mode 2 is not merely coarser. On the `nimbusrom` gate document it floods whole
letters white: **38 □ became 472 □**, and 13,034 glyphs became 4,957. That is
why `rasterize-mupdf.mjs` emits **mode 3 for any multi-component image**, and
why this is written down instead of left as a constant in the writer.

## 6. Size, em64, and advances are two numbers

The raster matrix is 26.6 fixed point: `em64 = trunc(size × 64)`. The advances
are **not** bound to that truncation, and collapsing them was a real bug.

`report.pdf`'s body is 8 pt at 96 dpi = 10.6666… px. The matrix truncates to
em64 **682**; every advance is a multiple of 10.6666…. Deriving `SIZE_PX =
EM64/64` made all 107 advances wrong by up to 0.011 px — small, and fatal by the
end of a line. `fontgen --size` keeps the size it is given and truncates only
the matrix.

## 7. The page is decoded, never rendered

`tools/rasterize-mupdf.mjs` decodes the producer's **own embedded page image**.
Rendering the PDF would invent pixels with a rasterizer that is not the
producer's, and there would be nothing left to certify against. This is why a
`--pdf` must be in the raster cache before it can be read, and why the reader
has no rendering path at all.

## 8. Redaction boxes: a black body, and edges that keep the glyph

A redaction box is a filled **black** rectangle drawn **last**, over the text.
Boxes overlap and connect into other shapes, but the body is always black and
only the boundary lines carry the box's partial alpha. Measured on
EFTA00434905 p1 and on `report`'s page (2026-09-03):

| zone | what the page byte is | evidence |
|---|---|---|
| body | 0 | none — the ink under it is destroyed |
| edge line (near-constant, ≥ 160) | `(gb · k) >> 8`, with `(255 · k) >> 8 = edge` | a composite of the glyph's own byte `gb` and the bar's alpha complement `k` |
| open page beside the box | `gb` | the glyph's ink, 0–2 columns of it when the box was placed a pixel short |

The order matters at the byte level: predicting the glyph drawn *over* the bar,
`(edge · (256 − e)) >> 8`, is 1 off on about half the bytes (the `>` against
EFTA00434905's right bar reads exact under bar-last and fails under glyph-last).
Under the linear law the composite is a product with one shift per light
contributor and reads the same either way — verified byte for byte on the
clipped `S` of `report`, where the bar's 196 edge over the S's second column
gives 171 / 24 / 38 / 0 / 24 / 177 … exactly.

What the reader does with it (`detectObjects`' EDGE MODEL, `scanLine`): edge
cells are prior ink the scan composites against, never anchors and never
residual; a glyph mostly under a body is accepted **only** when every visible
pixel is byte-exact, none is pending, at least one complete ink column of its
own lies on the open page, it accounts for every unexplained pixel of its
anchor column, and it is the *only character in the pool* that fits — 4,516
candidates were tried against `report`'s S and one fitted. Edge composites
support a read but never make a glyph *visible*: a `.` whose whole body sits
in an edge column is not a visible period. Little ink fits many glyphs and is
refused as ambiguous.

**Dark edges are body.** An edge byte under 160 means the bar covers the
column by 40 % or more; the glyph survives compressed into 0..edge, and there
the box compositor's rounding is not the glyph compositor's — a Courier `J`
under a 150 edge predicts 147 where the page holds 148, a Times-bold `g`
under a 101 top row predicts 40 for a 41. One byte in a 0..74 range is a large
error, so dark edges carry no evidence by default — for a single glyph; a
list of names is judged there with that byte of slack (below).

**Shadow-only reads are opt-in** (`--shadow`, `opts.shadow`): a glyph with
no ink on the open page, read from its shadow alone (at least 3 deviating
pixels, unique, and dark edges then count). On the synthetic benchmark below
they are never wrong; on the gate's *real* boxes they read one `m` right and
a `0`, a `.` and a `|` wrong — a redacted `client-ip=` beginning with `c`
came back as `0`, and a Times `m`'s serif tip in a 3-pixel shadow came back
as `.` — so the default refuses them. `report`'s second box hides the same
`S` with nothing but its shadow in a 74 edge; the reader says no to it by
default and reads it under `--shadow`.

**Re-measure:** `node test/engine.test.js` builds a page exactly this way (an
`A` mostly under a box with a 187 edge) and asserts the read, the refusals and
the exactness of a glyph merely touching the edge. `tools/clip-bench.mjs`
paints boxes over one known glyph per line of a certified page, bar-last
through the law, and counts right / wrong / refused per amount of leak
(2026-09-03, edges 196 · 165 · 119 · 74 · 52, `open` = leaked columns):

| page | open 0 (shadow only) | open 1 | open 2 |
|---|---|---|---|
| `EFTA00751637` p1, Courier 12.36 px, 75 glyphs × 5 edges | 0 right · 0 wrong · 375 refused | 15 · 0 · 360 | 23 · 0 · 352 |
| `v3` p2, Times 16 px, 54 glyphs × 5 edges | 0 · 0 · 270 | 29 · 0 · 241 | 91 · 0 · 179 |

Refusal is the common verdict and the point: the reader reads a leaked glyph
when the leak is enough and says nothing when it is not.

### String hypotheses under a bar (`engine/hypothesis.js`)

The same law run the other way round, over a *short list*: given names that
already fit a bar by width, each is drawn in full where the hidden name sits
(the line's set, baseline, y-phase, the ¼-px lattice), the bar is composited
over it bar-last, and every page byte outside the body judges it —
`consistent`, `contradicted`, or `no-evidence` when the bar left nothing (a
body with no shadow in its edges).
Nothing identifies a sliver; two consistent names are a tie, and the tie is
the answer. Rules that came out of measuring it, all in the file:

- **The producer's metrics come from the page, not the set.** The set's
  advances are the generating font's; a document set in another build of the
  same face draws the same outlines at other advances, and kern pairs are
  1–2 px (Times "AT" −1.75, "WA" −0.88, "Tr" −0.50 at 16 px). `pageMetrics`
  (render.js) takes the median of next.pen − pen per glyph and per pair over
  the page's certified lines; a pair kerns at ≥ ⅜ px. Advances measured this
  way changed v3 p2's decoy list from 68 to 61 strings tying the truth's width.
- **Pens are searched, not assumed.** The first glyph within 1¼ px of the
  space estimate on the lattice, the last glyph within 1¼ px of the
  accumulated advance; a pen the set cannot draw never beats a judged one.
- **Only the bar's edge COLUMNS judge**, over the box's own rows, with the
  bar's byte taken as the column's maximum corroborated by a second row (a
  uniform stem shadows the mode, and the second unshadowed row may hold the
  bar over a glyph's 254: a `d` stem left 196 once and 194 once); its top and
  bottom rows carry the neighbouring lines' descenders and the corners where
  two bars meet.
- **Dark edges judge too, with one byte of slack.** The reader refuses a dark
  edge as evidence for a single glyph because box compositors slip a byte
  there; over a list the slip is harmless. The user's rule, measured on the
  reference bar (edge byte 74, no leak at all): strip the column's own value,
  and the nine darker pixels are the hidden name's first column — SARAH
  KELLEN hits 9 of 9 within a byte, the four other names of the width tie hit
  1 or 2 and leave 7–9 pixels unexplained. The evidence floor is 2 pixels for
  the same reason: the contradictions do the guarding.
- **Two clue pixels name a letter.** Strip the bar's own byte from an edge
  column and what is left is the compositor's rounding (a byte, the slack)
  or the hidden name's overhang: on the Calibri memos the only clues are
  the last glyph's — an r's arm under a 151 edge (71 and 39), an f's hook
  under a 211 edge (172 and 192), an A's diagonal under the left edge. Two
  pixels, and every decoy that survives with the truth shares the letter
  (r-names on the Wexner bar, "Andre Assaf" on the Groff bar, A-names on
  the Mucinska bar); within ½ px of width the truth is alone on two of the
  three. A floor of 6 threw them away; at 2 the benches keep their zero
  truth contradictions, Courier's truth is consistent in 325 settings
  instead of 235 against 37 more ties.
- **An edge too dark to hold two levels is body.** The edge byte is the
  shadow's whole range (white under it is the byte, black is 0); one that
  cannot separate two levels by more than the acceptance width — edge ≤
  4·(tol + slack) — judges nothing. A 1..3 column beside a Calibri stem
  matched every name on the page, and a 7 contradicted the true one on a
  byte of JPEG ringing.
- **A match is evidence only where the page shows a shadow.** A glyph's
  faint pixel over the bar's own byte is not a measurement (the user's rule:
  strip the column's lightest pixels, judge the rest). SARAH KELLEN's 8
  "edge" pixels on the Calibri memo were 1; the reference bar keeps its 9.
- **The gap to a neighbour is a space unless the neighbour touches**
  (`line.gapLeft` / `gapRight`: 0 before a comma, after a bracket). The memo's
  lists put every bar before a comma; a space assumed there put the truth
  3 px off.
- **A name that overruns its right neighbour is contradicted** (reason
  `width`: its end plus the gap passes the neighbour's pen by over 1¼ px);
  one that ends early is not — a wider gap is a double space or a justified
  line (v3's `Seats:` sits 1.6 px before its value). Ten S-names of loose
  width on the reference bar share the S column and hide their overrun
  under the body; the width is what separates them, and it is a page
  measurement too. The fit is reported (`penFit`) for the matcher's own
  policy on names that end early.
- **Tolerance pages keep the set's metrics.** `pageMetrics` measures pens the
  reader certified byte-exactly; at tol 2 (Calibri 1.02) the pens gave
  "Lesley Groff" 76.08 px on one page and 77.91 on another where the set says
  77.24 and the bars are 77 wide.
- **The bar's own top and bottom rows judge where they are this line's**:
  strictly inside the box's columns (a corner composites two edges), within
  the reader's band rows, never where a neighbouring line inks the cell,
  and only when the row's byte holds the majority of the row (a descender
  row is ink on a fifth of its columns; the cap-top row of an all-caps word
  is a shadow end to end). A bar padded a row below the baseline shadows a
  `g` or a `y` there. Measured: every real bar seen so far (the reference,
  the two memos) is padded past the descenders, so the rows carried
  nothing; on the bench the rows added 15 decoy contradictions on the
  Courier page at no cost to the truth. A bar drawn TIGHT to its text
  (`hypothesis-bench.mjs --rows tight`) is the unsupported case: the reader
  fragments its box (`UNITED` came back nine columns wide) and a column
  shadowed on every row but one has no corroborated byte — 6 and 26 truth
  contradictions on the two pages, rows judged or not.
- **Black under an edge is destroyed**, as are the rows and columns flush to
  a box body that the reader's constancy vote did not pad (a bar no taller
  than its text): the alpha there was never measured.
- **Unexplained ink is judged in the reader's band rows**, with the neighbour
  words and the neighbouring lines' glyphs drawn as explained.

`tools/hypothesis-bench.mjs` paints a box over one certified word per line,
bar-last, with leaks of 0 / 1 / 2 columns each side and edges 196 · 165 ·
119 · 74 · 52, and tests the truth plus every word on the page whose advance
ties it within ¼ px. The gate is *truth contradicted = 0* (2026-09-05):

| page | truth consistent · contradicted · no-evidence | decoys contradicted · ties |
|---|---|---|
| `EFTA00751637` p1, Courier 12.36 px, 22 words × 15 settings | 235 · **0** · 95 | 1,942 of 2,055 · 20 |
| `v3` p2, Times 16 px, 42 words × 15 settings | 469 · **0** · 161 | 890 of 915 · 13 |

The ties are the premise measured: `-0800` against `-0000`, `01:13:54`
against `01:12:12`, `Re:` against `To:` two columns in, `Departs:` against
`Locator:` under a dark edge — the difference is under the body. Judging the
dark edges (119 and under) doubled the truth's evidence: before it those
settings were no-evidence for every word (Courier 113 consistent, Times 168).

`tools/hypothesis-truth.mjs` runs the tester on REAL bars whose text is
known — a memo whose un-redacted source exists (`EFTA00038617`,
`EFTA01649149`: Calibri 1.02 at tol 2, 18 bars): every bar's truth and every
name of the width from Recto's list. Measured 2026-09-05: the bars are the
names' advance boxes, so the side bearings sit inside the body and the edge
columns carry the bar's own byte — except where the last glyph overhangs
its advance (an r, an f) or the first one leans out (an A): two clue pixels,
enough at a floor of 2 to make Lex Wexner and Lesley Groff consistent and,
within ½ px of width, alone. Elsewhere no name gets evidence, the truth is
never contradicted, and where the list holds it the truth is the one name
the page did not contradict (Sarah Kellen on the first memo: 9 of 9 others
contradicted, by the first column and the width). That is what the pixels
say on a bar drawn to the advance box.

## 9. Coloured ink is coverage

mupdf composites a coloured pen over white per channel, in the same integer
arithmetic as §2:

```
page_c = (65280 − (255 − C_c) · e) >> 8        e = cov + (cov >> 7), C = the pen
```

so a blue glyph is the *same coverage* as its black twin, seen through the pen.
Measured on EFTA00009865 p1 (2026-09-03): the blue body pen (31, 73, 124)
reproduces **13,624 of 17,525** coloured pixels exactly, the rest ±1 per channel
(the page image's JPEG jitter), and 95 % of them have a unique black-ink byte
`(255 · (256 − e)) >> 8` — which is the byte every glyph set already holds.
The reader therefore recovers `e` from the channel with the most contrast and
reads coloured text with the sets it has (`colourInk` in
[../engine/ocr-engine.js](../engine/ocr-engine.js), shared by the CLI's
`readGray` and the app's `whitenColored`), instead of whitening it away.

What is *not* a pen's ramp is still whitened, because the certificate means
nothing over it. The pens are the page's own — dark, saturated colours that
occur fully covered at least 20 times — and a coloured component (the same
seeds-and-flood set the whitening always took) is text when one pen explains
three quarters of its **dark** pixels within ±1. Judged on the dark core on
purpose: near white every ramp converges and any pen fits, so a halo of JPEG
chroma noise around black text would pass as text under whatever pen the page
has — it did, on `email`, until the core rule. Measured bimodal: 0.87–1.0 on
every text component of three documents, 0.15 on the DOJ seal.

Two consequences the reader lives with:

- **Rasters carry channels now.** `rasterize-mupdf.mjs` writes mode 4 (u8 RGB)
  for any colour page; the retired mode 3 (sum + spread) could whiten colour but
  not read it. Old caches still read the old way.
- **Palette pages quantize the ramp — so a coverage is a RANGE, not a byte.**
  The producer composited the pen over white and *then* quantized the page in
  colour. Several coverages share the surviving colour, so recovering one byte
  is a guess, and comparing against that guess is why the links first came back
  as `http //v sacentral com`. The reader instead asks which coverages the
  colour admits: per pen, walk the ramp e = 0…256, quantize each predicted
  colour to the page's own colour set (every colour on the page is an entry by
  construction — quantMap's argument for grays), and group the coverages that
  land on the observed colour. The group is contiguous and becomes a range of
  black-ink bytes, `page.bandLo/bandHi`, which ONE predicate — `acceptor` —
  applies to every compare, the unexplained accounting and the fail flood.
  Measured band widths, 2026-09-04:

  | page | converted px | mean width | max |
  |---|---:|---:|---:|
  | `email` p1 | 6,002 | 3.7 | 6 |
  | EFTA00382173 p1 | 7,761 | 3.5 | 7 |
  | `nimbusrom` p2 | 39,525 | 1.9 | 4 |
  | EFTA00009865 p1 | 18,183 | 3.0 | 9 |

  **The honest caveat:** the page's colour set is a *subset* of the producer's
  palette (only the entries that occur), so the band can be wider than the true
  one — never narrower. It can therefore admit a candidate the true palette
  would have refused; it can never lose a read. Where the page's own colours
  are dense along the ramp — an ordinary anti-aliased page — the band collapses
  to a single byte and nothing is loosened at all.
- **A dot is text.** The dark-core rule that separates coloured text from
  emblem residue needs four dark pixels; the dot of an `i`, a period and a
  colon carry one or two, so they were whitened while their own word was read.
  A component of ≤ 12 px beside converted ink is that ink, and takes its
  neighbour's pen when it fits that pen — the same argument the dust rule
  makes. Without it `visacentral.com` reads `v sacentral com`.
- What still does not read is an honest □, counted apart in the summary as
  *coloured ink* so a document's neutral-text □ stays comparable. On `email`
  there were 14: periods and commas that sit inside an underline's ±2-row
  padding — the blanket pad rules keep on purpose
  ([§8](#8-redaction-boxes-a-black-body-and-edges-that-keep-the-glyph) made it
  adaptive for boxes only; link rows regressed when rules went adaptive, and
  did again in 2026-09: a pad shrunk to the rows that vote as the rule's AA
  read the dots and broke 12 corpus lines of 10,000, two of them clean — on
  some pages the row over an underline IS a composite zone).
- **A pad is don't-care, not blind.** The pad stays. But a byte that sits in a
  lone rule's pad *exactly as the glyph would leave it on white paper* is
  evidence for that glyph: the rule has no ink there, or the byte would not be
  the glyph's. `detectObjects` marks a rule's pad rows apart from its own
  (mask 4, and only for a rule with no box over, under or across it — a
  redaction's thin slice is typed `rule` too); `scanLine` counts such bytes
  for a candidate that touches no box, no bar edge, no absorbed or foreign
  cell, and leaves every other pad byte what it was. A `.` on a link's
  underline has 7 of its 9 pixels in the pad and was refused for want of
  evidence; it reads now. Fenced because it must be: unfenced, the same
  evidence tipped the clipped-glyph test into reading a `)` under a redaction
  bar. `email` 14 □ → 7, four lines gaining their dots and nothing else, 17
  gate documents byte-identical; 300 random corpus documents: 272 lines
  better, none that read clean lost, 307 dots gained, no glyph lost. What
  remains on those lines is `/` and letters inside the link, and one pixel
  where the tail of `@` meets `g` — a glyph question, not the underline's.

An underline crosses every descender of the words it underlines, so once a
blue link is ink its underline is pieces of 1–17 px that no glyph explains;
rules of 1–2 rows are extended over the raw ink runs on their own rows within
3 px of their ends (never a box's thin slice — that moved the space-across-a-box
rule on six gate documents).

**Re-measure:** `node test/engine.test.js` draws "ABC" in blue and in black
through this law and asserts the converted bytes equal the black twin's, a
three-colour blob is whitened, a neutral page passes through untouched, a
quantized ramp yields a band that holds the true byte while a dense ramp
yields none, and a dot beside converted ink is adopted while a colour no pen
explains is not; and a dot resting on an underline, most of it in the rule's
pad, is read when its pad bytes are its own and refused when they are not.

## 10. The producer's law: advances, size and kerning are per document

A certified line fixes the face, the size and every pen. It does not say how
the producer arrived at the pens, and three producers of one corpus laid the
same face three ways (measured in Recto's `lab/`, 2026-09-15, every line
re-laid from every start the snap allows — `render.js solveStart`):

| document | set's hmtx advances | advances at 1/1000 em | + laid size | kerned |
|---|---|---|---|---|
| Courier New 13 px, 300 lines | 10 lines exact | **300** | 300 (s = 0.99978) | no |
| Calibri 1.02 16 px, 35 lines | 30 | **35** | 32 | no |
| Nimbus Mono 12.359 px, 154 lines | 135 | 135 | **154** at 12.36 px | no |
| Times 16 px e-mail header, 4 lines | 0 | 0 | 0 | **yes** — 4/4 with `times.ttf`'s table |
| Times 16 px affidavit, 32 lines | 10 | 10 | 13 | no — Word-made, see below |

So: a PDF carries its advances at **1/1000 em** (`/Widths`), not the font's
1/2048 hmtx the sets were generated from — Courier New at 7.8 px against
7.80127 is one lattice step by the 30th glyph; the advance size is **not**
`em64 / 64` (§6 — Nimbus Mono at 12.36 px against the set's 12.359375); and
**kerning is a property of the producer, not the face**: the same font's
table is applied on one document and not on the next, and a body may differ
from its own header. None of it is a per-glyph table — a writer who has only
the pairs the page shows cannot lay `Yo` on a page that never wrote it — so
`render.js producerMetrics` learns the law as structure (quantization, scale,
kerned-or-not, against the font's own kern table from HarfBuzz) from a page's
certified pens, choosing the hypothesis that writes the most pens back and,
on a tie, the least assumption (the PDF's quantization, no kerning, the
scale nearest 1). `layoutLine` then lays every glyph and pair the set and the
table know under that law. `test/render.test.js` tells the hypotheses apart
on synthetic pens.

**Word pages have no per-word law.** The affidavit (Times New Roman 12 pt,
justified) was written in Word, and Word does not lay the same word the same
way twice: on that page 31 of 36 repeated words come back at different pens
(`(“Subject` five ways at five starts), and a Word 365 export of the same
text, read from its exact glyph origins, does the same (26 of 38 — the PDF
carries one `TJ` per line with integer adjustments of ±3..11 thousandths of
an em after individual glyphs, and the same word gets different adjustments
at different starts). An exact solver with every character's advance and
every word's start free (Recto `lab/law-solve.py`, an LP over the ¼-px
intervals) is infeasible for the page by 0.016 px; per-word scale or
tracking, every position or advance grid from 1/2 to 1/40 px, hinted widths
at every ppem 8–400, and the font's kern table all fail; the character
advances the lattice split reads off the pens (`lab/effadv.py`) differ from
hmtx by up to 5/1000 em (`m`) and from Word 365's own table in a different
pattern. So the positions are a function of the producer's layout state, not
of the text, and a writer that has only the page cannot lay a new word
pen-exact on such a page — the producer itself would not. The law learned
here (1/1000 em, the scale, kerned or not) writes 98 % of the page's pens and
is the deterministic part; the rest is Word's rounding, ≤ one lattice step on
~2 % of glyphs. Measured 2026-09-15 with Recto's `lab/source-compare.py`,
`lab/repeats.py`, `lab/word-fit.py` on the user's own Word exports rendered
through mupdf at 96 dpi (which the reader certifies 28/33 lines of, so the
corpus pipeline is that one).

**Re-measure:** `node lab/write-test.mjs lab/out/<doc>.read.json` in Recto —
the `engine` row is this learner; `stock` is the set's hmtx.

## 11. Filled rectangles are another rasterizer

An underline or a strikethrough is not a glyph: producers write it as a
filled rectangle (`re f`), and mupdf antialiases paths with its own scan
converter, not FreeType's. Measured against mupdf 1.28 `fillPath`
(2026-09-18): every pixel is a **17 × 15 sub-sample grid** (`fz_aa` level 8).
An edge at x covers sub-columns from `floor(x·17)`, an edge at y sub-rows from
`floor(y·15)`, both in float32; a pixel's coverage is sub-columns × sub-rows
(255 when full), and that coverage goes through the same blend law as a glyph
(§2). A rectangle thinner than one sub-sample still inks one — mupdf never
drops a hairline.

`engine/ftraster.js rectCoverage` is that law; `render.js renderLine` takes
the rectangles as `opts.rects` and blends them after the glyphs. The
rectangle itself comes from the face: `post.underlinePosition` /
`underlineThickness` and `OS/2.yStrikeoutPosition` / `yStrikeoutSize`, both
positions read as the **top** edge (the OpenType convention) — a convention,
not a measurement: the corpus has no underlined run to measure a producer's
rule against yet.

**Re-measure:** `npm run certify:rect` — 0 differing bytes over 4,384
rectangles (every 1/64 phase of each edge, hairlines, random floats).

## 12. A glyph set can be made when it is needed

`engine/ftraster.js` is `ftclone/` moved into the engine: the certified port
of mupdf's glyph pipeline, fed font **bytes** through a small big-endian view
instead of paths through node's Buffer, so a browser runs exactly what
`npm run certify:ftclone` certifies (the `ftclone/*.mjs` files are wrappers
over it now). On top of it `loadFace(bytes)` reads any sfnt — TrueType, or
OpenType around a CFF table — with its cmap (format 4 or 12), hmtx and
decoration metrics, and `makeSet(face, {sizePx})` is a set in the reader's
in-memory shape whose records are rasterized on demand (`set.ensure(text)`:
rasters at `em64 = trunc(sizePx·64)`, advances at `sizePx`, §6). A set made
this way is **byte-identical** to the one `tools/fontgen.mjs` generated —
`test/ftraster.test.js` compares every record of `dejavuserif786` (TrueType)
and `nimbus791` (CFF in an .otf) — so a writer is no longer limited to the
families, styles and sizes somebody generated in advance.
