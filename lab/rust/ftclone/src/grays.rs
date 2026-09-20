// grays — port of the Raster + FTClone pipeline in ../../../ftclone/ftclone.mjs
// (FreeType 2.13 smooth rasterizer, FT_INT64 build, as mupdf 1.28 wasm runs
// it — via the certified JS clone, whose f64 arithmetic is the byte law).
//
// Differences from the JS structure, all proven output-identical:
//  - cells live in a dense (W+1)×H arena with epoch stamps instead of
//    per-row Maps (accumulation is commutative; the sweep visits cells in
//    ascending x exactly like the JS sort; a touched-but-zero cell changes
//    no output byte);
//  - outlines are SCALED ONCE per (cp, em64x, em64y) and only translated by
//    the pen per phase (implicit conic midpoints commute with integer
//    translation: trunc((a+b)/2 + p) = trunc((a+b)/2) + p).
use crate::fixed::*;
use crate::{cff::CffFont, ttf::TtfFont, CffSeg, FontError};

use std::collections::HashMap;
use std::path::Path;

// ---------------------------------------------------------------- raster ---

pub struct Raster {
    w: i32,
    h: i32,
    stride: i32,
    cover: Vec<i32>,
    area: Vec<i32>,
    stamp: Vec<u32>,
    epoch: u32,
    cur: i32, // cell index, or -1 = dumpster
    x: i32,   // 26.8
    y: i32,   // 26.8
    arc: Vec<(i32, i32)>, // cubic bezier stack scratch
}

/// Coarse ink bbox: min/max of every out byte >= 1 the sweep wrote.
/// (x0, x1, y0, y1) inclusive; None when the render is blank.
pub type Coarse = Option<(i32, i32, i32, i32)>;

impl Raster {
    pub fn new() -> Self {
        Raster { w: 0, h: 0, stride: 0, cover: vec![], area: vec![], stamp: vec![], epoch: 0, cur: -1, x: 0, y: 0, arc: vec![] }
    }

