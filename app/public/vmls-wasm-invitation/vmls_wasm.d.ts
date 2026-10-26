/* tslint:disable */
/* eslint-disable */

/** The platform CSPRNG: `n => crypto.getRandomValues(new Uint8Array(n))`. */
export interface VmlsRandom {
    fill(length: number): Uint8Array;
}
/**
 * Sign `digest` with the device key (BIP-340, 64 bytes), then call the
 * matching `complete` with `operation` and the signature by `expiresAt`.
 * `body` is the exact preimage: `digest` is
 * SHA-256("VMLS/1 leaf-binding" || body). Use a typed "sign leaf-binding"
 * signer method that recomputes the digest and can show what it binds;
 * never a generic raw-digest method on the device key, which would be a
 * blind-signing oracle.
 */
export interface VmlsSignRequest {
    operation: Uint8Array;
    digest: Uint8Array;
    body: Uint8Array;
    expiresAt: bigint;
}
/**
 * Compute the secp256k1 ECDH of this person's rendezvous key with `peerRz`
 * and hand its 32-byte x coordinate to the matching `complete`, which wipes
 * the array it is given. It must come from the holder of `rz` over an
 * authenticated channel: a predictable or substituted answer discloses the
 * capability record. Zeros and either public key are refused.
 */
export interface VmlsEcdhRequest {
    operation: Uint8Array;
    peerRz: Uint8Array;
    expiresAt: bigint;
}
/**
 * A snapshot to seal. `plaintext` holds every group secret of the session:
 * seal it with a key bound to `session` (a non-extractable WebCrypto key),
 * wipe it with `plaintext.fill(0)`, persist only the sealed bytes (never
 * over a later generation), raise the high-water mark to `generation`, then
 * call `session.commitAck(generation)`.
 */
export interface VmlsSnapshot {
    session: Uint8Array;
    generation: bigint;
    plaintext: Uint8Array;
}
/** Every failure: `kind` is "engine" or "boundary"; `code`/`number` are stable. */
export interface VmlsError extends Error {
    kind: "engine" | "boundary";
    code: string;
    number: number;
    recovery?: string;
}

export interface VmlsCapabilityInfo {
    packageId: Uint8Array;
    expiresAt: bigint;
    identity: Uint8Array;
    device: Uint8Array;
    leafId: Uint8Array;
    homeBox: Uint8Array;
    bindingExpiresAt: bigint;
    credentialId: Uint8Array;
    credentialExpiresAt: bigint;
    welcomeMailbox: Uint8Array;
}

/** Sensitive copied local facts; may be stale immediately after return.
 * checkedAt and revocations are caller inputs, not authenticated sources.
 * No keeper, current registry, durable adoption or admission authority. */
export interface VmlsLocalCheckpointObservation {
    session: Uint8Array;
    generation: bigint;
    groupId: Uint8Array;
    epoch: bigint;
    homeBox: Uint8Array;
    installation: Uint8Array;
    contractVersion: number;
    ownLeafIndex: number;
    leafId: Uint8Array;
    identity: Uint8Array;
    device: Uint8Array;
    signatureKey: Uint8Array;
    leafHomeBox: Uint8Array;
    bindingExpiresAt: bigint;
    credentialId: Uint8Array;
    credentialExpiresAt: bigint;
    checkedAt: bigint;
    /** Exact own public binding/credential evidence; do not log it. */
    binding: Uint8Array;
}
export type VmlsLocalCheckpointInspection =
| { type: "Observed", observation: VmlsLocalCheckpointObservation }
| { type: "Held", reason: "BadInput" | "NotActive" | "AwaitingCommitAck" |
"PendingWork" | "UnresolvedSlots" | "BackdatedTime" |
"InconsistentState" | "SnapshotMismatch" }
| { type: "Held", reason: "InvalidBinding", bindingCode: string, bindingNumber: number };

