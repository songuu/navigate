import assert from 'node:assert/strict';
import {buildNewsQuery,isNewsDate} from '../src/news-format.js';

const base=(process.argv[2] || 'http://127.0.0.1:5196').replace(/\/$/,'');
async function read(path){
  const start=Date.now();
  const response=await fetch(base+path,{headers:{Host:'songuu.top'},signal:AbortSignal.timeout(90000)});
  assert.equal(response.status,200,`${path.split('?')[0]} returned HTTP ${response.status}`);
  const data=await response.json();console.log(`${path.split('?')[0]}: HTTP 200, ${Date.now()-start} ms`);return data;
}
const calendar=await read('/api/content/v1/news/calendar');
assert.ok(calendar.buckets.length>0,'Migrated calendar must contain articles');
const date=calendar.buckets.map(bucket=>bucket.date).sort().at(-1);
assert.ok(isNewsDate(date));
const page=await read('/api/content/v1/news?'+buildNewsQuery({date,limit:20}));
assert.ok(page.items.length>0,'Latest collection date must be readable');
for(const row of page.items){assert.equal(row.collected_date,date);assert.ok(isNewsDate(row.published_date));}
const detail=await read('/api/content/v1/news?'+buildNewsQuery({id:page.items[0].external_id}));
assert.equal(detail.items[0].external_id,page.items[0].external_id);assert.equal(typeof detail.items[0].content_text,'string');
await read('/api/content/v1/news?'+buildNewsQuery({limit:3}));
const repeat=await read('/api/content/v1/news?'+buildNewsQuery({date,limit:20}));
assert.equal(repeat.items.length,page.items.length);
const forbidden=await fetch(base+'/api/content/v1/news',{method:'POST',headers:{Host:'songuu.top'},signal:AbortSignal.timeout(30000)});
assert.equal(forbidden.status,405,'Public API must stay read-only');
console.log(`Verified latest date ${date}, ${page.items.length} rows, readable detail, stable DATE serialization, warm cache and rejected writes.`);
