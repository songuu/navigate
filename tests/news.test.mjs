import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNewsQuery, isNewsDate, safeArticleUrl, normalizeArticle, calendarDates, articleParagraphs, filterLoadedNews, findNewsNeighbors, calendarSelectionForLayer } from '../src/news-format.js';

test('list query uses collection date and bounded paging with allowed API parameters', () => {
  const params = buildNewsQuery({ date: '2026-10-25', layer: 'runtime', offset: 20, limit: 20 });
  assert.deepEqual(params.getAll('filter'), ['collected_date:eq:2026-10-25', 'ecosystem_layer:eq:runtime']);
  assert.deepEqual(params.getAll('sort'), ['collected_date:desc', 'published_date:desc', 'external_id:asc']);
  assert.equal(params.get('offset'), '20');
  assert.equal(params.get('count'), 'none');
  assert.equal(params.has('search'), false);
  assert.throws(() => buildNewsQuery({date:'2026-02-30'}), /日期/);
  assert.throws(() => buildNewsQuery({layer:'invalid'}), /分类/);
});

test('article id remains one filter value even with colon and URL punctuation', () => {
  const params = buildNewsQuery({id:'rss:foo?x=1&y=2'});
  assert.deepEqual(params.getAll('filter'), ['external_id:eq:rss:foo?x=1&y=2']);
  assert.equal(params.get('limit'), '1');
  assert.match(params.get('fields'), /content_text_zh/);
});

test('dates validate real calendar dates without timezone conversion', () => {
  assert.equal(isNewsDate('2024-02-29'), true);
  assert.equal(isNewsDate('2026-02-29'), false);
  assert.equal(isNewsDate('2026-1-2'), false);
  assert.equal(isNewsDate('2026-10-25T00:00:00Z'), false);
});

test('external URLs reject active content, credentials and non-web protocols', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hi', '//evil.test', 'https://user:pass@site.test', 'file:///tmp/x']) assert.equal(safeArticleUrl(value), null);
  assert.equal(safeArticleUrl('https://example.com/a?q=b'), 'https://example.com/a?q=b');
});

test('translation availability preserves original when no successful translation exists', () => {
  const partial = normalizeArticle({external_id:'a',title:'Original',title_zh:'伪译文',translation_status:'failed',content_text:'Original body',content_text_zh:'中文'});
  assert.equal(partial.title, 'Original');
  assert.equal(partial.canTranslate, false);
  const translated = normalizeArticle({external_id:'a',title:'Original',title_zh:'中文标题',translation_status:'translated',content_text:'Original body',content_text_zh:'中文正文'});
  assert.equal(translated.title, '中文标题');
  assert.equal(translated.canTranslate, true);
});

test('calendar derives available collection dates only for selected layer', () => {
  const buckets = [{date:'2026-10-25',ecosystemLayer:'runtime',articleCount:2},{date:'2026-10-24',ecosystemLayer:'model-platform',articleCount:3},{date:'2026-10-25',ecosystemLayer:'model-platform',articleCount:1},{date:'bad',ecosystemLayer:'runtime',articleCount:1}];
  assert.deepEqual(calendarDates(buckets), ['2026-10-25','2026-10-24']);
  assert.deepEqual(calendarDates(buckets,'runtime'), ['2026-10-25']);
});

test('body remains plain text paragraphs, and loaded search covers source and tags', () => {
  assert.deepEqual(articleParagraphs('<script>alert(1)</script>\n\n第二段'), ['<script>alert(1)</script>', '第二段']);
  const rows = [normalizeArticle({external_id:'a',title:'Model',source_name:'OpenAI',tags:['MCP']}),normalizeArticle({external_id:'b',title:'Other'})];
  assert.deepEqual(filterLoadedNews(rows,'mcp').map(row=>row.id),['a']);
  assert.deepEqual(filterLoadedNews(rows,'openai').map(row=>row.id),['a']);
});

