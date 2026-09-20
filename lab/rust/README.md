# lab/rust — the fast engine

The lab's exhaustive sweep is hours of JavaScript. This is the same search in
Rust, **certified against that JavaScript as its oracle**, and it is the
difference between a refutation costing an afternoon and costing a minute.

Refutation is most of what a hunt does, so that difference is the whole case
for this directory.

```bash
npm run rust:build            # cargo build --release (needs a Rust toolchain)
npm run rust:certify          # the gate — ~2 s, no corpus, no system font
```

```
3000 cases in 0.03s: 0 byte diffs, 0 null diffs, 0 bbox diffs, 0 law diffs
SELFTEST CERTIFIED: 0 diffs
bench (Carlito-Regular.ttf em64=1024, 94 glyphs × 4096 phases):
  1 core 502,844 renders/s · 16 cores 2,060,275 renders/s

PASS  ctrl  hits (72) — identical, 0.7s vs 27.7s in JS (40×)
PASS  ctrl  no decoy and no wrong size scores at all — 2 decoy faces × 13 sizes, all 0
PASS  ctrl2 hits (72) — identical, 0.7s vs 31.7s in JS (45×)
PASS  harvest windows are byte-identical to the render — 13 windows
```

## What it does

| | |
|---|---|
| `hunt sweep` | `../sweep.mjs`, 40–45× — every (face, em64, pen, law) over harvested targets |
| `hunt probe` | the **anisotropic** exact search (em64x ≠ em64y), which nothing in `../` can do |
| `hunt harvest` | the **connected-component** harvester — the general one, for proportional faces |
| `hunt selftest` | 3,000 golden tuples through `ftclone/`, plus the throughput number |

`sweep` and `harvest` are the two that matter. `identify` and `mbank` stay in
JavaScript on purpose: they are already fast enough, and a second
implementation of an answer is a second thing to keep true.

## The certification chain, and why it is shaped like this

A number from an unverified rasterizer is not evidence, so nothing here is
allowed to be believed on its own:

1. **`ftclone/`** (Rust) reproduces `../../ftclone/` (JS), which is itself
   certified against mupdf's own `fillText`. 3,000 seeded tuples covering the
   TTF composite path, fractional and anisotropic `em64`, bare CFF, and pens
   that clip every edge of the frame — **every coverage byte and every per-law
   ink bbox**, 0 diffs.
2. **`hunt sweep`** reproduces `../sweep.mjs`: two whole control sweeps
   compared hit for hit *in order*, summary row for summary row, and on the
   stage-A survivor lines.
3. **`hunt harvest`** has no JS counterpart, so it is certified by a closed
   loop instead — a page this repo drew itself is harvested blind, and every
   window it promotes must come back byte-identical to the render it came from.

Everything in that list is **synthetic**: control targets and the harvest page
are drawn by `ftclone/` through faces the repo ships, so `rust:certify` runs on
a fresh clone with no corpus and no system font. The corpus gate
(`npm run gate`) proves the reader against real documents; this one proves the
engine against arithmetic. Neither substitutes for the other.

**Each control roster carries decoys, and that assertion is the load-bearing
one.** Agreeing with the JS about which face won only proves the port; scoring
the wrong faces at flat zero proves the *search*. Exactness cannot
false-positive, so one stray decoy hit would mean the byte test has a hole in
it — the same thing `../selftest.mjs` leans on.

The goldens in `fixtures/golden-ctrl*.json` are **committed**, which is what
makes this a regression gate rather than a self-consistency check: change the
JS oracle's behaviour and the goldens disagree. `--regen` re-runs the oracle
(~60 s, JS-bound). Regenerate deliberately, never to make a failure go away.

## Layout

Two crates, mirroring the repo:

```
ftclone/   fixed · ttf · cff · grays    the certified rasterizer, ported module for module
hunt/      main · laws · io · sweep · probe · harvest
certify.mjs                            the oracle bridge and the gate
```

~2,600 lines of Rust and 420 of JS, from the previous repo's 8 crates and 3
tools. The merge is not cosmetic: `ftgrays`/`ftfixed`/`fontparse` were three
crates describing one file (`ftclone.mjs`), and `sweeplib`/`huntio`/`laws`/
`harvestlib` were four describing one binary.

## What is gone, and why

- **`hunt harvest` is whole.** In the previous repo it stopped at a
  `clusters.json` and handed off to a JS finisher, because targets were `.npz`
  and two deflate implementations do not agree byte for byte. The lab's one
  target format is now PGM + `index.json` — uncompressed, nothing to disagree
  about — so the split, the finisher and the `flate2` dependency all
  disappeared with it.
- **`hunt bench` is folded into `selftest`.** A speed number can now only be
  printed by a build that has just proven itself correct, which is the only
  kind worth quoting.
- **The hunt ledger** (atomic claim directories, resumable multi-session
  briefs) did not come across. `--ckpt` is what actually earned its keep: one
  fsynced JSONL line per finished config, so a killed sweep loses at most one.
- **The GPU did not come across**, and that is decided rather than deferred —
  see *Deliberately not here* in [../README.md](../README.md).

## Two things measured here that changed the lab

**Three of the six blend laws are one law.** `fzLin`, `fzLin254` and `mid` in
[../families.mjs](../families.mjs) agree on all 256 coverages. A sweep that
enumerated all six reported every linear-family hit three times and then
answered "which law?" with whichever alias came first in the object. Sweeps now
iterate `LAW_NAMES` — the four distinguishable maps — and `identify` still
keys by name, so a family keeps citing the law it was proven with. Two names
for one map is honest documentation; two names in one search is not.

**40–45×, not 65–100×.** The previous repo measured the larger figure on
larger sweeps. These controls are 13 configs over 72 templates, so process
start-up and target loading are a visible share of the Rust wall time and the
ratio is lower. It is the honest number *for this control*; the ratio grows
with the sweep, which is the case for having the engine at all.
