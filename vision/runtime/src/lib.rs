//! Original MIT inference for the experimental v1 network. No third-party
//! crates, network access, model downloads, recognition or telemetry.
//! Weights are separate data. Loading a file is not model qualification.

mod faces;
mod ffi;
mod kernels;
mod simd;

use kernels::{convolution, upsample, Layer, Tensor};

pub const PARAMETERS: usize = 30_086;
pub const WEIGHT_BYTES: usize = 8 + PARAMETERS * 4;
const SPECS: [(usize, usize, usize, usize, bool); 9] = [
    (3, 16, 3, 2, true),
    (16, 24, 3, 2, true),
    (24, 32, 3, 1, true),
    (32, 24, 3, 1, true),
    (24, 1, 1, 1, false),
    (24, 4, 1, 1, false),
    (40, 24, 3, 1, true),
    (24, 16, 3, 1, true),
    (16, 1, 1, 1, false),
];

const MOBILE_SPECS: [(usize, usize, usize, usize, bool); 11] = [
    (3, 16, 3, 2, true),
    (16, 24, 3, 2, true),
    (24, 32, 3, 1, true),
    (32, 24, 3, 1, true),
    (24, 1, 1, 1, false),
    (24, 4, 1, 1, false),
    (40, 40, 3, 1, true),
    (40, 24, 1, 1, true),
    (24, 24, 3, 1, true),
    (24, 16, 1, 1, true),
    (16, 1, 1, 1, false),
];

#[derive(Debug, PartialEq)]
pub enum Error {
    BadWeights,
    BadDimensions,
    BadInput,
    NonFiniteOutput,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Tasks {
    Faces,
    Matte,
    Both,
}

pub struct Model {
    layers: Vec<Layer>,
    mobile: bool,
}

impl Model {
    /// KVM1: four magic bytes, little-endian u32 parameter count, then
    /// little-endian f32 OIHW weights/biases in the documented layer order.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() < 8 {
            return Err(Error::BadWeights);
        }
        let mobile = match &bytes[..4] {
            b"KVM1" => false,
            b"KVM2" => true,
            _ => return Err(Error::BadWeights),
        };
        let parameters = if mobile { 19_974 } else { PARAMETERS };
        if bytes.len() != 8 + parameters * 4
            || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize != parameters
        {
            return Err(Error::BadWeights);
        }
        let mut values = Vec::with_capacity(parameters);
        for chunk in bytes[8..].chunks_exact(4) {
            let value = f32::from_le_bytes(chunk.try_into().unwrap());
            if !value.is_finite() {
                return Err(Error::BadWeights);
            }
            values.push(value);
        }
        let specs = if mobile {
            MOBILE_SPECS.as_slice()
        } else {
            SPECS.as_slice()
        };
        let mut layers = Vec::with_capacity(specs.len());
        let mut offset = 0;
        for (index, &(inputs, outputs, kernel, stride, relu)) in specs.iter().enumerate() {
            let depthwise = mobile && (index == 6 || index == 8);
            let count = (if depthwise { 1 } else { inputs }) * outputs * kernel * kernel;
            let weights = values[offset..offset + count].to_vec();
            offset += count;
            let bias = values[offset..offset + outputs].to_vec();
            offset += outputs;
            layers.push(Layer {
                inputs,
                outputs,
                kernel,
                stride,
                relu,
                depthwise,
                weights,
                bias,
            });
        }
        debug_assert_eq!(offset, parameters);
        Ok(Self { layers, mobile })
    }
}

struct Work {
    enc1: Tensor,
    enc2: Tensor,
    enc3: Tensor,
    face: Tensor,
    context: Tensor,
    matte1: Tensor,
    matte2: Tensor,
    wide: Tensor,
}

pub struct Engine {
    model: Model,
    pub width: usize,
    pub height: usize,
    rgb: Tensor,
    reference: Tensor,
    previous: Tensor,
    work: Work,
    alpha: Tensor,
    heat: Tensor,
    boxes: Tensor,
    valid: bool,
    tasks: Tasks,
    faces: [f32; faces::MAX_FACES * 4],
    face_count: usize,
    faces_usable: bool,
}

impl Engine {
    pub fn new(model: Model, width: usize, height: usize) -> Result<Self, Error> {
        check_size(width, height)?;
        let mobile = model.mobile;
        Ok(Self {
            model,
            width,
            height,
            rgb: Tensor::new(3, width, height),
            reference: Tensor::new(3, width, height),
            previous: Tensor::new(1, width, height),
            work: Work {
                enc1: Tensor::new(16, width / 2, height / 2),
                enc2: Tensor::new(24, width / 4, height / 4),
                enc3: Tensor::new(32, width / 4, height / 4),
                face: Tensor::new(24, width / 4, height / 4),
                context: Tensor::new(40, width, height),
                matte1: Tensor::new(24, width, height),
                matte2: Tensor::new(16, width, height),
                wide: Tensor::new(if mobile { 40 } else { 0 }, width, height),
            },
            alpha: Tensor::new(1, width, height),
            heat: Tensor::new(1, width / 4, height / 4),
            boxes: Tensor::new(4, width / 4, height / 4),
            valid: false,
            tasks: Tasks::Both,
            faces: [0.0; faces::MAX_FACES * 4],
            face_count: 0,
            faces_usable: false,
        })
    }

