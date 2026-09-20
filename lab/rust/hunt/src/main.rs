// hunt — the lab's fast engine. Four subcommands, and `selftest` is the one
// that makes the other three mean anything.
//
//   hunt selftest [--fixtures lab/rust/fixtures/golden.bin]
//   hunt sweep    --targets <hunt> --fonts a,b|all [--ems 700..1100] [--at 791]
//                 [--min-dim 0.75] [--screen 6] [--xstep 1 --ystep 1]
//                 [--wobble [N]] [--dims-only] [--report r.json] [--ckpt f]
//   hunt probe    --targets <hunt> --fonts f --ex 845..880 --ey 1275..1333
//                 [--laws fz,fzLin,mid] [--nt 4] [--frame 60x60] [--pen 12,44]
//                 [--near] [--report r.json] [--ckpt f]
//   hunt harvest  --doc <DOC> --out <hunt> [--pages 1,2,3] [--min-obs 3]
//                 [--max-var 8] [--maxw 26] [--maxh 26] [--dry]
//
// `--root <dir>` overrides the repo root, which is otherwise found by walking
// up from the working directory. Every other path above is relative to it.
//
// **Certification chain**: `selftest` must print 0 diffs against fixtures the
// JS ftclone generated, and then `node lab/rust/certify.mjs` must reproduce
// both control sweeps from `lab/sweep.mjs` exactly. Until both hold, a number
// this binary prints is a number from an unverified rasterizer.
mod harvest;
mod io;
mod laws;
mod probe;
mod sweep;

use ftclone::{bbox_at, render, Face, Raster};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == &format!("--{name}")).and_then(|i| args.get(i + 1).cloned())
}
fn flag(args: &[String], name: &str) -> bool { args.iter().any(|a| a == &format!("--{name}")) }
fn num<T: std::str::FromStr>(args: &[String], name: &str, d: T) -> T {
    opt(args, name).and_then(|s| s.parse().ok()).unwrap_or(d)
}
fn range(s: &str) -> (i32, i32) {
    let mut it = s.split("..");
    let a = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| panic!("range {s} needs a..b"));
    let b = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| panic!("range {s} needs a..b"));
    (a, b)
}
fn list(args: &[String], name: &str) -> Option<Vec<String>> {
    opt(args, name).map(|s| s.split(',').map(|v| v.trim().to_string()).collect())
}
/// A path argument is relative to the repo root unless it is already absolute.
fn at_root(root: &Path, s: &str) -> PathBuf {
    let p = PathBuf::from(s);
    if p.is_absolute() || s.contains(':') { p } else { root.join(s) }
}

/// The repo root is the nearest ancestor of the working directory holding both
/// `ftclone/` and `lab/`, so the binary works from anywhere in the tree with
/// no flag — and `--root` is there for when it is run from outside one.
fn find_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut d = cwd.clone();
    loop {
        if d.join("ftclone").is_dir() && d.join("lab").is_dir() { return d; }
        if !d.pop() { return cwd; }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let rest = &args[1.min(args.len())..];
    let root = opt(rest, "root").map(PathBuf::from).unwrap_or_else(find_root);
    let code = match cmd {
        "selftest" => selftest(rest, &root),
        "sweep" => run_sweep(rest, root),
        "probe" => run_probe(rest, root),
        "harvest" => run_harvest(rest, &root),
        _ => {
            eprintln!("usage: hunt <selftest|sweep|probe|harvest> [flags]   (see lab/rust/hunt/src/main.rs)");
            2
        }
    };
    std::process::exit(code);
}

// ------------------------------------------------------------- selftest ---

