/** Synthetic synchronous no-effect probe. Primary SDK and queue custody are
 * exercised separately by the existing native specs; this does not model
 * production tab lifetime, clients, authority or the complete root. */
export const preflightProbe = `
  const originals={random:crypto.getRandomValues,generate:crypto.subtle.generateKey,encrypt:crypto.subtle.encrypt,
    open:indexedDB.open,set:Storage.prototype.setItem,remove:Storage.prototype.removeItem,clear:Storage.prototype.clear,
    now:Date.now,fetch:window.fetch,socket:window.WebSocket};
  const effects={entropy:0,keys:0,encryptions:0,opens:0,writes:0,clocks:0,network:0};
  const blocked=name=>()=>{effects[name]++;throw Error('unexpected '+name)};
  crypto.getRandomValues=blocked('entropy');crypto.subtle.generateKey=blocked('keys');crypto.subtle.encrypt=blocked('encryptions');
  indexedDB.open=blocked('opens');Storage.prototype.setItem=blocked('writes');Storage.prototype.removeItem=blocked('writes');Storage.prototype.clear=blocked('writes');
  Date.now=blocked('clocks');window.fetch=blocked('network');window.WebSocket=blocked('network');
  const restore=()=>{crypto.getRandomValues=originals.random;crypto.subtle.generateKey=originals.generate;crypto.subtle.encrypt=originals.encrypt;
    indexedDB.open=originals.open;Storage.prototype.setItem=originals.set;Storage.prototype.removeItem=originals.remove;Storage.prototype.clear=originals.clear;
    Date.now=originals.now;window.fetch=originals.fetch;window.WebSocket=originals.socket};
`
export const noPreflightEffects = { entropy: 0, keys: 0, encryptions: 0, opens: 0, writes: 0, clocks: 0, network: 0 }
