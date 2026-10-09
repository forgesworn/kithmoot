# Original chat artwork

KithMoot includes 24 original reaction stickers and 24 looping GIF memes. The artwork was generated with the explicitly selected `gpt-image-2.5-sunburst` model; prompts and source sprite sheets are kept in `app/artwork-prompts/` and `app/src/assets/kithmoot-original/`. The GIF captions and animation are assembled locally, rather than linked from a third-party catalogue.

The emoji picker starts with the original artwork. Standard Unicode emoji remain available separately or through search; flags are omitted from the picker. Existing received Unicode reactions are still readable. Known `:km_*:` shortcodes render from local artwork on web and native Android. The separate 600 pack retains its explicit Nostr member unlock and picker-only gate.

Browsing and searching the original GIF/sticker pack makes no third-party requests. The PWA precaches the artwork from its own origin; desktop and Android package it. Native GIF previews use local assets, respect disabled system animation and stop with the view lifecycle. Web previews use static originals when reduced motion is requested. Choosing an original file uses the existing encrypted attachment flow and storage consent. Browsing the pack does not grant storage consent, and no third-party credit or URL is inserted into the draft.

To package source artwork, run `node scripts/build-original-chat-art.mjs` (FFmpeg and the project’s Playwright Chromium are required). To update the explicitly selected native checkout, run `node scripts/sync-original-chat-art.mjs --android /absolute/native-checkout`. The generated manifests pin file sizes and hashes; web selection rejects substituted URLs or bytes. Native selection accepts only the compiled catalogue and exact APK asset lengths.

The collection is a finite local pack. It does not promise an external provider’s trending or unlimited meme catalogue. People can also attach their own images and GIFs through the existing file picker.
