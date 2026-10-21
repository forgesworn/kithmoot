
const NativeUint8Array = Uint8Array;
const apply = Reflect.apply;
const defineProperty = Object.defineProperty;
const typed = Object.getPrototypeOf(NativeUint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset').get;
const getLength = Object.getOwnPropertyDescriptor(typed, 'length').get;
const getName = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag).get;
const setBytes = typed.set;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
export function stableRequestBody(value) {
    if (apply(getName, value, []) !== 'Uint8Array') {
        throw new TypeError('body must be a Uint8Array');
    }
    const buffer = apply(getBuffer, value, []);
    // The ArrayBuffer intrinsic rejects SharedArrayBuffer, including growable
    // storage. The constructor below rejects detached buffers.
    apply(getBufferLength, buffer, []);
    if (getResizable && apply(getResizable, buffer, [])) {
        throw new TypeError('body must use a fixed ArrayBuffer');
    }
    const offset = apply(getOffset, value, []);
    const length = apply(getLength, value, []);
    const view = new NativeUint8Array(buffer, offset, length);
    defineProperty(view, 'length', { value: length });
    return view;
}
export function copyRequestBody(view) {
    const length = apply(getLength, view, []);
    const snapshot = new NativeUint8Array(length);
    apply(setBytes, snapshot, [view]);
    defineProperty(snapshot, 'length', { value: length });
    return snapshot;
}
