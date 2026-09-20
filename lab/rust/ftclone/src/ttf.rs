// ttf — port of ../../../ftclone/ttf.mjs: cmap(4) lookup + glyf outlines
// (simple & composite) in font units, y-up. Raw TT points only — implicit
// conic midpoints are computed by the RASTER side after 26.6 scaling,
// exactly like ftclone.mjs.
use crate::{err, FontError, RawPt};
use std::collections::HashMap;

fn u16be(b: &[u8], o: usize) -> u32 { ((b[o] as u32) << 8) | b[o + 1] as u32 }
fn i16be(b: &[u8], o: usize) -> i32 { (u16be(b, o) as i16) as i32 }
fn u32be(b: &[u8], o: usize) -> u32 {
    ((b[o] as u32) << 24) | ((b[o + 1] as u32) << 16) | ((b[o + 2] as u32) << 8) | b[o + 3] as u32
}

struct Table { off: usize, }

pub struct TtfFont {
    b: Vec<u8>,
    pub units_per_em: u32,
    loc_format: i32,
    num_hm: usize,
    loca: usize,
    glyf: usize,
    hmtx: usize,
    cmap_sub: usize,
    seg_x2: usize,
}

#[derive(Clone, Copy, Default)]
pub struct Metrics { pub adv: i32, pub lsb: i32 }

impl TtfFont {
    pub fn load(path: &std::path::Path) -> Result<Self, FontError> {
        let b = std::fs::read(path)?;
        if b.len() < 12 { return Err(err("too short")); }
        let num_tables = u16be(&b, 4) as usize;
        let mut tables: HashMap<[u8; 4], Table> = HashMap::new();
        for i in 0..num_tables {
            let o = 12 + 16 * i;
            if o + 16 > b.len() { return Err(err("table dir truncated")); }
            let mut tag = [0u8; 4];
            tag.copy_from_slice(&b[o..o + 4]);
            tables.insert(tag, Table { off: u32be(&b, o + 8) as usize });
        }
        let t = |tag: &[u8; 4]| tables.get(tag).map(|t| t.off).ok_or_else(|| err(format!("missing table {}", String::from_utf8_lossy(tag))));
        let head = t(b"head")?;
        let units_per_em = u16be(&b, head + 18);
        let loc_format = i16be(&b, head + 50);
        let num_hm = u16be(&b, t(b"hhea")? + 34) as usize;
        let loca = t(b"loca")?;
        let glyf = t(b"glyf")?;
        let hmtx = t(b"hmtx")?;
        let cm = t(b"cmap")?;
        // cmap: prefer 3/1 format 4 (same preference walk as ttf.mjs)
        let n_sub = u16be(&b, cm + 2) as usize;
        let mut sub: Option<usize> = None;
        for i in 0..n_sub {
            let o = cm + 4 + 8 * i;
            let pid = u16be(&b, o);
            let eid = u16be(&b, o + 2);
            let soff = u32be(&b, o + 4) as usize;
            if (pid == 3 && (eid == 1 || eid == 10)) || pid == 0 {
                sub = Some(cm + soff);
                if pid == 3 && eid == 1 { break; }
            }
        }
        let sub = sub.ok_or_else(|| err("no usable cmap subtable"))?;
        if u16be(&b, sub) != 4 { return Err(err(format!("cmap format {} unsupported", u16be(&b, sub)))); }
        let seg_x2 = u16be(&b, sub + 6) as usize;
        Ok(TtfFont { b, units_per_em, loc_format, num_hm, loca, glyf, hmtx, cmap_sub: sub, seg_x2 })
    }

    pub fn gid_for(&self, cp: u32) -> u32 {
        let b = &self.b;
        let end_o = self.cmap_sub + 14;
        let start_o = end_o + self.seg_x2 + 2;
        let delta_o = start_o + self.seg_x2;
        let range_o = delta_o + self.seg_x2;
        let mut s = 0;
        while s < self.seg_x2 {
            if cp <= u16be(b, end_o + s) {
                let start = u16be(b, start_o + s);
                if cp < start { return 0; }
                let ro = u16be(b, range_o + s) as usize;
                if ro == 0 {
                    return ((cp as i32 + i16be(b, delta_o + s)) & 0xFFFF) as u32;
                }
                let gi = u16be(b, range_o + s + ro + (cp - start) as usize * 2);
                return if gi == 0 { 0 } else { ((gi as i32 + i16be(b, delta_o + s)) & 0xFFFF) as u32 };
            }
            s += 2;
        }
        0
    }

    fn loca_off(&self, gid: u32) -> (usize, usize) {
        let b = &self.b;
        let lo = self.loca;
        if self.loc_format != 0 {
            (u32be(b, lo + 4 * gid as usize) as usize, u32be(b, lo + 4 * gid as usize + 4) as usize)
        } else {
            (2 * u16be(b, lo + 2 * gid as usize) as usize, 2 * u16be(b, lo + 2 * gid as usize + 2) as usize)
        }
    }

