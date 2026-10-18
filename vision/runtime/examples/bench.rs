use kithmoot_vision::{Engine, Model, Tasks};
use std::time::Instant;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let weights = std::fs::read(
        args.get(1)
            .expect("bench <weights.kvm> [frames] [width] [height]"),
    )
    .unwrap();
    let frames: usize = args.get(2).map_or(20, |v| v.parse().unwrap());
    let width: usize = args.get(3).map_or(160, |v| v.parse().unwrap());
    let height: usize = args.get(4).map_or(96, |v| v.parse().unwrap());
    let mode = args.get(5).map_or("both", |v| v.as_str());
    let tasks = match mode {
        "faces" => Tasks::Faces,
        "matte" => Tasks::Matte,
        "both" => Tasks::Both,
        _ => panic!("unknown task"),
    };
    assert!(frames > 0);
    let mut engine = Engine::new(Model::from_bytes(&weights).unwrap(), width, height).unwrap();
    for (index, value) in engine.input_mut(0).unwrap().iter_mut().enumerate() {
        *value = (index % 251) as f32 / 250.0;
    }
    for _ in 0..3 {
        engine.run_tasks(false, false, tasks).unwrap();
    }
    let mut timings = Vec::with_capacity(frames);
    for _ in 0..frames {
        let start = Instant::now();
        engine.run_tasks(false, false, tasks).unwrap();
        std::hint::black_box(engine.output(3));
        std::hint::black_box(engine.faces_usable());
        std::hint::black_box(engine.output(if tasks == Tasks::Faces { 1 } else { 0 }));
        timings.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    timings.sort_by(f64::total_cmp);
    println!("{{\"tasks\":\"{}\",\"frames\":{},\"width\":{},\"height\":{},\"mean_ms\":{},\"p50_ms\":{},\"p95_ms\":{},\"workspace_bytes\":{},\"weights_bytes\":{},\"qualified\":false}}",
        mode, frames, width, height, timings.iter().sum::<f64>() / frames as f64,
        timings[frames / 2], timings[(frames * 95 / 100).min(frames - 1)],
        engine.workspace_bytes(), weights.len());
}