export type VmlsMlsState = "Pending" | "Committed" | "Failed";
export type VmlsCredentialState = "Unchanged" | "Revoked" | "Pending" | "Failed";
export type VmlsGrantState =
| { type: "Pending" | "Revoked" | "Failed" }
| { type: "NotAuthorised", requested: boolean };
export interface VmlsGrantRef {
    node: Uint8Array;
    grant: Uint8Array;
    keeper: boolean;
}
export interface VmlsGrant {
    grant: VmlsGrantRef;
    state: VmlsGrantState;
}
export type VmlsNextRemoval =
| { type: "Propose", leafIds: Uint8Array[] }
| { type: "Wait" | "UpdateFirst" | "Done" };
export type VmlsClaim = "BoxAccessEnded" | "RemoveApplied" | "BothComplete" |
"CredentialTombstoned" | "RevocationRequested" | "ComponentsOnly";



export type VmlsGroupProfile = "FullVmls1" | "Invitation1";
export type VmlsRestartDisposition = "TrustedLocalRestart" | "DetectedImport" | "DetectedClone" | "DetectedStateLoss";
export type VmlsReturnRoute = {type:"PrivateOob"} | {type:"LinkMailbox",node:Uint8Array};
export interface VmlsInvitationTarget {
    persona:Uint8Array; device:Uint8Array; rendezvous:Uint8Array; leafHome:Uint8Array;
    returnRoute:VmlsReturnRoute; expiresAt:bigint;
}
export interface VmlsInvitationContext {
    invitationId:Uint8Array; inviterPersona:Uint8Array; inviterDevice:Uint8Array; inviterRz:Uint8Array;
    joinerPersona:Uint8Array; joinerDevice:Uint8Array; joinerRz:Uint8Array;
    groupId:Uint8Array; groupHome:Uint8Array; groupInstallation:Uint8Array; joinerHome:Uint8Array;
    returnRoute:VmlsReturnRoute; expiresAt:bigint;
}
/** Typed invitation authorization, NOT a leaf-binding or generic digest request.
 * Independently parse canonical body {1:1,2:contextBytes,3:inviterLeafBindingBytes},
 * verify the binding/credential, compare the complete approved context and own
 * account/device, then recompute SHA256("Vennel invitation/1 authorization\0"||body).
 * expiresAt bounds the local pending operation; context.expiresAt bounds the invitation.
 */
export interface VmlsInvitationSignRequest {
    operation:Uint8Array; body:Uint8Array; digest:Uint8Array;
    context:VmlsInvitationContext; contextBytes:Uint8Array; contextCommitment:Uint8Array; expiresAt:bigint;
}
/** Verified delegation does not select a trusted inviter or prove current membership. */
export interface VmlsInvitationInspection {
    context:VmlsInvitationContext; contextBytes:Uint8Array; contextCommitment:Uint8Array; inviterBinding:Uint8Array;
}



/**
 * A capability record the adder verified. `Session.add` and
 * `Session.repair` consume the objects they are given, whatever the result;
 * open the record again to retry.
 */
export class Capability {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `{ packageId, expiresAt, identity, device, leafId, homeBox,
     * bindingExpiresAt, credentialId, credentialExpiresAt, welcomeMailbox }`.
     * `welcomeMailbox` is the address the keeper registers for this package;
     * neither field is a key.
     */
    info(): VmlsCapabilityInfo;
}

/**
 * A persona installation's coordinator, open under the caller's lock.
 */
export class Coordinator {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    confirmed(): boolean;
    /**
     * The fence reason, or `undefined`.
     */
    fenced(): any;
    installationReplaced(): void;
    onAdvance(answer: any): any;
    onRead(answer: any): any;
    onRetiringRead(answer: any): any;
    onRetiring(answer: any): any;
    promote(): Promotion;
    /**
     * The promotion is persisted: returns each session's witnessed
     * generation, to `commitAck` before anything is released.
     */
    promoted(promotion: Promotion): any;
    read(): any;
    refused(): boolean;
    resend(): any;
    /**
     * The retiring advance, only straight after `retireDue`; otherwise
     * `undefined`.
     */
    retiringAdvance(): any;
    /**
     * The retiring read, or `undefined` when no duty stands.
     */
    retiringRead(): any;
    retiring(): boolean;
    sessionMarks(): any;
    stage(candidate: any): Staged;
    /**
     * The stage is persisted: returns the advance request to send. The
     * stage is spent only when it applies.
     */
    staged(staged: Staged): any;
    /**
     * The bytes to persist after every answer and decision.
     */
    state(): any;
}

