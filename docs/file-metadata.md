# File metadata and connection visibility

The Metadata destination describes local observations and potential disclosures;
it is not a packet capture or an assertion about a service's retention policy.
It shows configured relay health, the file-storage choice, account identity,
selected ICE route and byte counts. Only the viewer's own server-reflexive ICE
addresses are listed. Remote addresses, room links, SDP and credentials are
excluded. Connection data is neither uploaded nor persisted by this view.

Public-IP geography is approximate. The optional lookup explicitly contacts
ipwho.is, without cookies or a referrer, only after a click that explains the
additional disclosure. No geolocation permission or automatic lookup is used.
An address obtained through ICE need not be the address a web request uses.

## Before file sharing

The web/desktop app runs cleaning before file encryption, storage authorisation
or upload, for picker, clipboard and drop attachments, including group storage
and paired Bothy. The Bothy controller checks its owner and route again after
cleaning. The original stays local. An error never falls back to uploading it.
The library/protocol can still receive files sent by older or independent
clients; recipient safety checks remain necessary.

Supported paths (64 MiB input/output bound):

- Still JPEG/PNG and browser-decodable still formats: decode oriented pixels
  and encode a fresh JPEG/PNG. Unsupported decoders hold the file unsent.
- GIF/APNG/WebP animation: retain picture, frame and timing blocks, discard
  EXIF/XMP, comments, timestamps and unknown ancillary blocks.
- MP4/MOV, WebM/Matroska, MP3, WAV, FLAC and Ogg: rebuild from audio/video
  packets with no source tags, names, languages, chapters, covers, attachments
  or data tracks. Keep rotation/flip required for playback. Unsupported
  codec/container combinations stay unsent.
- PDF: rebuild current pages without document info, XMP, annotation authors
  or dates, old incremental revisions, embedded document attachments or
  orphaned objects. Strip metadata segments from embedded JPEG pictures.
  Unsupported image encodings, scripts and attached-file annotations are held.
- DOCX/XLSX/PPTX and ODT/ODS/ODP: rebuild the ZIP without original timestamps,
  extra fields or archive comments. Remove document properties, comments,
  revision authors/IDs, deleted text and custom XML; accept inserted text and
  clean embedded pictures. Macro/embedded-file/signed containers are held.
- Plain text/Markdown/CSV/TSV/JSON/YAML/logs/subtitles: retain visible bytes;
  these have no separate metadata container. Other archives and formats stay
  unsent with export guidance.

Cleaning is not anonymisation or content redaction. Filenames, faces, speech,
visible text, identifiers inside ordinary content and information encoded in
picture/sound content remain. Compressed media bitstreams are preserved, so
codec-level auxiliary data is outside the current container-tag cleaning.
Do not describe the cleaner as removing every possible hidden identifier.
Recipients can keep/forward content. Existing links are not new local uploads.

Dependencies and exact source/licence notices ship at
`/j/metadata-third-party-notices.txt`; libraries are unmodified. This introduces
no publisher conversion service, file-inspection endpoint or telemetry.

## Update notes

`app/src/release-notes.json` is the curated release summary. Change its stable
`id` when user-visible behaviour changes. The build emits `whats-new.json`,
with the desktop package version, outside the service-worker precache. Update
notices offer a text-only preview without activating the update. Settings keeps
the installed build's summary available offline. Returning users get a
nonmodal, dismissible notice when the summary ID changes; first visits do not.
Desktop previews require an exact match to the offered desktop version. A
missing/mismatched/offline summary is reported as unavailable, never replaced
with claims about a different release. Code remains pinned to bundled assets.