    pub fn metrics(&self, gid: u32) -> Metrics {
        let b = &self.b;
        let hm = self.hmtx;
        let gid = gid as usize;
        let i = gid.min(self.num_hm - 1);
        Metrics {
            adv: u16be(b, hm + 4 * i) as i32,
            lsb: if gid < self.num_hm { i16be(b, hm + 4 * gid + 2) } else { i16be(b, hm + 4 * self.num_hm + 2 * (gid - self.num_hm)) },
        }
    }

    /// Raw TT points per contour ({x,y,on}), composites resolved with the
    /// exact float transform order of ttf.mjs: m0*px + m2*py + dx.
    pub fn glyph_points(&self, gid: u32, depth: u32) -> Vec<Vec<RawPt>> {
        if depth > 5 { return vec![]; }
        let b = &self.b;
        let (o0, o1) = self.loca_off(gid);
        if o1 <= o0 { return vec![]; }
        let g = self.glyf + o0;
        let nc = i16be(b, g);
        if nc >= 0 {
            let nc = nc as usize;
            let mut end_pts = Vec::with_capacity(nc);
            for i in 0..nc { end_pts.push(u16be(b, g + 10 + 2 * i) as usize); }
            let n_pts = end_pts[nc - 1] + 1;
            let mut o = g + 10 + 2 * nc;
            o += 2 + u16be(b, o) as usize; // instructions
            let mut flags: Vec<u8> = Vec::with_capacity(n_pts);
            while flags.len() < n_pts {
                let f = b[o]; o += 1;
                flags.push(f);
                if f & 8 != 0 {
                    let mut r = b[o]; o += 1;
                    while r > 0 { flags.push(f); r -= 1; }
                }
            }
            let mut xs = Vec::with_capacity(n_pts);
            let mut v: i32 = 0;
            for &f in &flags {
                if f & 2 != 0 { let d = b[o] as i32; o += 1; v += if f & 16 != 0 { d } else { -d }; }
                else if f & 16 == 0 { v += i16be(b, o); o += 2; }
                xs.push(v);
            }
            let mut ys = Vec::with_capacity(n_pts);
            v = 0;
            for &f in &flags {
                if f & 4 != 0 { let d = b[o] as i32; o += 1; v += if f & 32 != 0 { d } else { -d }; }
                else if f & 32 == 0 { v += i16be(b, o); o += 2; }
                ys.push(v);
            }
            let mut contours = Vec::with_capacity(nc);
            let mut s = 0usize;
            for &e in &end_pts {
                let mut pts = Vec::with_capacity(e + 1 - s);
                for i in s..=e {
                    pts.push(RawPt { x: xs[i] as f64, y: ys[i] as f64, on: flags[i] & 1 != 0 });
                }
                contours.push(pts);
                s = e + 1;
            }
            return contours;
        }
        // composite
        let mut out = Vec::new();
        let mut o = g + 10;
        loop {
            let flags = u16be(b, o);
            let gi = u16be(b, o + 2);
            o += 4;
            let (a1, a2): (i32, i32);
            if flags & 1 != 0 { a1 = i16be(b, o); a2 = i16be(b, o + 2); o += 4; }
            else { a1 = (b[o] as i8) as i32; a2 = (b[o + 1] as i8) as i32; o += 2; }
            let mut m = [1.0f64, 0.0, 0.0, 1.0];
            if flags & 8 != 0 {
                let s2 = i16be(b, o) as f64 / 16384.0;
                m = [s2, 0.0, 0.0, s2]; o += 2;
            } else if flags & 0x40 != 0 {
                m = [i16be(b, o) as f64 / 16384.0, 0.0, 0.0, i16be(b, o + 2) as f64 / 16384.0]; o += 4;
            } else if flags & 0x80 != 0 {
                m = [i16be(b, o) as f64 / 16384.0, i16be(b, o + 2) as f64 / 16384.0,
                     i16be(b, o + 4) as f64 / 16384.0, i16be(b, o + 6) as f64 / 16384.0]; o += 8;
            }
            let (dx, dy) = if flags & 2 != 0 { (a1 as f64, a2 as f64) } else { (0.0, 0.0) }; // ARGS_ARE_XY_VALUES
            for c in self.glyph_points(gi, depth + 1) {
                out.push(c.iter().map(|p| RawPt {
                    x: m[0] * p.x + m[2] * p.y + dx,
                    y: m[1] * p.x + m[3] * p.y + dy,
                    on: p.on,
                }).collect());
            }
            if flags & 0x20 == 0 { break; }
        }
        out
    }

    /// rawOutline: None when the cp has no glyph (gid 0), like ttf.mjs.
    pub fn raw_outline(&self, cp: u32) -> Option<(Vec<Vec<RawPt>>, Metrics, u32)> {
        let gid = self.gid_for(cp);
        if gid == 0 { return None; }
        Some((self.glyph_points(gid, 0), self.metrics(gid), gid))
    }
}