    pub fn reset(&mut self, w: i32, h: i32) {
        if w != self.w || h != self.h {
            self.w = w;
            self.h = h;
            self.stride = w + 1;
            let n = (self.stride * h) as usize;
            self.cover = vec![0; n];
            self.area = vec![0; n];
            self.stamp = vec![0; n];
            self.epoch = 0;
        }
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            self.stamp.fill(0);
            self.epoch = 1;
        }
        self.cur = -1;
        self.x = 0;
        self.y = 0;
    }

    #[inline]
    fn set_cell(&mut self, ex: i32, ey: i32) {
        if ey < 0 || ey >= self.h || ex >= self.w {
            self.cur = -1;
            return;
        }
        let ex = ex.max(-1);
        let idx = (ey * self.stride + ex + 1) as usize;
        if self.stamp[idx] != self.epoch {
            self.stamp[idx] = self.epoch;
            self.cover[idx] = 0;
            self.area[idx] = 0;
        }
        self.cur = idx as i32;
    }

    #[inline]
    fn integrate(&mut self, a: i32, b: i32) {
        if self.cur >= 0 {
            let i = self.cur as usize;
            self.cover[i] += a;
            self.area[i] += a * b;
        }
    }

    pub fn move_to(&mut self, x: i32, y: i32) {
        // 26.8 coords
        self.set_cell(trunc8(x), trunc8(y));
        self.x = x;
        self.y = y;
    }

    // gray_render_line, FT_INT64 variant (prod walker)
    pub fn line_to(&mut self, to_x: i32, to_y: i32) {
        let mut ey1 = trunc8(self.y);
        let ey2 = trunc8(to_y);
        if (ey1 >= self.h && ey2 >= self.h) || (ey1 < 0 && ey2 < 0) {
            self.x = to_x;
            self.y = to_y;
            return;
        }
        let mut ex1 = trunc8(self.x);
        let ex2 = trunc8(to_x);
        let mut fx1 = fract8(self.x);
        let mut fy1 = fract8(self.y);
        let mut fx2;
        let fy2_final;
        let dx = to_x - self.x;
        let dy = to_y - self.y;

        if ex1 == ex2 && ey1 == ey2 {
            // inside one cell
        } else if dy == 0 {
            self.set_cell(ex2, ey2);
            self.x = to_x;
            self.y = to_y;
            return;
        } else if dx == 0 {
            if dy > 0 {
                loop {
                    let fy2 = ONE_PIXEL;
                    self.integrate(fy2 - fy1, fx1 * 2);
                    fy1 = 0;
                    ey1 += 1;
                    self.set_cell(ex1, ey1);
                    if ey1 == ey2 { break; }
                }
            } else {
                loop {
                    let fy2 = 0;
                    self.integrate(fy2 - fy1, fx1 * 2);
                    fy1 = ONE_PIXEL;
                    ey1 -= 1;
                    self.set_cell(ex1, ey1);
                    if ey1 == ey2 { break; }
                }
            }
        } else {
            let mut prod = dx * fy1 - dy * fx1;
            let dxr = if ex1 != ex2 { recip32(dx) } else { 0.0 }; // trunc(0xFFFFFFFF/dx)
            let dyr = if ey1 != ey2 { recip32(dy) } else { 0.0 };
            loop {
                if prod - dx * ONE_PIXEL > 0 && prod <= 0 {
                    // left
                    fx2 = 0;
                    let fy2 = udiv(-prod as f64, -dxr);
                    prod -= dy * ONE_PIXEL;
                    self.integrate(fy2 - fy1, fx1 + fx2);
                    fx1 = ONE_PIXEL;
                    fy1 = fy2;
                    ex1 -= 1;
                } else if prod - dx * ONE_PIXEL + dy * ONE_PIXEL > 0 && prod - dx * ONE_PIXEL <= 0 {
                    // up
                    prod -= dx * ONE_PIXEL;
                    fx2 = udiv(-prod as f64, dyr);
                    let fy2 = ONE_PIXEL;
                    self.integrate(fy2 - fy1, fx1 + fx2);
                    fx1 = fx2;
                    fy1 = 0;
                    ey1 += 1;
                } else if prod + dy * ONE_PIXEL >= 0 && prod - dx * ONE_PIXEL + dy * ONE_PIXEL <= 0 {
                    // right
                    prod += dy * ONE_PIXEL;
                    fx2 = ONE_PIXEL;
                    let fy2 = udiv(prod as f64, dxr);
                    self.integrate(fy2 - fy1, fx1 + fx2);
                    fx1 = 0;
                    fy1 = fy2;
                    ex1 += 1;
                } else {
                    // down
                    fx2 = udiv(prod as f64, -dyr);
                    let fy2 = 0;
                    prod += dx * ONE_PIXEL;
                    self.integrate(fy2 - fy1, fx1 + fx2);
                    fx1 = fx2;
                    fy1 = ONE_PIXEL;
                    ey1 -= 1;
                }
                self.set_cell(ex1, ey1);
                if ex1 == ex2 && ey1 == ey2 { break; }
            }
        }
        fx2 = fract8(to_x);
        fy2_final = fract8(to_y);
        self.integrate(fy2_final - fy1, fx1 + fx2);
        self.x = to_x;
        self.y = to_y;
    }

    // gray_render_cubic + gray_split_cubic. controls/to in 26.6!
    pub fn cubic_to(&mut self, c1x6: i32, c1y6: i32, c2x6: i32, c2y6: i32, tx6: i32, ty6: i32) {
        let mut a = std::mem::take(&mut self.arc);
        a.clear();
        a.resize(16 * 3 + 1, (0, 0));
        a[0] = (upscale(tx6), upscale(ty6));
        a[1] = (upscale(c2x6), upscale(c2y6));
        a[2] = (upscale(c1x6), upscale(c1y6));
        a[3] = (self.x, self.y);
        let h = self.h;
        let (t0, t1, t2, t3) = (trunc8(a[0].1), trunc8(a[1].1), trunc8(a[2].1), trunc8(a[3].1));
        if (t0 >= h && t1 >= h && t2 >= h && t3 >= h) || (t0 < 0 && t1 < 0 && t2 < 0 && t3 < 0) {
            self.x = a[0].0;
            self.y = a[0].1;
            self.arc = a;
            return;
        }
        fn split(a: &mut [(i32, i32)], i: usize) {
            a[i + 6].0 = a[i + 3].0;
            let (mut sa, sb, mut sc) = (a[i].0 + a[i + 1].0, a[i + 1].0 + a[i + 2].0, a[i + 2].0 + a[i + 3].0);
            a[i + 5].0 = sc >> 1;
            sc += sb;
            a[i + 4].0 = sc >> 2;
            a[i + 1].0 = sa >> 1;
            sa += sb;
            a[i + 2].0 = sa >> 2;
            a[i + 3].0 = (sa + sc) >> 3;
            a[i + 6].1 = a[i + 3].1;
            let (mut sa, sb, mut sc) = (a[i].1 + a[i + 1].1, a[i + 1].1 + a[i + 2].1, a[i + 2].1 + a[i + 3].1);
            a[i + 5].1 = sc >> 1;
            sc += sb;
            a[i + 4].1 = sc >> 2;
            a[i + 1].1 = sa >> 1;
            sa += sb;
            a[i + 2].1 = sa >> 2;
            a[i + 3].1 = (sa + sc) >> 3;
        }
        let mut ai = 0usize;
        loop {
            if (2 * a[ai].0 - 3 * a[ai + 1].0 + a[ai + 3].0).abs() > ONE_PIXEL / 2
                || (2 * a[ai].1 - 3 * a[ai + 1].1 + a[ai + 3].1).abs() > ONE_PIXEL / 2
                || (a[ai].0 - 3 * a[ai + 2].0 + 2 * a[ai + 3].0).abs() > ONE_PIXEL / 2
                || (a[ai].1 - 3 * a[ai + 2].1 + 2 * a[ai + 3].1).abs() > ONE_PIXEL / 2
            {
                split(&mut a, ai);
                ai += 3;
                if ai + 6 >= a.len() {
                    let n = a.len();
                    a.resize(n + 6, (0, 0));
                }
                continue;
            }
            let (px, py) = a[ai];
            self.line_to(px, py);
            if ai == 0 { break; }
            ai -= 3;
        }
        self.arc = a;
    }

    // gray_render_conic, DDA (FT_INT64) variant. control/to in 26.6!
    pub fn conic_to(&mut self, cx6: i32, cy6: i32, tx6: i32, ty6: i32) {
        let p0x = self.x;
        let p0y = self.y;
        let p1x = upscale(cx6);
        let p1y = upscale(cy6);
        let p2x = upscale(tx6);
        let p2y = upscale(ty6);
        if (trunc8(p0y) >= self.h && trunc8(p1y) >= self.h && trunc8(p2y) >= self.h)
            || (trunc8(p0y) < 0 && trunc8(p1y) < 0 && trunc8(p2y) < 0)
        {
            self.x = p2x;
            self.y = p2y;
            return;
        }
        let bx = p1x - p0x;
        let by = p1y - p0y;
        let ax = p2x - p1x - bx;
        let ay = p2y - p1y - by;
        let mut dx = ax.abs();
        let dyv = ay.abs();
        if dx < dyv { dx = dyv; }
        if dx <= ONE_PIXEL / 4 {
            self.line_to(p2x, p2y);
            return;
        }
        let mut shift = 16i32;
        loop {
            dx >>= 2;
            shift -= 1;
            if dx <= ONE_PIXEL / 4 { break; }
        }
        let mut count = 0x10000u32 >> shift;

        // all intermediates stay < 2^53, so JS f64 arithmetic was exact and
        // i64 reproduces it bit-for-bit; floor(px/2^32) = arithmetic >> 32
        let mut rx = (ax as i64) << (shift + shift);
        let mut ry = (ay as i64) << (shift + shift);
        let mut qx = ((bx as i64) << (shift + 17)) + rx;
        let mut qy = ((by as i64) << (shift + 17)) + ry;
        rx *= 2;
        ry *= 2;
        let mut px = (p0x as i64) << 32;
        let mut py = (p0y as i64) << 32;
        loop {
            px += qx;
            py += qy;
            qx += rx;
            qy += ry;
            self.line_to((px >> 32) as i32, (py >> 32) as i32);
            count -= 1;
            if count == 0 { break; }
        }
    }

    // gray_sweep, nonzero rule — writes coverage into out (out MUST be
    // zeroed by the caller), returns the coarse bbox of nonzero writes.
    pub fn sweep(&mut self, out: &mut [u8]) -> Coarse {
        #[inline]
        fn fill_rule(v: i64) -> u8 {
            let mut c = (v as i32) >> 9; // JS ToInt32 wrap, then >> (PIXEL_BITS*2+1-8)
            if c & i32::MIN != 0 { c = !c; }
            if c > 255 { c = 255; }
            c as u8
        }
        let (mut bx0, mut bx1, mut by0, mut by1) = (i32::MAX, -1, i32::MAX, -1);
        for y in 0..self.h {
            let row = y * self.stride;
            let mut x = 0i32;
            let mut cover: i64 = 0;
            for ex in -1..self.w {
                let idx = (row + ex + 1) as usize;
                if self.stamp[idx] != self.epoch { continue; }
                if cover != 0 && ex > x {
                    let cvg = fill_rule(cover);
                    for i in x..ex { out[(y * self.w + i) as usize] = cvg; }
                    if cvg >= 1 {
                        if x < bx0 { bx0 = x; }
                        if ex - 1 > bx1 { bx1 = ex - 1; }
                        if y < by0 { by0 = y; }
                        if y > by1 { by1 = y; }
                    }
                }
                cover += self.cover[idx] as i64 * (ONE_PIXEL as i64 * 2);
                let area_v = cover - self.area[idx] as i64;
                if area_v != 0 && ex >= 0 {
                    let cvg = fill_rule(area_v);
                    out[(y * self.w + ex) as usize] = cvg;
                    if cvg >= 1 {
                        if ex < bx0 { bx0 = ex; }
                        if ex > bx1 { bx1 = ex; }
                        if y < by0 { by0 = y; }
                        if y > by1 { by1 = y; }
                    }
                }
                x = ex + 1;
            }
            if cover != 0 {
                let cvg = fill_rule(cover);
                for i in x..self.w { out[(y * self.w + i) as usize] = cvg; }
                if cvg >= 1 && x < self.w {
                    if x < bx0 { bx0 = x; }
                    if self.w - 1 > bx1 { bx1 = self.w - 1; }
                    if y < by0 { by0 = y; }
                    if y > by1 { by1 = y; }
                }
            }
        }
        if bx1 < 0 { None } else { Some((bx0, bx1, by0, by1)) }
    }
}

