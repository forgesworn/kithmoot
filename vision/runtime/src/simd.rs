//! Four spatial lanes. Bounds are checked by the slice-based entry points;
//! unaligned intrinsic loads/stores never read beyond an input row.

#[cfg(target_arch = "aarch64")]
type Raw = std::arch::aarch64::float32x4_t;
#[cfg(target_arch = "x86_64")]
type Raw = std::arch::x86_64::__m128;
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
type Raw = std::arch::wasm32::v128;
#[cfg(not(any(
    target_arch = "aarch64",
    target_arch = "x86_64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
type Raw = [f32; 4];

#[derive(Clone, Copy)]
pub struct V4(Raw);

impl V4 {
    #[inline(always)]
    pub fn splat(value: f32) -> Self {
        #[cfg(target_arch = "aarch64")]
        unsafe {
            Self(std::arch::aarch64::vdupq_n_f32(value))
        }
        #[cfg(target_arch = "x86_64")]
        unsafe {
            Self(std::arch::x86_64::_mm_set1_ps(value))
        }
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        {
            Self(std::arch::wasm32::f32x4_splat(value))
        }
        #[cfg(not(any(
            target_arch = "aarch64",
            target_arch = "x86_64",
            all(target_arch = "wasm32", target_feature = "simd128")
        )))]
        {
            Self([value; 4])
        }
    }

    #[inline(always)]
    fn load(values: &[f32]) -> Self {
        assert!(values.len() >= 4);
        // SAFETY: length checked above; every target permits unaligned loads.
        #[cfg(target_arch = "aarch64")]
        unsafe {
            Self(std::arch::aarch64::vld1q_f32(values.as_ptr()))
        }
        #[cfg(target_arch = "x86_64")]
        unsafe {
            Self(std::arch::x86_64::_mm_loadu_ps(values.as_ptr()))
        }
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        unsafe {
            Self(std::arch::wasm32::v128_load(values.as_ptr().cast()))
        }
        #[cfg(not(any(
            target_arch = "aarch64",
            target_arch = "x86_64",
            all(target_arch = "wasm32", target_feature = "simd128")
        )))]
        {
            Self(values[..4].try_into().unwrap())
        }
    }

    #[inline(always)]
    pub fn padded<const STRIDE: usize>(row: &[f32], first: isize) -> Self {
        if first >= 0 {
            let at = first as usize;
            if STRIDE == 1 && at + 4 <= row.len() {
                return Self::load(&row[at..]);
            }
            if STRIDE == 2 && at + 8 <= row.len() {
                // SAFETY: all eight source floats lie within this row.
                #[cfg(target_arch = "aarch64")]
                unsafe {
                    return Self(std::arch::aarch64::vld2q_f32(row.as_ptr().add(at)).0);
                }
                #[cfg(target_arch = "x86_64")]
                unsafe {
                    use std::arch::x86_64::*;
                    return Self(_mm_shuffle_ps::<136>(
                        _mm_loadu_ps(row.as_ptr().add(at)),
                        _mm_loadu_ps(row.as_ptr().add(at + 4)),
                    ));
                }
                #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
                unsafe {
                    use std::arch::wasm32::*;
                    return Self(i32x4_shuffle::<0, 2, 4, 6>(
                        v128_load(row.as_ptr().add(at).cast()),
                        v128_load(row.as_ptr().add(at + 4).cast()),
                    ));
                }
            }
        }
        let mut values = [0.0; 4];
        for (lane, value) in values.iter_mut().enumerate() {
            let at = first + (lane * STRIDE) as isize;
            if at >= 0 && (at as usize) < row.len() {
                *value = row[at as usize];
            }
        }
        Self::load(&values)
    }

    #[inline(always)]
    pub fn accumulate(self, input: Self, weight: f32) -> Self {
        #[cfg(target_arch = "aarch64")]
        unsafe {
            Self(std::arch::aarch64::vfmaq_n_f32(self.0, input.0, weight))
        }
        #[cfg(target_arch = "x86_64")]
        unsafe {
            use std::arch::x86_64::*;
            Self(_mm_add_ps(self.0, _mm_mul_ps(input.0, _mm_set1_ps(weight))))
        }
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        {
            use std::arch::wasm32::*;
            Self(f32x4_add(self.0, f32x4_mul(input.0, f32x4_splat(weight))))
        }
        #[cfg(not(any(
            target_arch = "aarch64",
            target_arch = "x86_64",
            all(target_arch = "wasm32", target_feature = "simd128")
        )))]
        {
            Self(std::array::from_fn(|i| self.0[i] + input.0[i] * weight))
        }
    }

    #[inline(always)]
    pub fn relu(self) -> Self {
        #[cfg(target_arch = "aarch64")]
        unsafe {
            Self(std::arch::aarch64::vmaxq_f32(
                self.0,
                std::arch::aarch64::vdupq_n_f32(0.0),
            ))
        }
        #[cfg(target_arch = "x86_64")]
        unsafe {
            Self(std::arch::x86_64::_mm_max_ps(
                self.0,
                std::arch::x86_64::_mm_setzero_ps(),
            ))
        }
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        {
            Self(std::arch::wasm32::f32x4_max(
                self.0,
                std::arch::wasm32::f32x4_splat(0.0),
            ))
        }
        #[cfg(not(any(
            target_arch = "aarch64",
            target_arch = "x86_64",
            all(target_arch = "wasm32", target_feature = "simd128")
        )))]
        {
            Self(self.0.map(|v| v.max(0.0)))
        }
    }

    #[inline(always)]
    pub fn store(self, destination: &mut [f32]) {
        assert!(destination.len() <= 4);
        let mut tail = [0.0; 4];
        let pointer = if destination.len() == 4 {
            destination.as_mut_ptr()
        } else {
            tail.as_mut_ptr()
        };
        // SAFETY: the destination or tail has four writable unaligned lanes.
        #[cfg(target_arch = "aarch64")]
        unsafe {
            std::arch::aarch64::vst1q_f32(pointer, self.0);
        }
        #[cfg(target_arch = "x86_64")]
        unsafe {
            std::arch::x86_64::_mm_storeu_ps(pointer, self.0);
        }
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        unsafe {
            std::arch::wasm32::v128_store(pointer.cast(), self.0);
        }
        #[cfg(not(any(
            target_arch = "aarch64",
            target_arch = "x86_64",
            all(target_arch = "wasm32", target_feature = "simd128")
        )))]
        unsafe {
            std::ptr::copy_nonoverlapping(self.0.as_ptr(), pointer, 4);
        }
        if destination.len() != 4 {
            destination.copy_from_slice(&tail[..destination.len()]);
        }
    }
}
