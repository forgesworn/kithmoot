import {defineConfig,devices} from '@playwright/test'
import {readFileSync} from 'node:fs'
// Validation-only branch: preserve serial hook lifetime and the original
// per-case limits. Fixed title slices preserve each engine’s disjoint full union.
const titles:unknown=JSON.parse(readFileSync(new URL('./test/private-renewal-validation-titles.json',import.meta.url),'utf8'))
if(!Array.isArray(titles)||titles.length!==533||titles.some(v=>typeof v!=='string')||new Set(titles).size!==533)throw Error('Private renewal title inventory drift')
const shard=process.env.ORDINARY_RENEWAL_SHARD
if(!['1','2','3','4'].includes(shard??''))throw Error('Select one fixed private renewal validation shard')
const boundaries=[0,134,267,400,533] as const
const index=Number(shard)-1
const selected=(titles as string[]).slice(boundaries[index],boundaries[index+1])
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
export default defineConfig({
  testDir:'test',testMatch:'ordinary-private-existing-root.spec.ts',
  timeout:30_000,expect:{timeout:5_000},fullyParallel:false,workers:1,retries:0,repeatEach:1,maxFailures:1,forbidOnly:true,
  grep:new RegExp('(?:^| )(?:'+selected.map(escape).join('|')+')$'),
  outputDir:'test-results/private-renewal-validation',
  reporter:[['list'],['json',{outputFile:'test-results/private-renewal-report.json'}]],
  projects:[{name:'chromium-sdk020',use:devices['Desktop Chrome']},{name:'firefox-sdk020',use:devices['Desktop Firefox']},{name:'webkit-sdk020',use:devices['Desktop Safari']}],
})
