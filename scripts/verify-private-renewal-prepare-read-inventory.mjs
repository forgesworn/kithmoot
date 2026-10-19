import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const [path,engine]=process.argv.slice(2),j=JSON.parse(readFileSync(path,'utf8'))
assert(['chromium','firefox','webkit'].includes(engine));assert.deepEqual(j.errors,[])
const titles=JSON.parse(readFileSync(new URL('../test/private-renewal-prepare-read-titles.json',import.meta.url),'utf8'))
function cases(v){return [...(v.specs??[]).flatMap(s=>s.tests.map(t=>({title:s.title,project:t.projectName,timeout:t.timeout,repeat:t.repeatEachIndex}))),...(v.suites??[]).flatMap(cases)]}
const rows=cases(j);assert.equal(rows.length,1);assert.deepEqual(rows.map(r=>r.title).sort(),[...titles].sort())
assert(rows.every(r=>r.project===engine+'-sdk020'));assert.equal(j.config.workers,1)
const projects=j.config.projects;assert.deepEqual(projects.map(p=>p.name).sort(),['chromium-sdk020','firefox-sdk020','webkit-sdk020']);assert(projects.every(p=>p.timeout===30000&&p.retries===0&&p.repeatEach===1))
console.log(JSON.stringify({engine,cases:rows.length,exactTitles:true,workers:1,retries:0,repeatEach:1,testTimeoutMs:30000}))
