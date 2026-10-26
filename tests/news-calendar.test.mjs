import test from 'node:test';
import assert from 'node:assert/strict';
import { readNewsCalendar, validateNewsCalendarSnapshot, newsCalendarChanged, newsListCount, newsAutoDate, refreshNewsListPrefix, startNewsCalendarRefresh } from '../src/news-calendar.js';

const responseDate = 'Mon, 26 Oct 2026 01:00:00 GMT';
const shape = () => ({
  buckets: [{date:'2026-10-26',ecosystemLayer:'runtime',articleCount:2}],
  sourceCounts: [{ecosystemLayer:'all',sourceCount:3},{ecosystemLayer:'runtime',sourceCount:2}],
});
const snapshot = overrides => ({
  ...shape(),
  snapshotGeneratedAt:'2026-10-26T01:00:00.000Z',
  snapshotExpiresAt:'2026-10-26T01:02:00.000Z',
  ...overrides,
});
const freshResponse = () => ({status:200,payload:snapshot(),responseDate,elapsedMs:10});

test('fresh snapshot returns only the calendar arrays and accepts an empty archive', () => {
  const payload=snapshot();
  assert.deepEqual(validateNewsCalendarSnapshot(payload,{responseDate,elapsedMs:100}),shape());
  assert.deepEqual(validateNewsCalendarSnapshot(snapshot({buckets:[],sourceCounts:[{ecosystemLayer:'all',sourceCount:0}]}),{responseDate}),{buckets:[],sourceCounts:[{ecosystemLayer:'all',sourceCount:0}]});
  assert.equal(payload.snapshotGeneratedAt,'2026-10-26T01:00:00.000Z');
});

test('freshness uses the server Date and monotonic elapsed time despite a wrong client clock', () => {
  const original=Date.now;
  try {
    for(const clientTime of [0,Date.parse('2099-01-01T00:00:00Z')]) {
      Date.now=()=>clientTime;
      assert.deepEqual(validateNewsCalendarSnapshot(snapshot(),{responseDate,elapsedMs:100}),shape());
    }
  } finally { Date.now=original; }
  assert.throws(()=>validateNewsCalendarSnapshot(snapshot(),{responseDate,elapsedMs:120001}),/过期/);
});

test('expired snapshots and snapshots expiring during this request are rejected', () => {
  for(const expires of ['2026-10-26T00:59:59.000Z','2026-10-26T01:00:00.000Z']) {
    assert.throws(()=>validateNewsCalendarSnapshot(snapshot({snapshotGeneratedAt:'2026-10-26T00:58:00.000Z',snapshotExpiresAt:expires}),{responseDate}),/过期/);
  }
  assert.throws(()=>validateNewsCalendarSnapshot(snapshot({snapshotExpiresAt:'2026-10-26T01:00:02.000Z'}),{responseDate,elapsedMs:2000}),/过期/);
});

test('missing and malformed response Dates never fall back to the client clock', () => {
  for(const value of [undefined,null,'','not a date','2026-10-26','Tue, 26 Oct 2026 01:00:00 GMT']) {
    assert.throws(()=>validateNewsCalendarSnapshot(snapshot(),{responseDate:value}),/服务器时间/);
  }
});

test('metadata must be present, valid ISO, ordered, and bounded to two minutes', () => {
  for(const overrides of [
    {snapshotGeneratedAt:undefined}, {snapshotExpiresAt:undefined},
    {snapshotGeneratedAt:'yesterday'}, {snapshotExpiresAt:42},
    {snapshotGeneratedAt:'2026-02-30T01:00:00.000Z'},
    {snapshotExpiresAt:'2026-10-26T01:00:00.000Z'},
    {snapshotExpiresAt:'2026-10-26T00:59:59.000Z'},
    {snapshotExpiresAt:'2026-10-26T01:02:00.001Z'},
  ]) assert.throws(()=>validateNewsCalendarSnapshot(snapshot(overrides),{responseDate}),/有效期/);
});

test('generation tolerates only the one-second precision of the server Date header', () => {
  assert.deepEqual(validateNewsCalendarSnapshot(snapshot({snapshotGeneratedAt:'2026-10-26T01:00:00.999Z'}),{responseDate}),shape());
  assert.throws(()=>validateNewsCalendarSnapshot(snapshot({snapshotGeneratedAt:'2026-10-26T01:00:01.001Z'}),{responseDate}),/未来/);
});

