// fixed — the fixed-point primitives of ../../../ftclone/ftclone.mjs, reproduced with
// JS-double semantics (NOT FreeType's C semantics: ftclone is what is
// byte-certified against mupdf-wasm, so its f64 arithmetic is the law).

pub const ONE_PIXEL: i32 = 256;

#[inline(always)]
pub fn upscale(x: i32) -> i32 { x << 2 } // 26.6 -> 26.8
#[inline(always)]
pub fn trunc8(x: i32) -> i32 { x >> 8 }
#[inline(always)]
pub fn fract8(x: i32) -> i32 { x & 255 }

/// FT_MulFix exactly as ftclone.mjs computes it:
///   ab = a*b (f64 — exact for the integer magnitudes involved, and
///   IEEE-faithful for the FRACTIONAL points TTF composite components
///   produce), then floor((ab + (ab<0 ? 0x7FFF : 0x8000)) / 65536).
/// Division by 65536 only shifts the exponent, so floor(t/65536) is exact.
#[inline(always)]
pub fn mulfix(a: f64, b: f64) -> f64 {
    let ab = a * b;
    ((ab + if ab < 0.0 { 32767.0 } else { 32768.0 }) / 65536.0).floor()
}

/// FT_DivFix as JS: Math.trunc((a * 65536) / b) in f64.
#[inline(always)]
pub fn divfix(a: f64, b: f64) -> f64 { (a * 65536.0 / b).trunc() }

/// JS Math.round for the non-negative values the ×32 em64 scale trick uses
/// (Math.round = floor(x + 0.5) for x >= 0; Rust f64::round differs at -x.5).
#[inline(always)]
pub fn js_round_pos(x: f64) -> f64 {
    debug_assert!(x >= 0.0);
    (x + 0.5).floor()
}

/// FT_UDIV as ftclone's `udiv`: floor(a * br / 2^32) computed in f64.
/// a*br reaches ~2^55 here, so the f64 product ROUNDS — i128 exactness
/// would diverge from the certified oracle. br is the reciprocal
/// trunc(0xFFFFFFFF / d), itself f64-computed.
#[inline(always)]
pub fn udiv(a: f64, br: f64) -> i32 {
    ((a * br) / 4294967296.0).floor() as i32
}

/// The reciprocal ftclone computes as Math.trunc(0xFFFFFFFF / d)
/// (C signed division semantics: truncation toward zero, in f64).
#[inline(always)]
pub fn recip32(d: i32) -> f64 { (4294967295.0 / d as f64).trunc() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mulfix_matches_int_path() {
        // integer inputs must agree with the exact i64 formulation
        for &(a, b) in &[(16384i64, 40960i64), (-16384, 40960), (123, -456789), (0, 5)] {
            let ab = a * b;
            let want = (ab + if ab < 0 { 0x7FFF } else { 0x8000 }) >> 16;
            assert_eq!(mulfix(a as f64, b as f64) as i64, want, "a={a} b={b}");
        }
    }
}
