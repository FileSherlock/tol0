// io — everything this engine reads or writes: the golden-fixture reader, the
// P5 pgm pair, font-path resolution, and the crash-safe checkpoint JSONL.
//
// **There is no zip/npz code here any more, and that is the whole reason
// `harvest` came across whole.** In the previous repo the Rust harvester had
// to stop at a clusters.json and hand off to a JS finisher, because targets
// were `.npz` and two deflate implementations do not agree byte for byte. The
// lab's one target format is now PGM + index.json (../../pgm.mjs) — an
// uncompressed container with nothing to disagree about — so the split, its
// finisher and the flate2 dependency all disappear.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

// ------------------------------------------------------------- fixtures ---

pub struct FixtureFont {
    pub path: String,
    pub is_cff: bool,
    pub gid_map: Vec<(u32, u32)>,
}

pub struct FixtureCase {
    pub font: usize,
    pub cp: u32,
    pub em64x: f64,
    pub em64y: f64,
    pub px64: i32,
    pub py64: i32,
    pub w: u16,
    pub h: u16,
    pub cov: Option<Vec<u8>>,
    /// per law: (x0, y0, w, h) of covBbox(cov, covMin[law]); None = blank
    pub boxes: Vec<Option<(i16, i16, i16, i16)>>,
}

pub struct Fixtures {
    pub laws: Vec<(String, [u8; 256], u8)>,
    pub fonts: Vec<FixtureFont>,
    pub cases: Vec<FixtureCase>,
}

struct Cur<'a> { b: &'a [u8], o: usize }
impl<'a> Cur<'a> {
    fn u8(&mut self) -> u8 { let v = self.b[self.o]; self.o += 1; v }
    fn u16(&mut self) -> u16 { let v = u16::from_le_bytes([self.b[self.o], self.b[self.o + 1]]); self.o += 2; v }
    fn i16(&mut self) -> i16 { self.u16() as i16 }
    fn u32(&mut self) -> u32 { let v = u32::from_le_bytes(self.b[self.o..self.o + 4].try_into().unwrap()); self.o += 4; v }
    fn i32(&mut self) -> i32 { self.u32() as i32 }
    fn f64(&mut self) -> f64 { let v = f64::from_le_bytes(self.b[self.o..self.o + 8].try_into().unwrap()); self.o += 8; v }
    fn bytes(&mut self, n: usize) -> &'a [u8] { let v = &self.b[self.o..self.o + n]; self.o += n; v }
}

pub fn read_fixtures(path: &Path) -> std::io::Result<Fixtures> {
    let data = std::fs::read(path)?;
    let mut c = Cur { b: &data, o: 0 };
    assert_eq!(c.bytes(8), b"HUNTFIX1", "bad fixture magic");
    let n_laws = c.u16() as usize;
    let mut laws = Vec::with_capacity(n_laws);
    for _ in 0..n_laws {
        let nl = c.u8() as usize;
        let name = String::from_utf8_lossy(c.bytes(nl)).into_owned();
        let mut lut = [0u8; 256];
        lut.copy_from_slice(c.bytes(256));
        let cov_min = c.u8();
        laws.push((name, lut, cov_min));
    }
    let n_fonts = c.u16() as usize;
    let mut fonts = Vec::with_capacity(n_fonts);
    for _ in 0..n_fonts {
        let pl = c.u16() as usize;
        let path = String::from_utf8_lossy(c.bytes(pl)).into_owned();
        let is_cff = c.u8() == 1;
        let n_gid = c.u32() as usize;
        let mut gid_map = Vec::with_capacity(n_gid);
        for _ in 0..n_gid { gid_map.push((c.u32(), c.u32())); }
        fonts.push(FixtureFont { path, is_cff, gid_map });
    }
    let n_cases = c.u32() as usize;
    let mut cases = Vec::with_capacity(n_cases);
    for _ in 0..n_cases {
        let font = c.u16() as usize;
        let cp = c.u32();
        let em64x = c.f64();
        let em64y = c.f64();
        let px64 = c.i32();
        let py64 = c.i32();
        let w = c.u16();
        let h = c.u16();
        let has_cov = c.u8() == 1;
        let (cov, boxes) = if has_cov {
            let cov = c.bytes(w as usize * h as usize).to_vec();
            let mut boxes = Vec::with_capacity(n_laws);
            for _ in 0..n_laws {
                let (x0, y0, bw, bh) = (c.i16(), c.i16(), c.i16(), c.i16());
                boxes.push(if bw < 0 { None } else { Some((x0, y0, bw, bh)) });
            }
            (Some(cov), boxes)
        } else {
            (None, vec![])
        };
        cases.push(FixtureCase { font, cp, em64x, em64y, px64, py64, w, h, cov, boxes });
    }
    Ok(Fixtures { laws, fonts, cases })
}

// ------------------------------------------------------------------ pgm ---

pub struct Pgm {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
}