test('malformed calendar buckets and source counts cannot reach the renderer', () => {
  for(const overrides of [
    {buckets:null}, {buckets:[null]}, {sourceCounts:{}}, {sourceCounts:[null]},
    {buckets:[{date:'2026-02-30',ecosystemLayer:'runtime',articleCount:1}]},
    {buckets:[{date:'2026-10-26',ecosystemLayer:'all',articleCount:1}]},
    {buckets:[{date:'2026-10-26',ecosystemLayer:'runtime',articleCount:0}]},
    {buckets:[{date:'2026-10-26',ecosystemLayer:'runtime',articleCount:'2'}]},
    {buckets:[{date:'2026-10-26',ecosystemLayer:'runtime',articleCount:1.5}]},
    {sourceCounts:[]},
    {sourceCounts:[{ecosystemLayer:'runtime',sourceCount:2}]},
    {sourceCounts:[{ecosystemLayer:'all',sourceCount:0},{ecosystemLayer:'all',sourceCount:1}]},
    {sourceCounts:[{ecosystemLayer:'all',sourceCount:1},{ecosystemLayer:'unknown',sourceCount:1}]},
    {sourceCounts:[{ecosystemLayer:'all',sourceCount:-1}]},
    {sourceCounts:[{ecosystemLayer:'all',sourceCount:'3'}]},
  ]) assert.throws(()=>validateNewsCalendarSnapshot(snapshot(overrides),{responseDate}),/格式/);
});

test('calendar loader reads the static asset without changing the lifetime signal', async () => {
  const calls=[],signal=new AbortController().signal;
  const result=await readNewsCalendar({signal,apiBase:'/custom',readJson:async(...args)=>{calls.push(args);return freshResponse();}});
  assert.deepEqual(result,shape());
  assert.deepEqual(calls,[['/data/news-calendar.json',signal,{withResponse:true,allowNotFound:false}]]);
});

test('only an explicit local Vite development 404 falls back once to the legacy API', async () => {
  for(const hostname of ['localhost','127.0.0.1','[::1]']) {
    const calls=[],signal=new AbortController().signal;
    const result=await readNewsCalendar({signal,apiBase:'/custom',isDevelopment:true,hostname,readJson:async(...args)=>{
      calls.push(args);return calls.length===1?{status:404}:shape();
    }});
    assert.deepEqual(result,shape());
    assert.deepEqual(calls,[['/data/news-calendar.json',signal,{withResponse:true,allowNotFound:true}],['/custom/news/calendar',signal]]);
  }
});

test('production 404 and nonlocal development 404 never request the slow API', async () => {
  for(const options of [{},{isDevelopment:false,hostname:'localhost'},{isDevelopment:true,hostname:'songuu.top'}]) {
    const calls=[];
    await assert.rejects(readNewsCalendar({...options,readJson:async(...args)=>{calls.push(args);return {status:404};}}),/HTTP 404/);
    assert.equal(calls.length,1);
  }
});

test('503, expired and corrupt snapshots never fall back even in local development', async () => {
  for(const reply of [
    {status:503},
    {...freshResponse(),payload:snapshot({snapshotGeneratedAt:'2026-10-26T00:58:00.000Z',snapshotExpiresAt:'2026-10-26T01:00:00.000Z'})},
    {...freshResponse(),payload:{}},
    {...freshResponse(),responseDate:undefined},
  ]) {
    let calls=0;
    await assert.rejects(readNewsCalendar({isDevelopment:true,hostname:'localhost',readJson:async()=>{calls++;return reply;}}));
    assert.equal(calls,1);
  }
});

test('read failures and aborts retain their explicit error and do not trigger fallback', async () => {
  for(const failure of [new SyntaxError('bad JSON'),new Error('资讯读取超时，请重试'),new DOMException('unmounted','AbortError')]) {
    let calls=0;
    await assert.rejects(readNewsCalendar({isDevelopment:true,hostname:'localhost',readJson:async()=>{calls++;throw failure;}}),error=>error===failure);
    assert.equal(calls,1);
  }
});

test('unchanged calendars ignore bucket ordering and unrelated layers do not refresh the selected list', async () => {
  const previous=shape();
  const next={buckets:[{date:'2026-10-25',ecosystemLayer:'foundation',articleCount:5},...previous.buckets],sourceCounts:[...previous.sourceCounts].reverse()};
  assert.equal(newsCalendarChanged(previous,{buckets:[...previous.buckets],sourceCounts:[...previous.sourceCounts].reverse()}),false);
  assert.equal(newsCalendarChanged(previous,next),true);
  assert.equal(newsListCount(next,{date:'2026-10-26',layer:'runtime'}),2);
  assert.equal(newsListCount(next,{date:null,layer:'all'}),7);
  let calls=0;
  assert.equal(await refreshNewsListPrefix({previousCount:2,nextCount:2,loadedCount:20,readPage:async()=>{calls++;}}),null);
  assert.equal(calls,0);
});

