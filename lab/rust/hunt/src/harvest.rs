// harvest — the CONNECTED-COMPONENT harvester: ingested pages → ground-truth
// glyph windows, in the lab's one target format (PGM + index.json).
//
//   hunt harvest --doc EFTA01150379 --out h1
//
// ## Why this exists next to ../../harvest.mjs
//
// `lab/harvest.mjs` fits a cell lattice per band and cuts one window per cell.
// That is the right tool for a monospace producer and it is **useless on a
// proportional face**: the lattice is fictional, so the windows are glyph
// fragments cut at a pitch nothing actually uses, and matching against them
// proves nothing. This harvester needs no lattice and no candidate renderer —
// a glyph is a maximal 8-connected run of dark pixels — so it is the GENERAL
// one, and the monospace harvester is the special case.
//
// What it gives up in exchange is the lattice harvester's proof that the cut
// is right. A component cut is right by construction unless two glyphs touch,
// which is exactly what the width filter and the neighbour-diversity rule
// below are for.
//
// ## What makes a target trustworthy here
//
//   1. components: maximal 8-connected runs of px < INK, ≥3 px, smaller than
//      maxw × maxh (a wider run is two glyphs whose antialias touched);
//   2. dot merge: a dot sitting over a stem (≥50% x-overlap, ≤4 px gap, one
//      side dot-sized) is one glyph — i, j, ä and the rest;
//   3. lines from ink rows, baseline = the modal glyph bottom;
//   4. label = the nearest overlay char by x, within 5 px;
//   5. cluster byte-identical windows and PROMOTE one only when it was seen
//      ≥ --min-obs times with ≥2 distinct LEFT and ≥2 distinct RIGHT
//      neighbour labels, and its label vote is unanimous or a ≥90% majority
//      of ≥3. Same discipline as the lattice harvester, same reason: a window
//      contaminated by its neighbour differs per neighbour, so it can never
//      reach byte-identity across two of them.
//
// Labels are the producer's own OCR and are CLAIMS, not truth. If a renderer
// matches a target labelled 'O' with its '0', believe the pixels.
use crate::io::{read_pgm, write_pgm, Pgm};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// ../../pgm.mjs INK: a byte < 250 is ink, 250..255 is fringe or paper.
pub const INK: u8 = 250;
pub const MINPX: usize = 3;

#[derive(Clone, Copy)]
pub struct Comp { pub x0: i32, pub x1: i32, pub y0: i32, pub y1: i32 }

/// 8-connected dark components with the size filters.
pub fn components(pg: &Pgm, maxw: i32, maxh: i32) -> Vec<Comp> {
    let (w, h) = (pg.w as i32, pg.h as i32);
    let mut seen = vec![false; (w * h) as usize];
    let mut comps = Vec::new();
    let mut stack: Vec<i32> = Vec::with_capacity(1024);
    for i in 0..w * h {
        if pg.px[i as usize] >= INK || seen[i as usize] { continue; }
        stack.clear();
        stack.push(i);
        seen[i as usize] = true;
        let (mut x0, mut x1, mut y0, mut y1, mut n) = (w, 0, h, 0, 0usize);
        while let Some(j) = stack.pop() {
            n += 1;
            let (x, y) = (j % w, j / w);
            if x < x0 { x0 = x; }
            if x > x1 { x1 = x; }
            if y < y0 { y0 = y; }
            if y > y1 { y1 = y; }
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                    let k = ny * w + nx;
                    if !seen[k as usize] && pg.px[k as usize] < INK {
                        seen[k as usize] = true;
                        stack.push(k);
                    }
                }
            }
        }
        if n < MINPX || x1 - x0 >= maxw || y1 - y0 >= maxh { continue; }
        comps.push(Comp { x0, x1, y0, y1 });
    }
    comps
}

/// Vertical dot-over-stem merge, re-scanning after each growth because a
/// merged box can now overlap a component the first pass had walked past.
pub fn merge_dots(comps: &mut Vec<Comp>, maxw: i32, maxh: i32) -> Vec<Comp> {
    comps.sort_by(|a, b| a.x0.cmp(&b.x0).then(a.y0.cmp(&b.y0)));
    let mut v: Vec<Option<Comp>> = comps.iter().copied().map(Some).collect();
    let n = v.len();
    let mut i = 0usize;
    while i < n {
        let Some(mut a) = v[i] else { i += 1; continue };
        let mut j = i + 1;
        while j < n {
            let Some(b) = v[j] else { j += 1; continue };
            if b.x0 > a.x1 { break; }
            if (a.y1 - a.y0).min(b.y1 - b.y0) > 3 { j += 1; continue; }   // neither is a dot
            let ox = a.x1.min(b.x1) - a.x0.max(b.x0) + 1;
            if (ox as f64) < 0.5 * ((a.x1 - a.x0 + 1).min(b.x1 - b.x0 + 1)) as f64 { j += 1; continue; }
            if a.y0.max(b.y0) - a.y1.min(b.y1) > 4 { j += 1; continue; }
            a.x0 = a.x0.min(b.x0);
            a.x1 = a.x1.max(b.x1);
            a.y0 = a.y0.min(b.y0);
            a.y1 = a.y1.max(b.y1);
            v[i] = Some(a);
            v[j] = None;
            j = i + 1;
        }
        v[i] = Some(a);
        i += 1;
    }
    v.into_iter().flatten().filter(|c| c.x1 - c.x0 < maxw && c.y1 - c.y0 < maxh).collect()
}

