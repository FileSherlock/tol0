// sweep — the fast half of ../../sweep.mjs: stage A dims prefilter + stage B
// exact phase sweep over every (face, em64, pen, law), with `--wobble`.
//
// **This is a clone of a JS tool, and the JS is the oracle.** Hit list,
// summary and stage-A survivor line are compared position by position against
// `lab/sweep.mjs`'s own report by `npm run rust:certify`; anything the two
// could disagree about — iteration order, tie-breaking, dedup order — is
// therefore a bug even when it looks harmless. Where this file says "JS order"
// it means that literally.
//
// The speed comes from four things, none of which changes an output byte:
// outlines are scaled ONCE per (cp, em64) and only translated per phase, the
// dims gate is a 32×32 bit matrix, crop+LUT+hash is fused into one reusable
// scratch buffer, and each config runs its phase grid on rayon.
use crate::io::{resolve_font, Checkpoint};
use crate::laws;
use ftclone::{bbox_at, render, Face, Raster, Scaled};
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHasher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use std::time::Instant;

// The sweep frame and pen, identical to lab/sweep.mjs.
pub const W: i32 = 40;
pub const H: i32 = 40;
pub const PENX: i32 = 10;
pub const BASEY: i32 = 28;
/// The harvest ink threshold (../../pgm.mjs INK). A target window is cropped
/// to its pixels < INK, and so is every candidate, at the law's own cov_min.
pub const INK: u8 = 250;

// ------------------------------------------------------------ templates ---

#[derive(Deserialize)]
struct TargetIndex { targets: Vec<TargetMeta> }

#[derive(Deserialize)]
struct TargetMeta {
    id: String,
    ch: String,
    cp: u32,
    #[serde(default)]
    obs: u64,
}

pub struct Tmpl {
    pub id: String,
    pub obs: u64,
    pub w: i32,
    pub h: i32,
    pub bytes: Vec<u8>,
}

pub struct CpT {
    pub cp: u32,
    pub ch: String,
    /// unique signatures in JS Map insertion order
    pub order: Vec<Tmpl>,
    by_hash: FxHashMap<u64, Vec<u32>>,
    pub dims: Vec<(i32, i32)>,
    /// bit y of word x set ⇔ (w=x+1, h=y+1) is a target dimension
    dims_gate: [u32; 32],
    pub total_obs: u64,
}

impl CpT {
    #[inline]
    fn gate(&self, w: i32, h: i32) -> bool {
        w >= 1 && h >= 1 && w <= 32 && h <= 32 && self.dims_gate[(w - 1) as usize] & (1u32 << (h - 1)) != 0
    }
}

fn sig_hash(w: i32, h: i32, bytes: &[u8]) -> u64 {
    let mut hs = FxHasher::default();
    hs.write_i32(w);
    hs.write_i32(h);
    hs.write(bytes);
    hs.finish()
}

/// Ink bbox of a pgm window at the harvest threshold — ../../pgm.mjs inkBbox.
fn ink_bbox(px: &[u8], w: i32, h: i32, min: u8) -> Option<(i32, i32, i32, i32)> {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, -1i32, -1i32);
    for r in 0..h {
        for c in 0..w {
            if px[(r * w + c) as usize] < min {
                if c < x0 { x0 = c; }
                if c > x1 { x1 = c; }
                if r < y0 { y0 = r; }
                if r > y1 { y1 = r; }
            }
        }
    }
    if x1 < 0 { None } else { Some((x0, y0, x1 - x0 + 1, y1 - y0 + 1)) }
}

pub struct Templates {
    pub by_cp: Vec<CpT>,
    pub n_tmpl: usize,
    /// every row's obs, INCLUDING rows dropped for having no ink — the JS
    /// denominator is the raw index, not the loaded set
    pub total_obs: u64,
}

