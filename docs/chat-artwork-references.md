# Bundled chat artwork

Built-in stickers and GIFs are already part of each app. Sending them carries a
small reference inside the encrypted chat event, without uploading artwork or
publishing a file announcement. Personal files continue to use encrypted
Wildbloom attachments.

An ordinary message or edit may contain `artwork`, a list of at most four objects:

```json
{
  "pack": "kithmoot-original-v1",
  "id": "coffee",
  "kind": "gif",
  "sha256": "1ec70ce57a315e6dd13e8d451543eb529786a792f218121c9bfd67db718a61f1",
  "label": "Coffee"
}
```

`pack` and `id` match `^[a-z0-9][a-z0-9_-]{0,63}$`. `kind` is `sticker` or
`gif`. `sha256` is 64 hexadecimal characters, canonicalised to lowercase.
`label` must be a string: collapse whitespace, remove Unicode category C
characters, collapse whitespace again, trim, cap at 80 Unicode code points and
trim again. An empty result falls back to `id`. Unknown object keys are omitted.

Receivers resolve only a locally trusted catalogue entry matching all four of
pack, id, kind and exact byte hash. They never follow a sender-provided URL or
fetch an unknown catalogue. A missing catalogue, a newer version or a hash
mismatch keeps a readable text fallback. Reduced motion uses a locally bundled
still preview. Nostr membership controls which optional packs appear in the
picker, rather than preventing recipients from reading shared artwork.

Text remains required. With no typed caption, send `Sticker: Coffee` or
`GIF: Coffee`; concatenate multiple captions with `; `. Matching clients may
hide that generated caption when they render all its artwork. Older clients
can show the text without understanding the new field.

Malformed incoming entries are dropped while the text remains. A non-array
field is dropped; an array longer than four rejects the whole message.
Outbound malformed or over-cap artwork is a caller error. Reactions,
retractions, invitations and assignments cannot carry the field, including an
empty or malformed value. An edit replaces its original's artwork; omission
removes it. Drafts and durable retries preserve the references independently of
uploaded attachments.

The reference never appears in public event tags. Shared normalisation and
signed encrypted-message fixtures live in `vectors/artwork-references.json`.
