# Fonts and glyph sets

Short version: **this repo ships every font and glyph set it is allowed to ship,
and tells you exactly how to rebuild the rest from your own machine.** A fresh
clone has 13 of 77 glyph sets. That is not an oversight.

## Why a glyph set is a licence question

The reader's candidates live in `assets/fonts/*.npz` — one file per (face, size,
pen-phase, blend-law) config, holding rasterized bitmaps of every character. A
`.npz` is therefore **a set of rasterized bitmaps of a typeface**, and it
inherits that typeface's licence. Shipping the rendered bitmaps of Arial is not
meaningfully different from shipping `arial.ttf`, so this repo does neither.

The predecessor project learned that the expensive way: 431 MB of Microsoft CJK
font binaries were committed before the ignore rule was written, and *gitignoring
a path does not untrack it*. This repo starts clean and guards the boundary with
a blanket ignore on `*.ttf` / `*.otf` / `*.cff` / `*.npz` plus exceptions
enumerated **one file per line** — a glob would let spelling decide a licence
question, and once did.

## The four classes

Every set's origin is in `PROVENANCE` in
[../tools/glyph-registry.mjs](../tools/glyph-registry.mjs), extracted from each
`.npz`'s own metadata — what was actually generated, not what someone claimed.

| class | n | ships? | how you get it |
|---|---:|---|---|
| `free` | 13 | **yes** | already here; face is in `fonts/` |
| `system` | 48 | no | regenerate from your own stock system font |
| `build` | 10 | no | needs one *specific* font build, not the current install |
| `corpus` | 6 | **never** | cut from document pixels — no reproduction path |

```bash
node tools/glyph-sets.mjs            # what you have and what you don't
node tools/glyph-sets.mjs --plan     # the exact command for each missing set
node tools/glyph-sets.mjs --verify   # prove the shipped 13 rebuild byte-exactly
```

### free — and provably so

The 13 shipped sets derive from URW Nimbus (Roman, Sans, Mono — the base-35
faces Ghostscript and mupdf embed) and DejaVu Serif. Both are redistributable
and both faces are in [`fonts/`](../fonts), so `--verify` re-renders each set
through `fontgen` and byte-compares the bundle payload — the bytes the engine
actually reads — rather than asking you to take it on trust. It runs the same
recipe `--plan` prints, so what is verified is the documented path.

Two certified pools (`nimbus791`, `nimbusromCourt`) are entirely free, so they
work on a fresh clone.

### system — regenerate from your own fonts

48 sets come from stock Windows fonts: Arial, Times New Roman, Courier New,
Tahoma, Segoe UI, Calibri, Cambria, Georgia, Verdana, Century Schoolbook.

```bash
node tools/fontgen.mjs --set cour13 --font C:/Windows/Fonts/cour.ttf
```

Pass `--set` and everything else — em64, pen phases, blend law, character list —
comes from the registry. That matters more than it looks: **26 sets were
generated with a non-default character list**, and a wrong list silently
produces different bundle bytes rather than failing. (One list contains an
apostrophe, which is also why `--plan` does not spell them out on a command
line.)

#### A regenerated legacy set will not match the original bytes

Measured 2026-07-26; `--plan` now says so on each affected line. Every set
recorded with `phasesY: '0'` regenerates byte-identically. **No set recorded
with `phasesY: '0,0.5'` does** — 7 of 7 tried differ, entirely in the ½-phase
half: all 684 y-phase-0 rasters of `times16` and all 428 of `cour13` match bit
for bit, and every ½-phase raster does not.

