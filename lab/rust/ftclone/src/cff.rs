// cff — port of ../../../ftclone/cff.mjs: minimal CFF/Type2 outline extractor.
// Interprets Type2 charstrings (hints skipped, masks consumed) into contours
// of lines + CUBIC beziers in charstring units. The f64 accumulation order
// matches the JS interpreter statement-for-statement. gid comes from the
// caller (mupdf's encodeCharacter on the same bytes, embedded in fixtures /
// gidmaps.json).
use crate::{err, CffContour, CffSeg, FontError};
use std::collections::HashMap;

fn u16be(b: &[u8], o: usize) -> usize { ((b[o] as usize) << 8) | b[o + 1] as usize }
fn i16be(b: &[u8], o: usize) -> f64 { ((((b[o] as u16) << 8) | b[o + 1] as u16) as i16) as f64 }
fn i32be(b: &[u8], o: usize) -> f64 {
    (((b[o] as u32) << 24 | (b[o + 1] as u32) << 16 | (b[o + 2] as u32) << 8 | b[o + 3] as u32) as i32) as f64
}

#[derive(Clone)]
struct Index { items: Vec<(usize, usize)>, end: usize }

fn index(b: &[u8], off: usize) -> Result<Index, FontError> {
    let count = u16be(b, off);
    if count == 0 { return Ok(Index { items: vec![], end: off + 2 }); }
    let off_size = b[off + 2] as usize;
    let off_at = |i: usize| -> usize {
        let mut v = 0usize;
        for k in 0..off_size { v = v * 256 + b[off + 3 + i * off_size + k] as usize; }
        v
    };
    let data_start = off + 3 + (count + 1) * off_size - 1;
    let mut items = Vec::with_capacity(count);
    for i in 0..count {
        let (a, z) = (data_start + off_at(i), data_start + off_at(i + 1));
        if z > b.len() || a > z { return Err(err("INDEX out of range")); }
        items.push((a, z));
    }
    Ok(Index { items, end: data_start + off_at(count) })
}

fn parse_dict(b: &[u8], range: (usize, usize)) -> Result<HashMap<u32, Vec<f64>>, FontError> {
    let data = &b[range.0..range.1];
    let mut d = HashMap::new();
    let mut st: Vec<f64> = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        let b0 = data[i];
        if b0 <= 21 {
            let mut op = b0 as u32;
            i += 1;
            if b0 == 12 { op = 1200 + data[i] as u32; i += 1; }
            d.insert(op, std::mem::take(&mut st));
        } else if b0 == 28 { st.push(i16be(data, i + 1)); i += 3; }
        else if b0 == 29 { st.push(i32be(data, i + 1)); i += 5; }
        else if b0 == 30 { // real
            let mut s = String::new();
            i += 1;
            'outer: while i < data.len() {
                for nib in [data[i] >> 4, data[i] & 15] {
                    match nib {
                        0..=9 => s.push((b'0' + nib) as char),
                        10 => s.push('.'),
                        11 => s.push('E'),
                        12 => s.push_str("E-"),
                        14 => s.push('-'),
                        15 => { i += 1; break 'outer; }
                        _ => {}
                    }
                }
                i += 1;
            }
            st.push(s.parse::<f64>().map_err(|_| err(format!("bad real '{s}'")))?);
        }
        else if (32..=246).contains(&b0) { st.push(b0 as f64 - 139.0); i += 1; }
        else if (247..=250).contains(&b0) { st.push((b0 as f64 - 247.0) * 256.0 + data[i + 1] as f64 + 108.0); i += 2; }
        else if (251..=254).contains(&b0) { st.push(-(b0 as f64 - 251.0) * 256.0 - data[i + 1] as f64 - 108.0); i += 2; }
        else { return Err(err(format!("dict op {b0}"))); }
    }
    Ok(d)
}

pub struct CffFont {
    b: Vec<u8>,
    pub units_per_em: u32,
    char_strings: Index,
    subrs: Index,
    gsubrs: Index,
    g_bias: f64,
    l_bias: f64,
}

fn bias(n: usize) -> f64 { if n < 1240 { 107.0 } else if n < 33900 { 1131.0 } else { 32768.0 } }

impl CffFont {
    pub fn load(path: &std::path::Path) -> Result<Self, FontError> {
        let b = std::fs::read(path)?;
        if b.is_empty() || b[0] != 1 { return Err(err("CFF major != 1")); }
        let hdr_size = b[2] as usize;
        let name_idx = index(&b, hdr_size)?;
        let top_idx = index(&b, name_idx.end)?;
        let string_idx = index(&b, top_idx.end)?;
        let gsubrs = index(&b, string_idx.end)?;
        let top = parse_dict(&b, top_idx.items[0])?;
        let font_matrix0 = top.get(&1207).and_then(|v| v.first().copied()).unwrap_or(0.001);
        let cs_off = *top.get(&17).and_then(|v| v.first()).ok_or_else(|| err("no CharStrings"))? as usize;
        let char_strings = index(&b, cs_off)?;
        let mut subrs = Index { items: vec![], end: 0 };
        if let Some(p) = top.get(&18) {
            let (p_size, p_off) = (p[0] as usize, p[1] as usize);
            let priv_dict = parse_dict(&b, (p_off, p_off + p_size))?;
            if let Some(s) = priv_dict.get(&19) {
                subrs = index(&b, p_off + s[0] as usize)?;
            }
        }
        let (g_bias, l_bias) = (bias(gsubrs.items.len()), bias(subrs.items.len()));
        // JS: Math.round(1 / fontMatrix[0])
        let units_per_em = ((1.0 / font_matrix0) + 0.5).floor() as u32;
        Ok(CffFont { b, units_per_em, char_strings, subrs, gsubrs, g_bias, l_bias })
    }