test('only the untouched latest view at the top follows a newly available date', () => {
  const calendar={buckets:[...shape().buckets,{date:'2026-10-27',ecosystemLayer:'runtime',articleCount:1}],sourceCounts:shape().sourceCounts};
  const state={date:'2026-10-26',layer:'all',explicitDate:false,explicitLayer:false,id:null};
  assert.equal(newsAutoDate(calendar,{...state,atTop:true,query:''}),'2026-10-27');
  for(const overrides of [{explicitDate:true},{explicitLayer:true},{id:'reading'},{atTop:false},{query:'model'},{date:null,explicitDate:true}]) {
    const context={...state,atTop:true,query:'',...overrides};
    assert.equal(newsAutoDate(calendar,context),context.date);
  }
  assert.equal(newsAutoDate(shape(),{...state,atTop:true,query:''}),'2026-10-26');
});

test('new insertions rebase the full loaded prefix and keep paging past all retained articles', async () => {
  const calls=[],items=Array.from({length:1500},(_,index)=>({id:`article-${index}`}));
  const result=await refreshNewsListPrefix({date:'2026-10-26',layer:'runtime',previousCount:1498,nextCount:1500,loadedCount:1200,readPage:async options=>{
    calls.push(options);return {items:items.slice(options.offset,options.offset+options.limit),hasMore:options.offset+options.limit<items.length};
  }});
  assert.equal(result.items.length,1202);
  assert.equal(result.offset,1202);
  assert.equal(result.hasMore,true);
  assert.deepEqual(calls,[{date:'2026-10-26',layer:'runtime',offset:0,limit:1000},{date:'2026-10-26',layer:'runtime',offset:1000,limit:202}]);
});

test('background list refresh handles removals and aborts without replacing the caller snapshot', async () => {
  const old=[{id:'old'}],before=JSON.stringify(old);
  const result=await refreshNewsListPrefix({previousCount:22,nextCount:1,loadedCount:40,readPage:async()=>({items:[{id:'current'}],hasMore:false})});
  assert.deepEqual(result,{items:[{id:'current'}],offset:1,hasMore:false});
  assert.equal(JSON.stringify(old),before);
  let current=true,calls=0;
  const canceled=await refreshNewsListPrefix({previousCount:40,nextCount:41,loadedCount:40,isCurrent:()=>current,readPage:async()=>{calls++;current=false;return {items:[{id:'new'}],hasMore:true};}});
  assert.equal(canceled,null);
  assert.equal(calls,1);
  await assert.rejects(refreshNewsListPrefix({previousCount:1,nextCount:2,loadedCount:20,readPage:async()=>({items:[],hasMore:true})}),/分页/);
});

function refreshHarness(refresh) {
  let visible=true,timer=null,visibilityListener=null,cleared=0;
  const controller=new AbortController();
  const visibility={get visibilityState(){return visible?'visible':'hidden';},addEventListener(type,listener){assert.equal(type,'visibilitychange');visibilityListener=listener;},removeEventListener(type,listener){assert.equal(listener,visibilityListener);visibilityListener=null;}};
  const dispose=startNewsCalendarRefresh({refresh,visibility,signal:controller.signal,setIntervalImpl:(callback,delay)=>{assert.equal(delay,30000);timer=callback;return 7;},clearIntervalImpl:id=>{assert.equal(id,7);timer=null;cleared++;}});
  return {dispose,controller,tick:()=>timer?.(),setVisible:value=>{visible=value;visibilityListener?.();},get hasTimer(){return Boolean(timer);},get hasListener(){return Boolean(visibilityListener);},get cleared(){return cleared;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('visible polling checks immediately and every thirty seconds, pauses hidden and resumes immediately', async () => {
  let calls=0;
  const harness=refreshHarness(async()=>{calls++;});
  await settle();assert.equal(calls,1);
  harness.tick();await settle();assert.equal(calls,2);
  harness.setVisible(false);assert.equal(harness.hasTimer,false);
  harness.tick();await settle();assert.equal(calls,2);
  harness.setVisible(true);await settle();assert.equal(calls,3);assert.equal(harness.hasTimer,true);
  harness.dispose();assert.equal(harness.hasTimer,false);assert.equal(harness.hasListener,false);
  harness.tick();await settle();assert.equal(calls,3);
});

test('polling never overlaps requests and survives a network error until disposal aborts scheduling', async () => {
  let calls=0,release;
  const harness=refreshHarness(async()=>{calls++;if(calls===1)await new Promise(resolve=>{release=resolve;});else throw new Error('offline');});
  harness.tick();harness.tick();await settle();assert.equal(calls,1);
  release();await settle();harness.tick();await settle();assert.equal(calls,2);
  harness.tick();await settle();assert.equal(calls,3);
  harness.controller.abort();assert.equal(harness.hasTimer,false);assert.equal(harness.hasListener,false);
  harness.tick();await settle();assert.equal(calls,3);
});
