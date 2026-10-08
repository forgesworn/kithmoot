/* @ts-self-types="./vmls_wasm.d.ts" */

/**
 * A capability record the adder verified. `Session.add` and
 * `Session.repair` consume the objects they are given, whatever the result;
 * open the record again to retry.
 */
export class Capability {
    static __wrap(ptr) {
        const obj = Object.create(Capability.prototype);
        obj.__wbg_ptr = ptr;
        CapabilityFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    static __unwrap(jsValue) {
        if (!(jsValue instanceof Capability)) {
            return 0;
        }
        return jsValue.__destroy_into_raw();
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CapabilityFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_capability_free(ptr, 0);
    }
    /**
     * `{ packageId, expiresAt, identity, device, leafId, homeBox,
     * bindingExpiresAt, credentialId, credentialExpiresAt }`. No key.
     * @returns {any}
     */
    info() {
        const ret = wasm.capability_info(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Capability.prototype[Symbol.dispose] = Capability.prototype.free;

/**
 * A persona installation's coordinator, open under the caller's lock.
 */
export class Coordinator {
    static __wrap(ptr) {
        const obj = Object.create(Coordinator.prototype);
        obj.__wbg_ptr = ptr;
        CoordinatorFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CoordinatorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_coordinator_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    confirmed() {
        const ret = wasm.coordinator_confirmed(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * The fence reason, or `undefined`.
     * @returns {any}
     */
    fenced() {
        const ret = wasm.coordinator_fenced(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    installationReplaced() {
        const ret = wasm.coordinator_installationReplaced(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {any} answer
     * @returns {any}
     */
    onAdvance(answer) {
        const ret = wasm.coordinator_onAdvance(this.__wbg_ptr, answer);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} answer
     * @returns {any}
     */
    onRead(answer) {
        const ret = wasm.coordinator_onRead(this.__wbg_ptr, answer);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} answer
     * @returns {any}
     */
    onRetiringRead(answer) {
        const ret = wasm.coordinator_onRetiringRead(this.__wbg_ptr, answer);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} answer
     * @returns {any}
     */
    onRetiring(answer) {
        const ret = wasm.coordinator_onRetiring(this.__wbg_ptr, answer);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {Promotion}
     */
    promote() {
        const ret = wasm.coordinator_promote(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Promotion.__wrap(ret[0]);
    }
    /**
     * The promotion is persisted: returns each session's witnessed
     * generation, to `commitAck` before anything is released.
     * @param {Promotion} promotion
     * @returns {any}
     */
    promoted(promotion) {
        _assertClass(promotion, Promotion);
        const ret = wasm.coordinator_promoted(this.__wbg_ptr, promotion.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    read() {
        const ret = wasm.coordinator_read(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {boolean}
     */
    refused() {
        const ret = wasm.coordinator_refused(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {any}
     */
    resend() {
        const ret = wasm.coordinator_resend(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The retiring advance, only straight after `retireDue`; otherwise
     * `undefined`.
     * @returns {any}
     */
    retiringAdvance() {
        const ret = wasm.coordinator_retiringAdvance(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The retiring read, or `undefined` when no duty stands.
     * @returns {any}
     */
    retiringRead() {
        const ret = wasm.coordinator_retiringRead(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {boolean}
     */
    retiring() {
        const ret = wasm.coordinator_retiring(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {any}
     */
    sessionMarks() {
        const ret = wasm.coordinator_sessionMarks(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} candidate
     * @returns {Staged}
     */
    stage(candidate) {
        const ret = wasm.coordinator_stage(this.__wbg_ptr, candidate);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Staged.__wrap(ret[0]);
    }
    /**
     * The stage is persisted: returns the advance request to send. The
     * stage is spent only when it applies.
     * @param {Staged} staged
     * @returns {any}
     */
    staged(staged) {
        _assertClass(staged, Staged);
        const ret = wasm.coordinator_staged(this.__wbg_ptr, staged.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The bytes to persist after every answer and decision.
     * @returns {any}
     */
    state() {
        const ret = wasm.coordinator_state(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Coordinator.prototype[Symbol.dispose] = Coordinator.prototype.free;

/**
 * Where a joining person's capability record arrives, and what opens it.
 * Returns no secret.
 */
export class Introduction {
    static __wrap(ptr) {
        const obj = Object.create(Introduction.prototype);
        obj.__wbg_ptr = ptr;
        IntroductionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IntroductionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_introduction_free(ptr, 0);
    }
    /**
     * @returns {any}
     */
    counter() {
        const ret = wasm.introduction_counter(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The introduction mailbox to fetch.
     * @returns {any}
     */
    mailbox() {
        const ret = wasm.introduction_mailbox(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Opens and verifies a capability record fetched from the mailbox.
     * @param {any} now
     * @param {any} envelope
     * @returns {Capability}
     */
    openCapability(now, envelope) {
        const ret = wasm.introduction_openCapability(this.__wbg_ptr, now, envelope);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Capability.__wrap(ret[0]);
    }
    /**
     * @returns {any}
     */
    peerRz() {
        const ret = wasm.introduction_peerRz(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Introduction.prototype[Symbol.dispose] = Introduction.prototype.free;

/**
 * A capability record waiting for the device's signature and the ECDH with
 * the adder, under one operation id: ask for both at once.
 */
export class PendingCapability {
    static __wrap(ptr) {
        const obj = Object.create(PendingCapability.prototype);
        obj.__wbg_ptr = ptr;
        PendingCapabilityFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PendingCapabilityFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pendingcapability_free(ptr, 0);
    }
    /**
     * Both answers: `{ session, step }`. `sharedX` is wiped.
     * @param {any} now
     * @param {any} operation
     * @param {any} signature
     * @param {any} shared_x
     * @returns {any}
     */
    complete(now, operation, signature, shared_x) {
        const ret = wasm.pendingcapability_complete(this.__wbg_ptr, now, operation, signature, shared_x);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    ecdhRequest() {
        const ret = wasm.pendingcapability_ecdhRequest(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Whether it still waits for its answers at `now`; an expired one is
     * wiped here.
     * @param {any} now
     * @returns {boolean}
     */
    isPending(now) {
        const ret = wasm.pendingcapability_isPending(this.__wbg_ptr, now);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {any}
     */
    signRequest() {
        const ret = wasm.pendingcapability_signRequest(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) PendingCapability.prototype[Symbol.dispose] = PendingCapability.prototype.free;

/**
 * A group creation waiting for the device's signature.
 */
export class PendingCreate {
    static __wrap(ptr) {
        const obj = Object.create(PendingCreate.prototype);
        obj.__wbg_ptr = ptr;
        PendingCreateFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PendingCreateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pendingcreate_free(ptr, 0);
    }
    /**
     * The 64-byte signature over the request's digest: `{ session, step }`.
     * Ends the operation whatever the result, unless `operation` is not
     * this one's.
     * @param {any} now
     * @param {any} operation
     * @param {any} signature
     * @returns {any}
     */
    complete(now, operation, signature) {
        const ret = wasm.pendingcreate_complete(this.__wbg_ptr, now, operation, signature);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Whether it still waits for its answer at `now` (a BigInt); an expired
     * one is wiped here.
     * @param {any} now
     * @returns {boolean}
     */
    isPending(now) {
        const ret = wasm.pendingcreate_isPending(this.__wbg_ptr, now);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * `{ operation, digest, body, expiresAt }`.
     * @returns {any}
     */
    request() {
        const ret = wasm.pendingcreate_request(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) PendingCreate.prototype[Symbol.dispose] = PendingCreate.prototype.free;

/**
 * The adder's side of an introduction, waiting for the ECDH.
 */
export class PendingIntroduction {
    static __wrap(ptr) {
        const obj = Object.create(PendingIntroduction.prototype);
        obj.__wbg_ptr = ptr;
        PendingIntroductionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PendingIntroductionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pendingintroduction_free(ptr, 0);
    }
    /**
     * The ECDH's x coordinate (wiped): the `Introduction`.
     * @param {any} now
     * @param {any} operation
     * @param {any} shared_x
     * @returns {Introduction}
     */
    complete(now, operation, shared_x) {
        const ret = wasm.pendingintroduction_complete(this.__wbg_ptr, now, operation, shared_x);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Introduction.__wrap(ret[0]);
    }
    /**
     * Whether it still waits for its answer at `now`.
     * @param {any} now
     * @returns {boolean}
     */
    isPending(now) {
        const ret = wasm.pendingintroduction_isPending(this.__wbg_ptr, now);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * `{ operation, peerRz, expiresAt }`.
     * @returns {any}
     */
    request() {
        const ret = wasm.pendingintroduction_request(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) PendingIntroduction.prototype[Symbol.dispose] = PendingIntroduction.prototype.free;

/**
 * The CSPRNG and this device's two public keys, bound once.
 */
export class Platform {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PlatformFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_platform_free(ptr, 0);
    }
    /**
     * `deviceKey` is the device's 32-byte x-only public key, as its person
     * credential names it; `rendezvousKey` this person's x-only `rz`.
     * Neither secret half ever crosses.
     * @param {any} device_key
     * @param {any} rendezvous_key
     * @param {VmlsRandom} rng
     */
    constructor(device_key, rendezvous_key, rng) {
        const ret = wasm.platform_new(device_key, rendezvous_key, rng);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        PlatformFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Platform.prototype[Symbol.dispose] = Platform.prototype.free;

/**
 * A promotion: persist `state()` with the promoted objects, then pass it to
 * `promoted`. Applied once.
 */
export class Promotion {
    static __wrap(ptr) {
        const obj = Object.create(Promotion.prototype);
        obj.__wbg_ptr = ptr;
        PromotionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PromotionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_promotion_free(ptr, 0);
    }
    /**
     * @returns {any}
     */
    state() {
        const ret = wasm.promotion_state(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Promotion.prototype[Symbol.dispose] = Promotion.prototype.free;

/**
 * One device in one group.
 */
export class Session {
    static __wrap(ptr) {
        const obj = Object.create(Session.prototype);
        obj.__wbg_ptr = ptr;
        SessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_session_free(ptr, 0);
    }
    /**
     * @returns {any}
     */
    ackedGeneration() {
        const ret = wasm.session_ackedGeneration(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Consumes the `Capability` objects in `capabilities`.
     * @param {any} now
     * @param {any} capabilities
     * @returns {any}
     */
    add(now, capabilities) {
        const ret = wasm.session_add(this.__wbg_ptr, now, capabilities);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * `[{ epoch, commitHash }]`.
     * @returns {any}
     */
    appliedCommits() {
        const ret = wasm.session_appliedCommits(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * States that the snapshot of `generation` (a BigInt) is sealed and
     * persisted and that the high-water mark is now `highWater` (a BigInt,
     * at least `generation`; a lower one throws `HighWaterBehind`).
     * @param {any} generation
     * @param {any} high_water
     */
    commitAck(generation, high_water) {
        const ret = wasm.session_commitAck(this.__wbg_ptr, generation, high_water);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The signature over the prepared digest: the Update Commit's step.
     * @param {any} now
     * @param {any} operation
     * @param {any} signature
     * @returns {any}
     */
    completeUpdate(now, operation, signature) {
        const ret = wasm.session_completeUpdate(this.__wbg_ptr, now, operation, signature);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} package_id
     * @returns {any}
     */
    confirmMember(package_id) {
        const ret = wasm.session_confirmMember(this.__wbg_ptr, package_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * `signedReceipt` is the box's 197-byte receipt (decoded from base64).
     * @param {any} now
     * @param {any} attempt
     * @param {any} signed_receipt
     * @returns {any}
     */
    depositResult(now, attempt, signed_receipt) {
        const ret = wasm.session_depositResult(this.__wbg_ptr, now, attempt, signed_receipt);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    epoch() {
        const ret = wasm.session_epoch(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    generation() {
        const ret = wasm.session_generation(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    homeBox() {
        const ret = wasm.session_homeBox(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    id() {
        const ret = wasm.session_id(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The home box installation the group pins, or `null` before joining.
     * @returns {any}
     */
    installation() {
        const ret = wasm.session_installation(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The box answered a retained epoch's mailbox empty after
     * acknowledgement. The engine deletes it only once every remaining
     * member has been heard under a later epoch (contract §5.2, P3-07).
     * Until then it refuses and nothing changes: the step has no snapshot.
     * Report it again on a later empty answer.
     * @param {any} mailbox
     * @returns {any}
     */
    mailboxDrained(mailbox) {
        const ret = wasm.session_mailboxDrained(this.__wbg_ptr, mailbox);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    members() {
        const ret = wasm.session_members(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {number}
     */
    nextAttempt() {
        const ret = wasm.session_nextAttempt(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * The home box's current installation from a capabilities reply, at
     * every open and on every reply. Another than the group's fences it.
     * @param {any} now
     * @param {any} installation
     * @returns {any}
     */
    observeInstallation(now, installation) {
        const ret = wasm.session_observeInstallation(this.__wbg_ptr, now, installation);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * A receipt queried after an `OrderingUnconfirmed` event.
     * @param {any} now
     * @param {any} signed_receipt
     * @returns {any}
     */
    observeReceipt(now, signed_receipt) {
        const ret = wasm.session_observeReceipt(this.__wbg_ptr, now, signed_receipt);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Restores a session from the plaintext of its snapshot, which the
     * caller unsealed, and its high-water mark (a BigInt). A snapshot older
     * than the mark throws `Rollback`; a newer one opens unacknowledged, so
     * raise the mark to `generation()` and `commitAck` it before sending.
     * The adapter wipes the `plaintext` array it is given on every path,
     * including every refusal, before it looks at the other arguments.
     * @param {Platform} platform
     * @param {any} session
     * @param {any} plaintext
     * @param {any} high_water
     * @returns {Session}
     */
    static open(platform, session, plaintext, high_water) {
        _assertClass(platform, Platform);
        const ret = wasm.session_open(platform.__wbg_ptr, session, plaintext, high_water);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Session.__wrap(ret[0]);
    }
    /**
     * @param {any} record_ids
     * @returns {any}
     */
    outboundDelivered(record_ids) {
        const ret = wasm.session_outboundDelivered(this.__wbg_ptr, record_ids);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Records not yet confirmed delivered: after a restart, resend these
     * exact bytes. Throws `AwaitingCommitAck` until the latest snapshot is
     * acknowledged.
     * @returns {any}
     */
    outbox() {
        const ret = wasm.session_outbox(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    ownLeafId() {
        const ret = wasm.session_ownLeafId(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {any}
     */
    phase() {
        const ret = wasm.session_phase(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Prepares this device's capability record for an adder and its
     * pending-join session: a `PendingCapability`. The request is
     * `{ binding, expiresAt, adderRz, counter }`.
     * @param {Platform} platform
     * @param {any} now
     * @param {any} request
     * @returns {PendingCapability}
     */
    static prepareCapability(platform, now, request) {
        _assertClass(platform, Platform);
        const ret = wasm.session_prepareCapability(platform.__wbg_ptr, now, request);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PendingCapability.__wrap(ret[0]);
    }
    /**
     * Prepares a group with this device as its only member: a
     * `PendingCreate`. `installation` is the home box's current
     * installation from its capabilities reply (`parseCapabilities`); the
     * group pins it.
     * @param {Platform} platform
     * @param {any} now
     * @param {any} request
     * @param {any} installation
     * @returns {PendingCreate}
     */
    static prepareCreate(platform, now, request, installation) {
        _assertClass(platform, Platform);
        const ret = wasm.session_prepareCreate(platform.__wbg_ptr, now, request, installation);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PendingCreate.__wrap(ret[0]);
    }
    /**
     * Prepares an Update of this leaf's key and binding:
     * `{ operation, digest, expiresAt }`. Any change to the session before
     * `completeUpdate` makes it stale; preparing again replaces it.
     * @param {any} now
     * @param {any} request
     * @returns {any}
     */
    prepareUpdate(now, request) {
        const ret = wasm.session_prepareUpdate(this.__wbg_ptr, now, request);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Classifies and applies one record fetched from `mailbox`:
     * `{ outcome, ack, step }`.
     * `signedReceipt` is required for a commit-slot record and `undefined`
     * or `null` otherwise. `installation` is `{ homeBox, installation }`
     * for a Welcome, after an `InstallationNeeded` event named `homeBox`,
     * and `undefined` or `null` otherwise.
     * @param {any} now
     * @param {any} mailbox
     * @param {any} envelope
     * @param {any} signed_receipt
     * @param {any} installation
     * @returns {any}
     */
    process(now, mailbox, envelope, signed_receipt, installation) {
        const ret = wasm.session_process(this.__wbg_ptr, now, mailbox, envelope, signed_receipt, installation);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} now
     * @param {any} leaf_ids
     * @returns {any}
     */
    remove(now, leaf_ids) {
        const ret = wasm.session_remove(this.__wbg_ptr, now, leaf_ids);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Consumes the `Capability` objects in `add`.
     * @param {any} now
     * @param {any} remove
     * @param {any} add
     * @returns {any}
     */
    repair(now, remove, add) {
        const ret = wasm.session_repair(this.__wbg_ptr, now, remove, add);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} body
     * @returns {any}
     */
    send(body) {
        const ret = wasm.session_send(this.__wbg_ptr, body);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * `status` is `"Filled"`, `"Expired"` or `"Void"`, with the winner's
     * receipt. The receipt's label decides, never the word.
     * @param {any} now
     * @param {any} attempt
     * @param {any} status
     * @param {any} signed_receipt
     * @returns {any}
     */
    slotStatus(now, attempt, status, signed_receipt) {
        const ret = wasm.session_slotStatus(this.__wbg_ptr, now, attempt, status, signed_receipt);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {any} now
     * @returns {any}
     */
    tick(now) {
        const ret = wasm.session_tick(this.__wbg_ptr, now);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {boolean}
     */
    updateRequired() {
        const ret = wasm.session_updateRequired(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {any}
     */
    watchList() {
        const ret = wasm.session_watchList(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Session.prototype[Symbol.dispose] = Session.prototype.free;

/**
 * A staged candidate: persist `state()` with the candidate's objects, then
 * pass it to `staged`. Applied once.
 */
export class Staged {
    static __wrap(ptr) {
        const obj = Object.create(Staged.prototype);
        obj.__wbg_ptr = ptr;
        StagedFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        StagedFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_staged_free(ptr, 0);
    }
    /**
     * @returns {any}
     */
    state() {
        const ret = wasm.staged_state(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
}
if (Symbol.dispose) Staged.prototype[Symbol.dispose] = Staged.prototype.free;

/**
 * A new installation's genesis for the keeper's enrolment:
 * `{ state, digest }`. `subject` is the enrolment's; `installation` the
 * vault's own; `witness` the pinned witness key.
 * @param {any} subject
 * @param {any} installation
 * @param {any} witness
 * @param {any} active
 * @returns {any}
 */
export function coordinatorGenesis(subject, installation, witness, active) {
    const ret = wasm.coordinatorGenesis(subject, installation, witness, active);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * The hash the caller records for a sealed object's exact bytes.
 * @param {any} sealed
 * @returns {any}
 */
export function coordinatorObjectHash(sealed) {
    const ret = wasm.coordinatorObjectHash(sealed);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Opens the coordinator from its persisted state and the objects actually
 * stored, active and (if a candidate is staged) staged.
 * @param {Platform} platform
 * @param {any} state
 * @param {any} active
 * @param {any} staged
 * @returns {Coordinator}
 */
export function openCoordinator(platform, state, active, staged) {
    _assertClass(platform, Platform);
    const ret = wasm.openCoordinator(platform.__wbg_ptr, state, active, staged);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Coordinator.__wrap(ret[0]);
}

/**
 * The home box's current installation from its capabilities reply body (a
 * `Uint8Array`), parsed strictly; anything malformed is
 * `UnsupportedSecurityContract`.
 * @param {any} body
 * @returns {any}
 */
export function parseCapabilities(body) {
    const ret = wasm.parseCapabilities(body);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * The adder's side: prepares the introduction for `peerRz`'s capability
 * record number `counter` (a BigInt): a `PendingIntroduction`.
 * @param {Platform} platform
 * @param {any} now
 * @param {any} peer_rz
 * @param {any} counter
 * @returns {PendingIntroduction}
 */
export function prepareIntroduction(platform, now, peer_rz, counter) {
    _assertClass(platform, Platform);
    const ret = wasm.prepareIntroduction(platform.__wbg_ptr, now, peer_rz, counter);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return PendingIntroduction.__wrap(ret[0]);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_bigint_get_as_i64_a2383202b9353e4c: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_is_bigint_b123553bed3bb382: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_e343b7d08827ba72: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_3c45d4f2dde4e749: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_90b56bc79aad6f6c: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_02babf21faa37971: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_187d372bd5fdd4aa: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_capability_unwrap: function(arg0) {
            const ret = Capability.__unwrap(arg0);
            return ret;
        },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_fill_3ab05388022bd872: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.fill(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_fill_775586ed37049ccf: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.fill(arg1, arg2 >>> 0, arg3 >>> 0);
            return ret;
        },
        __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_get_31af05bd4842a84f: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_6c896e0571ddae51: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_Uint8Array_828cef2aaacafc31: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_e15a2ff68ffdbef2: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_length_78dac82682e59660: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_7f3c00c40364105e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_343a093a3c2ffb4e: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_ee2291f50781bf1d: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_from_slice_9a868026ffa4208a: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_3da0ad195f6f63ba: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_now_aa4ccb83129e9e55: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_2baf45db356cf468: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_session_new: function(arg0) {
            const ret = Session.__wrap(arg0);
            return ret;
        },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_name_2c630595dc90a7aa: function(arg0, arg1, arg2) {
            arg0.name = getStringFromWasm0(arg1, arg2);
        },
        __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_0b583911f537483a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_002b94d5e13d1411: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./vmls_wasm_bg.js": import0,
    };
}

const CapabilityFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_capability_free(ptr, 1));
const CoordinatorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_coordinator_free(ptr, 1));
const IntroductionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_introduction_free(ptr, 1));
const PendingCapabilityFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pendingcapability_free(ptr, 1));
const PendingCreateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pendingcreate_free(ptr, 1));
const PendingIntroductionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pendingintroduction_free(ptr, 1));
const PlatformFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_platform_free(ptr, 1));
const PromotionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_promotion_free(ptr, 1));
const SessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_session_free(ptr, 1));
const StagedFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_staged_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('vmls_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
