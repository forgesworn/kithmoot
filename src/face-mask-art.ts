/** Original KithMoot geometric mask, drawn for this project. MIT, like the
 * repository. No film, comic, Anonymous logo or stock artwork is included.
 * Coordinates: 200 × 240. The backing is opaque, including the eye/vent marks.
 * Android's km_privacy_mask.xml uses these same paths. */
export const FACE_MASK_PATHS = [
  { fill: '#101820', d: 'M0 0H200V240H0Z' },
  { fill: '#273b49', d: 'M100 8 176 34 190 114 167 199 100 234 33 199 10 114 24 34Z' },
  { fill: '#e3e6dc', d: 'M100 20 165 44 177 113 156 188 100 220 44 188 23 113 35 44Z' },
  { fill: '#bacdc5', d: 'M100 20V220L156 188 177 113 165 44Z' },
  { fill: '#224754', d: 'M34 76 84 86 100 99 116 86 166 76 159 115 115 126 100 117 85 126 41 115Z' },
  { fill: '#101820', d: 'M44 88 80 95 87 106 50 103ZM156 88 120 95 113 106 150 103Z' },
  { fill: '#36877e', d: 'M100 91 114 148 100 157 86 148Z' },
  { fill: '#224754', d: 'M65 169H82V181H65ZM92 173H108V185H92ZM118 169H135V181H118Z' },
  { fill: '#36877e', d: 'M78 200 100 211 122 200 100 204Z' },
] as const