    /// Reallocate only when the source dimensions change. Reset temporal and
    /// reference buffers at that boundary, never reuse another camera's data.
    pub fn prepare(&mut self, width: usize, height: usize) -> Result<(), Error> {
        self.valid = false;
        check_size(width, height)?;
        if self.width == width && self.height == height {
            return Ok(());
        }
        let placeholder = Model {
            layers: Vec::new(),
            mobile: false,
        };
        let model = std::mem::replace(&mut self.model, placeholder);
        *self = Self::new(model, width, height)?;
        Ok(())
    }

    pub fn input_mut(&mut self, kind: u32) -> Option<&mut [f32]> {
        self.valid = false;
        match kind {
            0 => Some(&mut self.rgb.data),
            1 => Some(&mut self.reference.data),
            2 => Some(&mut self.previous.data),
            _ => None,
        }
    }

    pub fn output(&self, kind: u32) -> Option<&[f32]> {
        if !self.valid {
            return None;
        }
        match kind {
            0 if self.tasks != Tasks::Faces => Some(&self.alpha.data),
            1 if self.tasks != Tasks::Matte => Some(&self.heat.data),
            2 if self.tasks != Tasks::Matte => Some(&self.boxes.data),
            3 if self.tasks != Tasks::Matte => Some(&self.faces[..self.face_count * 4]),
            _ => None,
        }
    }

    pub fn faces_usable(&self) -> bool {
        self.valid && self.faces_usable
    }

    /// The prepared engine reuses every tensor allocation across frames.
    /// Reference/temporal evidence is explicitly enabled per frame.
    pub fn run(&mut self, reference_valid: bool, previous_valid: bool) -> Result<(), Error> {
        self.run_tasks(reference_valid, previous_valid, Tasks::Both)
    }

    pub fn run_tasks(
        &mut self,
        reference_valid: bool,
        previous_valid: bool,
        tasks: Tasks,
    ) -> Result<(), Error> {
        self.valid = false;
        self.tasks = tasks;
        self.faces_usable = false;
        self.face_count = 0;
        if !normalised(&self.rgb.data)
            || (reference_valid && !normalised(&self.reference.data))
            || (previous_valid && !normalised(&self.previous.data))
        {
            return Err(Error::BadInput);
        }
        let l = &self.model.layers;
        let b = &mut self.work;
        convolution(&l[0], &self.rgb, &mut b.enc1);
        convolution(&l[1], &b.enc1, &mut b.enc2);
        convolution(&l[2], &b.enc2, &mut b.enc3);
        if tasks != Tasks::Matte {
            convolution(&l[3], &b.enc3, &mut b.face);
            convolution(&l[4], &b.face, &mut self.heat);
            convolution(&l[5], &b.face, &mut self.boxes);
            if self
                .heat
                .data
                .iter()
                .chain(self.boxes.data.iter())
                .any(|v| !v.is_finite())
            {
                return Err(Error::NonFiniteOutput);
            }
            for value in &mut self.boxes.data {
                *value = 1.0 / (1.0 + (-*value).exp());
            }
            (self.face_count, self.faces_usable) = faces::decode(
                &self.heat.data,
                &self.boxes.data,
                self.heat.width,
                self.heat.height,
                &mut self.faces,
            );
        }
        if tasks == Tasks::Faces {
            self.valid = true;
            return Ok(());
        }
        let plane = self.width * self.height;
        b.context.data[..3 * plane].copy_from_slice(&self.rgb.data);
        if reference_valid {
            b.context.data[3 * plane..6 * plane].copy_from_slice(&self.reference.data);
        } else {
            b.context.data[3 * plane..6 * plane].fill(0.0);
        }
        b.context.data[6 * plane..7 * plane].fill(if reference_valid { 1.0 } else { 0.0 });
        if previous_valid {
            b.context.data[7 * plane..8 * plane].copy_from_slice(&self.previous.data);
        } else {
            b.context.data[7 * plane..8 * plane].fill(0.0);
        }
        upsample(&b.enc3, &mut b.context, 8);
        if self.model.mobile {
            b.wide.channels = 40;
            convolution(&l[6], &b.context, &mut b.wide);
            convolution(&l[7], &b.wide, &mut b.matte1);
            b.wide.channels = 24;
            convolution(&l[8], &b.matte1, &mut b.wide);
            convolution(&l[9], &b.wide, &mut b.matte2);
            convolution(&l[10], &b.matte2, &mut self.alpha);
        } else {
            convolution(&l[6], &b.context, &mut b.matte1);
            convolution(&l[7], &b.matte1, &mut b.matte2);
            convolution(&l[8], &b.matte2, &mut self.alpha);
        }
        if self.alpha.data.iter().any(|v| !v.is_finite()) {
            return Err(Error::NonFiniteOutput);
        }
        for value in &mut self.alpha.data {
            *value = 1.0 / (1.0 + (-*value).exp());
        }
        self.valid = true;
        Ok(())
    }