const articles = count => Array.from({length:count}, (_,index) => ({id:`article-${index}`,title:`文章 ${index}`}));
function pagedReader(items, calls) {
  return async options => {
    calls.push(options);
    return {items:items.slice(options.offset,options.offset+options.limit),hasMore:options.offset+options.limit<items.length};
  };
}

test('last article on the first loaded screen gets its real next article without mutating list snapshot', async () => {
  const items=articles(45),calls=[],seed={items:items.slice(0,20),nextOffset:20,hasMore:true};
  const before=JSON.stringify(seed);
  const neighbors=await findNewsNeighbors({id:'article-19',date:'2026-10-25',layer:'runtime',seed,readPage:pagedReader(items,calls),pageSize:20});
  assert.equal(neighbors.previous.id,'article-18');assert.equal(neighbors.next.id,'article-20');
  assert.deepEqual(calls,[{date:'2026-10-25',layer:'runtime',offset:20,limit:20}]);
  assert.equal(JSON.stringify(seed),before);
});

test('a known final page has no next neighbor and does not fetch again', async () => {
  const items=articles(20),calls=[];
  const neighbors=await findNewsNeighbors({id:'article-19',seed:{items,nextOffset:20,hasMore:false},readPage:pagedReader(items,calls)});
  assert.equal(neighbors.previous.id,'article-18');assert.equal(neighbors.next,null);assert.equal(calls.length,0);
});

test('deep links scan subsequent pages beyond the former 1000 article cutoff', async () => {
  const items=articles(1504),calls=[];
  const neighbors=await findNewsNeighbors({id:'article-1500',date:null,layer:'all',readPage:pagedReader(items,calls),pageSize:500});
  assert.equal(neighbors.previous.id,'article-1499');assert.equal(neighbors.next.id,'article-1501');
  assert.deepEqual(calls.map(call=>call.offset),[0,500,1000,1500]);
  assert.ok(calls.every(call=>call.date===null&&call.layer==='all'));
});

test('deep-link last page resolves the preceding article without inventing a next one', async () => {
  const items=articles(42),calls=[];
  const neighbors=await findNewsNeighbors({id:'article-41',readPage:pagedReader(items,calls),pageSize:20});
  assert.equal(neighbors.previous.id,'article-40');assert.equal(neighbors.next,null);
  assert.deepEqual(calls.map(call=>call.offset),[0,20,40]);
});

test('neighbor paging terminates for empty final pages and rejects non-progressing pages', async () => {
  const seed={items:articles(20),nextOffset:20,hasMore:true};
  const neighbors=await findNewsNeighbors({id:'article-19',seed,readPage:async()=>({items:[],hasMore:false})});
  assert.equal(neighbors.previous.id,'article-18');assert.equal(neighbors.next,null);
  await assert.rejects(findNewsNeighbors({id:'missing',readPage:async()=>({items:[],hasMore:true})}),/分页/);
});

test('canceled neighbor lookup stops before requesting another page', async () => {
  let current=true;const calls=[];
  const neighbors=await findNewsNeighbors({id:'missing',isCurrent:()=>current,readPage:async options=>{calls.push(options);current=false;return {items:articles(20),hasMore:true};}});
  assert.equal(neighbors,null);assert.equal(calls.length,1);
});

test('a layer change that selects an older date also selects its calendar month', () => {
  assert.deepEqual(calendarSelectionForLayer('2026-10-25','2026-10',['2026-09-30'],true),{date:'2026-09-30',month:'2026-09'});
  assert.deepEqual(calendarSelectionForLayer('2026-10-25','2026-10',[],true),{date:null,month:'2026-10'});
  assert.deepEqual(calendarSelectionForLayer('2026-10-25','2026-11',['2026-10-25'],true),{date:'2026-10-25',month:'2026-11'});
  assert.deepEqual(calendarSelectionForLayer('2026-10-25','2026-10',[],false),{date:'2026-10-25',month:'2026-10'});
});