impl Default for Raster {
    fn default() -> Self { Self::new() }
}

/// Exact equivalent of the JS bboxAt(cov, min) full-frame scan, restricted
/// to the coarse box (which contains every byte >= 1, hence every byte >=
/// min). Returns (x0, y0, w, h).
pub fn bbox_at(cov: &[u8], w: i32, coarse: Coarse, min: u8) -> Option<(i32, i32, i32, i32)> {
    let (cx0, cx1, cy0, cy1) = coarse?;
    let (mut x0, mut x1, mut y0, mut y1) = (i32::MAX, -1, i32::MAX, -1);
    for y in cy0..=cy1 {
        for x in cx0..=cx1 {
            if cov[(y * w + x) as usize] >= min {
                if x < x0 { x0 = x; }
                if x > x1 { x1 = x; }
                if y < y0 { y0 = y; }
                if y > y1 { y1 = y; }
            }
        }
    }
    if x1 < 0 { None } else { Some((x0, y0, x1 - x0 + 1, y1 - y0 + 1)) }
}

// ------------------------------------------------------------------ face ---

pub enum FontKind {
    Ttf(TtfFont),
    Cff(CffFont),
}

pub struct Face {
    pub kind: FontKind,
    pub upm: f64,
    pub scale16: f64,
    pub gid_map: Option<HashMap<u32, u32>>,
}