    pub fn workspace_bytes(&self) -> usize {
        let b = &self.work;
        [
            &self.rgb,
            &self.reference,
            &self.previous,
            &b.enc1,
            &b.enc2,
            &b.enc3,
            &b.face,
            &b.context,
            &b.matte1,
            &b.matte2,
            &b.wide,
            &self.alpha,
            &self.heat,
            &self.boxes,
        ]
        .iter()
        .map(|tensor| tensor.data.capacity() * 4)
        .sum()
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let b = &mut self.work;
        for tensor in [
            &mut self.rgb,
            &mut self.reference,
            &mut self.previous,
            &mut b.enc1,
            &mut b.enc2,
            &mut b.enc3,
            &mut b.face,
            &mut b.context,
            &mut b.matte1,
            &mut b.matte2,
            &mut b.wide,
            &mut self.alpha,
            &mut self.heat,
            &mut self.boxes,
        ] {
            tensor.data.fill(0.0);
        }
    }
}

fn normalised(data: &[f32]) -> bool {
    data.iter()
        .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
}
fn check_size(width: usize, height: usize) -> Result<(), Error> {
    if width < 16
        || height < 16
        || width % 4 != 0
        || height % 4 != 0
        || width > 512
        || height > 512
        || width * height > 65_536
    {
        Err(Error::BadDimensions)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn zero_model() -> Model {
        let mut bytes = vec![0; WEIGHT_BYTES];
        bytes[..4].copy_from_slice(b"KVM1");
        bytes[4..8].copy_from_slice(&(PARAMETERS as u32).to_le_bytes());
        Model::from_bytes(&bytes).unwrap()
    }

    #[test]
    fn rejects_malformed_weights_and_dimensions() {
        assert!(Model::from_bytes(b"bad").is_err());
        let mut bytes = vec![0; WEIGHT_BYTES];
        bytes[..4].copy_from_slice(b"KVM1");
        bytes[4..8].copy_from_slice(&(PARAMETERS as u32).to_le_bytes());
        bytes[8..12].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(Model::from_bytes(&bytes).is_err());
        assert!(Engine::new(zero_model(), 15, 96).is_err());
        assert!(Engine::new(zero_model(), 512, 512).is_err());
    }

    #[test]
    fn prepared_frames_reuse_buffers_and_invalid_input_invalidates_outputs() {
        let mut engine = Engine::new(zero_model(), 32, 32).unwrap();
        let address = engine.input_mut(0).unwrap().as_ptr();
        let bytes = engine.workspace_bytes();
        engine.run(false, false).unwrap();
        assert!(engine.output(0).unwrap().iter().all(|v| *v == 0.5));
        engine.run(false, false).unwrap();
        assert_eq!(bytes, engine.workspace_bytes());
        assert_eq!(address, engine.input_mut(0).unwrap().as_ptr());
        engine.input_mut(0).unwrap()[1] = f32::NAN;
        assert_eq!(engine.run(false, false), Err(Error::BadInput));
        assert!(engine.output(0).is_none());
        engine.input_mut(0).unwrap()[1] = 0.0;
        engine.run(false, false).unwrap();
        assert_eq!(engine.prepare(0, 0), Err(Error::BadDimensions));
        assert!(engine.output(0).is_none());
    }

    #[test]
    fn simd_add_matches_scalar_for_edges_and_remainders() {
        for len in 0..35 {
            let input: Vec<_> = (0..len).map(|v| v as f32 / 17.0).collect();
            let mut output = vec![0.7; len];
            kernels::add_scaled(&mut output, &input, 0.13);
            for (a, b) in output.iter().zip(input.iter()) {
                assert!((*a - (0.7 + b * 0.13)).abs() < 0.000001);
            }
        }
    }

    #[test]
    fn requesting_one_task_hides_the_other_tasks_previous_outputs() {
        let mut engine = Engine::new(zero_model(), 16, 16).unwrap();
        engine.run(false, false).unwrap();
        let alpha = engine.output(0).unwrap().to_vec();
        let faces = engine.output(1).unwrap().to_vec();
        engine.run_tasks(false, false, Tasks::Faces).unwrap();
        assert!(engine.output(0).is_none());
        assert_eq!(engine.output(1).unwrap(), faces);
        engine.run_tasks(false, false, Tasks::Matte).unwrap();
        assert_eq!(engine.output(0).unwrap(), alpha);
        assert!(engine.output(1).is_none());
        assert!(!engine.faces_usable());
    }
}
