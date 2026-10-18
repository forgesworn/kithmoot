//! Planar f32 kernels. SIMD is across adjacent pixels; there is no im2col
//! allocation, dependency on a vendor ML SDK, or per-frame worker pool.

#[inline]
pub fn add_scaled(out: &mut [f32], input: &[f32], weight: f32) {
    debug_assert_eq!(out.len(), input.len());
    let count = out.len() / 4 * 4;
    for offset in (0..count).step_by(4) {
        // SAFETY: each block is within both same-length slices. These
        // intrinsics use unaligned loads/stores; the targets guarantee SIMD.
        #[cfg(target_arch = "aarch64")]
        unsafe {
            use std::arch::aarch64::*;
            let a = vld1q_f32(out.as_ptr().add(offset));
            let b = vld1q_f32(input.as_ptr().add(offset));
            vst1q_f32(
                out.as_mut_ptr().add(offset),
                vaddq_f32(a, vmulq_n_f32(b, weight)),
            );
        }
        #[cfg(target_arch = "x86_64")]
        unsafe {
            use std::arch::x86_64::*;
            let a = _mm_loadu_ps(out.as_ptr().add(offset));
            let b = _mm_loadu_ps(input.as_ptr().add(offset));
            _mm_storeu_ps(
                out.as_mut_ptr().add(offset),
                _mm_add_ps(a, _mm_mul_ps(b, _mm_set1_ps(weight))),
            );
        }
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        unsafe {
            use std::arch::wasm32::*;
            let a = v128_load(out.as_ptr().add(offset).cast());
            let b = v128_load(input.as_ptr().add(offset).cast());
            v128_store(
                out.as_mut_ptr().add(offset).cast(),
                f32x4_add(a, f32x4_mul(b, f32x4_splat(weight))),
            );
        }
        #[cfg(not(any(
            target_arch = "aarch64",
            target_arch = "x86_64",
            all(target_arch = "wasm32", target_feature = "simd128")
        )))]
        for i in offset..offset + 4 {
            out[i] += input[i] * weight;
        }
    }
    for offset in count..out.len() {
        out[offset] += input[offset] * weight;
    }
}

