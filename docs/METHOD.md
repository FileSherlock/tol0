# Method

Eight rules. Each one was paid for — most of them twice — and none of them is
specific to OCR. They are the part of this project that transfers.

**1. Trust pixels only.** Every written constant is a copy of a measurement, and
copies go stale. Re-measure before building on one; when a measurement
contradicts a document, fix the document *in the same session* and say what it
supersedes. This repo's own "8 snap phases" survived months of work and is
[4](LAWS.md#1-the-pen-lattice).

**2. A byte-identical regression gate beats a suite of assertions.** `npm run
gate` re-reads 18 fixed documents and byte-compares whole transcripts against
committed references: **33,736 lines, 2,436,383 glyphs, 177 □ (149 of them coloured ink), 55 s**. The
expected numbers *are the reference files*, so there is no threshold to argue
about and any change in any number is the signal. It has caught every accidental
regression, including one a plausible-looking simplification would have shipped
silently ([the raster mode](LAWS.md#5-colour-and-why-the-raster-mode-is-not-a-detail)).
The corollary: re-record only after an **intended** change, and say what changed.

**3. "No match" is a statement about your roster, not about the world.** A hunt
stalled for a week because every sweep enumerated `C:/Windows/Fonts` — and
Windows *also* installs fonts per user, in
`%LOCALAPPDATA%/Microsoft/Windows/Fonts`. The same trap then wrote off
`TimesNewRoman8` as a lost artifact; it was in the second directory. Record what
a roster enumerated, and treat every elimination as provisional until you can
name it.

**4. Union theft.** Pooling glyph sets that do not actually co-occur makes reads
*worse*: a foreign face byte-matches a fragment and wins the column. Group only
what really mixes on a line — a bold label and its regular value, not "all the
fonts we have".

**5. Tolerance is part of the proof, never a knob.** Loosening tolerance to make
one more document read invalidates the family that was proven at 0. If a page
genuinely needs slack, justify it with a *documented producer law* — JPEG
jitter, palette quantization — or do not claim the read. A useful tell: a
*wrong* face does not decay gracefully as tolerance rises. `report`'s unread
footer at `--tol 16` becomes `"......   . ..'  ....."` — that is a different
face, not a near miss, and no amount of slack will fix it.

**6. Same face ≠ same producer, and a tie can be the answer.** Two faces tied at
the same size usually means the document really does contain both, rather than
that the identification failed.

**7. Verify shape before believing a name.** Overlay and metadata font names
lie. Distinctive glyph shapes do not. The same applies one level down: a font
*build* is not a font — Calibri 1.02 and the installed 6.2x are different
drawings, and two DejaVu Serif builds differ in `t` and `D` alone, which is
exactly enough to lose a read.

**8. Cheap screens rank; they do not eliminate.** Measured against a known
answer, the advance-vector prefilter put the true face at **rank 15 of 387** and
got its size off by one. Excellent as a top-25 filter, worthless as a verdict.
Treat a screen's output as an ordering and confirm the winner by rendering.

## The shape these add up to

Every layer certifies itself against the layer below, and the bottom layer
certifies itself against the real thing:

```
ftclone   vs mupdf fillText          npm run certify:ftclone   0 diffs / 1128 renders
engine    vs synthetic pages          npm test                  43 tests, ~40 ms
reader    vs committed transcripts    npm run gate              18/18 byte-identical
Recto     vs this repo's files        npm run sync:recto:check  cmp-identical
```

Nothing in the stack is trusted because it looks right. That is the entire
method, and rules 1–8 are what it costs to keep it true.
