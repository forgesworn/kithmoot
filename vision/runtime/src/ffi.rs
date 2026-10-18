//! Thin C ABI shared by native/JNI hosts and WASM. Handles and returned views
//! have one owner. Never call concurrently or retain views after resize/free.

use crate::{Engine, Model, Tasks, WEIGHT_BYTES};

#[no_mangle]
pub extern "C" fn kv_weight_bytes() -> usize {
    WEIGHT_BYTES
}

#[no_mangle]
pub extern "C" fn kv_alloc_weights() -> *mut u8 {
    Box::into_raw(vec![0u8; WEIGHT_BYTES].into_boxed_slice()).cast::<u8>()
}

/// # Safety
/// `bytes` is a live allocation returned by kv_alloc_weights, freed once.
#[no_mangle]
pub unsafe extern "C" fn kv_free_weights(bytes: *mut u8) {
    if !bytes.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            bytes,
            WEIGHT_BYTES,
        )));
    }
}

/// # Safety
/// `bytes` points to WEIGHT_BYTES readable bytes for the duration of this call.
/// The returned engine must be used by one owner and freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn kv_create(
    bytes: *const u8,
    length: usize,
    width: usize,
    height: usize,
) -> *mut Engine {
    if bytes.is_null() || length < 8 || length > WEIGHT_BYTES {
        return std::ptr::null_mut();
    }
    let model = match Model::from_bytes(std::slice::from_raw_parts(bytes, length)) {
        Ok(model) => model,
        Err(_) => return std::ptr::null_mut(),
    };
    match Engine::new(model, width, height) {
        Ok(engine) => Box::into_raw(Box::new(engine)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// All functions below take a live, exclusively owned kv_create handle.
#[no_mangle]
pub unsafe extern "C" fn kv_free(engine: *mut Engine) {
    if !engine.is_null() {
        drop(Box::from_raw(engine));
    }
}

#[no_mangle]
pub unsafe extern "C" fn kv_prepare(engine: *mut Engine, width: usize, height: usize) -> u32 {
    engine
        .as_mut()
        .is_some_and(|e| e.prepare(width, height).is_ok()) as u32
}

#[no_mangle]
pub unsafe extern "C" fn kv_input_ptr(engine: *mut Engine, kind: u32) -> *mut f32 {
    engine
        .as_mut()
        .and_then(|e| e.input_mut(kind))
        .map_or(std::ptr::null_mut(), |v| v.as_mut_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn kv_input_len(engine: *mut Engine, kind: u32) -> usize {
    engine
        .as_mut()
        .and_then(|e| e.input_mut(kind))
        .map_or(0, |v| v.len())
}

#[no_mangle]
pub unsafe extern "C" fn kv_run(engine: *mut Engine, flags: u32) -> u32 {
    if flags & !15 != 0 {
        if let Some(e) = engine.as_mut() {
            e.valid = false;
        }
        return 0;
    }
    let tasks = match flags & 12 {
        4 => Tasks::Faces,
        8 => Tasks::Matte,
        _ => Tasks::Both,
    };
    engine
        .as_mut()
        .is_some_and(|e| e.run_tasks(flags & 1 != 0, flags & 2 != 0, tasks).is_ok()) as u32
}

#[no_mangle]
pub unsafe extern "C" fn kv_faces_usable(engine: *const Engine) -> u32 {
    engine.as_ref().is_some_and(|e| e.faces_usable()) as u32
}

#[no_mangle]
pub unsafe extern "C" fn kv_output_ptr(engine: *const Engine, kind: u32) -> *const f32 {
    engine
        .as_ref()
        .and_then(|e| e.output(kind))
        .map_or(std::ptr::null(), |v| v.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn kv_output_len(engine: *const Engine, kind: u32) -> usize {
    engine
        .as_ref()
        .and_then(|e| e.output(kind))
        .map_or(0, |v| v.len())
}

#[no_mangle]
pub unsafe extern "C" fn kv_workspace_bytes(engine: *const Engine) -> usize {
    engine.as_ref().map_or(0, |e| e.workspace_bytes())
}
