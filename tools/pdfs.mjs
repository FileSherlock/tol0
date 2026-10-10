// pdfs.mjs — where a corpus document's PDF is.
//
// The project's PDFs live once, under their EFTA numbers, in one folder beside
// this repository (~/Desktop/pdfs, its README and manifest.json), shared with
// Recto and recto-eval; PDFS=<path> points elsewhere. fixtures/corpus keeps the
// truth transcripts, and is still where a PDF is looked for when that folder
// is absent or lacks it (a fresh clone), so a missing document is reported
// exactly as before.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PDFS = process.env.PDFS ? resolve(process.env.PDFS) : resolve(REPO, '..', 'pdfs');

// fixture path (relative to fixtures/corpus) → name in the PDF folder, where they differ
const NAMES = {
  'v3.pdf': 'EFTA00575939.pdf', 'big.pdf': 'EFTA01011184.pdf',
  'courier_1.pdf': 'EFTA00382083.pdf', 'courier_2.pdf': 'EFTA00400459.pdf',
  'recto/efta00018586.pdf': 'EFTA00018586.p8.pdf',
  'calibri/EFTA00038617.pdf': 'EFTA00038617.p2.pdf', 'calibri/EFTA01649149.pdf': 'EFTA01649149.p2.pdf',
};

// corpusPdf('v3.pdf'), corpusPdf('nimbus791/EFTA00751637.pdf') → an absolute path
export function corpusPdf(rel) {
  const shared = join(PDFS, NAMES[rel] ?? rel.split('/').pop());
  return existsSync(shared) ? shared : join(REPO, 'fixtures', 'corpus', rel);
}
