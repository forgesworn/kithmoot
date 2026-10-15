import type {Page} from '@playwright/test'
import {controls} from './ordinary-member-session.setup.js'
export async function memberTransport(page: Page): Promise<void> {
  await page.evaluate(`window.secret=new Uint8Array(preparedAuthoritySecret);window.roomId=Ordinary.deriveRoom(secret).roomId;
    window.inviterSk=new Uint8Array(preparedAuthoritySigner);window.memberEpochTimeoutMs=10000`)
  // This is the synthetic authority's relay, not an application observer.
  // Return a grant sealed to the credential from the actual signed request.
  const relay = controls.slice(controls.indexOf(' window.nativeHeld='), controls.indexOf(' if(!window.deferMemberCreation)'))
    .replace("if(frame[1].kind===20468&&grants){", `if(frame[1].kind===20468&&grants){
      if(!Ordinary.decodeEpochRequest(frame[1],{roomId,authoritySk:inviterSk,roomKey:Ordinary.deriveRoom(secret).roomKey,now:Math.floor(Date.now()/1000)}))throw Error('invalid native epoch request');`)
    .replace('credential:ownCredential', "credential:JSON.parse(Ordinary.nip44.v2.decrypt(frame[1].content,Ordinary.nip44.v2.utils.getConversationKey(inviterSk,frame[1].pubkey))).credential")
  await page.evaluate(`(()=>{${relay}})()`)
}

