# The only font binaries in this repo

Every face here is redistributable. Nothing may be added to this directory
without recording its licence in the table below.

| file | face | licence |
|---|---|---|
| `Carlito-Regular.ttf` | Carlito (Łukasz Dziedzic) | SIL Open Font License 1.1 |
| `DejaVuSerif.ttf` | DejaVu Serif | DejaVu Fonts License (Bitstream Vera derivative; permissive) |
| `NimbusMonoPS-Regular.cff` | URW Nimbus Mono PS | URW++ base-35, GPL with the font exception |
| `NimbusRoman-Regular.cff` | URW Nimbus Roman | URW++ base-35, GPL with the font exception |
| `NimbusRoman-Regular-1.12.0.cff` | URW Nimbus Roman, rev 1.12.0 | URW++ base-35, GPL with the font exception |
| `NimbusRoman-Bold.cff` | URW Nimbus Roman Bold | URW++ base-35, GPL with the font exception |
| `NimbusRoman-Italic.cff` | URW Nimbus Roman Italic | URW++ base-35, GPL with the font exception |
| `NimbusSans-Regular.cff` | URW Nimbus Sans | URW++ base-35, GPL with the font exception |
| `NimbusSans-Bold.cff` | URW Nimbus Sans Bold | URW++ base-35, GPL with the font exception |

## What they are for

- **Carlito** and **NimbusMonoPS** certify the rasterizer
  (`npm run certify:ftclone`) — one TrueType path, one CFF path. NimbusMonoPS is
  also what mupdf embeds as its builtin `Courier`, so that run doubles as proof
  that the file here is the font mupdf actually uses.
- The rest are the source faces for the **13 committed glyph sets**.
  `node tools/glyph-sets.mjs --verify` re-renders every one of them from these
  files and byte-compares the result, so "these sets are reproducible" is
  asserted rather than claimed.

Two `NimbusRoman-Regular` revisions are kept deliberately. They are different
*drawings*, and the ECF court-brief family reads with 1.12.0 and not with the
current one. A font build is part of a proof here, not an implementation detail
— see [../docs/FONTS.md](../docs/FONTS.md).

## Everything else is referenced, never shipped

`.gitignore` blanket-ignores `*.ttf` / `*.otf` / `*.cff` / `*.npz` and excepts
only this directory and the 13 free sets. That is deliberate: the previous repo
committed 431 MB of Microsoft CJK fonts before the ignore rule was added, and
ignoring a path does not untrack what is already in the index.

Glyph sets for Arial, Times New Roman, Courier New, Calibri, Cambria, Tahoma,
Segoe UI and friends are regenerated from *your* installed copies:
`node tools/glyph-sets.mjs --plan`. Byte-exact results depend on the exact font
build, which is why this project has hit that wall twice — Calibri 1.02 vs the
installed 6.2x, and a DejaVu Serif build differing in `t` and `D` alone.

Exact licence texts are not vendored yet — see the open licence question in the
project plan.
