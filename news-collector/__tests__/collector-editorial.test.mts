import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOnce} from '../src/collect.ts';
import {externalIdFor} from '../src/normalize.ts';
import type {NewsSource,RawFeedItem} from '../src/types.ts';
const now=new Date('2026-10-26T02:00:00Z');
const source:NewsSource={key:'mixed-feed',name:'Mixed',url:'https://example.com/feed',kind:'en-media',lang:'en',enabled:true};
const article=(key:string,title='OpenAI releases a new reasoning model',isoDate='2026-10-26T00:00:00Z'):RawFeedItem=>({title,link:'https://example.com/'+key,isoDate,contentSnippet:'New AI reasoning model and developer API with benchmark improvements.'});

test('UTC lookback is applied before source cap; missing dates are visible and future dates rejected',async()=>{
  const rows=[article('old',undefined,'2026-10-20T00:00:00Z'),article('future',undefined,'2026-10-27T00:00:00Z'),article('new')];
  const report=await collectOnce({sources:[source],now,dryRun:true,lookbackHours:24,maxPerSource:1,fetchFeedImpl:async s=>({source:s,ok:true,attempts:1,items:rows})});
  assert.equal(report.items[0]?.url,'https://example.com/new');assert.equal(report.collection?.outsideWindow,2);
  const undated=await collectOnce({sources:[source],now,dryRun:true,lookbackHours:24,fetchFeedImpl:async s=>({source:s,ok:true,attempts:1,items:[{...article('unknown'),isoDate:undefined}]})});
  assert.equal(undated.items.length,1);assert.equal(undated.collection?.undated,1);
});

test('known stored articles are skipped before AI/content and an empty batch does not write',async()=>{
  const row=article('known');let writes=0,bodies=0,models=0;
  const report=await collectOnce({sources:[source],now,dryRun:false,skipExisting:true,fetchFeedImpl:async s=>({source:s,ok:true,attempts:1,items:[row]}),
    contentRepository:{findExistingNewsIds:async ids=>{assert.deepEqual(ids,[externalIdFor(row)]);return ids;},upsertNewsItems:async()=>{writes++;throw new Error('must not write');}},
    editorial:{enabled:true,maxAnalyze:1,client:{chat:async()=>{models++;throw new Error('must not analyze');}}},articleContentEnabled:true,fetchArticleContentImpl:async()=>{bodies++;throw new Error('must not fetch');}});
  assert.equal(writes,0);assert.equal(bodies,0);assert.equal(models,0);assert.equal(report.collection?.existingSkipped,1);assert.equal(report.tableCount,'unchanged');
});

test('editorial selection runs before body extraction and never overwrites old archive records',async()=>{
  const visited:string[]=[],rows=[{...article('car','New family SUV launches at a lower price'),contentSnippet:'A new car with more seats and a discounted price.'},article('ai')];
  const report=await collectOnce({sources:[source],now,dryRun:true,lookbackHours:24,editorial:{enabled:true,maxAnalyze:0},fetchFeedImpl:async s=>({source:s,ok:true,attempts:1,items:rows}),articleContentEnabled:true,fetchArticleContentImpl:async url=>{visited.push(url);return {text:'AI article body',excerpt:'AI article body',status:'fetched',fetchedAt:now.toISOString()};}});
  assert.deepEqual(visited,['https://example.com/ai']);assert.equal(report.items.length,1);assert.equal(report.editorial?.irrelevant,1);
});

test('unexpected adapter and invalid-item failures remain local to their source or article',async()=>{
  const bad={...source,key:'bad'},visited:string[]=[];
  const report=await collectOnce({sources:[bad,source],now,dryRun:true,fetchFeedImpl:async s=>{if(s.key==='bad')throw new TypeError('adapter exploded');return {source:s,ok:true,attempts:1,items:[article('one'),{...article('invalid'),title:' '},article('two','Anthropic publishes a Claude coding update')]};},articleContentEnabled:true,fetchArticleContentImpl:async url=>{visited.push(url);if(url.endsWith('one'))throw new Error('body adapter exploded');return {text:'Working content',excerpt:'Working content',status:'fetched',fetchedAt:now.toISOString()};}});
  assert.equal(report.sources.find(s=>s.key==='bad')?.ok,false);assert.equal(report.collection?.rejected,1);assert.equal(visited.length,2);assert.equal(report.contentFailed,1);assert.equal(report.contentFetched,1);
});

test('a rich feed body does not spend an external body request',async()=>{
  let calls=0;const body='<p>'+('Detailed AI engineering implementation with reproducible experiments. '.repeat(10))+'</p>';
  const report=await collectOnce({sources:[source],now,dryRun:true,fetchFeedImpl:async s=>({source:s,ok:true,attempts:1,items:[{...article('full'),content:body,contentIsFull:true}]}),articleContentEnabled:true,fetchArticleContentImpl:async()=>{calls++;throw new Error('unnecessary request');}});
  assert.equal(calls,0);assert.equal(report.items[0]?.contentStatus,'fetched');assert.ok((report.items[0]?.contentText.length||0)>500);
});

test('credential-bearing and non-HTTP source items never reach analysis or storage',async()=>{
  const report=await collectOnce({sources:[source],now,dryRun:true,fetchFeedImpl:async s=>({source:s,ok:true,attempts:1,items:[{...article('credential'),link:'https://user:secret@example.com/private'},{...article('script'),link:'javascript:alert(1)'},article('safe')]})});
  assert.equal(report.collection?.rejected,2);assert.deepEqual(report.items.map(item=>item.url),['https://example.com/safe']);
});