/**
 * Where a joining person's capability record arrives, and what opens it.
 * Returns no secret.
 */
export class Introduction {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    counter(): any;
    /**
     * The introduction mailbox to fetch.
     */
    mailbox(): any;
    /**
     * Opens and verifies a capability record fetched from the mailbox.
     */
    openCapability(now: any, envelope: any): Capability;
    openInvitationCapability(now: any, envelope: any): Capability;
    peerRz(): any;
}

/**
 * A capability record waiting for the device's signature and the ECDH with
 * the adder, under one operation id: ask for both at once.
 */
export class PendingCapability {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Both answers: `{ session, step }`. `sharedX` is wiped.
     */
    complete(now: any, operation: any, signature: any, shared_x: any): any;
    ecdhRequest(): any;
    /**
     * Whether it still waits for its answers at `now`; an expired one is
     * wiped here.
     */
    isPending(now: any): boolean;
    signRequest(): any;
}

/**
 * A group creation waiting for the device's signature.
 */
export class PendingCreate {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The 64-byte signature over the request's digest: `{ session, step }`.
     * Ends the operation whatever the result, unless `operation` is not
     * this one's.
     */
    complete(now: any, operation: any, signature: any): any;
    /**
     * Whether it still waits for its answer at `now` (a BigInt); an expired
     * one is wiped here.
     */
    isPending(now: any): boolean;
    /**
     * `{ operation, digest, body, expiresAt }`.
     */
    request(): any;
}

/**
 * The adder's side of an introduction, waiting for the ECDH.
 */
export class PendingIntroduction {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The ECDH's x coordinate (wiped): the `Introduction`.
     */
    complete(now: any, operation: any, shared_x: any): Introduction;
    /**
     * Whether it still waits for its answer at `now`.
     */
    isPending(now: any): boolean;
    /**
     * `{ operation, peerRz, expiresAt }`.
     */
    request(): any;
}

export class PendingInvitation {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    request(): VmlsInvitationSignRequest;
}

/**
 * The CSPRNG and this device's two public keys, bound once.
 */
export class Platform {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `deviceKey` is the device's 32-byte x-only public key, as its person
     * credential names it; `rendezvousKey` this person's x-only `rz`.
     * Neither secret half ever crosses.
     */
    constructor(device_key: any, rendezvous_key: any, rng: VmlsRandom);
}

/**
 * A promotion: persist `state()` with the promoted objects, then pass it to
 * `promoted`. Applied once.
 */
export class Promotion {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    state(): any;
}

/**
 * One device in one group.
 */