    pub fn num_glyphs(&self) -> usize { self.char_strings.items.len() }

    /// runCharstring: None when the gid has no charstring (JS returns null).
    /// Malformed charstrings (bad subr index, unknown op, depth) return an
    /// error — the JS oracle would throw there.
    pub fn outline(&self, gid: u32) -> Result<Option<Vec<CffContour>>, FontError> {
        let Some(&cs) = self.char_strings.items.get(gid as usize) else { return Ok(None); };
        let mut st: Vec<f64> = Vec::new();
        let mut x = 0.0f64;
        let mut y = 0.0f64;
        let mut n_stems = 0usize;
        let mut width: Option<f64> = None;
        let mut contours: Vec<CffContour> = Vec::new();
        let mut cur: Option<CffContour> = None;
        self.exec(cs, 0, &mut st, &mut x, &mut y, &mut n_stems, &mut width, &mut contours, &mut cur, gid)?;
        if let Some(c) = cur.take() {
            if !c.segs.is_empty() { contours.push(c); }
        }
        Ok(Some(contours))
    }

    #[allow(clippy::too_many_arguments)]
    fn exec(&self, code: (usize, usize), depth: u32, st: &mut Vec<f64>, x: &mut f64, y: &mut f64,
            n_stems: &mut usize, width: &mut Option<f64>, contours: &mut Vec<CffContour>,
            cur: &mut Option<CffContour>, gid: u32) -> Result<(), FontError> {
        if depth > 10 { return Err(err("subr depth")); }
        let code = &self.b[code.0..code.1];

        macro_rules! move_to { ($nx:expr, $ny:expr) => {{
            if let Some(c) = cur.take() { if !c.segs.is_empty() { contours.push(c); } }
            *cur = Some(CffContour { sx: $nx, sy: $ny, segs: Vec::new() });
        }}; }
        macro_rules! line_to { ($nx:expr, $ny:expr) => {{
            if let Some(c) = cur.as_mut() { c.segs.push(CffSeg::Line { x: $nx, y: $ny }); }
        }}; }
        macro_rules! curve_to { ($c1x:expr, $c1y:expr, $c2x:expr, $c2y:expr, $nx:expr, $ny:expr) => {{
            if let Some(c) = cur.as_mut() { c.segs.push(CffSeg::Cubic { c1x: $c1x, c1y: $c1y, c2x: $c2x, c2y: $c2y, x: $nx, y: $ny }); }
        }}; }
        // rrcurveto step, shared by ops 8/24/25 (mirrors the JS `rr` helper)
        macro_rules! rr { ($k:expr) => {{
            let k = $k;
            let c1x = *x + st[k]; let c1y = *y + st[k + 1];
            let c2x = c1x + st[k + 2]; let c2y = c1y + st[k + 3];
            *x = c2x + st[k + 4]; *y = c2y + st[k + 5];
            curve_to!(c1x, c1y, c2x, c2y, *x, *y);
        }}; }

        let mut i = 0usize;
        while i < code.len() {
            let b0 = code[i];
            if b0 >= 32 || b0 == 28 {
                if b0 == 28 { st.push(i16be(code, i + 1)); i += 3; }
                else if b0 <= 246 { st.push(b0 as f64 - 139.0); i += 1; }
                else if b0 <= 250 { st.push((b0 as f64 - 247.0) * 256.0 + code[i + 1] as f64 + 108.0); i += 2; }
                else if b0 <= 254 { st.push(-(b0 as f64 - 251.0) * 256.0 - code[i + 1] as f64 - 108.0); i += 2; }
                else { st.push(i32be(code, i + 1) / 65536.0); i += 5; } // 16.16
                continue;
            }
            i += 1;
            match b0 {
                1 | 3 | 18 | 23 => { // h/vstem(hm)
                    if width.is_none() && st.len() % 2 == 1 { *width = Some(st.remove(0)); }
                    *n_stems += st.len() >> 1; st.clear();
                }
                19 | 20 => { // hintmask/cntrmask
                    if width.is_none() && st.len() % 2 == 1 { *width = Some(st.remove(0)); }
                    *n_stems += st.len() >> 1; st.clear();
                    i += (*n_stems + 7) >> 3;
                }
                21 => { // rmoveto
                    if width.is_none() && st.len() > 2 { *width = Some(st.remove(0)); }
                    *x += st[0]; *y += st[1]; move_to!(*x, *y); st.clear();
                }
                22 => { // hmoveto
                    if width.is_none() && st.len() > 1 { *width = Some(st.remove(0)); }
                    *x += st[0]; move_to!(*x, *y); st.clear();
                }
                4 => { // vmoveto
                    if width.is_none() && st.len() > 1 { *width = Some(st.remove(0)); }
                    *y += st[0]; move_to!(*x, *y); st.clear();
                }
                5 => { // rlineto
                    let mut k = 0;
                    while k + 1 < st.len() { *x += st[k]; *y += st[k + 1]; line_to!(*x, *y); k += 2; }
                    st.clear();
                }
                6 | 7 => { // hlineto / vlineto (alternating)
                    let mut horiz = b0 == 6;
                    for k in 0..st.len() {
                        if horiz { *x += st[k]; } else { *y += st[k]; }
                        line_to!(*x, *y);
                        horiz = !horiz;
                    }
                    st.clear();
                }
                8 => { // rrcurveto
                    let mut k = 0;
                    while k + 5 < st.len() { rr!(k); k += 6; }
                    st.clear();
                }
                24 => { // rcurveline
                    let mut k = 0usize;
                    while (k as isize) + 5 < st.len() as isize - 2 { rr!(k); k += 6; }
                    *x += st[k]; *y += st[k + 1]; line_to!(*x, *y); st.clear();
                }
                25 => { // rlinecurve
                    let mut k = 0usize;
                    while (k as isize) + 1 < st.len() as isize - 6 { *x += st[k]; *y += st[k + 1]; line_to!(*x, *y); k += 2; }
                    rr!(k); st.clear();
                }
                26 => { // vvcurveto
                    let mut k = 0usize;
                    let mut dx1 = 0.0f64;
                    if st.len() % 4 == 1 { dx1 = st[0]; k = 1; }
                    while k + 3 < st.len() {
                        let c1x = *x + dx1; let c1y = *y + st[k];
                        let c2x = c1x + st[k + 1]; let c2y = c1y + st[k + 2];
                        *x = c2x; *y = c2y + st[k + 3];
                        curve_to!(c1x, c1y, c2x, c2y, *x, *y);
                        dx1 = 0.0; k += 4;
                    }
                    st.clear();
                }
                27 => { // hhcurveto
                    let mut k = 0usize;
                    let mut dy1 = 0.0f64;
                    if st.len() % 4 == 1 { dy1 = st[0]; k = 1; }
                    while k + 3 < st.len() {
                        let c1x = *x + st[k]; let c1y = *y + dy1;
                        let c2x = c1x + st[k + 1]; let c2y = c1y + st[k + 2];
                        *x = c2x + st[k + 3]; *y = c2y;
                        curve_to!(c1x, c1y, c2x, c2y, *x, *y);
                        dy1 = 0.0; k += 4;
                    }
                    st.clear();
                }
                30 | 31 => { // vhcurveto / hvcurveto
                    let mut horiz = b0 == 31;
                    let mut k = 0usize;
                    while k + 3 < st.len() {
                        let last = k + 8 > st.len(); // 5-arg tail?
                        let extra = if last && k + 5 == st.len() { st[k + 4] } else { 0.0 };
                        let (c1x, c1y, c2x, c2y);
                        if horiz {
                            c1x = *x + st[k]; c1y = *y;
                            c2x = c1x + st[k + 1]; c2y = c1y + st[k + 2];
                            *y = c2y + st[k + 3]; *x = c2x + extra;
                        } else {
                            c1x = *x; c1y = *y + st[k];
                            c2x = c1x + st[k + 1]; c2y = c1y + st[k + 2];
                            *x = c2x + st[k + 3]; *y = c2y + extra;
                        }
                        curve_to!(c1x, c1y, c2x, c2y, *x, *y);
                        horiz = !horiz; k += 4;
                    }
                    st.clear();
                }
                10 => { // callsubr
                    let idx = st.pop().ok_or_else(|| err("empty stack callsubr"))? + self.l_bias;
                    let item = *self.subrs.items.get(idx as usize).ok_or_else(|| err(format!("subr {idx} gid {gid}")))?;
                    self.exec(item, depth + 1, st, x, y, n_stems, width, contours, cur, gid)?;
                }
                29 => { // callgsubr
                    let idx = st.pop().ok_or_else(|| err("empty stack callgsubr"))? + self.g_bias;
                    let item = *self.gsubrs.items.get(idx as usize).ok_or_else(|| err(format!("gsubr {idx} gid {gid}")))?;
                    self.exec(item, depth + 1, st, x, y, n_stems, width, contours, cur, gid)?;
                }
                11 => return Ok(()), // return
                14 => { // endchar — NOTE: like the JS oracle, this only exits
                    // the CURRENT exec frame; an outer frame keeps going.
                    if width.is_none() && st.len() % 2 == 1 { *width = Some(st.remove(0)); }
                    if let Some(c) = cur.take() { if !c.segs.is_empty() { contours.push(c); } }
                    return Ok(());
                }
                _ => return Err(err(format!("charstring op {b0} gid {gid}"))),
            }
        }
        Ok(())
    }
}