/// Reproduce every byte and every per-law bbox of the JS goldens, then report
/// throughput on the same outlines. The benchmark is folded in here
/// deliberately: a speed number can then only be printed by a build that has
/// just proven itself correct, which is the only kind worth quoting.
fn selftest(args: &[String], root: &Path) -> i32 {
    let fpath = at_root(root, &opt(args, "fixtures").unwrap_or_else(|| "lab/rust/fixtures/golden.bin".into()));
    let fx = match io::read_fixtures(&fpath) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("cannot read {}: {e}", fpath.display());
            eprintln!("generate it with: npm run rust:certify");
            return 2;
        }
    };

    // The law LUTs must match the fixture LUTs bit for bit AND in order — the
    // sweep's hit order is the law order, so a reordering is a silent diff.
    let lw = laws::build();
    let mut law_diffs = 0usize;
    if fx.laws.len() != laws::N_LAWS {
        println!("LAW COUNT MISMATCH: fixtures {} vs engine {}", fx.laws.len(), laws::N_LAWS);
        law_diffs += 1;
    }
    for (i, (name, lut, cov_min)) in fx.laws.iter().enumerate().take(laws::N_LAWS) {
        if laws::LAW_NAMES[i] != name {
            println!("LAW ORDER MISMATCH at {i}: fixtures '{name}' vs engine '{}'", laws::LAW_NAMES[i]);
            law_diffs += 1;
            continue;
        }
        if &lw.luts[i] != lut { println!("LAW LUT MISMATCH: {name}"); law_diffs += 1; }
        if lw.cov_min[i] != *cov_min { println!("LAW covMin MISMATCH: {name}"); law_diffs += 1; }
    }

    let mut faces: Vec<Option<Face>> = Vec::new();
    for f in &fx.fonts {
        let p = at_root(root, &f.path);
        match Face::load(&p) {
            Ok(mut face) => {
                if f.is_cff { face.gid_map = Some(f.gid_map.iter().copied().collect()); }
                faces.push(Some(face));
            }
            Err(e) => { println!("FONT LOAD FAILED {}: {e}", f.path); faces.push(None); }
        }
    }

    let t0 = Instant::now();
    let (mut byte_diffs, mut null_diffs, mut bbox_diffs) = (0u64, 0u64, 0u64);
    let mut worst = 0i32;
    let mut worst_case = String::new();
    let mut raster = Raster::new();
    let mut cov = vec![0u8; 64 * 64];
    for (ci, c) in fx.cases.iter().enumerate() {
        let Some(face) = faces[c.font].as_ref() else { null_diffs += 1; continue };
        let scaled = face.scale(c.cp, c.em64x, c.em64y);
        match (&scaled, &c.cov) {
            (None, None) => continue,
            (None, Some(_)) | (Some(_), None) => { null_diffs += 1; continue; }
            (Some(s), Some(want)) => {
                let (w, h) = (c.w as i32, c.h as i32);
                if cov.len() < (w * h) as usize { cov.resize((w * h) as usize, 0); }
                let coarse = render(s, c.px64, c.py64, w, h, &mut raster, &mut cov);
                let (mut d, mut wst) = (0u64, 0i32);
                for i in 0..(w * h) as usize {
                    let dv = (cov[i] as i32 - want[i] as i32).abs();
                    if dv != 0 { d += 1; if dv > wst { wst = dv; } }
                }
                if d > 0 {
                    byte_diffs += d;
                    if wst > worst {
                        worst = wst;
                        worst_case = format!("case {ci}: {} cp{} em64({},{}) pen({},{})",
                            fx.fonts[c.font].path, c.cp, c.em64x, c.em64y, c.px64, c.py64);
                    }
                }
                for (li, want_box) in c.boxes.iter().enumerate().take(laws::N_LAWS) {
                    let got = bbox_at(&cov, w, coarse, lw.cov_min[li])
                        .map(|(x0, y0, bw, bh)| (x0 as i16, y0 as i16, bw as i16, bh as i16));
                    if got != *want_box { bbox_diffs += 1; }
                }
            }
        }
    }
    let dt = t0.elapsed().as_secs_f64();
    let total = byte_diffs + null_diffs + bbox_diffs + law_diffs as u64;
    println!("{} cases in {dt:.2}s: {byte_diffs} byte diffs, {null_diffs} null diffs, {bbox_diffs} bbox diffs, {law_diffs} law diffs",
        fx.cases.len());
    if total != 0 {
        if !worst_case.is_empty() { println!("worst |d|={worst} at {worst_case}"); }
        println!("SELFTEST FAILED");
        return 1;
    }
    println!("SELFTEST CERTIFIED: 0 diffs");
    bench(&faces, &fx);
    0
}

/// Throughput on the certified path — printed by `selftest` and nowhere else.
fn bench(faces: &[Option<Face>], fx: &io::Fixtures) {
    use rayon::prelude::*;
    let Some((fi, face)) = faces.iter().enumerate().find_map(|(i, f)| f.as_ref().map(|f| (i, f))) else { return };
    let (w, h) = (sweep::W, sweep::H);
    let em = 1024.0;
    let scaled: Vec<_> = (33..127u32).filter_map(|cp| face.scale(cp, em, em)).collect();
    if scaled.is_empty() { return; }

    let t0 = Instant::now();
    let mut n = 0u64;
    {
        let mut raster = Raster::new();
        let mut cov = vec![0u8; (w * h) as usize];
        let mut sink = 0u64;
        for s in &scaled {
            for fy in 0..64 {
                for fx in 0..64 {
                    if let Some((x0, _, _, _)) = render(s, sweep::PENX * 64 + fx, sweep::BASEY * 64 + fy, w, h, &mut raster, &mut cov) {
                        sink += x0 as u64;
                    }
                    n += 1;
                }
            }
        }
        std::hint::black_box(sink);
    }
    let dt1 = t0.elapsed().as_secs_f64();

    let t0 = Instant::now();
    let work: Vec<(usize, i32)> = (0..scaled.len()).flat_map(|i| (0..64).map(move |fy| (i, fy))).collect();
    let n3: u64 = work.par_iter().map(|&(i, fy)| {
        let mut raster = Raster::new();
        let mut cov = vec![0u8; (w * h) as usize];
        let mut sink = 0u64;
        for fx in 0..64 {
            if let Some((x0, _, _, _)) = render(&scaled[i], sweep::PENX * 64 + fx, sweep::BASEY * 64 + fy, w, h, &mut raster, &mut cov) {
                sink += x0 as u64;
            }
        }
        std::hint::black_box(sink);
        64
    }).sum();
    let dt3 = t0.elapsed().as_secs_f64();
    println!("bench ({} em64={em}, {} glyphs × 4096 phases): 1 core {:.0} renders/s · {} cores {:.0} renders/s",
        fx.fonts[fi].path.rsplit(['/', '\\']).next().unwrap_or(""), scaled.len(),
        n as f64 / dt1, rayon::current_num_threads(), n3 as f64 / dt3);
}

