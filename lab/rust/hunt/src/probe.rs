// probe — the ANISOTROPIC exact search: (font, em64x, em64y, phase, law)
// against harvested targets, with rayon over em64x and a checkpoint per
// (font, em64y) row.
//
// This is the one search `lab/identify.mjs` and `lab/sweep.mjs` cannot do:
// both assume a square matrix (em64x == em64y), and a producer that scales x
// and y differently is invisible to them. It is a probe rather than a sweep
// because the grid is quadratic in the em range — screen with `sweep` first,
// then open a window here.
//
// `--near` reports the FEWEST differing bytes per target instead of pass/fail,
// which is how a wrong face (floor ~20 of 140 px) is told apart from a right
// face with a wrong law or pen (floor 0–3). "No exact match" alone cannot make
// that distinction, and once did not.
use crate::io::{read_pgm, Checkpoint, Pgm};
use crate::laws;
use crate::sweep::{gid_map_for, load_gid_maps, short_name};
use ftclone::{bbox_at, render, Face, Raster};
use rayon::prelude::*;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Instant;

pub struct ProbeParams {
    pub root: PathBuf,
    pub targets: String,
    pub fonts: Vec<String>,
    pub exr: (i32, i32),
    pub eyr: (i32, i32),
    pub laws: Vec<String>,
    pub nt: usize,
    pub frame: (i32, i32),  // W, H (aniso family probes used 60×60)
    pub pen: (i32, i32),    // PENX, BASEY in px
    pub fy: i32,            // baseline fraction (aniso family: 0)
    pub near: bool,         // diagnostic: report the BEST byte-diff per target
    pub report: Option<PathBuf>,
    pub ckpt: Option<PathBuf>,
}

#[derive(Deserialize)]
struct TargetIndex { targets: Vec<TargetMeta> }

#[derive(Deserialize, Clone)]
struct TargetMeta {
    id: String,
    cp: u32,
    #[serde(default)]
    obs: Option<u64>,
}

struct Target {
    id: String,
    cp: u32,
    pg: Pgm,
    // ink box of the page window (<250), inclusive
    bx0: i32, by0: i32, bw: i32, bh: i32,
}

fn page_box(pg: &Pgm) -> Option<(i32, i32, i32, i32)> {
    let (mut x0, mut x1, mut y0, mut y1) = (i32::MAX, -1, i32::MAX, -1);
    for y in 0..pg.h as i32 {
        for x in 0..pg.w as i32 {
            if pg.px[(y * pg.w as i32 + x) as usize] < 250 {
                if x < x0 { x0 = x; }
                if x > x1 { x1 = x; }
                if y < y0 { y0 = y; }
                if y > y1 { y1 = y; }
            }
        }
    }
    if x1 < 0 { None } else { Some((x0, y0, x1 - x0 + 1, y1 - y0 + 1)) }
}