export class Session {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    ackedGeneration(): any;
    /**
     * Consumes the `Capability` objects in `capabilities`.
     */
    add(now: any, capabilities: any): any;
    /**
     * `[{ epoch, commitHash }]`.
     */
    appliedCommits(): any;
    /**
     * States that the snapshot of `generation` (a BigInt) is sealed and
     * persisted and that the high-water mark is now `highWater` (a BigInt,
     * at least `generation`; a lower one throws `HighWaterBehind`).
     */
    commitAck(generation: any, high_water: any): void;
    completeInvitation(now: any, pending: PendingInvitation, operation: any, signature: any): any;
    /**
     * The signature over the prepared digest: the Update Commit's step.
     */
    completeUpdate(now: any, operation: any, signature: any): any;
    confirmMember(package_id: any): any;
    /**
     * `signedReceipt` is the box's 197-byte receipt (decoded from base64).
     */
    depositResult(now: any, attempt: any, signed_receipt: any): any;
    epoch(): any;
    generation(): any;
    /**
     * Actual MLS group id, or `null` before joining; not the local session id.
     * Sensitive metadata for encrypted admission, not proof of authority.
     */
    groupId(): any;
    homeBox(): any;
    id(): any;
    /**
     * Copies a guarded local observation under this actual session's borrow.
     * Wipes the given plaintext array, including malformed-input/Busy/Poisoned
     * refusals. No callbacks or state changes. The borrowed engine checkpoint
     * never leaves this call; callers must recheck actual custody and current
     * authority after asynchronous work, never adopt this object as a proof.
     */
    inspectLocalCheckpoint(plaintext: any, now: any, expected_identity: any, revoked_credentials: any): VmlsLocalCheckpointInspection;
    /**
     * The home box installation the group pins, or `null` before joining.
     */
    installation(): any;
    invitationResponse(now: any): any;
    issuedInvitation(invitation_id: any, now: any): any;
    /**
     * The box answered a retained epoch's mailbox empty after
     * acknowledgement. The engine deletes it only once every remaining
     * member has been heard under a later epoch (contract §5.2, P3-07).
     * Until then it refuses and nothing changes: the step has no snapshot.
     * Report it again on a later empty answer.
     */
    mailboxDrained(mailbox: any): any;
    members(): any;
    nextAttempt(): number;
    /**
     * The home box's current installation from a capabilities reply, at
     * every open and on every reply. Another than the group's fences it.
     */
    observeInstallation(now: any, installation: any): any;
    /**
     * A receipt queried after an `OrderingUnconfirmed` event.
     */
    observeReceipt(now: any, signed_receipt: any): any;
    /**
     * Actual surviving-installation provenance; never label imported backups trusted.
     */
    static openInvitationSession(platform: Platform, session: any, plaintext: any, high_water: any, disposition: any): Session;
    /**
     * Restores a session from the plaintext of its snapshot, which the
     * caller unsealed, and its high-water mark (a BigInt). A snapshot older
     * than the mark throws `Rollback`; a newer one opens unacknowledged, so
     * raise the mark to `generation()` and `commitAck` it before sending.
     * The adapter wipes the `plaintext` array it is given on every path,
     * including every refusal, before it looks at the other arguments.
     */
    static open(platform: Platform, session: any, plaintext: any, high_water: any): Session;
    outboundDelivered(record_ids: any): any;
    /**
     * Records not yet confirmed delivered: after a restart, resend these
     * exact bytes. Throws `AwaitingCommitAck` until the latest snapshot is
     * acknowledged.
     */
    outbox(): any;
    ownLeafId(): any;
    phase(): any;
    /**
     * Prepares this device's capability record for an adder and its
     * pending-join session: a `PendingCapability`. The request is
     * `{ binding, expectedGroupId, expiresAt, adderRz, counter }`.
     */
    static prepareCapability(platform: Platform, now: any, request: any): PendingCapability;
    static prepareCreateInvitationProfile(platform: Platform, now: any, request: any, installation: any): PendingCreate;
    /**
     * Prepares a group with this device as its only member: a
     * `PendingCreate`. `installation` is the home box's current
     * installation from its capabilities reply (`parseCapabilities`); the
     * group pins it.
     */
    static prepareCreate(platform: Platform, now: any, request: any, installation: any): PendingCreate;
    /**
     * expectedInviterPersona comes from deliberate trusted-contact/OOB selection.
     */
    static prepareInvitationCapability(platform: Platform, now: any, binding: any, authorization_bytes: any, expected_inviter_persona: any): PendingCapability;
    prepareInvitation(now: any, target: any): PendingInvitation;
    /**
     * Prepares an Update of this leaf's key and binding:
     * `{ operation, digest, expiresAt }`. Any change to the session before
     * `completeUpdate` makes it stale; preparing again replaces it.
     */
    prepareUpdate(now: any, request: any): any;
    /**
     * Classifies and applies one record fetched from `mailbox`:
     * `{ outcome, ack, step }`.
     * `signedReceipt` is required for a commit-slot record and `undefined`
     * or `null` otherwise. `installation` is `{ homeBox, installation }`
     * for a Welcome, after an `InstallationNeeded` event named `homeBox`,
     * and `undefined` or `null` otherwise.
     */
    process(now: any, mailbox: any, envelope: any, signed_receipt: any, installation: any): any;
    profile(): VmlsGroupProfile;
    /**
     * Borrows the opaque capability; unlike add(), this does not consume it.
     */
    recordInvitationResponse(now: any, capability: Capability): any;
    remove(now: any, leaf_ids: any): any;
    /**
     * Consumes the `Capability` objects in `add`.
     */
    repair(now: any, remove: any, add: any): any;
    retryInvitationResponse(now: any): any;
    send(body: any): any;
    /**
     * `status` is `"Filled"`, `"Expired"` or `"Void"`, with the winner's
     * receipt. The receipt's label decides, never the word.
     */
    slotStatus(now: any, attempt: any, status: any, signed_receipt: any): any;
    tick(now: any): any;
    updateRequired(): boolean;
    watchList(): any;
}

