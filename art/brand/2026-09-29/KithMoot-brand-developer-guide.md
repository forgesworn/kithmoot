# KithMoot — brand and interface guide

Status: proposed design system accompanying the branding board, 29 September 2026. The selected vortex establishes the identity; the palette and interface specifications below are proposed implementation values, not values extracted from an existing vector master. The board is a visual reference, not production artwork.

## Brand character

Modern, recognisable, calm and human. KithMoot should feel at home beside mainstream messaging apps. The name carries the historical character; interfaces should be contemporary and straightforward. Avoid medieval lettering, shields, generic community pictograms and decorative technology effects.

Use **KithMoot** in product text and **ForgeSworn** for the parent brand. Do not add a domain to permanent artwork until the address is confirmed. No new tagline is prescribed here.

## Logo

Preserve the selected circular four-arm vortex. Four copies of one curved ribbon shape rotate around the centre at 90° intervals, retaining open space between arms and in the middle. Turquoise arms occupy upper right and lower left; deep-blue arms occupy upper left and lower right. Repeat the same local shading structure on every arm, rotating it with the geometry. Opposite arms match in colour and treatment.

Use the supplied wordmark artwork. Do not approximate its lettering using the interface font. The standard light-background wordmark has deep-blue “Kith” and turquoise “Moot”.

- Primary: gradient symbol with wordmark.
- Compact: symbol alone.
- Flat: the same geometry with solid blue and turquoise fills.
- One colour: all four separated arms in navy or white; preserve the negative spaces.
- Clear space: at least one quarter of the symbol diameter around the entire lockup.
- Small sizes: use the flat mark and inspect at 16, 24 and 32 px. If the gaps close, prepare an optically adjusted small-size master. The raster board does not establish a tested minimum size.
- Dark surfaces: place the standard mark on a pale container, or use an approved white mark. Deep-blue arms should not disappear into a dark background.

Do not stretch, mirror, independently rearrange arms, add external glows, animate continuous rotation, or use the mark as a loading spinner. A brand symbol should not look like a permanently busy interface.

## Proposed palette

| Token | Hex | Role |
|---|---|---|
| `brand-blue` | `#073B7A` | Deep-blue logo family; light-mode primary actions |
| `brand-turquoise` | `#00BFC5` | Turquoise logo family; accents; dark-mode primary actions |
| `brand-aqua` | `#35E8DD` | Logo highlights; restrained decorative accents |
| `ink` | `#102A43` | Light-mode text; text on turquoise buttons |
| `mist` | `#F3F8FA` | Light-mode page background; dark-mode primary text |
| `night` | `#081923` | Dark-mode page background |
| `white` | `#FFFFFF` | Light-mode cards; text on blue buttons |

Keep gradients in the logo. Interface fills should normally be flat. Match production logo gradients to approved vector artwork rather than deriving them from this board.

### Text combinations

Calculated sRGB contrast ratios for these exact solid colours:

| Foreground / background | Ratio | Intended use |
|---|---:|---|
| White / deep blue | 10.96:1 | Light-mode primary button |
| Ink / turquoise | 6.46:1 | Dark-mode primary button |
| Ink / white | 14.64:1 | Light-mode body copy |
| Mist / night | 16.72:1 | Dark-mode body copy |
| Turquoise / night | 7.89:1 | Dark-mode links and accents |

Turquoise on white is only 2.27:1: do not use it for ordinary text or as the sole visible boundary of an essential control. Use deep blue for light-mode links. Recheck actual rendered combinations whenever opacity, gradients or component backgrounds change. These calculations do not certify the complete interface.

## Typography

Proposed interface family: **Inter**, with `system-ui, sans-serif` fallback. Keep the supplied logo wordmark separate.

| Use | Size / line height | Weight |
|---|---|---|
| Marketing heading | 40–56 px / 1.1 | 700 |
| Page heading | 28–32 px / 1.2 | 600 |
| Section heading | 20–24 px / 1.3 | 600 |
| Body and messages | 16 px / 24 px | 400 |
| Buttons and navigation | 14–16 px / 1.4 | 500–600 |
| Secondary labels | 13–14 px / 1.4 | 400–500 |

Use sentence case. Avoid long uppercase passages and excessively tight tracking. Support user text scaling; do not force fixed-height message containers.

## App and web interface

Use an 8 px spacing base, with 4 px for small adjustments. Proposed card radius: 12 px. Use circles for avatars and rounded rectangles for controls. Keep icon stroke weights consistent. Decoration should leave conversation content dominant.

Light mode: mist canvas, white cards, ink text, deep-blue primary actions. Dark mode: night canvas, visibly separated raised surfaces, mist text, turquoise primary actions with ink labels. Choose and verify supporting surface and border tokens during implementation; do not assume reversing colours produces a usable dark theme.

Show selected state through more than colour. Keep visible keyboard focus, labelled icon controls and readable disabled states. Suggested minimum interaction area: 44 × 44 CSS px. Treat semantic success, warning and error colours as separate tokens; brand turquoise must not imply success everywhere.

Use restrained transitions around 150–200 ms; honour reduced-motion preferences. The board’s messaging screens illustrate styling, not a final feature specification.

## App icon

Use the symbol alone, centred with breathing room. Prepare platform-specific assets from the approved vector master and preview under each platform’s masks. Keep essential geometry away from cropped corners. Use a pale field to preserve the blue arms in dark contexts. Do not bake a platform mask into every source asset.

## Sticker direction

Proposed first sticker: 50 mm round, white background, vortex above the KithMoot wordmark. No URL until confirmed. A mark-only version can support smaller merchandise.

The board is a concept, not a print file. Produce the final layout from vector masters. Confirm the printer’s bleed, safe area, cut-line and colour-profile requirements before exporting. For an initial working layout, allow 3 mm bleed and keep essential content at least 3 mm inside the cut line, subject to the printer’s template. Request a colour proof: bright RGB turquoise may reproduce less vividly in CMYK.

## Production handoff checklist

The final asset package should contain approved full-colour, flat and single-colour SVG masters; horizontal and stacked wordmark lockups; platform icon exports; and a printer-specific sticker PDF. Those production masters are not supplied by the raster branding board or this guide. Keep the master shapes consistent across every export and make lettering outlines in print artwork.

Developers should import approved assets, implement named colour tokens, and use this guide for typography, spacing and theme behaviour. Do not trace the board or extract text from it as the source of truth.
