import test from 'node:test';
import assert from 'node:assert/strict';
import { readNewsCalendar, validateNewsCalendarSnapshot } from '../src/news-calendar.js';

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
