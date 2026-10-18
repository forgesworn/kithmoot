import {defineConfig,devices} from '@playwright/test'
import {readFileSync} from 'node:fs'
// Validation-only branch: preserve serial hook lifetime and the original
// per-case limits. Fixed title halves give each engine a disjoint full union.
const titles:unknown=JSON.parse(readFileSync(new URL('./test/private-renewal-validation-titles.json',import.meta.url),'utf8'))
if(!Array.isArray(titles)||titles.length!==533||titles.some(v=>typeof v!=='string')||new Set(titles).size!==533)throw Error('Private renewal title inventory drift')
const shard=process.env.ORDINARY_RENEWAL_SHARD
if(shard!=='1'&&shard!=='2')throw Error('Select one fixed private renewal validation shard')
const selected=(titles as string[]).slice(shard==='1'?0:267,shard==='1'?267:533)
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
export default defineConfig({
  testDir:'test',testMatch:'ordinary-private-existing-root.spec.ts',
  timeout:30_000,expect:{timeout:5_000},fullyParallel:false,workers:1,retries:0,repeatEach:1,maxFailures:1,forbidOnly:true,
  grep:new RegExp('(?:^| )(?:'+selected.map(escape).join('|')+')$'),
  outputDir:'test-results/private-renewal-validation',
  reporter:[['list'],['json',{outputFile:'test-results/private-renewal-report.json'}]],
  projects:[{name:'chromium-sdk020',use:devices['Desktop Chrome']},{name:'firefox-sdk020',use:devices['Desktop Firefox']},{name:'webkit-sdk020',use:devices['Desktop Safari']}],
})