/// Outline scaled to 26.6 for one (cp, em64x, em64y) — pen NOT applied.
/// This is the hoisted invariant: per phase only (px64, py64) is added.
pub enum Scaled {
    Ttf(Vec<Vec<(i32, i32, bool)>>),
    Cff(Vec<ScaledCffContour>),
}

pub struct ScaledCffContour {
    pub sx: i32,
    pub sy: i32,
    pub segs: Vec<ScaledSeg>,
}

pub enum ScaledSeg {
    Line(i32, i32),
    Cubic(i32, i32, i32, i32, i32, i32),
}

impl Face {
    pub fn load(path: &Path) -> Result<Self, FontError> {
        let is_cff = path.extension().map(|e| e.eq_ignore_ascii_case("cff")).unwrap_or(false);
        let (kind, upm) = if is_cff {
            let f = CffFont::load(path)?;
            let upm = f.units_per_em as f64;
            (FontKind::Cff(f), upm)
        } else {
            let f = TtfFont::load(path)?;
            let upm = f.units_per_em as f64;
            (FontKind::Ttf(f), upm)
        };
        // FT loads at char size 65536/64 = 1024pt @72dpi
        let scale16 = divfix(65536.0, upm);
        Ok(Face { kind, upm, scale16, gid_map: None })
    }

    pub fn is_cff(&self) -> bool { matches!(self.kind, FontKind::Cff(_)) }

