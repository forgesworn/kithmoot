import {defineConfig,devices} from '@playwright/test'
import {readFileSync} from 'node:fs'
const titles:unknown=JSON.parse(readFileSync(new URL('./test/private-renewal-prepare-read-titles.json',import.meta.url),'utf8'))
if(!Array.isArray(titles)||titles.length!==17||titles.some(v=>typeof v!=='string')||new Set(titles).size!==17)throw Error('Prepare-read development title inventory drift')
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
export default defineConfig({
  testDir:'test',testMatch:'ordinary-private-existing-root.spec.ts',
  timeout:30_000,expect:{timeout:5_000},fullyParallel:false,workers:1,retries:0,repeatEach:1,maxFailures:1,forbidOnly:true,
  grep:new RegExp('(?:^| )(?:'+titles.map(escape).join('|')+')$'),
  outputDir:'test-results/private-renewal-prepare-read',reporter:[['list'],['json',{outputFile:'test-results/private-renewal-prepare-read-report.json'}]],
  projects:[{name:'chromium-sdk020',use:devices['Desktop Chrome']},{name:'firefox-sdk020',use:devices['Desktop Firefox']},{name:'webkit-sdk020',use:devices['Desktop Safari']}],
})
