# Coordinated browser vault and typed signing

This P3-03c slice puts the dormant browser vault's credentials, approvals,
revocations and leaf-signature journal inside the reviewed persona coordinator.
It adds the contracted `signBoxRequestV1` operation. It does not enable MLS in
production or wire MLS rooms into the app.

## Commit and signing boundaries

`CoordinatedMlsVault` stores one versioned typed vault object in each persona's
existing sealed container. The container's installation, Web Lock, exact
ciphertext manifest, staged write and promotion rules apply unchanged. The
record contains the person credential and device scalar, separate leaf/box
consent scopes, revocations, at most 1,024 live journal entries and retained
retired-device identifiers. Policy and journal limits refuse further additions;
live decisions and retired keys are not evicted to make space.

Identity signing and consent prompts run outside the writer lock. The vault
reopens and checks the device, credential, account and approval after those
awaits. Leaf approval, signature and journal decision form one candidate.
Nothing returns as a successful signature until that candidate is promoted.
Denials are also covered writes. Release and later reply acceptance recheck
the operation deadline and binding/device-credential expiry; a slow successful
commit can retain its journal while withholding an expired signature. A lost advance reply returns `witness-pending`;
a retry reconciles and reads the exact promoted decision before doing new work.

Each vault instance has an unpredictable boot nonce. Journal entries bind that
nonce, the app generation and the synchronous cross-tab revision. An identical
operation can replay in the same lifetime, but a pre-restart operation is stale;
the future room adapter must allocate a new operation id. Replacement,
withdrawal, revocation and clear invalidate earlier contexts and replies across
tabs before writing. Explicit replacement retains the old device and credential
as tombstones. Clear uses the existing installation-bound retirement path.

Readable unsupported typed records fence. A rejected proposed edit does not
fence a healthy predecessor. Missing keys or corrupt seals never create a new
record or fresh enrolment. Buffer copies are wiped and parsed scalar fields are
cleared on exit; JavaScript cannot guarantee erasure of immutable strings or
protection against same-origin script compromise.

## Box authentication

The device signs only the method/path combinations in contract §6.2.1. Inputs
cannot supply a timestamp, arbitrary Nostr event, query, alternate encoding or
another route. GET capabilities and DELETE package require the empty-body hash.
The NIP-98 event binds kind 27235, empty content, the exact body hash, method and
`http://<lowercase-unpadded-base32-Link-node><path>` URL.

Approving a new box scope is witnessed. Signing a request under an existing
approval is unjournalled and sends no witness request, as the contract requires.
`BrowserPersonaCoordinator.readConfirmed` grants a read-only view only after a
successful fresh operation in this coordinator lifetime. It compares the exact
durable revision under the persona lock and checks the confirming account
context. Restart, a different tab's write, pending witness work or explicit
invalidation removes that authority. It cannot stage a write or yield session
marks. A queued operation cannot resurrect an earlier confirmation during
cleanup, and an in-flight local read rechecks its exact confirmation token
after every release boundary. Covered leaf signatures and future MLS operations still require
`transact`, never this local confirmation path.

Within one vault lifetime, repeated identical requests advance their timestamp
by one second, at most 30 seconds ahead of the vault clock. The bounded timestamp
cache refuses new live entries rather than evicting one and reusing its event
id. A lifetime clock floor holds signing if the clock regresses, including
after an earlier cache entry has expired. Like Android's in-memory cache, separate tabs or a restart can produce an
already-used request id; the box's replay refusal remains authoritative. The
future box client must retry with a fresh header and reconcile status after a
lost reply or replay refusal. No timestamp cache, request header or request
fingerprint is persisted or broadcast.

## Explicit legacy migration

`migrate` accepts a legacy `MlsVault` and an already enrolled, confirmed, empty
persona destination. It does not create source keys or an installation. It
freezes the legacy source under its existing Web Lock, binding it to the exact
destination installation before the destination stages any record. That marker
makes legacy reads, writes, replacement and clear refuse. The transfer releases
only public device metadata after promotion; neither vault exposes a scalar
export callback.

The source ciphertext stays retained. An interrupted migration can resume that
same destination. A committed migration is idempotent and cannot overwrite a
later credential, approval or journal entry. Legacy journal revisions cannot
replay in the new boot context. A missing source key/device or another migration
destination refuses; no empty import substitutes for lost data.

This cannot retrospectively establish that an unwitnessed legacy source was
never rolled back, and an old application build does not understand the new
freeze marker. The standalone vault had no production caller. The future UI
must offer an explicit migration or new-device choice and must use only the
coordinated vault afterwards. This patch performs no automatic migration and
removes no legacy ciphertext.

## Acceptance and remaining gates

The offline browser fixture uses the real pinned Rust WASM, browser WebCrypto,
IndexedDB and Web Locks, with a separate disposable receipt signer in the test
runner. It exercises typed credentials and real device signatures rather than
only synthetic object bytes. Cases cover staged/promoted interruptions, lost
advances, durable denial, restart and real page reload, two tabs, whole-profile
rollback, lost inner keys, readable unsupported records, a full journal, consent
races, retired devices, request shape/clock/replay boundaries and migration
recovery. These are fixture results, not real Bothy, physical-device or
independent production-peer acceptance.

Focused commands:

```sh
npx vitest run app/src/mls-vault.test.ts app/src/mls-coordinated-vault.test.ts
npx playwright test -c playwright.mls.config.ts
npm run typecheck
npm run build
```

Before merge, the changed storage/coordinator and signing paths need a fresh
security review under P3-03. The prior foundation review does not cover this
slice. Production remains gated. Full-app vault/consent UI, the room store and
box client, real-witness typed-signing acceptance, Android/browser composition
and physical-device acceptance remain separate work.