    /// Scale cp's outline for (em64x, em64y); None = "no glyph" (JS null).
    pub fn scale(&self, cp: u32, em64x: f64, em64y: f64) -> Option<Scaled> {
        match &self.kind {
            FontKind::Ttf(f) => {
                let (contours, _m, _gid) = f.raw_outline(cp)?;
                // em64 may be fractional in 1/32 steps: mulfix(p*32, em64)
                // === mulfix(p, em64*32) — the ×32 scale trick
                let em32x = js_round_pos(em64x * 32.0);
                let em32y = -js_round_pos(em64y * 32.0);
                let mut out = Vec::with_capacity(contours.len());
                for raw in &contours {
                    if raw.len() < 2 { continue; }
                    out.push(raw.iter().map(|p| {
                        (mulfix(p.x, em32x) as i32, mulfix(p.y, em32y) as i32, p.on)
                    }).collect());
                }
                Some(Scaled::Ttf(out))
            }
            FontKind::Cff(f) => {
                let gid = match &self.gid_map {
                    Some(m) => *m.get(&cp)?,
                    None => cp,
                };
                let contours = f.outline(gid).ok()??;
                let pre = |u: f64| mulfix(u, self.scale16);
                let tx = |u: f64| mulfix(pre(u), em64x) as i32;
                let ty = |v: f64| mulfix(pre(v), -em64y) as i32;
                let mut out = Vec::with_capacity(contours.len());
                for c in &contours {
                    let mut segs = Vec::with_capacity(c.segs.len());
                    for s in &c.segs {
                        match *s {
                            CffSeg::Line { x, y } => segs.push(ScaledSeg::Line(tx(x), ty(y))),
                            CffSeg::Cubic { c1x, c1y, c2x, c2y, x, y } => segs.push(ScaledSeg::Cubic(
                                tx(c1x), ty(c1y), tx(c2x), ty(c2y), tx(x), ty(y),
                            )),
                        }
                    }
                    out.push(ScaledCffContour { sx: tx(c.sx), sy: ty(c.sy), segs });
                }
                Some(Scaled::Cff(out))
            }
        }
    }
}

/// Render a scaled outline at pen (px64, py64) into `out` (w*h, zeroed
/// here). Returns the coarse ink bbox. Byte-identical to FTClone.coverage.
pub fn render(scaled: &Scaled, px64: i32, py64: i32, w: i32, h: i32, raster: &mut Raster, out: &mut [u8]) -> Coarse {
    raster.reset(w, h);
    match scaled {
        Scaled::Ttf(contours) => {
            let half = |a: i32, b: i32| (a + b) / 2; // Math.trunc((a+b)/2)
            for pts in contours {
                let limit0 = pts.len() - 1;
                let mut limit = limit0;
                let at = |i: usize| {
                    let p = pts[i];
                    (p.0 + px64, p.1 + py64, p.2)
                };
                let v_last = at(limit0);
                let mut v_start = at(0);
                let mut i: isize = 0;
                if !v_start.2 {
                    if v_last.2 {
                        v_start = v_last;
                        limit -= 1;
                    } else {
                        v_start = (half(v_start.0, v_last.0), half(v_start.1, v_last.1), true);
                    }
                    i -= 1;
                }
                raster.move_to(upscale(v_start.0), upscale(v_start.1));
                let mut closed_by_conic = false;
                while i < limit as isize {
                    i += 1;
                    let p = at(i as usize);
                    if p.2 {
                        raster.line_to(upscale(p.0), upscale(p.1));
                        continue;
                    }
                    let mut v_control = p;
                    let mut done = false;
                    while i < limit as isize {
                        i += 1;
                        let vec = at(i as usize);
                        if vec.2 {
                            raster.conic_to(v_control.0, v_control.1, vec.0, vec.1);
                            done = true;
                            break;
                        }
                        let v_middle = (half(v_control.0, vec.0), half(v_control.1, vec.1));
                        raster.conic_to(v_control.0, v_control.1, v_middle.0, v_middle.1);
                        v_control = vec;
                    }
                    if !done {
                        // ran out of points: close with conic to start
                        raster.conic_to(v_control.0, v_control.1, v_start.0, v_start.1);
                        closed_by_conic = true;
                        break;
                    }
                }
                if !closed_by_conic {
                    raster.line_to(upscale(v_start.0), upscale(v_start.1));
                }
            }
        }
        Scaled::Cff(contours) => {
            for c in contours {
                let sx = c.sx + px64;
                let sy = c.sy + py64;
                raster.move_to(upscale(sx), upscale(sy));
                for s in &c.segs {
                    match *s {
                        ScaledSeg::Line(x, y) => raster.line_to(upscale(x + px64), upscale(y + py64)),
                        ScaledSeg::Cubic(c1x, c1y, c2x, c2y, x, y) => raster.cubic_to(
                            c1x + px64, c1y + py64, c2x + px64, c2y + py64, x + px64, y + py64,
                        ),
                    }
                }
                raster.line_to(upscale(sx), upscale(sy)); // decompose closes every contour
            }
        }
    }
    out[..(w * h) as usize].fill(0);
    raster.sweep(out)
}