/**
 * A staged candidate: persist `state()` with the candidate's objects, then
 * pass it to `staged`. Applied once.
 */
export class Staged {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    state(): any;
}

/**
 * One removal at one session. The bytes from `encode()` belong in the
 * sealed, witnessed persona record and are reopened with `removalDecode`.
 */
export class VmlsRemoval {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    claimCopy(): string | undefined;
    claim(): VmlsClaim;
    credential(): VmlsCredentialState;
    encode(): Uint8Array;
    grants(): VmlsGrant[];
    leafIds(): Uint8Array[];
    /**
     * MLS reaches `Committed` only from applied session readback and the
     * coordinator's witnessed mark, never from platform-supplied numbers.
     */
    mlsCommitted(session: Session, coordinator: Coordinator): void;
    mls(): VmlsMlsState;
    /**
     * The Remove loop's next step, derived from the live session itself.
     */
    next(session: Session): VmlsNextRemoval;
    openedEpoch(): bigint;
    personIdentity(): Uint8Array | undefined;
    sessionId(): Uint8Array;
    setCredential(state: VmlsCredentialState): void;
    setGrant(grant: Uint8Array, state: VmlsGrantState): void;
    setMls(state: VmlsMlsState): void;
}

/**
 * A new installation's genesis for the keeper's enrolment:
 * `{ state, digest }`. `subject` is the enrolment's; `installation` the
 * vault's own; `witness` the pinned witness key.
 */
export function coordinatorGenesis(subject: any, installation: any, witness: any, active: any): any;

/**
 * The hash the caller records for a sealed object's exact bytes.
 */
export function coordinatorObjectHash(sealed: any): any;

export function inspectInvitation(now: any, authorization_bytes: any): VmlsInvitationInspection;

/**
 * Opens the coordinator from its persisted state and the objects actually
 * stored, active and (if a candidate is staged) staged.
 */
export function openCoordinator(platform: Platform, state: any, active: any, staged: any): Coordinator;

/**
 * The home box's current installation from its capabilities reply body (a
 * `Uint8Array`), parsed strictly; anything malformed is
 * `UnsupportedSecurityContract`.
 */
export function parseCapabilities(body: any): any;

/**
 * The adder's side: prepares the introduction for `peerRz`'s capability
 * record number `counter` (a BigInt): a `PendingIntroduction`.
 */
export function prepareIntroduction(platform: Platform, now: any, peer_rz: any, counter: any): PendingIntroduction;

export function prepareInvitationIntroduction(platform: Platform, now: any, authorization_bytes: any): PendingIntroduction;

/**
 * A removal from the bytes in the sealed persona record.
 */
export function removalDecode(bytes: Uint8Array): VmlsRemoval;

/**
 * Removing one device of `session`'s group. Persist the returned journal
 * before acting on it.
 */
export function removalDevice(session: Session, leaf_id: Uint8Array, grants: VmlsGrantRef[]): VmlsRemoval;

/**
 * Removing every leaf of one person in `session`'s group.
 */
