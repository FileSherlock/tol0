// ttf.mjs — the minimal TrueType parser (cmap 4/12 lookup + glyf outlines,
// simple & composite, in FONT UNITS, y-up) now lives in engine/ftraster.js so
// the browser runs the certified code; this is its path-taking wrapper.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('../engine/ftraster.js');
export function loadFont(path) { return R.loadTTF(readFileSync(path)); }
