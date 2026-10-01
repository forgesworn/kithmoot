# KithMoot SVG asset pack

19 standalone SVGs, reconstructed from the selected raster logo and its branding direction. The symbol has been regularised to four identical rotated arms. The reference lettering is converted into smooth outlined paths. These are editable vector reconstructions, not embedded copies of the raster image.

## Choose a file

| File family | Variants | Use |
|---|---|---|
| `kithmoot-symbol-*.svg` | gradient, flat, navy, white | Logo symbol by itself |
| `kithmoot-wordmark-*.svg` | flat, navy, white | KithMoot lettering by itself |
| `kithmoot-horizontal-*.svg` | gradient, flat, navy, white | Symbol beside lettering; headers and banners |
| `kithmoot-stacked-*.svg` | gradient, flat, navy, white | Symbol above lettering; square and portrait layouts |
| `kithmoot-symbol-small-flat.svg` | flat | Wider gaps for favicon and small interface use |
| `kithmoot-app-icon-light.svg` | full colour on white | Square app-icon master |
| `kithmoot-app-icon-dark.svg` | full colour on pale disc over dark | Square app-icon master for dark presentation |
| `kithmoot-sticker-round-50mm.svg` | full colour on white | 50 mm circular sticker artwork |

All symbol, wordmark and combined logo files have transparent backgrounds. White variants will be invisible on white backgrounds. App-icon files have opaque square backgrounds and no baked-in rounded platform mask. The sticker has a white circular background and transparent corners.

## Efficient construction

- Flat and single-colour symbols: **one arm path**, referenced four times with rotation transforms.
- Gradient symbols: **two paths**, the main arm and its broad folded face, reused around the circle.
- Four native `linearGradient` definitions: two continuous surface gradients per colour family. Each gradient has two or three stops. These are genuine SVG gradients, not strips or stacks of narrow shapes.
- No embedded bitmap, filter, blur, external resource, script or font dependency.
- Wordmarks are two compound paths, preserving the supplied lettering. Wordmarks remain solid-colour, including those paired with the shaded symbol.
- Individual SVGs are approximately **1.1–6.2 kB**, uncompressed.

The gradients rotate with the geometry, so opposite arms have matching local shading. Keep all four arm instances linked when editing. The small-size symbol deliberately increases the gaps; the standard geometry is preferable for larger use.

## Editing and integration

Open directly in Inkscape, Illustrator or an SVG-capable editor. Edit the paths and gradients inside `<defs>` to change the shared symbol. Lettering is outlined, so it will not substitute a different font on another computer.

For web use, load via `<img>` or an equivalent asset component and supply appropriate alt text. If inlining more than one SVG in the same document, prefix each asset's element IDs and its matching references to avoid duplicate IDs. Keep `viewBox` and preserve aspect ratio.

Native gradients and `<use>` references are standard SVG features. If a particular print importer cannot resolve linked paths, unlink clones in a print-specific copy while retaining the gradients; keep the compact master intact.

## Print and app notes

The sticker SVG is explicitly sized to 50 × 50 mm, with artwork inset from the circular edge. It contains no URL. It is trim-size artwork; it does not include a printer-specific bleed, spot cut contour or CMYK output profile. Apply those according to the selected printer's template. The SVG colours are RGB, so proof the turquoise before a print run.

The square app-icon masters use a 1024 × 1024 viewBox. Export the raster sizes or platform assets needed by the application build process. These SVGs are not a complete Android adaptive-icon or Apple asset-catalog package.

Use the supplied PNG contact sheet to compare the main variants. The SVG files are the vector masters for this pack.

## Validation

Rendered in Inkscape and visually checked for the primary lockups, colour variants, single-colour symbols, app icons and sticker. Flat symbols were also inspected at 16, 24, 32 and 48 px. All 19 SVGs were parsed and checked for missing local references and prohibited raster, text and filter elements.