pub fn load_targets(dir: &Path) -> Result<Templates, String> {
    let raw = std::fs::read_to_string(dir.join("index.json"))
        .map_err(|e| format!("{}/index.json: {e}", dir.display()))?;
    let idx: TargetIndex = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let mut by_cp: Vec<CpT> = Vec::new();
    let mut cp_pos: HashMap<u32, usize> = HashMap::new();
    let mut total_obs = 0u64;
    for t in &idx.targets {
        total_obs += t.obs;
        let pg = crate::io::read_pgm(&dir.join(format!("{}.pgm", t.id))).map_err(|e| format!("{}: {e}", t.id))?;
        let (w, h) = (pg.w as i32, pg.h as i32);
        let Some((bx, by, bw, bh)) = ink_bbox(&pg.px, w, h, INK) else { continue };
        let mut bytes = vec![0u8; (bw * bh) as usize];
        for r in 0..bh {
            for c in 0..bw {
                bytes[(r * bw + c) as usize] = pg.px[((by + r) * w + bx + c) as usize];
            }
        }
        let ci = *cp_pos.entry(t.cp).or_insert_with(|| {
            by_cp.push(CpT { cp: t.cp, ch: t.ch.clone(), order: vec![], by_hash: FxHashMap::default(),
                dims: vec![], dims_gate: [0; 32], total_obs: 0 });
            by_cp.len() - 1
        });
        let e = &mut by_cp[ci];
        let hash = sig_hash(bw, bh, &bytes);
        let dup = e.by_hash.get(&hash).is_some_and(|cands| cands.iter().any(|&ti| {
            let o = &e.order[ti as usize];
            o.w == bw && o.h == bh && o.bytes == bytes
        }));
        if !dup {
            e.by_hash.entry(hash).or_default().push(e.order.len() as u32);
            e.order.push(Tmpl { id: t.id.clone(), obs: t.obs, w: bw, h: bh, bytes });
        }
        if !e.dims.iter().any(|d| d.0 == bw && d.1 == bh) { e.dims.push((bw, bh)); }
        e.total_obs += t.obs;
    }
    for e in &mut by_cp {
        for &(w, h) in &e.dims {
            if (1..=32).contains(&w) && (1..=32).contains(&h) {
                e.dims_gate[(w - 1) as usize] |= 1u32 << (h - 1);
            }
        }
    }
    let n_tmpl: usize = by_cp.iter().map(|c| c.order.len()).sum();
    if n_tmpl == 0 { return Err("no usable targets".into()); }
    Ok(Templates { by_cp, n_tmpl, total_obs })
}

// --------------------------------------------------------------- params ---

pub struct SweepParams {
    pub root: PathBuf,
    pub targets: String,
    pub fonts: Vec<String>,
    pub ems: (i32, i32),
    /// `--at a,b,c`: skip stage A and sweep exactly these em64
    pub at: Option<Vec<i32>>,
    pub xstep: i32,
    pub ystep: i32,
    pub min_dim: f64,
    pub wobble: f64, // 0 = off
    pub screen: usize,
    pub dims_only: bool,
    pub report: Option<PathBuf>,
    pub ckpt: Option<PathBuf>,
}

// ----------------------------------------------------------------- hits ---

#[derive(Clone, Serialize, Deserialize)]
pub struct Hit {
    pub font: String,
    pub em64: i32,
    pub law: String,
    pub ch: String,
    pub id: String,
    pub obs: u64,
    pub fx: i32,
    pub fy: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wob: Option<u32>,
}

struct SumRow {
    font: String,
    em64: i32,
    law: String,
    tmpl: Vec<String>,      // insertion-ordered unique target ids
    tmpl_set: FxHashMap<String, ()>,
    weight: u64,
    chars: Vec<String>,     // insertion-ordered unique
    chars_set: FxHashMap<String, ()>,
}

#[derive(Default)]
struct Summary {
    rows: Vec<SumRow>,
    index: HashMap<String, usize>,
}

impl Summary {
    fn absorb(&mut self, h: &Hit) {
        let key = format!("{}|{}|{}", h.font, h.em64, h.law);
        let i = *self.index.entry(key).or_insert_with(|| {
            self.rows.push(SumRow { font: h.font.clone(), em64: h.em64, law: h.law.clone(),
                tmpl: vec![], tmpl_set: FxHashMap::default(), weight: 0,
                chars: vec![], chars_set: FxHashMap::default() });
            self.rows.len() - 1
        });
        let r = &mut self.rows[i];
        if r.tmpl_set.insert(h.id.clone(), ()).is_none() {
            r.tmpl.push(h.id.clone());
            r.weight += h.obs;
        }
        if r.chars_set.insert(h.ch.clone(), ()).is_none() { r.chars.push(h.ch.clone()); }
    }
}

