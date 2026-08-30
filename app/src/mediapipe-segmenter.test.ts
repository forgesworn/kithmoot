import { describe, it, expect } from 'vitest'
import { isSoftwareRenderer, preferredDelegate } from './mediapipe-segmenter.js'

/**
 * Real renderer strings, as the browsers actually report them.
 *
 * Copied rather than invented: the whole value of this check is that it
 * recognises what a machine with no GPU calls itself, and a made-up string
 * proves nothing about that.
 */
const SOFTWARE = [
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  'Google SwiftShader',
  'Mesa/X.org, llvmpipe (LLVM 15.0.7, 256 bits)',
  'llvmpipe (LLVM 12.0.0, 256 bits)',
  'Mesa softpipe',
  'Microsoft Basic Render Driver',
  'Apple Software Renderer',
]

const HARDWARE = [
  'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Mesa Intel(R) Xe Graphics (TGL GT2)',
  'AMD Radeon Pro 5500M OpenGL Engine',
  'Adreno (TM) 650',
  'Mali-G78',
]

describe('isSoftwareRenderer', () => {
  it.each(SOFTWARE)('recognises %s as software', (renderer) => {
    expect(isSoftwareRenderer(renderer)).toBe(true)
  })

  it.each(HARDWARE)('leaves %s alone', (renderer) => {
    expect(isSoftwareRenderer(renderer)).toBe(false)
  })
})

describe('preferredDelegate', () => {
  /**
   * BUG: the model ran on a software rasteriser because creating the GPU
   * delegate did not fail.
   *
   * "GPU first, CPU if that throws" reads like a safe fallback and is not
   * one. Chrome without a usable GPU does not refuse WebGL - it hands it to
   * SwiftShader, the delegate is created happily, and the model then runs on
   * a software rasteriser and pays a readback through it once a frame.
   * Measured: 126ms a frame that way against 36ms on CPU, with the whole
   * page held at 8fps behind it, because this pipeline runs on the main
   * thread.
   */
  it('does not ask a software rasteriser to pretend it is a GPU', () => {
    expect(preferredDelegate('Google SwiftShader')).toBe('CPU')
    expect(
      preferredDelegate('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'),
    ).toBe('CPU')
  })

  it('uses the GPU where there is one', () => {
    expect(preferredDelegate('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)')).toBe('GPU')
  })

  /** A browser that hides the renderer string - Firefox with
   *  `privacy.resistFingerprinting`, say - is not a browser without a GPU,
   *  and guessing CPU would slow down every one of them. No answer means the
   *  behaviour this shipped with, which is right wherever there is a real
   *  GPU and no worse than before wherever there is not. */
  it('falls back to the old behaviour when the renderer will not say', () => {
    expect(preferredDelegate(null)).toBe('GPU')
  })
})
