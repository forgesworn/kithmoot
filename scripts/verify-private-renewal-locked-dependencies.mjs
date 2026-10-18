import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'))
const expected={'@forgesworn/fold-kit':'0.12.0','signet-login':'0.20.0','signet-verify':'0.7.1','@playwright/test':'1.62.1','typescript':'5.9.3','esbuild':'0.28.2'}
const versions={}
for(const [name,version]of Object.entries(expected)){
 const declared=lock.packages['node_modules/'+name],actual=JSON.parse(readFileSync(new URL('../node_modules/'+name+'/package.json',import.meta.url),'utf8'))
 assert.equal(declared.version,version,name+' lock version');assert.equal(actual.version,version,name+' installed version')
 versions[name]={version,resolved:declared.resolved,integrity:declared.integrity??null}
}
console.log(JSON.stringify({node:process.version,lockedDependencies:versions}))
