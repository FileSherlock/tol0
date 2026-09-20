// families.mjs — THE registry of proven producer families, as data. Everything
// this project has byte-certified about how a document raster gets made lives
// here in machine-readable form, so `identify.mjs` can try every known answer
// automatically and a new hunt starts warm instead of from a blank page.
//
// **Each entry cites the DOCUMENT that proves it, not a prose file.** The old
// repo's `record` fields pointed at seven FINDINGS-*.md; those went stale, and
// the document pixels never do. If you doubt an entry, re-read its document —
// that is the authority, and re-reading it is one command.
//
// Add a family the moment it is byte-proven. The constants here are COPIES for
// machine use ([METHOD rule 1](../docs/METHOD.md)); the pixels remain the
// authority.
//
// ## Two kinds of entry
//
// **renderable** — a glyph config ftclone reproduces byte-for-byte:
//   { font, em64, fy, gid, law }
//   - fx is ALWAYS the ¼-px lattice [0,16,32,48]/64 and draws is always 1
//     (double-draw was tried and refuted). See ../docs/LAWS.md §1.
//   - fy is in 1/64 px. [0] = integer baselines, which is the only thing
//     mupdf's fillText can produce (LAWS §1: y rounds to whole pixels).
//     [0,32] additionally tries a true ½-px baseline; it only matters when it
//     changes the RASTER, since the exact test is bbox-aligned.
//   - gid: 'cmap' (TTF — ttf.mjs resolves the codepoint itself)
//          'mupdf' (bare CFF — gid map from mupdf encodeCharacter on the same
//          bytes, because a CFF has no cmap)
//   - law: the cov → page-byte map, keyed into LAWS below.
//
// **pageLaw** — no per-glyph render: a page-level transform, or a producer the
// ¼-px engine cannot match. Carries the fingerprint that identifies it and
// what to do about it.
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------- font paths
// METHOD rule 3 in code: Windows installs fonts PER USER as well as globally,
// and the Settings font list merges the two, so a roster built from
// C:/Windows/Fonts alone is HALF the machine. That gap hid DejaVu Serif for a
// week and then wrote off TimesNewRoman8 as a lost artifact. Both directories,
// always — and `face()` reports which one answered.
export const FONT_DIRS = [
  'C:/Windows/Fonts',
  `${(process.env.LOCALAPPDATA ?? '').replace(/\\/g, '/')}/Microsoft/Windows/Fonts`,
  new URL('../fonts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
];

/** Resolve a bare font file name against every roster directory. Returns null
 *  when no directory has it — which is a statement about this machine, not
 *  about the document. */
export function face(name) {
  if (/^([A-Za-z]:|\/)/.test(name)) return existsSync(name) ? name : null;
  for (const d of FONT_DIRS) {
    const p = `${d.replace(/\/$/, '')}/${name}`;
    if (existsSync(p)) return p;
  }
  return null;
}

// --------------------------------------------------------------------- laws
// A blend law maps FreeType coverage (0..255) to the byte the producer wrote.
// Integer laws are non-surjective, so the bytes a producer CAN emit have holes
// — and the holes are a fingerprint independent of the face. That is how the
// calibri 'mid' law was pinned (its hole is at 127/128).
const LIN = v => (v >= 128 && v <= 254 ? v + 1 : v);
const lut = f => { const L = new Uint8Array(256); for (let c = 0; c < 256; c++) L[c] = f(c); return L; };

export const LAWS = {
  // mupdf's own composite of black over white — ../docs/LAWS.md §2.
  fz:     lut(c => (255 * (256 - (c + (c >> 7)))) >> 8),
  // plain source-over, no >>7 correction. Not mupdf; kept because a sweep that
  // cannot express it cannot refute it.
  src:    lut(c => 255 - c),
  // the eDiscovery producer's +1 post-law on light bytes (LAWS §4).
  fzLin:  lut(c => LIN((255 * (256 - (c + (c >> 7)))) >> 8)),
  srcLin: lut(c => LIN(255 - c)),
  // 'linear254' in engine terms: raw 254 (coverage 1) goes to 255 and the
  // pixel disappears. The nimbusrom family, NOT the report family.
  fzLin254: lut(c => { const b = (255 * (256 - (c + (c >> 7)))) >> 8; return b >= 128 && b <= 254 ? Math.min(255, b + 1) : b; }),
  // the Calibri letterhead law: every antialias byte pushed 1 away from the
  // 127/128 midpoint.
  mid:    lut(c => { const t = 255 - c; return Math.max(0, Math.min(255, t + (t >> 7) - ((255 - t) >> 7))); }),
};

/** The DISTINCT laws, in LAWS order, the first name winning — and this is a
 *  correction, measured 2026-07-26 while certifying `lab/rust`.
 *
 *  **`fzLin`, `fzLin254` and `mid` are ONE map**: they agree on all 256
 *  coverages, so three of the six entries above are aliases. `min(255, b+1)`
 *  guards a case fz can never produce (b = 255 is not in [128,254]), and the
 *  Calibri midpoint push lands on the same bytes as the +1 post-law. Only four
 *  laws here are distinguishable from pixels: `fz`, `src`, `fzLin`, `srcLin`.
 *
 *  A sweep that enumerated all six reported every linear-family hit THREE
 *  times and then answered "which law?" with whichever alias came first in
 *  this object — an ambiguity that looked like evidence. Sweeps iterate this
 *  list; `identify` still keys `LAWS` by name, so a family may keep citing the
 *  law it was proven with. Two names for one map is honest documentation; two
 *  names in one search is not. */
export const LAW_NAMES = Object.keys(LAWS).filter((k, i, all) =>
  !all.slice(0, i).some(p => LAWS[p].every((v, c) => v === LAWS[k][c])));

/** Smallest coverage a law renders as ink (byte < pgm.INK). The LUTs are
 *  monotone in coverage, so this is the threshold at which a candidate's bbox
 *  is measured — and it MUST be the law's own, not a constant. Using a fixed
 *  threshold made every glyph with a faint 250..254 fringe measure 1–2 px too
 *  wide and get rejected before its bytes were ever compared. */
export const covMin = Object.fromEntries(Object.entries(LAWS).map(([k, L]) => {
  let c = 0; while (c < 256 && L[c] >= 250) c++;
  return [k, c];
}));

// ---------------------------------------------------------------- the families
export const FAMILIES = [
  // ---- mupdf @ 96 dpi over installed Windows faces (the corpus family) ----
  // Plain fz blend, nothing else. Proven by whole-document reads at tol 0.
  { name: 'times16', renderable: true, font: 'times.ttf', em64: 1024, fy: [0, 32], gid: 'cmap', law: 'fz',
    set: 'times16', record: 'gate v3.pdf + big.pdf — 25,586 lines, 0 □' },
  { name: 'times13', renderable: true, font: 'times.ttf', em64: 832, fy: [0, 32], gid: 'cmap', law: 'fz',
    set: 'times13' },
  { name: 'cour13', renderable: true, font: 'cour.ttf', em64: 832, fy: [0, 32], gid: 'cmap', law: 'fz',
    set: 'cour13', record: 'gate courier_1.pdf + courier_2.pdf — 0 □' },
  { name: 'cour16', renderable: true, font: 'cour.ttf', em64: 1024, fy: [0, 32], gid: 'cmap', law: 'fz', set: 'cour16' },
  { name: 'cour12', renderable: true, font: 'cour.ttf', em64: 768, fy: [0, 32], gid: 'cmap', law: 'fz', set: 'cour12' },
  { name: 'arial16', renderable: true, font: 'arial.ttf', em64: 1024, fy: [0, 32], gid: 'cmap', law: 'fz', set: 'arial16' },
  { name: 'calibri16', renderable: true, font: 'calibri.ttf', em64: 1024, fy: [0, 32], gid: 'cmap', law: 'fz', set: 'calibri16' },
  { name: 'segoeui16', renderable: true, font: 'segoeui.ttf', em64: 1024, fy: [0, 32], gid: 'cmap', law: 'fz', set: 'segoeui16' },
  { name: 'verdana16', renderable: true, font: 'verdana.ttf', em64: 1024, fy: [0, 32], gid: 'cmap', law: 'fz', set: 'verdana16' },
  { name: 'georgia16', renderable: true, font: 'georgia.ttf', em64: 1024, fy: [0, 32], gid: 'cmap', law: 'fz', set: 'georgia16' },

  // ---- the eDiscovery linear producer (report.pdf) ----
  // Same blend, then +1 on every light byte. 8 pt at 96 dpi, so em64 682 with
  // advances at the UNtruncated 10.6666… px — LAWS §6.
  { name: 'times16-linear', renderable: true, font: 'times.ttf', em64: 1024, fy: [0, 32], gid: 'cmap', law: 'fzLin',
    set: 'timeslin16', record: 'gate report.pdf' },
  { name: 'tnr8-linear10', renderable: true, font: 'TimesNewRoman8_Clean.ttf', em64: 682, sizePx: 10.667, fy: [0], gid: 'cmap', law: 'fzLin',
    set: 'tnr8lin10', record: 'gate report.pdf body — per-USER font, see FONT_DIRS' },

  // ---- Tahoma email family: the largest tol-0 corpus population ----
  // Found by the m-bank prefilter (`mbank.mjs scan`) and proven the same day.
  // Plain fz, integer y, no post-law — the exotic part was only finding it.
  { name: 'tahoma853', renderable: true, font: 'tahoma.ttf', em64: 853, fy: [0], gid: 'cmap', law: 'fz',
    set: 'tahoma853', record: 'EFTA01164435 1,963 glyphs 0 □ · EFTA00644019 3,659 0 □; 6,870 docs at this em64' },
  { name: 'tahomabd853', renderable: true, font: 'tahomabd.ttf', em64: 853, fy: [0], gid: 'cmap', law: 'fz', set: 'tahomabd853' },
  { name: 'tahoma832', renderable: true, font: 'tahoma.ttf', em64: 832, fy: [0], gid: 'cmap', law: 'fz',
    set: 'tahoma832', record: 'EFTA00999916 1,759 glyphs 5 □; 894 docs' },
  { name: 'tahomabd832', renderable: true, font: 'tahomabd.ttf', em64: 832, fy: [0], gid: 'cmap', law: 'fz', set: 'tahomabd832' },
  { name: 'tahoma1024', renderable: true, font: 'tahoma.ttf', em64: 1024, fy: [0], gid: 'cmap', law: 'fz',
    set: 'tahoma1024', record: 'EFTA01156316 844 glyphs 0 □; 147 docs' },
  { name: 'tahomabd1024', renderable: true, font: 'tahomabd.ttf', em64: 1024, fy: [0], gid: 'cmap', law: 'fz', set: 'tahomabd1024' },
  // The same producer's threads quote a SECOND body face at the SAME size —
  // EFTA00142692 reads its Tahoma and Segoe halves in one pass. METHOD rule 6:
  // a tie can be the answer.
  { name: 'segoeui853', renderable: true, font: 'segoeui.ttf', em64: 853, fy: [0], gid: 'cmap', law: 'fz', set: 'segoeui853' },
  { name: 'segoeuib853', renderable: true, font: 'segoeuib.ttf', em64: 853, fy: [0], gid: 'cmap', law: 'fz', set: 'segoeuib853' },

  // ---- mupdf-lineage renderer over the builtin base-14 faces ----
  // The producing PROGRAM is unidentified; only the render law is proven, and
  // that is enough to read the documents. em64 791 = 12.359375 px isotropic.
  { name: 'nimbus791', renderable: true, font: 'NimbusMonoPS-Regular.cff', em64: 791, fy: [0], gid: 'mupdf', law: 'fz',
    set: 'nimbus791', record: 'gate n791 block — 11 docs, 5,028/5,028 truth rows incl. spacing' },

  // ---- eDiscovery serif family: builtin Nimbus + linear254 + per-page palette ----
  // The palette step is per PAGE and read off the page itself, so it is a
  // reader flag (`--palette`), not something a glyph render can carry.
  { name: 'nimbusromlin1024', renderable: true, font: 'NimbusRoman-Regular.cff', em64: 1024, fy: [0], gid: 'mupdf', law: 'fzLin254',
    set: 'nimbusromlin1024', record: 'gate nimbusrom.pdf — 12 pages, 13,034 glyphs, 38 □ (censused: fixtures/gate-ref/README.md)' },
  { name: 'nimbusrombdlin1024', renderable: true, font: 'NimbusRoman-Bold.cff', em64: 1024, fy: [0], gid: 'mupdf', law: 'fzLin254', set: 'nimbusrombdlin1024' },
  { name: 'nimbusromlin983', renderable: true, font: 'NimbusRoman-Regular.cff', em64: 983, fy: [0], gid: 'mupdf', law: 'fzLin254', set: 'nimbusromlin983' },
  { name: 'nimbusromilin1024', renderable: true, font: 'NimbusRoman-Italic.cff', em64: 1024, fy: [0], gid: 'mupdf', law: 'fzLin254', set: 'nimbusromilin1024' },
  { name: 'nimbusrombdlin1194', renderable: true, font: 'NimbusRoman-Bold.cff', em64: 1194, fy: [0], gid: 'mupdf', law: 'fzLin254', set: 'nimbusrombdlin1194' },
  { name: 'nimbussansbdlin1536', renderable: true, font: 'NimbusSans-Bold.cff', em64: 1536, fy: [0], gid: 'mupdf', law: 'fzLin254', set: 'nimbussansbdlin1536' },
  // The same pages also embed a REAL Times New Roman subset for ■ and curly
  // quotes, rendered at the same pens. METHOD rule 6 again.
  { name: 'tnrlin1024', renderable: true, font: 'times.ttf', em64: 1024, fy: [0], gid: 'cmap', law: 'fzLin254', set: 'tnrlin1024' },
  // Sub-family of the same palette container (ECF court filings): NO linear
  // step. One sub-family per SOURCE-document producer.
  { name: 'censcbk1198', renderable: true, font: 'CENSCBK.TTF', em64: 1198, fy: [0], gid: 'cmap', law: 'fz',
    set: 'censcbk1198', record: 'EFTA00093044 brief body, exact' },

  // ---- Word→JPEG letterheads on Calibri VERSION 1.02 ----
  // METHOD rule 7 one level down: the installed Calibri 6.2x is a DIFFERENT
  // DRAWING of w and x. This needs the 1.02 build, which is not on most
  // machines, so these entries usually skip — and a skip is not a refutation.
  { name: 'calibri102-16', renderable: true, font: 'calibri-102.ttf', em64: 1024, fy: [0], gid: 'cmap', law: 'mid',
    set: 'calibri102mid_1024', record: 'EFTA00038617 + EFTA01649149 — 0 □ at tol 2' },
  { name: 'calibrib102-16', renderable: true, font: 'calibrib-102.ttf', em64: 1024, fy: [0], gid: 'cmap', law: 'mid', set: 'calibrib102mid_1024' },

  // ---- EFTA01150379: DejaVu Serif @ 786 ----
  // The one entry that is deliberately NOT a pool: the face is right and the
  // BUILD is wrong, differing in lowercase 't' alone, so it reads at tol 4 and
  // tol is part of the proof (METHOD rule 5). Reproduce it explicitly.
  { name: 'dejavuserif786', renderable: true, font: 'DejaVuSerif.ttf', em64: 786, fy: [0], gid: 'cmap', law: 'fz',
    set: null, record: 'EFTA01150379 — 115 templates / 31 chars / 21.0% of 2,194,088 instances byte-exact; 94.5%/page at tol 4' },

  // ---- page-law families: recognize by fingerprint, do not try to render ----
  { name: 'palette-quant', renderable: false,
    fingerprint: 'reads "almost, but ±1" against a proven rasterizer',
    action: 'reader --palette: page byte = nearest available gray, ties darker. The palette is read off the page, so its grays are fixpoints (../docs/LAWS.md §4).',
    record: 'gate v3.pdf, email.pdf P1' },
  { name: 'jpeg-jitter', renderable: false,
    fingerprint: 'mode-3 colour raster, ±1 channel jitter on ink, blue mailto links',
    action: 'reader --tol 1, justified by the documented producer law and by every tol-0 document in the family staying byte-identical under it',
    record: 'EFTA00142692 — 361 □ at tol 0, 36 □ at tol 1' },
  { name: 'unknown-816x1073', renderable: false,
    fingerprint: '816×1073 pages (MediaBox 612×804.75 pt) and a CONTINUOUS pen lattice — zero byte-identical cell repeats, which is the tell that no finite phase set generated them',
    action: 'OPEN. Not matchable by the ¼-px engine as-is; producer AND faces unidentified (the trio mixes g-shapes, so ≥2 faces). Verify face from glyph SHAPES before spending a sweep on it.',
    record: 'open problem' },
  { name: 'tahoma704-descenders', renderable: false,
    fingerprint: 'Tahoma at em64 704: x-height letters exact at tol 0, but every DESCENDER (g p y and parentheses) fails — "followin[g]", "com[p]lainants", "(2)"',
    action: 'OPEN sub-family, 9 documents. Face and size are certain: ±2..±16 read 0 lines, and neither ½-phase baselines nor tol 1/2/4 recovers one descender, so this is a STRUCTURAL descender-row law, not a size or gray error. Do NOT widen the tahoma pool to chase it.',
    record: 'EFTA00172162 (EFTA0017xxxx block)' },
];

// ---------------------------------------------------------------------------
// SUPERSEDED, kept because someone will remember the old entry:
// `stretched-rerender` claimed EFTA01150379 was a stretched-and-rerendered
// page drawn in Cambria, and the hunt was CLOSED as "unwinnable by
// construction". BOTH claims were wrong. It is DejaVu Serif at em64 786,
// natively rendered under plain fz — the entry above. It hid for a week
// because every sweep enumerated C:/Windows/Fonts and DejaVu Serif is a
// per-user install (METHOD rule 3). The generic "recognize a stretch and stop"
// advice went with it: no corpus document is known to be a stretched rerender.
// ---------------------------------------------------------------------------

/** Plausible em64 window for `identify --scan` when nothing above matches:
 *  ~7 px to ~20 px glyphs cover every text size this corpus has shown. Spikes
 *  worth trying first are trunc(pt · 96/72 · 64) for the common point sizes. */
export const SCAN_DEFAULT = { from: 448, to: 1280 };
