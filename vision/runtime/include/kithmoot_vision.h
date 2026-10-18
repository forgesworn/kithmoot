#ifndef KITHMOOT_VISION_H
#define KITHMOOT_VISION_H
/* Original MIT C ABI. One owner/thread per handle. Inputs/outputs are borrowed
 * NCHW f32 views and become invalid after input access, resize, run or free.
 * This experimental engine does not certify a model's accuracy/provenance. */
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct KvEngine KvEngine;
enum KvFlags { KV_REFERENCE = 1, KV_PREVIOUS_ALPHA = 2, KV_FACES_ONLY = 4, KV_MATTE_ONLY = 8 };
enum KvInputs { KV_RGB = 0, KV_REFERENCE_RGB = 1, KV_PREVIOUS = 2 };
enum KvOutputs { KV_ALPHA = 0, KV_FACE_LOGITS = 1, KV_FACE_GEOMETRY = 2, KV_FACE_BOXES = 3 };
size_t kv_weight_bytes(void);
uint8_t *kv_alloc_weights(void);
void kv_free_weights(uint8_t *bytes);
KvEngine *kv_create(const uint8_t *bytes, size_t length, size_t width, size_t height);
void kv_free(KvEngine *engine);
uint32_t kv_prepare(KvEngine *engine, size_t width, size_t height);
float *kv_input_ptr(KvEngine *engine, uint32_t kind);
size_t kv_input_len(KvEngine *engine, uint32_t kind);
uint32_t kv_run(KvEngine *engine, uint32_t flags);
const float *kv_output_ptr(const KvEngine *engine, uint32_t kind);
size_t kv_output_len(const KvEngine *engine, uint32_t kind);
uint32_t kv_faces_usable(const KvEngine *engine);
size_t kv_workspace_bytes(const KvEngine *engine);
#ifdef __cplusplus
}
#endif
#endif