pub struct Tensor {
    pub channels: usize,
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

impl Tensor {
    pub fn new(channels: usize, width: usize, height: usize) -> Self {
        Self {
            channels,
            width,
            height,
            data: vec![0.0; channels * width * height],
        }
    }
}

pub struct Layer {
    pub inputs: usize,
    pub outputs: usize,
    pub kernel: usize,
    pub stride: usize,
    pub relu: bool,
    pub depthwise: bool,
    pub weights: Vec<f32>,
    pub bias: Vec<f32>,
}

pub fn convolution(layer: &Layer, input: &Tensor, out: &mut Tensor) {
    if layer.depthwise {
        depthwise(layer, input, out);
        return;
    }
    if layer.outputs >= 4 && layer.outputs % 4 == 0 {
        match (layer.kernel, layer.stride) {
            (3, 1) => {
                tiled::<3, 1>(layer, input, out);
                return;
            }
            (3, 2) => {
                tiled::<3, 2>(layer, input, out);
                return;
            }
            (1, 1) => {
                tiled::<1, 1>(layer, input, out);
                return;
            }
            _ => {}
        }
    }
    convolution_reference(layer, input, out)
}

pub fn convolution_reference(layer: &Layer, input: &Tensor, out: &mut Tensor) {
    debug_assert_eq!(input.channels, layer.inputs);
    debug_assert_eq!(out.channels, layer.outputs);
    let source_plane = input.width * input.height;
    let output_plane = out.width * out.height;
    let pad = layer.kernel / 2;
    for oc in 0..layer.outputs {
        let destination = &mut out.data[oc * output_plane..(oc + 1) * output_plane];
        destination.fill(layer.bias[oc]);
        for ic in 0..if layer.depthwise { 1 } else { layer.inputs } {
            for ky in 0..layer.kernel {
                for kx in 0..layer.kernel {
                    let filter_inputs = if layer.depthwise { 1 } else { layer.inputs };
                    let weight = layer.weights
                        [((oc * filter_inputs + ic) * layer.kernel + ky) * layer.kernel + kx];
                    for y in 0..out.height {
                        let iy = (y * layer.stride + ky) as isize - pad as isize;
                        if iy < 0 || iy >= input.height as isize {
                            continue;
                        }
                        let row = (if layer.depthwise { oc } else { ic }) * source_plane
                            + iy as usize * input.width;
                        if layer.stride == 1 {
                            let start = pad.saturating_sub(kx);
                            let end = out.width.min(input.width + pad - kx);
                            if end <= start {
                                continue;
                            }
                            let source = row + start + kx - pad;
                            let target = y * out.width + start;
                            add_scaled(
                                &mut destination[target..target + end - start],
                                &input.data[source..source + end - start],
                                weight,
                            );
                        } else {
                            for x in 0..out.width {
                                let ix = (x * layer.stride + kx) as isize - pad as isize;
                                if ix >= 0 && ix < input.width as isize {
                                    destination[y * out.width + x] +=
                                        input.data[row + ix as usize] * weight;
                                }
                            }
                        }
                    }
                }
            }
        }
        if layer.relu {
            for value in destination {
                *value = value.max(0.0);
            }
        }
    }
}

/// Four output channels x four spatial positions stay in registers across
/// all input channels. Each source vector is reused four times, and each
/// output vector is stored once, rather than loaded/stored per coefficient.
fn tiled<const KERNEL: usize, const STRIDE: usize>(
    layer: &Layer,
    input: &Tensor,
    out: &mut Tensor,
) {
    use crate::simd::V4;
    let plane = input.width * input.height;
    let target_plane = out.width * out.height;
    let channel_weights = layer.inputs * KERNEL * KERNEL;
    for oc in (0..layer.outputs).step_by(4) {
        for y in 0..out.height {
            for x in (0..out.width).step_by(4) {
                let mut a = V4::splat(layer.bias[oc]);
                let mut b = V4::splat(layer.bias[oc + 1]);
                let mut c = V4::splat(layer.bias[oc + 2]);
                let mut d = V4::splat(layer.bias[oc + 3]);
                for ic in 0..layer.inputs {
                    for ky in 0..KERNEL {
                        let iy = (y * STRIDE + ky) as isize - (KERNEL / 2) as isize;
                        if iy < 0 || iy >= input.height as isize {
                            continue;
                        }
                        let at = ic * plane + iy as usize * input.width;
                        let row = &input.data[at..at + input.width];
                        for kx in 0..KERNEL {
                            let vector = V4::padded::<STRIDE>(
                                row,
                                (x * STRIDE + kx) as isize - (KERNEL / 2) as isize,
                            );
                            let w = oc * channel_weights + (ic * KERNEL + ky) * KERNEL + kx;
                            a = a.accumulate(vector, layer.weights[w]);
                            b = b.accumulate(vector, layer.weights[w + channel_weights]);
                            c = c.accumulate(vector, layer.weights[w + 2 * channel_weights]);
                            d = d.accumulate(vector, layer.weights[w + 3 * channel_weights]);
                        }
                    }
                }
                if layer.relu {
                    a = a.relu();
                    b = b.relu();
                    c = c.relu();
                    d = d.relu();
                }
                let count = (out.width - x).min(4);
                let start = oc * target_plane + y * out.width + x;
                a.store(&mut out.data[start..start + count]);
                b.store(&mut out.data[start + target_plane..start + target_plane + count]);
                c.store(&mut out.data[start + 2 * target_plane..start + 2 * target_plane + count]);
                d.store(&mut out.data[start + 3 * target_plane..start + 3 * target_plane + count]);
            }
        }
    }
}

fn depthwise(layer: &Layer, input: &Tensor, out: &mut Tensor) {
    use crate::simd::V4;
    debug_assert_eq!(layer.kernel, 3);
    debug_assert_eq!(layer.stride, 1);
    let plane = input.width * input.height;
    for channel in 0..layer.inputs {
        for y in 0..out.height {
            for x in (0..out.width).step_by(4) {
                let mut sum = V4::splat(layer.bias[channel]);
                for ky in 0..3 {
                    let iy = (y + ky) as isize - 1;
                    if iy < 0 || iy >= input.height as isize {
                        continue;
                    }
                    let at = channel * plane + iy as usize * input.width;
                    let row = &input.data[at..at + input.width];
                    for kx in 0..3 {
                        sum = sum.accumulate(
                            V4::padded::<1>(row, (x + kx) as isize - 1),
                            layer.weights[channel * 9 + ky * 3 + kx],
                        );
                    }
                }
                if layer.relu {
                    sum = sum.relu();
                }
                let at = channel * plane + y * out.width + x;
                let count = (out.width - x).min(4);
                sum.store(&mut out.data[at..at + count]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn depthwise_matches_reference_at_edges_and_partial_vectors() {
        let mut input = Tensor::new(3, 7, 5);
        for (i, v) in input.data.iter_mut().enumerate() {
            *v = (i % 17) as f32 / 17.0;
        }
        let layer = Layer {
            inputs: 3,
            outputs: 3,
            kernel: 3,
            stride: 1,
            relu: true,
            depthwise: true,
            weights: (0..27).map(|i| i as f32 / 27.0 - 0.2).collect(),
            bias: vec![0.0; 3],
        };
        let mut actual = Tensor::new(3, 7, 5);
        let mut expected = Tensor::new(3, 7, 5);
        convolution(&layer, &input, &mut actual);
        convolution_reference(&layer, &input, &mut expected);
        for (a, b) in actual.data.iter().zip(&expected.data) {
            assert!((a - b).abs() < 0.00002);
        }
    }

    #[test]
    fn tiled_kernels_match_reference_at_padding_strides_and_partial_vectors() {
        for width in [4, 5, 8, 11] {
            for kernel in [1, 3] {
                for stride in [1, 2] {
                    let mut input = Tensor::new(3, width, 7);
                    for (i, v) in input.data.iter_mut().enumerate() {
                        *v = (i % 23) as f32 / 23.0;
                    }
                    let layer = Layer {
                        inputs: 3,
                        outputs: 8,
                        kernel,
                        stride,
                        relu: true,
                        depthwise: false,
                        weights: (0..8 * 3 * kernel * kernel)
                            .map(|i| (i % 13) as f32 / 13.0 - 0.4)
                            .collect(),
                        bias: vec![-0.2; 8],
                    };
                    let mut actual =
                        Tensor::new(8, width.div_ceil(stride), 7usize.div_ceil(stride));
                    let mut expected = Tensor::new(8, actual.width, actual.height);
                    convolution(&layer, &input, &mut actual);
                    convolution_reference(&layer, &input, &mut expected);
                    for (a, b) in actual.data.iter().zip(&expected.data) {
                        assert!((a - b).abs() < 0.00002, "{a} != {b}");
                    }
                }
            }
        }
    }
}

/// PyTorch interpolate(mode=bilinear, align_corners=false), NCHW, into an
/// existing channel range. No resampling tables or frame allocations.
pub fn upsample(input: &Tensor, out: &mut Tensor, first_channel: usize) {
    let source_plane = input.width * input.height;
    let target_plane = out.width * out.height;
    for channel in 0..input.channels {
        for y in 0..out.height {
            let fy = ((y as f32 + 0.5) * input.height as f32 / out.height as f32 - 0.5).max(0.0);
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(input.height - 1);
            let dy = fy - y0 as f32;
            for x in 0..out.width {
                let fx = ((x as f32 + 0.5) * input.width as f32 / out.width as f32 - 0.5).max(0.0);
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(input.width - 1);
                let dx = fx - x0 as f32;
                let base = channel * source_plane;
                let a = input.data[base + y0 * input.width + x0] * (1.0 - dx)
                    + input.data[base + y0 * input.width + x1] * dx;
                let b = input.data[base + y1 * input.width + x0] * (1.0 - dx)
                    + input.data[base + y1 * input.width + x1] * dx;
                out.data[(channel + first_channel) * target_plane + y * out.width + x] =
                    a * (1.0 - dy) + b * dy;
            }
        }
    }
}
