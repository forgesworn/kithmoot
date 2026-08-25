import { toCanvas } from 'qrcode'

// A join link and a pairing link both carry the room secret - the pairing
// link a one-off code on top of that - so the QR for either is rendered
// entirely on this device, into a plain <canvas>. There is no server-side
// or third-party QR-image service anywhere in this file, and there must
// never be one added here: handing either link to a remote image API would
// put the room secret on that service's request log, which is exactly the
// property "the link never reaches a server" (see README.md) exists to
// rule out.
//
// Rendered black-on-white regardless of the app's own (currently dark-only)
// theme, at a fixed size generous enough to photograph from a normal
// laptop-to-phone distance, with the standard four-module quiet zone a
// scanner needs to find the symbol at all.
const QR_WIDTH = 320
const QR_MARGIN = 4

/** Draws `text` as a QR code into `canvas`. Safe to call again on the same
 *  canvas - each call fully replaces whatever was drawn before, which is
 *  what a fresh pairing code needs. */
export async function renderQr(canvas: HTMLCanvasElement, text: string): Promise<void> {
  await toCanvas(canvas, text, {
    width: QR_WIDTH,
    margin: QR_MARGIN,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000ff', light: '#ffffffff' },
  })
}
