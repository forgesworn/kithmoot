import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const [path,engine,shard]=process.argv.slice(2)
assert(['chromium','firefox','webkit'].includes(engine));assert(['1','2'].includes(shard))
const titles=JSON.parse(readFileSync(new URL('../test/private-renewal-validation-titles.json',import.meta.url),'utf8'))
assert.equal(titles.length,533);assert.equal(new Set(titles).size,533)
const inventory=JSON.parse(readFileSync(path,'utf8'))
const cases=value=>[...(value.specs??[]).flatMap(spec=>spec.tests.map(test=>[test.projectName,spec.title])),...(value.suites??[]).flatMap(cases)]
const selected=titles.slice(shard==='1'?0:267,shard==='1'?267:533)
assert.deepEqual(cases(inventory),selected.map(title=>[engine+'-sdk020',title]))
assert.equal(inventory.config.workers,1);assert.equal(inventory.config.maxFailures,1);assert.equal(inventory.config.fullyParallel,false)
for(const project of inventory.config.projects){assert.equal(project.timeout,30000);assert.equal(project.retries,0);assert.equal(project.repeatEach,1)}
console.log(JSON.stringify({engine,shard,cases:selected.length,exactTitleOrder:true,workers:1,retries:0,testTimeoutMs:30000}))