// ---------------------------------------------------------------- sweep ---

fn run_sweep(args: &[String], root: PathBuf) -> i32 {
    let Some(fonts) = list(args, "fonts") else {
        eprintln!("sweep needs --fonts <a.ttf,b.cff> or --fonts all");
        eprintln!("  (the warm-start 'faces the proven families name' default lives in lab/sweep.mjs;");
        eprintln!("   this engine is the exhaustive one, so it makes you say what you enumerated)");
        return 2;
    };
    let p = sweep::SweepParams {
        targets: opt(args, "targets").unwrap_or_else(|| "default".into()),
        fonts,
        ems: range(&opt(args, "ems").unwrap_or_else(|| "700..1100".into())),
        at: list(args, "at").map(|v| v.iter().filter_map(|s| s.parse().ok()).collect()),
        xstep: num(args, "xstep", 1),
        ystep: num(args, "ystep", 1),
        min_dim: num(args, "min-dim", 0.75),
        wobble: if flag(args, "wobble") { num(args, "wobble", 10.0) } else { 0.0 },
        screen: num(args, "screen", 6),
        dims_only: flag(args, "dims-only"),
        report: opt(args, "report").map(|r| at_root(&root, &r)),
        ckpt: opt(args, "ckpt").map(|r| at_root(&root, &r)),
        root,
    };
    match sweep::run(&p) {
        Ok(()) => 0,
        Err(e) => { eprintln!("sweep failed: {e}"); 1 }
    }
}

// ---------------------------------------------------------------- probe ---

fn run_probe(args: &[String], root: PathBuf) -> i32 {
    let Some(fonts) = list(args, "fonts") else { eprintln!("probe needs --fonts"); return 2 };
    let (Some(ex), Some(ey)) = (opt(args, "ex"), opt(args, "ey")) else {
        eprintln!("probe needs --ex a..b and --ey a..b — the asymmetry IS the tool");
        return 2;
    };
    let frame = opt(args, "frame").unwrap_or_else(|| "60x60".into());
    let mut fit = frame.split('x');
    let fw: i32 = fit.next().and_then(|s| s.parse().ok()).unwrap_or(60);
    let fh: i32 = fit.next().and_then(|s| s.parse().ok()).unwrap_or(60);
    let pen = opt(args, "pen").unwrap_or_else(|| "12,44".into());
    let mut pit = pen.split(',');
    let penx: i32 = pit.next().and_then(|s| s.parse().ok()).unwrap_or(12);
    let basey: i32 = pit.next().and_then(|s| s.parse().ok()).unwrap_or(44);
    let p = probe::ProbeParams {
        targets: opt(args, "targets").unwrap_or_else(|| "default".into()),
        fonts,
        exr: range(&ex),
        eyr: range(&ey),
        laws: list(args, "laws").unwrap_or_else(|| laws::LAW_NAMES.iter().map(|s| s.to_string()).collect()),
        nt: num(args, "nt", 4),
        frame: (fw, fh),
        pen: (penx, basey),
        fy: num(args, "fy", 0),
        near: flag(args, "near"),
        report: opt(args, "report").map(|r| at_root(&root, &r)),
        ckpt: opt(args, "ckpt").map(|r| at_root(&root, &r)),
        root,
    };
    match probe::run_probe(&p) {
        Ok(()) => 0,
        Err(e) => { eprintln!("probe failed: {e}"); 1 }
    }
}

// -------------------------------------------------------------- harvest ---

fn run_harvest(args: &[String], root: &Path) -> i32 {
    let Some(doc) = opt(args, "doc") else {
        eprintln!("harvest needs --doc <DOC> (a folder under lab/pages/ — run lab/ingest.mjs first)");
        return 2;
    };
    let p = harvest::HarvestParams {
        out: opt(args, "out").unwrap_or_else(|| doc.clone()),
        doc,
        pages: list(args, "pages").map(|v| v.iter().filter_map(|s| s.parse().ok()).collect()),
        min_obs: num(args, "min-obs", 3),
        max_var: num(args, "max-var", 8),
        maxw: num(args, "maxw", 26),
        maxh: num(args, "maxh", 26),
        dry: flag(args, "dry"),
    };
    match harvest::run(root, &p) {
        Ok(()) => 0,
        Err(e) => { eprintln!("harvest failed: {e}"); 1 }
    }
}