That is not fontgen misbehaving. Those ½-phase rasters are artifacts of an older
pipeline that **rounded pen y to an integer and shifted** — which is what mupdf
itself does ([LAWS §1](LAWS.md#1-the-pen-lattice)). `fontgen` places a true 1/64
pen, so it renders what a ½-px pen actually looks like, and the two disagree by
construction.

The cost was measured on the gate rather than reasoned about: with all 7
regenerated sets swapped in, **all 18 transcripts stay byte-identical across
2.44 M glyphs**; the only change is that lines pinned at a ½ phase report their
baseline 1 px lower, moving 13 coordinate labels in two summaries. So a
regenerated set reads the same text, and you should regenerate. What you do not
get back is the `.npz` bytes — which is why the gate ships reference
*transcripts* rather than trusting anyone's set to be identical.

Measured but *not* explained: `timesilin16` also differs in 82 of its 428
y-phase-0 rasters (`timesbdlin16` 11, `timeslin16` 6), bounding boxes off by a
pixel at particular x-phases. No y-rounding story accounts for that, and no gate
document exercises those glyphs. Open, not cleared.

### build — a specific font build, not just a font

10 sets need a *particular* build, and the version you have installed will not
reproduce them: **Calibri 1.02** (`calibri-jondot.ttf`; the installed 6.2x has
different drawings — that was the difference between a family reading and not),
**Cambria (Win11 build)**, **`TimesNewRoman8.ttf`**, and — ported from Recto's
bundle on 2026-09-03 together with the `system` set `tnrbdlin1024` —
**`dejavuserif786law`**: the shipped DejaVu Serif rendered through the
predecessor's transport-law transform (`lab/transform.mjs`, font hash
`75707371a24d48cf`), which this repo does not carry. It is the set that reads
EFTA01150379 at tolerance 0, and it is `build`-class here for exactly that
reason: the face is free, the reproduction path is not in this repo.

`TimesNewRoman8` was written off as lost because the search was
`C:/Windows/Fonts`; it was in `%LOCALAPPDATA%/Microsoft/Windows/Fonts` all along
([METHOD](METHOD.md) rule 3, in person). Finding it exposed two errors in the
recipe, which is the other half of the point — **an unreproducible set hides its
own bugs**:

- `tnr8lin10`'s em64 is **682, not the 683** on record. At 683, 404 of 428
  y-phase-0 rasters differ from the original; at 682, 30 do.
- Its advances need the **unquantized** size, which `fontgen` could not express
  at all until `--size` ([LAWS §6](LAWS.md#6-size-em64-and-advances-are-two-numbers)).

With both fixed, all three `tnr8` sets regenerate and `report` reads
byte-identically from them. A footnote that says something about `build` as a
class: against stock `times.ttf` these sets differ in **16 of 856 rasters — the
characters `<` and `~`, nothing else**, advances identical, and `report`
contains neither. The build genuinely matters; it just happens not to matter
*here*, and the only way to know which is true is to render both.

### corpus — no reproduction path

6 sets (`bullet16`, `bullet16b`, `bulleto16`, `fedline_page`, `ftrfouo_page`,
`hdrles_page`) were never rendered from a font. They were cut from the pixels of
two source documents, so they can be neither shipped nor regenerated.
`fontgen --set` refuses them with that explanation rather than producing
something wrong. Only the `calibri` pool needs them.

## Consequences to expect

- `glyphs.bin` is built from whatever sets you have, so it is a **per-machine
  artifact** and is gitignored (`node tools/export-glyphs.mjs`; `--check`
  compares against your own `.npz`, not a committed reference).
- Most pools need `system` sets, so most cannot run on a fresh clone until you
  regenerate. `--plan` is the todo list; the gate says the same thing document by
  document, skipping **loudly** and never printing a green line for something it
  did not read.
- `npm test` asserts every `free` set is present and makes **no** assertion about
  the others — a fresh clone is *expected* to be missing 62 sets, and that must
  not read as a failure.

## The honest caveat

Byte-exact results depend on the exact font build on your machine. Two people
running `--set cour13` against different Courier New revisions can legitimately
get different bytes, and the toolkit will tell them so by refusing to read at
tolerance 0 rather than quietly approximating. That is the design working — but
it does mean "regenerate it yourself" is a weaker guarantee than "it ships
here", which is why the free 13 are verified byte-for-byte and the rest are not.