// -------------------------------------------------------------- stage A ---

/// Render two pens and ask whether the ink bbox is within ±1 px of SOME target
/// dimension of that character. It RANKS; it never decides (METHOD rule 8).
fn dim_score(face: &Face, probes: &[&CpT], em: i32) -> f64 {
    let mut raster = Raster::new();
    let mut cov = vec![0u8; (W * H) as usize];
    let (mut ok, mut tried) = (0usize, 0usize);
    for cpt in probes {
        tried += 1;
        let Some(scaled) = face.scale(cpt.cp, em as f64, em as f64) else { continue };
        for (fx, fy) in [(0, 0), (33, 31)] {
            let coarse = render(&scaled, PENX * 64 + fx, BASEY * 64 + fy, W, H, &mut raster, &mut cov);
            if let Some((_, _, bw, bh)) = bbox_at(&cov, W, coarse, 6) {
                if cpt.dims.iter().any(|d| (d.0 - bw).abs() <= 1 && (d.1 - bh).abs() <= 1) { ok += 1; break; }
            }
        }
    }
    if tried == 0 { 0.0 } else { ok as f64 / tried as f64 }
}

// -------------------------------------------------------------- stage B ---

struct RawHit { law: usize, wobbled: bool, order_idx: u32, fx: i32, fy: i32, wob: u32 }

/// One config over `cps` (indices into tpl.by_cp) — JS `sweepConfig`. Returns
/// hits in exactly the JS iteration order (cp, fy, fx, law).
fn sweep_config(face: &Face, font: &str, em: i32, cps: &[usize], tpl: &Templates,
                lw: &laws::Laws, p: &SweepParams) -> Vec<Hit> {
    // hoist: one scaled outline per cp for the whole 4096-phase grid
    let scaled: Vec<Option<Scaled>> = cps.iter()
        .map(|&ci| face.scale(tpl.by_cp[ci].cp, em as f64, em as f64))
        .collect();

    let fys: Vec<i32> = (0..64).step_by(p.ystep as usize).collect();
    let mut chunks: Vec<(usize, &[i32])> = vec![];
    for i in 0..cps.len() {
        for c in fys.chunks(16) { chunks.push((i, c)); }
    }

    let results: Vec<Vec<RawHit>> = chunks.par_iter().map(|&(ci_pos, fy_chunk)| {
        let mut out = Vec::new();
        let Some(scaled) = scaled[ci_pos].as_ref() else { return out };
        let cpt = &tpl.by_cp[cps[ci_pos]];
        let mut raster = Raster::new();
        let mut cov = vec![0u8; (W * H) as usize];
        let mut scratch: Vec<u8> = Vec::with_capacity(32 * 32);
        for &fy in fy_chunk {
            let mut fx = 0;
            while fx < 64 {
                let coarse = render(scaled, PENX * 64 + fx, BASEY * 64 + fy, W, H, &mut raster, &mut cov);
                for law in 0..laws::N_LAWS {
                    let Some((x0, y0, bw, bh)) = bbox_at(&cov, W, coarse, lw.cov_min[law]) else { continue };
                    if bw > 30 || bh > 30 { continue; }
                    if !cpt.gate(bw, bh) { continue; }
                    if !cpt.dims.iter().any(|d| d.0 == bw && d.1 == bh) { continue; }
                    scratch.clear();
                    let lut = &lw.luts[law];
                    for y in 0..bh {
                        for x in 0..bw {
                            scratch.push(lut[cov[((y0 + y) * W + x0 + x) as usize] as usize]);
                        }
                    }
                    let hash = sig_hash(bw, bh, &scratch);
                    let mut matched = false;
                    if let Some(cands) = cpt.by_hash.get(&hash) {
                        for &ti in cands {
                            let t = &cpt.order[ti as usize];
                            if t.w == bw && t.h == bh && t.bytes == scratch {
                                out.push(RawHit { law, wobbled: false, order_idx: ti, fx, fy, wob: 0 });
                                matched = true;
                                break;
                            }
                        }
                    }
                    if !matched && p.wobble > 0.0 {
                        // ±1 wobble: no pixel differs by more than 1, at most N% by 1
                        let max_wob = (scratch.len() as f64 * p.wobble / 100.0).ceil() as u32;
                        for (ti, t) in cpt.order.iter().enumerate() {
                            if t.w != bw || t.h != bh { continue; }
                            let (mut wob, mut okc) = (0u32, true);
                            for i in 0..scratch.len() {
                                let d = scratch[i] as i32 - t.bytes[i] as i32;
                                if !(-1..=1).contains(&d) { okc = false; break; }
                                if d != 0 { wob += 1; if wob > max_wob { okc = false; break; } }
                            }
                            if okc && wob > 0 {
                                out.push(RawHit { law, wobbled: true, order_idx: ti as u32, fx, fy, wob });
                                break;
                            }
                        }
                    }
                }
                fx += p.xstep;
            }
        }
        out
    }).collect();

    // materialize in JS order — chunks are already (cp, fy) ordered
    let mut hits = Vec::new();
    for (k, raw) in results.into_iter().enumerate() {
        let cpt = &tpl.by_cp[cps[chunks[k].0]];
        for r in raw {
            let t = &cpt.order[r.order_idx as usize];
            hits.push(Hit {
                font: font.to_string(),
                em64: em,
                law: format!("{}{}", laws::LAW_NAMES[r.law], if r.wobbled { "~" } else { "" }),
                ch: cpt.ch.clone(),
                id: t.id.clone(),
                obs: t.obs,
                fx: r.fx,
                fy: r.fy,
                wob: if r.wobbled { Some(r.wob) } else { None },
            });
        }
    }
    hits
}

