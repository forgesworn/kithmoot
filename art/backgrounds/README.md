# Call background sources

The full-size originals of the sea backgrounds offered under "Hide what is
behind you". Nothing here is built or deployed: Vite only publishes
`app/public`, and `deploy/deploy.sh` ships `site/` and `app/dist`. What the
app actually loads is the 1280px WebP beside each name in
`app/public/backgrounds/`, which is a tenth of the size and is fetched only
when somebody picks that background.

| Original | Shipped as | In the app |
| --- | --- | --- |
| `sea-lagoon.png` | `sea-lagoon.webp` | Lagoon |
| `sea-coral.png` | `sea-coral.webp` | Coral garden |
| `sea-deep.png` | `sea-deep.webp` | Deep blue |
| `sea-sand.png` | `sea-sand.webp` | White sand |

Made on 17 September 2026 with OpenAI `gpt-image-2.5-sunburst`, 1536x1024,
asking in each case for an underwater tropical scene with open water across
the middle for a person to sit in front of, no fish in the foreground (the
fish are drawn over the top at call time, so they have to move), and no text
or watermark. Beyond that the four differ by water and light: a lagoon with
reef down both sides, a vivid coral garden, deep blue open water, and pale
water over white sand.

To re-make one at a different size or crop, keep those constraints: a busy
centre sits directly behind a person's head and shoulders, where every fault
in the segmentation mask shows. `sea-sand` is the kindest to the mask and
`sea-coral` the cruellest, which makes the pair of them a useful test.

Regenerating costs money, so it is a deliberate act with the owner's say-so,
not something a build does.

Convert with:

```
cwebp -q 80 -resize 1280 0 sea-lagoon.png -o ../../app/public/backgrounds/sea-lagoon.webp
```
