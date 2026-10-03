/** Pointer rules for drawing on a shared screen, kept free of the DOM so they
 *  can be tested directly. */

export interface PictureRect { left: number; top: number; width: number; height: number }

/** Whether a client point lies inside the displayed picture. A phone held
 *  upright shows a wide picture as a band inside a tall viewport, and a touch
 *  in the black above or below it is not on the picture at all. */
export function insidePicture(rect: PictureRect, clientX: number, clientY: number): boolean {
  return rect.width > 0 && rect.height > 0
    && clientX >= rect.left && clientX <= rect.left + rect.width
    && clientY >= rect.top && clientY <= rect.top + rect.height
}

/** A press begins a stroke only when it lands on the picture and no other
 *  pointer already owns a stroke, so a resting palm or a second finger cannot
 *  restart the line the first one is drawing. */
export function mayBeginStroke(
  rect: PictureRect, clientX: number, clientY: number, pointerId: number, activePointer: number | undefined,
): boolean {
  if (activePointer !== undefined && activePointer !== pointerId) return false
  return insidePicture(rect, clientX, clientY)
}

/** Normalised position on the picture, clamped to its edges. Used for moves
 *  once a stroke is under way, so a finger sliding off the edge pins to it. */
export function clampToPicture(rect: PictureRect, clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  }
}