// ------------------------------------------------------------ the sweep ---

pub fn short_name(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// `--fonts all` — every face in every roster directory, in the JS order
/// (directory order, `readdirSync().sort()` within each).
pub fn all_fonts(root: &Path) -> Vec<String> {
    let mut out = vec![];
    for d in crate::io::font_dirs(root) {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        let mut names: Vec<String> = rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| { let l = n.to_ascii_lowercase(); l.ends_with(".ttf") || l.ends_with(".cff") })
            .collect();
        names.sort();
        for n in names { out.push(format!("{}/{n}", d.to_string_lossy().replace('\\', "/"))); }
    }
    out
}

/// cp → gid for bare CFF faces, which have no cmap. Written by the JS side
/// (`lab/rust/certify.mjs`) from mupdf's own `encodeCharacter` on the same
/// bytes, because that is what the JS tools do at runtime and the two have to
/// agree on which glyph a codepoint even names.
pub fn load_gid_maps(root: &Path) -> HashMap<String, HashMap<u32, u32>> {
    let mut out = HashMap::new();
    if let Ok(s) = std::fs::read_to_string(root.join("lab/rust/gidmaps.json")) {
        if let Ok(v) = serde_json::from_str::<HashMap<String, HashMap<String, u32>>>(&s) {
            for (k, m) in v {
                out.insert(k, m.into_iter().filter_map(|(cp, gid)| cp.parse().ok().map(|c: u32| (c, gid))).collect());
            }
        }
    }
    out
}

pub fn gid_map_for<'a>(maps: &'a HashMap<String, HashMap<u32, u32>>, font: &str) -> Option<&'a HashMap<u32, u32>> {
    let norm = font.replace('\\', "/");
    if let Some(m) = maps.get(&norm) { return Some(m); }
    let base = short_name(&norm);
    maps.iter().find(|(k, _)| short_name(k) == base).map(|(_, m)| m)
}