pub struct Line { pub y0: i32, pub y1: i32, pub glyphs: Vec<Comp> }

/// Ink-row line assembly: rows that carry ink group into bands, and a glyph
/// joins the band its vertical centre falls in.
pub fn assemble_lines(glyphs: &[Comp], h: i32) -> Vec<Line> {
    let mut ink = vec![false; h as usize];
    for g in glyphs {
        for y in g.y0..=g.y1 { ink[y as usize] = true; }
    }
    let mut lines = Vec::new();
    let mut s = -1i32;
    for y in 0..=h {
        if y < h && ink[y as usize] {
            if s < 0 { s = y; }
        } else if s >= 0 {
            lines.push(Line { y0: s, y1: y - 1, glyphs: vec![] });
            s = -1;
        }
    }
    for g in glyphs {
        let cy = (g.y0 + g.y1) as f64 / 2.0;
        if let Some(l) = lines.iter_mut().find(|l| cy >= (l.y0 - 1) as f64 && cy <= (l.y1 + 1) as f64) {
            l.glyphs.push(*g);
        }
    }
    lines
}

// --------------------------------------------------------------- overlay ---

#[derive(Deserialize)]
struct WordsFile { words: Vec<Word> }

#[derive(Deserialize)]
struct Word {
    text: String,
    #[serde(default)]
    chars: Option<Vec<f64>>,
    px: WordPx,
}

#[derive(Deserialize)]
struct WordPx {
    #[serde(rename = "yBase")]
    y_base: f64,
}

// --------------------------------------------------------------- the run ---

/// One observation of one window: the bytes, plus everything the promotion
/// rules need to judge it.
struct Obs {
    w: i32,
    h: i32,
    bytes: Vec<u8>,
    label: Option<String>,
    left: String,
    right: String,
    dy: i32,
    x: i32,
    y: i32,
}

struct Cluster {
    w: i32,
    h: i32,
    bytes: Vec<u8>,
    obs: u64,
    labels: Vec<(String, u64)>,   // insertion order
    left: Vec<String>,
    right: Vec<String>,
    dys: Vec<(i32, u64)>,
    srcs: Vec<serde_json::Value>,
}

#[derive(Serialize)]
struct TargetRow {
    id: String,
    ch: String,
    cp: u32,
    variant: usize,
    w: i32,
    h: i32,
    dy: i32,
    #[serde(rename = "labelShare")]
    label_share: f64,
    obs: u64,
    srcs: Vec<serde_json::Value>,
}

pub struct HarvestParams {
    pub doc: String,
    pub out: String,
    pub pages: Option<Vec<i64>>,
    pub min_obs: u64,
    pub max_var: usize,
    pub maxw: i32,
    pub maxh: i32,
    pub dry: bool,
}