pub fn read_pgm(path: &Path) -> std::io::Result<Pgm> {
    let b = std::fs::read(path)?;
    let bad = |m: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, m.to_string());
    let head = String::from_utf8_lossy(&b[..b.len().min(64)]).into_owned();
    let mut it = head.split_ascii_whitespace();
    if it.next() != Some("P5") { return Err(bad("not a P5 pgm")); }
    let w: usize = it.next().and_then(|s| s.parse().ok()).ok_or_else(|| bad("no width"))?;
    let h: usize = it.next().and_then(|s| s.parse().ok()).ok_or_else(|| bad("no height"))?;
    // header length = the four whitespace-delimited fields plus the SINGLE
    // whitespace byte after maxval; the pixel plane starts there and may
    // itself begin with a byte that looks like whitespace.
    let mut o = 0usize;
    for f in 0..4 {
        while o < b.len() && !b[o].is_ascii_whitespace() { o += 1; }
        if f < 3 { while o < b.len() && b[o].is_ascii_whitespace() { o += 1; } }
    }
    o += 1;
    if o + w * h > b.len() { return Err(bad("pgm truncated")); }
    Ok(Pgm { w, h, px: b[o..o + w * h].to_vec() })
}

/// Byte-for-byte the header ../../pgm.mjs `writePgm` emits.
pub fn write_pgm(path: &Path, w: i32, h: i32, px: &[u8]) -> std::io::Result<()> {
    let mut out = format!("P5\n{w} {h}\n255\n").into_bytes();
    out.extend_from_slice(px);
    std::fs::write(path, out)
}

// ------------------------------------------------------------ font paths ---

/// Resolve a bare font file name the way ../../families.mjs `face()` does.
///
/// METHOD rule 3 in code: Windows installs fonts PER USER as well as globally,
/// so a roster built from `C:/Windows/Fonts` alone is HALF the machine. That
/// gap once hid a face for a week. Both directories, plus the faces this repo
/// ships — and a miss returns None, which is a statement about this machine
/// and not about the document.
pub fn font_dirs(root: &Path) -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from("C:/Windows/Fonts")];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        v.push(PathBuf::from(local.replace('\\', "/")).join("Microsoft/Windows/Fonts"));
    }
    v.push(root.join("fonts"));
    v
}

pub fn resolve_font(root: &Path, name: &str) -> Option<PathBuf> {
    if name.contains(':') || name.starts_with('/') || name.starts_with('\\') {
        let p = PathBuf::from(name);
        return p.exists().then_some(p);
    }
    for d in font_dirs(root) {
        let p = d.join(name);
        if p.exists() { return Some(p); }
    }
    let p = root.join(name);
    p.exists().then_some(p)
}

// ----------------------------------------------------------- checkpoint ---

#[derive(Serialize, Deserialize)]
struct CkptLine {
    #[serde(rename = "type")]
    kind: String,
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

/// Append-only JSONL checkpoint. One line per finished config, fsynced on the
/// config boundary, so a killed run loses at most one config. A params line at
/// the head invalidates a stale checkpoint when the sweep setup changes —
/// resuming into a different search would be worse than starting over.
pub struct Checkpoint {
    file: Option<File>,
    pub done: HashMap<String, serde_json::Value>,
}

impl Checkpoint {
    pub fn open(path: &Path, params_key: &str) -> std::io::Result<Checkpoint> {
        let mut done = HashMap::new();
        let mut valid = false;
        if let Ok(f) = File::open(path) {
            for (i, line) in BufReader::new(f).lines().enumerate() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() { continue; }
                let Ok(l) = serde_json::from_str::<CkptLine>(&line) else { break };
                if i == 0 {
                    if l.kind == "params" && l.key == params_key { valid = true; continue; }
                    break;
                }
                if valid && l.kind == "config" {
                    done.insert(l.key, l.data.unwrap_or(serde_json::Value::Null));
                }
            }
        }
        if !valid { done.clear(); }
        if let Some(dir) = path.parent() { std::fs::create_dir_all(dir)?; }
        let mut file = if valid {
            OpenOptions::new().append(true).open(path)?
        } else {
            let mut f = File::create(path)?;
            let line = serde_json::to_string(&CkptLine { kind: "params".into(), key: params_key.into(), data: None })?;
            writeln!(f, "{line}")?;
            f.sync_all()?;
            f
        };
        file.flush()?;
        Ok(Checkpoint { file: Some(file), done })
    }

    /// Record a finished config, fsynced before returning.
    pub fn record(&mut self, key: &str, data: serde_json::Value) -> std::io::Result<()> {
        if let Some(f) = self.file.as_mut() {
            let line = serde_json::to_string(&CkptLine { kind: "config".into(), key: key.into(), data: Some(data.clone()) })?;
            writeln!(f, "{line}")?;
            f.flush()?;
            f.sync_all()?;
        }
        self.done.insert(key.into(), data);
        Ok(())
    }
}
