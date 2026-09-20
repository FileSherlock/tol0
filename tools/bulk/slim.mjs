// slim.mjs — a page's read, small enough to keep a million of them, and
// nothing lost. blind-read's JSON spends nine tenths of its bytes on
// `glyphs: [[ch, pen], …]`; pens sit on the ¼-px lattice (LAWS §1) and rise
// along a line, so the same information is
//   g   the glyphs' characters, joined
//   p   pen·4 as integers, each the difference from the one before
//   c   { index: px } for the few glyphs clipped under a redaction box
// A line that does not fit that mould (a pen off the lattice, a character
// that is not one code point) keeps its `glyphs` untouched. expandPage gives
// back exactly what pageResult made — same keys, same order, same numbers —
// and test/bulk.test.js holds it to that.
export function slimLine(L) {
  if (!L.glyphs) return L;
  const { glyphs, ...rest } = L;
  const p = [], c = {};
  let g = '', prev = 0, fits = true;
  for (let i = 0; i < glyphs.length && fits; i++) {
    const [ch, pen, clip] = glyphs[i], q = pen * 4;
    if (typeof ch !== 'string' || Array.from(ch).length !== 1 || !Number.isInteger(q)) { fits = false; break; }
    g += ch; p.push(q - prev); prev = q;
    if (glyphs[i].length > 2) c[i] = clip;
  }
  if (!fits) return L;
  return { ...rest, g, p, ...(Object.keys(c).length ? { c } : {}) };
}

export function expandLine(S) {
  if (S.g === undefined) return S;
  const { g, p, c, ...rest } = S;
  let q = 0;
  const glyphs = Array.from(g).map((ch, i) => { q += p[i]; return c && i in c ? [ch, q / 4, c[i]] : [ch, q / 4]; });
  return { ...rest, glyphs };
}

export const slimPage = P => ({ ...P, lines: P.lines.map(slimLine) });
export const expandPage = P => (P.lines ? { ...P, lines: P.lines.map(expandLine) } : P);
