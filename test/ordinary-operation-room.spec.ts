import { build } from 'esbuild'
import { test, expect } from '@playwright/test'
import { setup } from './ordinary-bootstrap.setup.js'
const ORIGIN = 'https://ordinary-operation-room.invalid'
let bundle = ''
test.beforeAll(async () => { bundle = (await build({ entryPoints: ['test/ordinary-operation-room.browser-entry.ts'],bundle:true,write:false,
  format:'iife',globalName:'Ordinary',platform:'browser',target:'es2022' })).outputFiles[0]!.text })
test.beforeEach(async ({context,page}) => {
  await context.route(ORIGIN+'/**',route=>route.fulfill({contentType:'text/html',body:`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`}))
  await page.goto(ORIGIN);await page.clock.install()
})
for(const visitor of [false,true]) for(const keep of [false,true]) for(const scenario of ['ordinary','unrelated-url','conflicting-url','orphan-matching-url',...visitor?[]:['redirect-origin','relay-origin','initial-origin']]) {
  test(`cleanup preserves actual signed room custody, visitor=${visitor}, keep=${keep}, scenario=${scenario}`,async({page})=>{
    await page.evaluate(`(${setup})(${JSON.stringify({visitor,keep,noRelays:true})})`)
    await page.evaluate(`(async()=>{
      const material=await bootstrap.bootstrap(evidence);Ordinary.wipeOrdinaryPersistentBootstrapResult(material);await bootstrap.close();
      window.prior=(await images())[0];
      // This is authenticated fixture journal enrollment, not a production
      // renewal producer. The retained room/device/credential source is real.
      const [br,tr]=await rawBoth(),bi=await Ordinary.openOrdinaryFrame(br.frame,br.key),ti=await Ordinary.openOrdinaryFrame(tr.frame,tr.key);
      window.scenario='${scenario}';
      if(scenario==='unrelated-url')history.replaceState(null,'','#malformed-current-link');
      if(scenario==='conflicting-url'){
        const other=Ordinary.roomInvitation(new Uint8Array(32).fill(18),Ordinary.getPublicKey(inviterSk),true);
        history.replaceState(null,'',new URL(Ordinary.encodeRoomLink(location.origin+'/j/',{invitation:other,relays:[],iceUrls:[]})).hash);
      }
      if(scenario==='orphan-matching-url'){
        history.replaceState(null,'',new URL(url).hash);
        for(const image of [bi,ti]) for(const name of [...image.records.keys()]){
          const family=Ordinary.classifyOrdinaryPhysicalName(name,image===bi?'browser':'tab')?.family;
          if(['access','bookmarks','navigation'].includes(family)&&name.includes('kithmoot.room.')||['bookmarks','navigation'].includes(family))image.records.delete(name);
        }
      }
      if(scenario==='redirect-origin')bi.records.set(Ordinary.ORDINARY_SIGNET_KEYS.pendingRedirect,JSON.stringify({challenge:'5'.repeat(64),origin:'https://conflicting-origin.invalid',appName:'KithMoot',createdAt:Date.now()}));
      if(scenario==='relay-origin')bi.records.set(Ordinary.ORDINARY_SIGNET_KEYS.pendingRelayAuth,JSON.stringify({challenge:'5'.repeat(64),origin:'https://conflicting-origin.invalid',appName:'KithMoot',relayUrl:'wss://relay.invalid',sessionSkHex:'0'.repeat(63)+'1',issuedAt:Date.now()}));
      if(scenario==='initial-origin')ti.records.set('kithmoot.initial-login.v1',JSON.stringify({version:1,method:'nip07',origin:'https://conflicting-origin.invalid',appName:'KithMoot',challenge:'5'.repeat(64),account,
        createdAt:Date.now(),expiresAt:Date.now()+300000,browser:{generation:bi.generation,fence:0},tab:{purpose:tabPurpose,generation:ti.generation,fence:0}}));
      const names=Ordinary.ordinaryOperationNames(tabPurpose),id='4'.repeat(64),sequence=1;
      const marker=Ordinary.ordinaryOperationMarker({id,tab:tabPurpose,sequence,commitment:null});
      bi.records.set(names.marker,marker);ti.records.set(names.marker,marker);bi.revision++;ti.revision++;
      const be=await Ordinary.sealOrdinaryImage(bi,br.key),te=await Ordinary.sealOrdinaryImage(ti,tr.key);
      bi.revision++;ti.revision++;const bc=await Ordinary.sealOrdinaryImage(bi,br.key),tc=await Ordinary.sealOrdinaryImage(ti,tr.key);
      const digest=async text=>Ordinary.bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))));
      const journal={version:1,id,tab:tabPurpose,sequence,phase:'settled',source:[Ordinary.ordinaryFrameDigest(br.frame),Ordinary.ordinaryFrameDigest(tr.frame)],
        enrolled:[Ordinary.ordinaryFrameDigest(be),Ordinary.ordinaryFrameDigest(te)],target:[Ordinary.ordinaryFrameDigest(bc),Ordinary.ordinaryFrameDigest(tc)],
        sourceRevisions:[br.frame.revision,tr.frame.revision],enrolledRevisions:[be.revision,te.revision],targetRevisions:[bc.revision,tc.revision],
        requestDigest:await digest('authenticated fixture source'),resultDigest:await digest('completed fixture operation'),
        scopes:[['browser',invScopeName,bi.generation,bi.fences.get(invScopeName)??0],[tabPurpose,invScopeName,ti.generation,ti.fences.get(invScopeName)??0]],
        ceilings:[tabExpiry],request:'',result:null,secrets:[],nonces:null};
      const commitment=Ordinary.ordinaryOperationCommitment(Ordinary.decodeOrdinaryOperationClassification(Ordinary.encodeOrdinaryOperationJournal(journal)));
      const settledMarker=Ordinary.ordinaryOperationMarker({id,tab:tabPurpose,sequence,commitment});bi.records.set(names.marker,settledMarker);ti.records.set(names.marker,settledMarker);
      bi.revision++;ti.revision++;
      const binding=i=>({purpose:i.purpose,keyId:i.keyId,generation:i.generation,expiresAt:i.expiresAt});
      const control=await Ordinary.sealOrdinaryOperationControl(journal,{browser:{binding:binding(bi),key:br.key},tab:{binding:binding(ti),key:tr.key}});
      const bf=await Ordinary.sealOrdinaryImage(bi,br.key),tf=await Ordinary.sealOrdinaryImage(ti,tr.key);
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(Ordinary.ORDINARY_DATABASE,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const tx=db.transaction('owners','readwrite');tx.objectStore('owners').put({key:br.key,frame:bf},'browser');tx.objectStore('owners').put({key:tr.key,frame:tf},tabPurpose);tx.objectStore('owners').put(control,names.control);
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();window.names=names;
      window.seeded=await rawBoth();window.signsBefore=signCalls;countCrypto();
    })()`)
    await page.clock.fastForward(3600_100)
    expect(await page.evaluate(`(async()=>{
      const status=await outcome(()=>Ordinary.OrdinaryStateOwner.expireTabs(guard,()=>{}));
      if(['orphan-matching-url','redirect-origin','relay-origin','initial-origin'].includes(scenario)){
        const rows=await rawBoth();return [status,rows.every((row,i)=>Ordinary.sameOrdinaryFrame(row.frame,seeded[i].frame)),signCalls===signsBefore,entropy,encryptions];
      }
      if(status!=='ok')return [status];
      const [row,missing]=await rawBoth(),image=await Ordinary.openOrdinaryFrame(row.frame,row.key);
      return [!missing,!image.records.has(names.marker),JSON.stringify([...image.records])===JSON.stringify([...prior.records]),
        JSON.stringify([...image.fences])===JSON.stringify([...prior.fences]),JSON.stringify(image.migration)===JSON.stringify(prior.migration),
        signCalls===signsBefore,entropy,encryptions];
    })()`)).toEqual(['orphan-matching-url','redirect-origin','relay-origin','initial-origin'].includes(scenario)?['OrdinaryStateHold',true,true,0,0]:[true,true,true,true,true,true,1,1])
  })
}
