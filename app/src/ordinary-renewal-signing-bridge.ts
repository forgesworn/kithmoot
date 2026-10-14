/** @internal Fixed owner ↔ foreground plumbing. Registrar callsites belong
 * solely to the fixed owner; there is no package export or arbitrary signer,
 * template, phase writer or Session adoption facade. */
import type { EventTemplate,SignerEffectBoundary } from 'signet-login'
import type { OrdinaryForegroundSigner } from './ordinary-foreground-signer.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { checkOrdinaryRenewalSigningObligation,validateOrdinaryRenewalSigningForeground,type OrdinaryRenewalObligation } from './ordinary-renewal-obligation.js'
declare const lifetimeBrand:unique symbol
export interface OrdinaryRenewalSigningLifetime {readonly [lifetimeBrand]:true}
declare const attemptBrand:unique symbol
export interface OrdinaryRenewalSigningAttempt {readonly [attemptBrand]:true}
interface Lifetime {
 readonly obligation:OrdinaryRenewalObligation
 readonly pending:Promise<unknown>
 readonly signer:OrdinaryForegroundSigner
 tracked:boolean
 attempted:boolean
}
const lifetimes=new WeakMap<object,Lifetime>(),attempts=new WeakMap<object,{lifetime:Lifetime;statement:Required<EventTemplate>;boundary:SignerEffectBoundary;consumed:boolean}>()
function hold():never{throw new OrdinaryStateHold()}
/** Sole callsite: owner, after registering its exact outer promise. */
export function registerOrdinaryRenewalSigningLifetime(input:Readonly<{obligation:OrdinaryRenewalObligation;pending:Promise<unknown>;signer:OrdinaryForegroundSigner}>):OrdinaryRenewalSigningLifetime{
 validateOrdinaryRenewalSigningForeground(input.obligation,input.pending,input.signer)
 const token=Object.freeze({}) as OrdinaryRenewalSigningLifetime
 lifetimes.set(token,{...input,tracked:false,attempted:false});return token
}
/** Sole callsite: the captured native Fore implementation. */
export function takeOrdinaryRenewalSigningLifetime(token:OrdinaryRenewalSigningLifetime,signer:OrdinaryForegroundSigner):Promise<unknown>{
 const value=lifetimes.get(token);if(!value||value.signer!==signer||value.tracked)hold()
 validateOrdinaryRenewalSigningForeground(value.obligation,value.pending,signer);value.tracked=true;return value.pending
}
/** Sole callsite: owner, only after exact provider-started native readback.
 * The supplied boundary is the owner's fixed, permanently one-use seam. */
export function registerOrdinaryRenewalSigningAttempt(token:OrdinaryRenewalSigningLifetime,statement:Required<EventTemplate>,boundary:SignerEffectBoundary):OrdinaryRenewalSigningAttempt{
 const value=lifetimes.get(token);if(!value||!value.tracked||value.attempted)hold()
 checkOrdinaryRenewalSigningObligation(value.obligation,value.pending);value.attempted=true
 const attempt=Object.freeze({}) as OrdinaryRenewalSigningAttempt
 attempts.set(attempt,{lifetime:value,statement,boundary,consumed:false});return attempt
}
/** Sole callsite: static Fore.signMemberRenewal. No caller template is read. */
export function takeOrdinaryRenewalSigningAttempt(token:OrdinaryRenewalSigningAttempt,signer:OrdinaryForegroundSigner):Readonly<{statement:Required<EventTemplate>;boundary:SignerEffectBoundary;pending:Promise<unknown>}>{
 const value=attempts.get(token);if(!value||value.consumed||value.lifetime.signer!==signer)hold()
 validateOrdinaryRenewalSigningForeground(value.lifetime.obligation,value.lifetime.pending,signer);value.consumed=true
 return Object.freeze({statement:value.statement,boundary:value.boundary,pending:value.lifetime.pending})
}
export function releaseOrdinaryRenewalSigningLifetime(token:OrdinaryRenewalSigningLifetime|undefined):void{if(token)lifetimes.delete(token)}

/** Sole consumer: Fore's captured client check, while its exact P is tracked. */
export function validateOrdinaryRenewalSigningLifetime(token:OrdinaryRenewalSigningLifetime,signer:OrdinaryForegroundSigner):Promise<unknown>{
 const value=lifetimes.get(token);if(!value||!value.tracked||value.signer!==signer)hold()
 validateOrdinaryRenewalSigningForeground(value.obligation,value.pending,signer);return value.pending
}
