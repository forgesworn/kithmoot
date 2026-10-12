# Captured access and bookmark composition

The access/bookmark component now validates retained browser access and bookmark
rows together with tab admission and navigation rows. It is a component of the
complete ordinary image preflight. It does not validate identity, epochs, quiet
traffic, cadence, pending queues or the other ordinary families, and main does
not call it yet.

`captureOrdinaryStartupContext(browser, tab)` clones and physically preflights
both input images, reads the actual `globalThis.location.href`, and privately
retains the exact four relevant partitions. The public frozen token exposes
counts only. Callers cannot supply a URL, retained-room list or account hint.
The eventual production barrier must call capture before history mutation,
arrival handling or either owner allocation. That ordering is a requirement for
integration, not something this unmounted helper proves.

`validateOrdinaryRoomAccessAndBookmarksSnapshot` consumes the token once before
validation, including refusal. It copies and physically preflights both supplied
images, compares exact physical names, bytes and counts for all four partitions,
checks each owner's migration flag, and resolves their union once. Changed,
missing, substituted or relocated evidence holds. A copied token has no private
entry. An unused token can be explicitly released; retained maps are cleared on
consumption and release.

The original captured location remains available after deliberate URL scrubbing.
Capturing only after scrubbing cannot recover an orphan's missing bearer and
holds the dependent records. Opaque, contact-card and incomplete startup hashes
are inert; recognising room fields selects the strict room-link parser. An
unknown restrictive field in a recognisable room link still holds. Navigation
uses the same candidate classification; it never assigns an account from a
room-switch reminder.

Bookmark metadata and links use a private shared parser. The bookmark validator
no longer recursively calls the access validator on a synthetic one-row image,
and its retained links never cross a public API. All bookmark and access rows
are structurally parsed before their links and admissions are resolved together.
Cross-owner creator/delegate key collisions are checked in that one resolution.
Conflicting policies for one invitation or resolved stable room hold in either
candidate order. Labels and relay/ICE hints may differ with the same security
policy. Explicit meeting/group conversion still uses the retained record's
persistence flags, rather than converting a record from the URL's version.

The existing family entry points remain for component callers. They reject the
old `links` and `retainedRooms` option fields, and the bookmark module now only
re-exports the implementation from the shared closure. The older navigation
capability also consumes its private entry once, on success or refusal. It
continues to bind only its exact access partition; the both-owner composer uses
its own captured tab navigation rather than a separately recaptured capability.

This is custody evidence. Startup and navigation bearers are unscoped, and
bookmark cached plaintext is not authenticated by the adjacent signed ciphertext.
Signer-backed decrypt/compare and current admission/session checks remain owed
before restoration effects. No clock, entropy, CryptoKey allocation, encryption,
IndexedDB opening, Storage mutation or network request belongs to this component.
Derived/parser-owned secret buffers are wiped when validation exits.

The full composer must own one complete browser and tab capture and derive this
private access evidence from that capture, or compare all protected partitions
under one generation. Independently recapturing identity, epoch, quiet or pending
families would not establish a same-image boundary. Real pending-message
bindings, quiet channel provenance, cadence node/grant evidence, production
client/capacity fences, protected startup and coordinated forgetting remain open.
This source work does not close DG08 or any release/physical acceptance gate.

Unit tests use real access, grant and bookmark writers. Native component tests
prepare those writers and actual signed contact-card encoding before a synthetic
no-effect probe, exercise native location/history and the four partitions in
Chromium, Firefox and WebKit, and keep inherited migration/reload cases. The
migration fixture explicitly makes the other owner empty and uses a noop client
fence. These are bounded component checks, not a production root, signer-backed
restoration, live peer delivery or independent acceptance.
