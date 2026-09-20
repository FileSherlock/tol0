// ftclone (Rust) — a port of this repo's own certified JS clone: ../../ftclone/
// `ftclone.mjs` + `ttf.mjs` + `cff.mjs`, module for module.
//
//   fixed.rs  the 26.6 / 16.16 integer helpers      (ftclone.mjs, top)
//   ttf.rs    glyf/loca/cmap outlines, y-up units   (ttf.mjs)
//   cff.rs    Type2 charstrings → cubic contours    (cff.mjs)
//   grays.rs  the FreeType smooth rasterizer + the scale/render pipeline
//
// **The JS is the oracle here, not a specification.** The JS clone is what was
// certified against mupdf's own fillText; this port is certified against the
// JS, over 3,000 seeded (font, em64x, em64y, pen, cp) tuples covering the TTF
// composite path (float component transforms), fractional em64 and CFF.
// `npm run rust:certify` is that gate, and it must print 0 diffs before any
// number this engine reports means anything.
//
// Raw outline points are f64 for exactly that reason: composite component
// transforms are float arithmetic in JS (readInt16/16384) and their rounding
// has to match bit for bit.
pub mod cff;
pub mod fixed;
pub mod grays;
pub mod ttf;

pub use grays::{bbox_at, render, Face, Raster, Scaled};

#[derive(Clone, Copy, Debug)]
pub struct RawPt {
    pub x: f64,
    pub y: f64,
    pub on: bool,
}

/// One CFF/Type2 path segment (lines + CUBIC beziers, charstring units).
#[derive(Clone, Copy, Debug)]
pub enum CffSeg {
    Line { x: f64, y: f64 },
    Cubic { c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64 },
}

#[derive(Clone, Debug)]
pub struct CffContour {
    pub sx: f64,
    pub sy: f64,
    pub segs: Vec<CffSeg>,
}

#[derive(Debug)]
pub enum FontError {
    Io(std::io::Error),
    Parse(String),
}

impl std::fmt::Display for FontError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            FontError::Io(e) => write!(f, "{e}"),
            FontError::Parse(s) => write!(f, "{s}"),
        }
    }
}

impl From<std::io::Error> for FontError {
    fn from(e: std::io::Error) -> Self { FontError::Io(e) }
}

pub(crate) fn err(msg: impl Into<String>) -> FontError { FontError::Parse(msg.into()) }
