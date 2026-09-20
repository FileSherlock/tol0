// cff.mjs — the minimal CFF/Type2 outline extractor for the bundled URW fonts
// now lives in engine/ftraster.js (bytes in); this is its path-taking wrapper.
// gid comes from the caller (mupdf's encodeCharacter on the same bytes).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('../engine/ftraster.js');
export function loadCff(path) { return R.loadCFF(readFileSync(path)); }