pub fn run(root: &Path, p: &HarvestParams) -> Result<(), String> {
    let dir = root.join("lab/pages").join(&p.doc);
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e} — run: node lab/ingest.mjs <pdf>", dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| {
            if !(n.starts_with("page-") && n.ends_with(".pgm")) { return false; }
            let num: String = n.chars().filter(|c| c.is_ascii_digit()).collect();
            match (&p.pages, num.parse::<i64>()) {
                (Some(ps), Ok(v)) => ps.contains(&v),
                (Some(_), Err(_)) => false,
                (None, _) => true,
            }
        })
        .collect();
    files.sort();
    if files.is_empty() { return Err(format!("no pages under {}", dir.display())); }

    // Pages are independent; the merge below is sequential and in page order,
    // so cluster identity never depends on which thread finished first.
    let per_page: Vec<(usize, Vec<Obs>, usize)> = files.par_iter().enumerate().map(|(pi, pf)| {
        let tag = pf.trim_end_matches(".pgm");
        let words: Vec<Word> = std::fs::read_to_string(dir.join(format!("{tag}.words.json")))
            .ok()
            .and_then(|s| serde_json::from_str::<WordsFile>(&s).ok())
            .map(|f| f.words)
            .unwrap_or_default();
        let Ok(pg) = read_pgm(&dir.join(pf)) else { return (pi, vec![], 0) };
        let (w, h) = (pg.w as i32, pg.h as i32);

        let mut comps = components(&pg, p.maxw, p.maxh);
        let n_comp = comps.len();
        let glyphs = merge_dots(&mut comps, p.maxw, p.maxh);
        let mut lines = assemble_lines(&glyphs, h);
        let mut out: Vec<Obs> = vec![];

        for line in &mut lines {
            line.glyphs.sort_by_key(|g| g.x0);
            if line.glyphs.len() < 3 { continue; }
            // baseline = modal glyph bottom, ties to the first seen
            let mut bots: Vec<(i32, u64)> = Vec::new();
            for g in &line.glyphs {
                match bots.iter_mut().find(|(y, _)| *y == g.y1) {
                    Some(e) => e.1 += 1,
                    None => bots.push((g.y1, 1)),
                }
            }
            let (mut baseline, mut best_n) = bots[0];
            for &(y, n) in &bots[1..] { if n > best_n { best_n = n; baseline = y; } }

            // overlay characters whose baseline falls in this line's band
            let mut chars: Vec<(f64, String)> = Vec::new();
            for wd in &words {
                if wd.px.y_base < (line.y0 - 2) as f64 || wd.px.y_base > (line.y1 + 4) as f64 { continue; }
                let Some(cx) = wd.chars.as_ref() else { continue };
                for (i, c) in wd.text.chars().enumerate() {
                    if i < cx.len() { chars.push((cx[i], c.to_string())); }
                }
            }
            chars.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

            let labels: Vec<Option<String>> = line.glyphs.iter().map(|g| {
                let mut bd = 5.0f64;
                let mut best = None;
                for c in &chars {
                    let d = (c.0 - g.x0 as f64).abs();
                    if d < bd { bd = d; best = Some(c.1.clone()); }
                }
                best
            }).collect();

            for (gi, g) in line.glyphs.iter().enumerate() {
                let (cw, chh) = (g.x1 - g.x0 + 1, g.y1 - g.y0 + 1);
                let mut bytes = vec![0u8; (cw * chh) as usize];
                for y in 0..chh {
                    for x in 0..cw {
                        bytes[(y * cw + x) as usize] = pg.px[((g.y0 + y) * w + g.x0 + x) as usize];
                    }
                }
                let nb = |i: Option<usize>| i.and_then(|i| labels.get(i).cloned().flatten()).unwrap_or_else(|| "␣".into());
                out.push(Obs {
                    w: cw, h: chh, bytes,
                    label: labels[gi].clone(),
                    left: nb(gi.checked_sub(1)),
                    right: nb(if gi + 1 < line.glyphs.len() { Some(gi + 1) } else { None }),
                    dy: g.y0 - baseline,
                    x: g.x0, y: g.y0,
                });
            }
        }
        (pi, out, n_comp)
    }).collect();

    // ---- merge, in page order ----
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut index: HashMap<(i32, i32, Vec<u8>), usize> = HashMap::new();
    let (mut total, mut labeled, mut raw_comps) = (0u64, 0u64, 0usize);
    for (pi, obs, n_comp) in &per_page {
        raw_comps += n_comp;
        for o in obs {
            total += 1;
            let key = (o.w, o.h, o.bytes.clone());
            let ci = match index.get(&key) {
                Some(&i) => i,
                None => {
                    clusters.push(Cluster { w: o.w, h: o.h, bytes: o.bytes.clone(), obs: 0,
                        labels: vec![], left: vec![], right: vec![], dys: vec![], srcs: vec![] });
                    index.insert(key, clusters.len() - 1);
                    clusters.len() - 1
                }
            };
            let cl = &mut clusters[ci];
            cl.obs += 1;
            match cl.dys.iter_mut().find(|(d, _)| *d == o.dy) { Some(e) => e.1 += 1, None => cl.dys.push((o.dy, 1)) }
            if !cl.left.contains(&o.left) { cl.left.push(o.left.clone()); }
            if !cl.right.contains(&o.right) { cl.right.push(o.right.clone()); }
            if let Some(ch) = &o.label {
                labeled += 1;
                match cl.labels.iter_mut().find(|(c, _)| c == ch) { Some(e) => e.1 += 1, None => cl.labels.push((ch.clone(), 1)) }
            }
            if cl.srcs.len() < 3 {
                cl.srcs.push(serde_json::json!({ "doc": p.doc, "page": pi + 1, "x": o.x, "y": o.y }));
            }
        }
    }

    // ---- promote ----
    struct Promoted<'a> { ch: String, cp: u32, share: f64, cl: &'a Cluster }
    let mut promoted: Vec<Promoted> = vec![];
    let (mut rej_obs, mut rej_nb, mut rej_label, mut by_majority) = (0usize, 0usize, 0usize, 0usize);
    for cl in &clusters {
        if cl.obs < p.min_obs { rej_obs += 1; continue; }
        if cl.left.len() < 2 || cl.right.len() < 2 { rej_nb += 1; continue; }
        if cl.labels.is_empty() { rej_label += 1; continue; }
        // Unanimous, or a ≥90% majority of ≥3 votes: the overlay itself
        // misreads, and the PIXELS of a repeated window are still truth when
        // its label vote is not unanimous.
        let mut votes = cl.labels.clone();
        votes.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        let (ch, top) = votes[0].clone();
        if cl.labels.len() != 1 {
            if top < 3 || (top as f64) / (cl.obs as f64) < 0.9 { rej_label += 1; continue; }
            by_majority += 1;
        }
        let cp = ch.chars().next().unwrap() as u32;
        promoted.push(Promoted { ch, cp, share: (top as f64) / (cl.obs as f64), cl });
    }

    // ---- group by codepoint, keep the most-observed variants ----
    let mut by_cp: Vec<(u32, Vec<&Promoted>)> = vec![];
    for pr in &promoted {
        match by_cp.iter_mut().find(|(cp, _)| *cp == pr.cp) {
            Some(e) => e.1.push(pr),
            None => by_cp.push((pr.cp, vec![pr])),
        }
    }
    by_cp.sort_by_key(|(cp, _)| *cp);
    let mut overflow = 0usize;
    let mut rows: Vec<TargetRow> = vec![];
    let mut pgms: Vec<(String, i32, i32, Vec<u8>)> = vec![];
    for (cp, list) in &mut by_cp {
        list.sort_by_key(|pr| std::cmp::Reverse(pr.cl.obs));
        if list.len() > p.max_var { overflow += list.len() - p.max_var; list.truncate(p.max_var); }
        for (i, pr) in list.iter().enumerate() {
            let id = format!("{cp}_v{}", i + 1);
            let dy = pr.cl.dys.iter().max_by_key(|(_, n)| *n).map(|(d, _)| *d).unwrap_or(0);
            rows.push(TargetRow {
                id: id.clone(), ch: pr.ch.clone(), cp: *cp, variant: i + 1,
                w: pr.cl.w, h: pr.cl.h, dy,
                label_share: (pr.share * 1000.0).round() / 1000.0,
                obs: pr.cl.obs, srcs: pr.cl.srcs.clone(),
            });
            pgms.push((id, pr.cl.w, pr.cl.h, pr.cl.bytes.clone()));
        }
    }

    println!("pages {}  components {raw_comps} -> {total} glyphs ({labeled} labeled)  clusters {}",
        files.len(), clusters.len());
    println!("promoted {} ({by_majority} by 90% majority label) -> {} targets, {} distinct chars \
        (variant overflow dropped: {overflow})", promoted.len(), rows.len(), by_cp.len());
    println!("rejected: obs<{} {rej_obs}, neighbour-diversity {rej_nb}, label-conflict {rej_label}", p.min_obs);
    let mut chars: Vec<&str> = rows.iter().map(|r| r.ch.as_str()).collect();
    chars.sort_unstable();
    chars.dedup();
    println!("{}", chars.concat());

    if p.dry { return Ok(()); }
    if rows.is_empty() { return Err("nothing promoted — no targets written".into()); }
    let out_dir = root.join("lab/targets").join(&p.out);
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    for (id, w, h, bytes) in &pgms {
        write_pgm(&out_dir.join(format!("{id}.pgm")), *w, *h, bytes).map_err(|e| e.to_string())?;
    }
    let index = serde_json::json!({
        "harvester": "connected-component (lab/rust)",
        "source": [p.doc],
        "note": "Windows are maximal 8-connected runs of ink (< 250), dot-merged, cut to their own \
                 bounding box — NO lattice and no candidate renderer, so this works on proportional \
                 faces where lab/harvest.mjs cannot. Promoted at >=min-obs byte-identical observations \
                 with >=2 distinct left AND right neighbour labels. dy = modal offset of the window top \
                 from the line baseline.",
        "targets": rows,
    });
    std::fs::write(out_dir.join("index.json"), serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    println!("\nwrote lab/targets/{}/index.json + {} PGMs", p.out, rows.len());
    Ok(())
}
