/* tslint:disable */
/* eslint-disable */

/** One paired route, exactly as the page must persist it. */
export interface LinkRoute {
    routeId: string;
    card: Uint8Array;
    pairedRouteSecret: Uint8Array;
    /** A u64 carried exactly; a safe-integer number is also accepted. */
    cardSerial: bigint;
    /** Unix seconds, a u64 carried exactly; a safe-integer number is also accepted. */
    cardVerifiedAt: bigint;
}
export interface LinkConfig {
    /** 32 bytes, supplied by the host from its own encrypted storage. */
    transportSeed: Uint8Array;
    /** wss:// relays only; a browser cannot pin or skip certificate checks. */
    relayUrls: string[];
    routes: LinkRoute[];
}
export interface LinkPairingBundle {
    routeId: string;
    serverCard: Uint8Array;
    /** The QR's 16 raw capability bytes; never retained. */
    pairingSecret: Uint8Array;
    /** Absolute Unix-second deadline. */
    expiresAt: number;
}
export interface LinkPath {
    status: string;
    relay: string | null;
    direct: string | null;
    cause: string;
}
export interface LinkHttpRequest {
    routeId: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    authorization: string;
    body: Uint8Array;
}
export interface LinkHttpResponse {
    status: number;
    body: Uint8Array;
    witnessRefused: boolean;
    path: LinkPath;
}
export interface LinkSocketListener {
    onOpen?: () => void;
    onText?: (text: string) => void;
    onClosed?: (reason: string) => void;
}



/**
 * The browser Link engine.
 */
export class LinkEngine {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Remove the paired transport at the server after logical retirement.
     */
    finalizeRoute(routeId: string): Promise<void>;
    /**
     * Open the route's event WebSocket: text only, bounded as link-websocket
     * bounds it, over a Link stream to the route's pinned peer.
     */
    openSocket(virtualUrl: string, routeId: string, listener: LinkSocketListener): Promise<LinkSocket>;
    /**
     * Enrol a route from a scanned pairing QR and return the exact record
     * the page must persist.  The route is also installed at once.
     */
    pairRoute(bundle: LinkPairingBundle): Promise<LinkRoute>;
    /**
     * Forget a route locally and close its session.
     */
    removeRoute(routeId: string): Promise<void>;
    /**
     * One bounded, allowlisted request (cadence, VMLS or witness) over the
     * route's pinned session.
     */
    request(request: LinkHttpRequest): Promise<LinkHttpResponse>;
    /**
     * Ask the paired server to retire the route.  Local credentials stay.
     */
    retireRoute(routeId: string): Promise<void>;
    /**
     * Open the endpoint on the host's transport seed and install the
     * persisted routes.  Relay-only; every relay must be `wss://`.
     */
    static start(config: LinkConfig): Promise<LinkEngine>;
    /**
     * Stop the engine: refuse every later call, close its sessions, remove
     * every route secret from it and close the endpoint.
     */
    stop(): Promise<void>;
    /**
     * Install a newer record of a route (its card serial must increase).
     */
    upsertRoute(route: LinkRoute): Promise<void>;
}

/**
 * A text WebSocket over a Link stream.
 */
export class LinkSocket {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Start a normal close; `onClosed` reports the end.
     */
    disconnect(): void;
    path(): LinkPath;
    /**
     * Queue one text message; refused above the size bound or when the
     * outbound queue is full (which also closes the socket).
     */
    sendText(text: string): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_linkengine_free: (a: number, b: number) => void;
    readonly __wbg_linksocket_free: (a: number, b: number) => void;
    readonly linkengine_finalizeRoute: (a: number, b: number, c: number) => any;
    readonly linkengine_openSocket: (a: number, b: number, c: number, d: number, e: number, f: any) => any;
    readonly linkengine_pairRoute: (a: number, b: any) => any;
    readonly linkengine_removeRoute: (a: number, b: number, c: number) => any;
    readonly linkengine_request: (a: number, b: any) => any;
    readonly linkengine_retireRoute: (a: number, b: number, c: number) => any;
    readonly linkengine_start: (a: any) => any;
    readonly linkengine_stop: (a: number) => any;
    readonly linkengine_upsertRoute: (a: number, b: any) => any;
    readonly linksocket_disconnect: (a: number) => [number, number];
    readonly linksocket_path: (a: number) => any;
    readonly linksocket_sendText: (a: number, b: number, c: number) => [number, number];
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h42738cbd1e00e781: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__he5b9d713ca4b1735: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h0796117c95730a5b: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h0796117c95730a5b_15: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h0796117c95730a5b_16: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hb1ae107ef32ecc5f: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
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