pub fn run_probe(p: &ProbeParams) -> Result<(), String> {
    let lw = laws::build();
    let law_idx: Vec<usize> = p.laws.iter().map(|n| {
        laws::LAW_NAMES.iter().position(|l| l == n).ok_or_else(|| format!("unknown law {n}"))
    }).collect::<Result<_, _>>()?;

    let dir = p.root.join("lab/targets").join(&p.targets);
    let idx_raw = std::fs::read_to_string(dir.join("index.json"))
        .map_err(|e| format!("{}/index.json: {e}", dir.display()))?;
    let idx: TargetIndex = serde_json::from_str(&idx_raw).map_err(|e| e.to_string())?;
    let mut metas = idx.targets.clone();
    metas.sort_by_key(|t| std::cmp::Reverse(t.obs.unwrap_or(0)));
    metas.truncate(p.nt);
    let mut targets = Vec::new();
    for m in metas {
        let pg = read_pgm(&dir.join(format!("{}.pgm", m.id))).map_err(|e| e.to_string())?;
        if let Some((bx0, by0, bw, bh)) = page_box(&pg) {
            targets.push(Target { id: m.id, cp: m.cp, pg, bx0, by0, bw, bh });
        }
    }
    println!("{} targets loaded", targets.len());

    let (fw, fh) = p.frame;
    let (penx, basey) = p.pen;
    let gid_maps = load_gid_maps(&p.root);
    let params_key = format!("probe2|{}|{:?}|{:?}|{:?}|{}|{}|{:?}|{:?}|{}",
        p.targets, p.exr, p.eyr, p.laws, p.nt, p.fy, p.frame, p.pen, p.fonts.join(","));
    let mut ckpt = match &p.ckpt {
        Some(path) => Some(Checkpoint::open(path, &params_key).map_err(|e| e.to_string())?),
        None => None,
    };

    let mut all_hits: Vec<(String, String, i32, i32, String)> = vec![]; // font, law, ex, ey, target
    for font in &p.fonts {
        let Some(font_path) = crate::io::resolve_font(&p.root, font) else {
            println!("SKIP {font}: in no roster directory");
            continue;
        };
        let font = font_path.to_string_lossy().replace('\\', "/");
        let mut face = match Face::load(&font_path) {
            Ok(f) => f,
            Err(e) => { println!("SKIP {font}: {e}"); continue; }
        };
        if face.is_cff() {
            match gid_map_for(&gid_maps, &font) {
                Some(m) => face.gid_map = Some(m.clone()),
                None => { println!("SKIP {font}: CFF with no gidmaps.json entry — run: npm run rust:certify"); continue; }
            }
        }
        let short = short_name(&font);
        let t0 = Instant::now();
        let mut hits: std::collections::BTreeMap<String, BTreeSet<String>> = Default::default();
        // near mode: best (fewest differing bytes) per target over the whole grid
        let mut best: Vec<(u32, String)> = targets.iter().map(|t| (u32::MAX, t.id.clone())).collect();
        for ey in p.eyr.0..=p.eyr.1 {
            let key = format!("{short}|ey{ey}");
            if let Some(v) = ckpt.as_ref().and_then(|c| c.done.get(&key)) {
                let stored: Vec<(String, i32, String)> = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
                for (law, ex, id) in stored {
                    hits.entry(format!("{law}|{ex}|{ey}")).or_default().insert(id.clone());
                    all_hits.push((short.clone(), law, ex, ey, id));
                }
                continue;
            }
            let exs: Vec<i32> = (p.exr.0..=p.exr.1).collect();
            let near_rows: Vec<Vec<(usize, u32, String)>> = if !p.near { vec![] } else {
                exs.par_iter().map(|&ex| {
                    let mut out: Vec<(usize, u32, String)> = vec![];
                    let mut raster = Raster::new();
                    let mut cov = vec![0u8; (fw * fh) as usize];
                    for (ti, t) in targets.iter().enumerate() {
                        let Some(scaled) = face.scale(t.cp, ex as f64, ey as f64) else { continue; };
                        let mut bd = u32::MAX;
                        let mut bw = String::new();
                        for fx in 0..64 {
                            let coarse = render(&scaled, penx * 64 + fx, basey * 64 + p.fy, fw, fh, &mut raster, &mut cov);
                            for &li in &law_idx {
                                let Some((cx0, cy0, cw, chh)) = bbox_at(&cov, fw, coarse, lw.cov_min[li]) else { continue; };
                                let lut = &lw.luts[li];
                                let mut d = 0u32;
                                for y in 0..t.pg.h as i32 {
                                    for x in 0..t.pg.w as i32 {
                                        let cy = cy0 + y - t.by0;
                                        let cx = cx0 + x - t.bx0;
                                        let v = if cy >= 0 && cy < fh && cx >= 0 && cx < fw {
                                            lut[cov[(cy * fw + cx) as usize] as usize]
                                        } else { 255 };
                                        if v != t.pg.px[(y * t.pg.w as i32 + x) as usize] { d += 1; }
                                    }
                                    if d >= bd { break; }
                                }
                                if d < bd {
                                    bd = d;
                                    bw = format!("{}|ex{ex}|ey{ey}|fx{fx} box {cw}x{chh} vs {}x{}",
                                        laws::LAW_NAMES[li], t.bw, t.bh);
                                }
                            }
                        }
                        if bd != u32::MAX { out.push((ti, bd, bw)); }
                    }
                    out
                }).collect()
            };
            for (ti, d, wh) in near_rows.into_iter().flatten() {
                if d < best[ti].0 { best[ti] = (d, wh); }
            }
            let row: Vec<Vec<(String, i32, String)>> = exs.par_iter().map(|&ex| {
                let mut out = vec![];
                let mut raster = Raster::new();
                let mut cov = vec![0u8; (fw * fh) as usize];
                for t in &targets {
                    let Some(scaled) = face.scale(t.cp, ex as f64, ey as f64) else { continue; };
                    for fx in 0..64 {
                        let coarse = render(&scaled, penx * 64 + fx, basey * 64 + p.fy, fw, fh, &mut raster, &mut cov);
                        for &li in &law_idx {
                            // Gate on the law's OWN ink threshold: cov_min is the
                            // smallest coverage rendering to byte < 250, i.e. the
                            // harvest's ink threshold. Gating at cov>=1 instead
                            // counts the faint 250..254 fringe as ink, making the
                            // render bbox wider than the target's and rejecting
                            // correct (font, em, phase) before the byte compare.
                            let Some((cx0, cy0, cw, chh)) = bbox_at(&cov, fw, coarse, lw.cov_min[li]) else { continue; };
                            if cw != t.bw || chh != t.bh { continue; }
                            let lut = &lw.luts[li];
                            let mut ok = true;
                            'cmp: for y in 0..t.pg.h as i32 {
                                for x in 0..t.pg.w as i32 {
                                    let cy = cy0 + y - t.by0;
                                    let cx = cx0 + x - t.bx0;
                                    let v = if cy >= 0 && cy < fh && cx >= 0 && cx < fw {
                                        lut[cov[(cy * fw + cx) as usize] as usize]
                                    } else { 255 };
                                    if v != t.pg.px[(y * t.pg.w as i32 + x) as usize] { ok = false; break 'cmp; }
                                }
                            }
                            if ok { out.push((laws::LAW_NAMES[li].to_string(), ex, t.id.clone())); }
                        }
                    }
                }
                out
            }).collect();
            let flat: Vec<(String, i32, String)> = row.into_iter().flatten().collect();
            for (law, ex, id) in &flat {
                hits.entry(format!("{law}|{ex}|{ey}")).or_default().insert(id.clone());
                all_hits.push((short.clone(), law.clone(), *ex, ey, id.clone()));
            }
            if let Some(c) = ckpt.as_mut() {
                c.record(&key, serde_json::to_value(&flat).unwrap()).map_err(|e| e.to_string())?;
            }
        }
        if p.near {
            let mut bs: Vec<(usize, &(u32, String))> = best.iter().enumerate().collect();
            bs.sort_by_key(|(_, b)| b.0);
            println!("{short} NEAR (fewest differing bytes per target, best first):");
            for (ti, (d, wh)) in bs.iter().take(8) {
                let t = &targets[*ti];
                println!("   {:>4} diff / {:>3} px  {} '{}'  {}", d, t.pg.w * t.pg.h, t.id, t.cp as u8 as char, wh);
            }
        }
        let mut ranked: Vec<(&String, &BTreeSet<String>)> = hits.iter().collect();
        ranked.sort_by_key(|(_, s)| std::cmp::Reverse(s.len()));
        println!("{short}: [{:.0}s] {}", t0.elapsed().as_secs_f64(),
            if ranked.is_empty() { "NO exact match".to_string() }
            else {
                ranked.iter().take(5).map(|(k, s)| format!("{k} → {}/{}", s.len(), targets.len()))
                    .collect::<Vec<_>>().join("  ")
            });
    }
    if let Some(rp) = &p.report {
        let rows: Vec<serde_json::Value> = all_hits.iter().map(|(f, l, ex, ey, id)| {
            serde_json::json!({ "font": f, "law": l, "em64": ex, "em64y": ey, "target": id })
        }).collect();
        std::fs::write(rp, serde_json::to_string_pretty(&rows).unwrap()).map_err(|e| e.to_string())?;
        println!("report written: {}", rp.display());
    }
    Ok(())
}
