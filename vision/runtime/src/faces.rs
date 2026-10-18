//! Same normalised face decoding as the training library. Capacity overflow,
//! no face or malformed geometry is unusable; do not keep a partial list.

pub const MAX_FACES: usize = 32;

pub fn decode(
    logits: &[f32],
    boxes: &[f32],
    width: usize,
    height: usize,
    result: &mut [f32; MAX_FACES * 4],
) -> (usize, bool) {
    result.fill(0.0);
    let plane = width * height;
    let mut count = 0;
    for y in 0..height {
        for x in 0..width {
            let at = y * width + x;
            let score = sigmoid(logits[at]);
            if score < 0.5 {
                continue;
            }
            let mut peak = true;
            for yy in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                    if sigmoid(logits[yy * width + xx]) > score {
                        peak = false;
                    }
                }
            }
            if !peak {
                continue;
            }
            if count == MAX_FACES {
                result.fill(0.0);
                return (0, false);
            }
            let cx = (x as f32 + boxes[at]) / width as f32;
            let cy = (y as f32 + boxes[plane + at]) / height as f32;
            let w = boxes[2 * plane + at];
            let h = boxes[3 * plane + at];
            let left = (cx - w / 2.0).max(0.0);
            let top = (cy - h / 2.0).max(0.0);
            let right = (cx + w / 2.0).min(1.0);
            let bottom = (cy + h / 2.0).min(1.0);
            if right <= left || bottom <= top {
                result.fill(0.0);
                return (0, false);
            }
            result[count * 4..count * 4 + 4].copy_from_slice(&[
                left,
                top,
                right - left,
                bottom - top,
            ]);
            count += 1;
        }
    }
    (count, count > 0)
}

fn sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value).exp())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_peak_is_returned_or_overflow_is_unusable() {
        let mut logits = vec![-10.0; 64];
        logits[2 * 8 + 2] = 10.0;
        logits[5 * 8 + 5] = 10.0;
        let boxes = vec![0.2; 256];
        let mut output = [0.0; MAX_FACES * 4];
        assert_eq!(decode(&logits, &boxes, 8, 8, &mut output), (2, true));
        assert!((output[2] - 0.2).abs() < 0.000001);
        logits.fill(0.0);
        assert_eq!(decode(&logits, &boxes, 8, 8, &mut output), (0, false));
        assert!(output.iter().all(|v| *v == 0.0));
    }
}
