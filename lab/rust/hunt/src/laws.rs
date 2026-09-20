// laws — the blend laws of ../../families.mjs as cov→byte LUTs.
//
// **The ORDER is load-bearing, not cosmetic.** `lab/sweep.mjs` iterates
// `LAW_NAMES`, so the order below is the order hits come out in, and the
// certification compares hit lists position by position. This array is that
// export read top to bottom; changing one without the other makes the cert
// fail, which is the intended alarm.
//
//   fz        mupdf's own composite of black over white   (../../../docs/LAWS.md §2)
//   src       plain source-over, no >>7 correction
//   fzLin     fz + the eDiscovery +1 post-law on light bytes            (§4)
//   srcLin    src + the same post-law
//
// **Four, not six.** `families.mjs` also names `fzLin254` (the nimbusrom
// "raw 254 → 255") and `mid` (the Calibri midpoint push), and measurement says
// both are `fzLin` — identical on all 256 coverages. They stay there as the
// names families were proven under; they do not belong in a search, where
// enumerating them reported every linear hit three times and answered "which
// law?" with whichever alias came first.
//
// cov_min is the smallest coverage a law renders as ink (byte < pgm.INK=250).
// The LUTs are monotone in coverage, so it is the threshold at which a
// candidate's bbox must be measured — and it MUST be the law's own, not a
// constant. A fixed threshold counts the faint 250..254 fringe as ink and
// makes every such glyph measure 1–2 px too wide, rejecting the RIGHT config
// before its bytes are ever compared.

pub const N_LAWS: usize = 4;
pub const LAW_NAMES: [&str; N_LAWS] = ["fz", "src", "fzLin", "srcLin"];

pub struct Laws {
    pub luts: [[u8; 256]; N_LAWS],
    pub cov_min: [u8; N_LAWS],
}

fn lin(v: i32) -> i32 { if (128..=254).contains(&v) { v + 1 } else { v } }

pub fn build() -> Laws {
    let fz = |c: i32| (255 * (256 - (c + (c >> 7)))) >> 8;
    let fns: [&dyn Fn(i32) -> i32; N_LAWS] = [
        &fz,
        &|c| 255 - c,
        &|c| lin(fz(c)),
        &|c| lin(255 - c),
    ];
    let mut luts = [[0u8; 256]; N_LAWS];
    let mut cov_min = [0u8; N_LAWS];
    for (li, f) in fns.iter().enumerate() {
        for c in 0..256 { luts[li][c] = f(c as i32) as u8; }
        let mut c = 0usize;
        while c < 256 && luts[li][c] >= 250 { c += 1; }
        cov_min[li] = c as u8;
    }
    Laws { luts, cov_min }
}