export function removalPerson(session: Session, identity: Uint8Array, grants: VmlsGrantRef[]): VmlsRemoval;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_capability_free: (a: number, b: number) => void;
    readonly __wbg_coordinator_free: (a: number, b: number) => void;
    readonly __wbg_introduction_free: (a: number, b: number) => void;
    readonly __wbg_pendingcapability_free: (a: number, b: number) => void;
    readonly __wbg_pendingcreate_free: (a: number, b: number) => void;
    readonly __wbg_pendingintroduction_free: (a: number, b: number) => void;
    readonly __wbg_pendinginvitation_free: (a: number, b: number) => void;
    readonly __wbg_platform_free: (a: number, b: number) => void;
    readonly __wbg_promotion_free: (a: number, b: number) => void;
    readonly __wbg_session_free: (a: number, b: number) => void;
    readonly __wbg_staged_free: (a: number, b: number) => void;
    readonly __wbg_vmlsremoval_free: (a: number, b: number) => void;
    readonly capability_info: (a: number) => [number, number, number];
    readonly coordinatorGenesis: (a: any, b: any, c: any, d: any) => [number, number, number];
    readonly coordinatorObjectHash: (a: any) => [number, number, number];
    readonly coordinator_confirmed: (a: number) => [number, number, number];
    readonly coordinator_fenced: (a: number) => [number, number, number];
    readonly coordinator_installationReplaced: (a: number) => [number, number];
    readonly coordinator_onAdvance: (a: number, b: any) => [number, number, number];
    readonly coordinator_onRead: (a: number, b: any) => [number, number, number];
    readonly coordinator_onRetiring: (a: number, b: any) => [number, number, number];
    readonly coordinator_onRetiringRead: (a: number, b: any) => [number, number, number];
    readonly coordinator_promote: (a: number) => [number, number, number];
    readonly coordinator_promoted: (a: number, b: number) => [number, number, number];
    readonly coordinator_read: (a: number) => [number, number, number];
    readonly coordinator_refused: (a: number) => [number, number, number];
    readonly coordinator_resend: (a: number) => [number, number, number];
    readonly coordinator_retiring: (a: number) => [number, number, number];
    readonly coordinator_retiringAdvance: (a: number) => [number, number, number];
    readonly coordinator_retiringRead: (a: number) => [number, number, number];
    readonly coordinator_sessionMarks: (a: number) => [number, number, number];
    readonly coordinator_stage: (a: number, b: any) => [number, number, number];
    readonly coordinator_staged: (a: number, b: number) => [number, number, number];
    readonly coordinator_state: (a: number) => [number, number, number];
    readonly inspectInvitation: (a: any, b: any) => [number, number, number];
    readonly introduction_counter: (a: number) => [number, number, number];
    readonly introduction_mailbox: (a: number) => [number, number, number];
    readonly introduction_openCapability: (a: number, b: any, c: any) => [number, number, number];
    readonly introduction_openInvitationCapability: (a: number, b: any, c: any) => [number, number, number];
    readonly introduction_peerRz: (a: number) => [number, number, number];
    readonly openCoordinator: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly parseCapabilities: (a: any) => [number, number, number];
    readonly pendingcapability_complete: (a: number, b: any, c: any, d: any, e: any) => [number, number, number];
    readonly pendingcapability_ecdhRequest: (a: number) => [number, number, number];
    readonly pendingcapability_isPending: (a: number, b: any) => [number, number, number];
    readonly pendingcapability_signRequest: (a: number) => [number, number, number];
    readonly pendingcreate_complete: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly pendingcreate_isPending: (a: number, b: any) => [number, number, number];
    readonly pendingcreate_request: (a: number) => [number, number, number];
    readonly pendingintroduction_complete: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly pendingintroduction_isPending: (a: number, b: any) => [number, number, number];
    readonly pendingintroduction_request: (a: number) => [number, number, number];
    readonly pendinginvitation_request: (a: number) => [number, number, number];
    readonly platform_new: (a: any, b: any, c: any) => [number, number, number];
    readonly prepareIntroduction: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly prepareInvitationIntroduction: (a: number, b: any, c: any) => [number, number, number];
    readonly promotion_state: (a: number) => [number, number, number];
    readonly removalDecode: (a: any) => [number, number, number];
    readonly removalDevice: (a: number, b: any, c: any) => [number, number, number];
    readonly removalPerson: (a: number, b: any, c: any) => [number, number, number];
    readonly session_ackedGeneration: (a: number) => [number, number, number];
    readonly session_add: (a: number, b: any, c: any) => [number, number, number];
    readonly session_appliedCommits: (a: number) => [number, number, number];
    readonly session_commitAck: (a: number, b: any, c: any) => [number, number];
    readonly session_completeInvitation: (a: number, b: any, c: number, d: any, e: any) => [number, number, number];
    readonly session_completeUpdate: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly session_confirmMember: (a: number, b: any) => [number, number, number];
    readonly session_depositResult: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly session_epoch: (a: number) => [number, number, number];
    readonly session_generation: (a: number) => [number, number, number];
    readonly session_groupId: (a: number) => [number, number, number];
    readonly session_homeBox: (a: number) => [number, number, number];
    readonly session_id: (a: number) => [number, number, number];
    readonly session_inspectLocalCheckpoint: (a: number, b: any, c: any, d: any, e: any) => [number, number, number];
    readonly session_installation: (a: number) => [number, number, number];
    readonly session_invitationResponse: (a: number, b: any) => [number, number, number];
    readonly session_issuedInvitation: (a: number, b: any, c: any) => [number, number, number];
    readonly session_mailboxDrained: (a: number, b: any) => [number, number, number];
    readonly session_members: (a: number) => [number, number, number];
    readonly session_nextAttempt: (a: number) => [number, number, number];
    readonly session_observeInstallation: (a: number, b: any, c: any) => [number, number, number];
    readonly session_observeReceipt: (a: number, b: any, c: any) => [number, number, number];
    readonly session_open: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly session_openInvitationSession: (a: number, b: any, c: any, d: any, e: any) => [number, number, number];
    readonly session_outboundDelivered: (a: number, b: any) => [number, number, number];
    readonly session_outbox: (a: number) => [number, number, number];
    readonly session_ownLeafId: (a: number) => [number, number, number];
    readonly session_phase: (a: number) => [number, number, number];
    readonly session_prepareCapability: (a: number, b: any, c: any) => [number, number, number];
    readonly session_prepareCreate: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly session_prepareCreateInvitationProfile: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly session_prepareInvitation: (a: number, b: any, c: any) => [number, number, number];
    readonly session_prepareInvitationCapability: (a: number, b: any, c: any, d: any, e: any) => [number, number, number];
    readonly session_prepareUpdate: (a: number, b: any, c: any) => [number, number, number];
    readonly session_process: (a: number, b: any, c: any, d: any, e: any, f: any) => [number, number, number];
    readonly session_profile: (a: number) => [number, number, number];
    readonly session_recordInvitationResponse: (a: number, b: any, c: number) => [number, number, number];
    readonly session_remove: (a: number, b: any, c: any) => [number, number, number];
    readonly session_repair: (a: number, b: any, c: any, d: any) => [number, number, number];
    readonly session_retryInvitationResponse: (a: number, b: any) => [number, number, number];
    readonly session_send: (a: number, b: any) => [number, number, number];
    readonly session_slotStatus: (a: number, b: any, c: any, d: any, e: any) => [number, number, number];
    readonly session_tick: (a: number, b: any) => [number, number, number];
    readonly session_updateRequired: (a: number) => [number, number, number];
    readonly session_watchList: (a: number) => [number, number, number];
    readonly staged_state: (a: number) => [number, number, number];
    readonly vmlsremoval_claim: (a: number) => [number, number, number];
    readonly vmlsremoval_claimCopy: (a: number) => [number, number, number];
    readonly vmlsremoval_credential: (a: number) => [number, number, number];
    readonly vmlsremoval_encode: (a: number) => [number, number, number];
    readonly vmlsremoval_grants: (a: number) => [number, number, number];
    readonly vmlsremoval_leafIds: (a: number) => [number, number, number];
    readonly vmlsremoval_mls: (a: number) => [number, number, number];
    readonly vmlsremoval_mlsCommitted: (a: number, b: number, c: number) => [number, number];
    readonly vmlsremoval_next: (a: number, b: number) => [number, number, number];
    readonly vmlsremoval_openedEpoch: (a: number) => [number, number, number];
    readonly vmlsremoval_personIdentity: (a: number) => [number, number, number];
    readonly vmlsremoval_sessionId: (a: number) => [number, number, number];
    readonly vmlsremoval_setCredential: (a: number, b: any) => [number, number];
    readonly vmlsremoval_setGrant: (a: number, b: any, c: any) => [number, number];
    readonly vmlsremoval_setMls: (a: number, b: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
