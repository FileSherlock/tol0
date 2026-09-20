// raster-cache.mjs — where page rasters live, and what they are called.
//
// ONE definition, imported by both halves, because the writer
// (rasterize-mupdf.mjs) and the reader (blind-read.mjs) must agree on a path
// derived from the document itself — if they drift, the reader silently
// reports "not rasterized" for a document that was in fact cached.
//
// The cache is keyed by sha256(PDF bytes)[:16], so it is bound to the exact
// document: swap a byte and you get a fresh directory rather than a stale
// raster read as if it were the new file. Contents are gitignored — they are
// derived from, and as licence-encumbered as, the source document.
//
// Record format (per page, gzipped): 'GRY1' u32-magic | u32 mode | u32 w |
// u32 h, then
//   mode 0 : no ink / no image on the page — no body
//   mode 1 : u8 gray, w·h
//   mode 2 : u16le R+G+B sums, w·h
//   mode 3 : u16le R+G+B sums, w·h, then u8 per-pixel channel spread (max−min)
//   mode 4 : u8 R,G,B per pixel, 3·w·h — what rasterize-mupdf.mjs writes for
//            colour pages since 2026-09-03 (LAWS §9: coloured text is read as
//            coverage and needs the channels; 2 and 3 are read, never written)
// Decoding (including the colour-ink whitening floods) lives in blind-read.mjs
// readGray, which is the only consumer.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Repo-relative cache root (also the string used in error messages). */
export const CACHE_DIR = 'fixtures/raster-cache';

/** Directory holding pdfPath's page rasters (not created here). */
export function cacheDirFor(pdfPath) {
  const sha = createHash('sha256').update(readFileSync(pdfPath)).digest('hex');
  return { sha, key: sha.slice(0, 16), dir: join(REPO, CACHE_DIR, sha.slice(0, 16)) };
}

export const pageFile = pno => `page-${String(pno).padStart(4, '0')}.gray.gz`;