pub fn run(p: &SweepParams) -> Result<(), String> {
    let tdir = p.root.join("lab/targets").join(&p.targets);
    let tpl = load_targets(&tdir)?;
    let lw = laws::build();
    let gid_maps = load_gid_maps(&p.root);
    println!("{} distinct templates over {} chars from lab/targets/{}", tpl.n_tmpl, tpl.by_cp.len(), p.targets);

    // probe chars: most-observed, not tiny. Stable sort = the JS order.
    let mut probe_refs: Vec<&CpT> = tpl.by_cp.iter().filter(|c| c.dims.iter().any(|d| d.0 >= 5 && d.1 >= 5)).collect();
    probe_refs.sort_by_key(|c| std::cmp::Reverse(c.total_obs));
    probe_refs.truncate(8);
    let mut screen_idx: Vec<usize> = (0..tpl.by_cp.len()).collect();
    screen_idx.sort_by_key(|&i| std::cmp::Reverse(tpl.by_cp[i].total_obs));
    screen_idx.truncate(p.screen);
    println!("dims probe: {}   stage-B screen: {}",
        probe_refs.iter().map(|c| c.ch.as_str()).collect::<Vec<_>>().join(" "),
        screen_idx.iter().map(|&i| tpl.by_cp[i].ch.as_str()).collect::<Vec<_>>().join(" "));

    // resolve the roster before anything long-running, so a typo fails fast
    let want: Vec<String> = if p.fonts.len() == 1 && p.fonts[0] == "all" { all_fonts(&p.root) } else { p.fonts.clone() };
    let mut fonts: Vec<String> = vec![];
    for f in &want {
        match resolve_font(&p.root, f) {
            Some(path) => fonts.push(path.to_string_lossy().replace('\\', "/")),
            None => println!("SKIP {f}: in no roster directory (C:/Windows/Fonts, %LOCALAPPDATA%/…/Fonts, fonts/)"),
        }
    }
    println!("roster: {} faces", fonts.len());

    let params_key = format!("v1|{}|{}..{}|{:?}|{}|{}|{}|{}|{}|{}",
        p.targets, p.ems.0, p.ems.1, p.at, p.xstep, p.ystep, p.min_dim, p.wobble, p.screen, fonts.join(","));
    let mut ckpt = match &p.ckpt {
        Some(path) => Some(Checkpoint::open(path, &params_key).map_err(|e| e.to_string())?),
        None => None,
    };
    if let Some(c) = &ckpt {
        if !c.done.is_empty() { println!("checkpoint: {} finished config(s), resuming", c.done.len()); }
    }

    let mut hits: Vec<Hit> = Vec::new();
    let mut summary = Summary::default();
    let all_idx: Vec<usize> = (0..tpl.by_cp.len()).collect();
    let rest: Vec<usize> = all_idx.iter().filter(|i| !screen_idx.contains(i)).copied().collect();

    for font in &fonts {
        let mut face = match Face::load(Path::new(font)) {
            Ok(f) => f,
            Err(e) => { println!("SKIP {font}: {e}"); continue; }
        };
        if face.is_cff() {
            match gid_map_for(&gid_maps, font) {
                Some(m) => face.gid_map = Some(m.clone()),
                None => { println!("SKIP {font}: CFF with no gidmaps.json entry — run: npm run rust:certify"); continue; }
            }
        }
        let short = short_name(font);

        // ---- stage A ----
        let ems: Vec<i32> = match &p.at {
            Some(at) => at.clone(),
            None => {
                let sa_key = format!("stagea|{short}");
                let s: Vec<i32> = if let Some(v) = ckpt.as_ref().and_then(|c| c.done.get(&sa_key)) {
                    serde_json::from_value(v.clone()).map_err(|e| e.to_string())?
                } else {
                    let range: Vec<i32> = (p.ems.0..=p.ems.1).collect();
                    let ok: Vec<bool> = range.par_iter().map(|&e| dim_score(&face, &probe_refs, e) >= p.min_dim).collect();
                    let s: Vec<i32> = range.iter().zip(&ok).filter(|(_, &k)| k).map(|(&e, _)| e).collect();
                    if let Some(c) = ckpt.as_mut() {
                        c.record(&sa_key, serde_json::to_value(&s).unwrap()).map_err(|e| e.to_string())?;
                    }
                    s
                };
                let list = if !s.is_empty() && s.len() <= 24 {
                    format!(" [{}]", s.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(","))
                } else { String::new() };
                println!("{short}: {} dims survivors{list}", s.len());
                s
            }
        };
        if p.dims_only { continue; }

        // ---- stage B ----
        let t_font = Instant::now();
        for &em in &ems {
            let key = format!("{short}|{em}");
            if let Some(v) = ckpt.as_ref().and_then(|c| c.done.get(&key)) {
                let stored: Vec<Hit> = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
                let n = stored.len();
                for h in stored { summary.absorb(&h); hits.push(h); }
                if n > 0 { println!("  (ckpt) {short} em64={em}: {n} hits replayed"); }
                continue;
            }
            let n_before = hits.len();
            for h in sweep_config(&face, &short, em, &screen_idx, &tpl, &lw, p) { summary.absorb(&h); hits.push(h); }
            if hits.len() == n_before {
                // A wrong config scores zero on the commonest letters and is
                // abandoned in milliseconds; only a config that already scored
                // is worth the rest of the alphabet.
                if let Some(c) = ckpt.as_mut() {
                    c.record(&key, serde_json::Value::Array(vec![])).map_err(|e| e.to_string())?;
                }
                continue;
            }
            let t0 = Instant::now();
            for h in sweep_config(&face, &short, em, &rest, &tpl, &lw, p) { summary.absorb(&h); hits.push(h); }
            let dt = t0.elapsed().as_secs_f64();
            if let Some(best) = summary.rows.iter().filter(|s| s.font == short && s.em64 == em)
                .max_by_key(|s| s.tmpl.len()) {
                println!("  *** {short} em64={em}: {} — {} templates / {} chars / weight {}  [{:.0}s]",
                    best.law, best.tmpl.len(), best.chars.len(), best.weight, dt);
            }
            if let Some(c) = ckpt.as_mut() {
                let cfg: Vec<&Hit> = hits[n_before..].iter().collect();
                c.record(&key, serde_json::to_value(&cfg).unwrap()).map_err(|e| e.to_string())?;
            }
        }
        if !ems.is_empty() {
            println!("  {short}: {} configs in {:.0}s", ems.len(), t_font.elapsed().as_secs_f64());
        }
    }

    // ---- the ranking ----
    let mut rows: Vec<&SumRow> = summary.rows.iter().collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.weight)); // stable, like the JS sort
    println!("\ntop configs by observation weight (of {} target observations):", tpl.total_obs);
    for r in rows.iter().take(12) {
        println!("  {:<22} em64 {:>4} {:<9} {:>4} templates / {} chars / weight {} ({:.1}%)",
            r.font, r.em64, r.law, r.tmpl.len(), r.chars.len(), r.weight,
            100.0 * r.weight as f64 / tpl.total_obs as f64);
    }
    if rows.is_empty() {
        println!("  NONE — no (face, em64, pen, law) in this roster reproduces one target byte-exactly.");
        println!("  That is a statement about THIS ROSTER (../docs/METHOD.md rule 3). Say what it enumerated:");
        println!("    {} faces, em64 {}, all 4096 pens, {} laws.", fonts.len(),
            match &p.at { Some(a) => a.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(","),
                          None => format!("{}..{}", p.ems.0, p.ems.1) }, laws::N_LAWS);
    } else {
        println!("\nconfirm the winner before believing it:  node lab/identify.mjs --targets {} --scan {} --ems {}..{} --law {}",
            p.targets, rows[0].font, rows[0].em64, rows[0].em64, rows[0].law.replace('~', ""));
    }

    if let Some(rp) = &p.report {
        #[derive(Serialize)]
        struct RepRow<'a> { font: &'a str, em64: i32, law: &'a str, tmpl: usize, weight: u64, chars: String }
        #[derive(Serialize)]
        struct Report<'a> { targets: String, ems: Vec<i32>, fonts: &'a [String], hits: &'a [Hit], summary: Vec<RepRow<'a>> }
        let rep = Report {
            targets: format!("lab/targets/{}", p.targets),
            ems: p.at.clone().unwrap_or_else(|| vec![p.ems.0, p.ems.1]),
            fonts: &fonts,
            hits: &hits,
            summary: rows.iter().map(|r| RepRow { font: &r.font, em64: r.em64, law: &r.law,
                tmpl: r.tmpl.len(), weight: r.weight, chars: r.chars.concat() }).collect(),
        };
        std::fs::write(rp, serde_json::to_string_pretty(&rep).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        println!("wrote {}", rp.display());
    }
    Ok(())
}
