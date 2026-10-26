import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {NEWS_LAYERS, isNewsDate} from '../src/news-format.js';
import {validateNewsCalendarSnapshot} from '../src/news-calendar.js';

// Probe the first HTTP reads after readiness, and again after >5min idle.
// Passive cache mode also needs a probe after its 60s TTL expires.
// This probe reads public data only; it never flushes shared host/PG caches.
const [baseArgument='http://127.0.0.1:5196', phase='cold-start', limitArgument='2500', totalArgument, requestPath='/api/content/v1/news/calendar'] = process.argv.slice(2);
const base = new URL(baseArgument);
assert.ok(['http:', 'https:'].includes(base.protocol), 'Expected an HTTP(S) API base URL');
assert.ok(!base.username && !base.password, 'API base URL must not contain credentials');
const maxMs = Number(limitArgument);
assert.ok(Number.isSafeInteger(maxMs) && maxMs >= 100 && maxMs <= 60_000, 'Expected an integer 100–60000ms request limit');
const expectedTotal = totalArgument === undefined ? null : Number(totalArgument);
assert.ok(expectedTotal === null || (Number.isSafeInteger(expectedTotal) && expectedTotal > 0), 'Expected a positive article total');
const layers = new Set(NEWS_LAYERS.map(([key]) => key));
assert.ok(['/api/content/v1/news/calendar','/data/news-calendar.json','/data/news-calendar-candidate.json'].includes(requestPath), 'Expected a calendar API or snapshot path');

function validateCalendar(calendar) {
  assert.ok(calendar && Array.isArray(calendar.buckets) && calendar.buckets.length > 0, 'Calendar must contain archived articles');
  assert.ok(Array.isArray(calendar.sourceCounts), 'Calendar must contain source counts');
  const bucketKeys = new Set();
  let total = 0;
  for (const bucket of calendar.buckets) {
    assert.ok(isNewsDate(bucket.date), 'Calendar date must be valid');
    assert.ok(layers.has(bucket.ecosystemLayer), 'Calendar layer must be known');
    assert.ok(Number.isSafeInteger(bucket.articleCount) && bucket.articleCount > 0, 'Calendar article count must be positive');
    const key = `${bucket.date}/${bucket.ecosystemLayer}`;
    assert.ok(!bucketKeys.has(key), 'Calendar buckets must be unique');
    bucketKeys.add(key);
    total += bucket.articleCount;
  }
  assert.ok(Number.isSafeInteger(total), 'Calendar total must be a safe integer');
  const sourceLayers = new Set();
  for (const source of calendar.sourceCounts) {
    assert.ok(source.ecosystemLayer === 'all' || layers.has(source.ecosystemLayer), 'Source layer must be known');
    assert.ok(!sourceLayers.has(source.ecosystemLayer), 'Source counts must be unique per layer');
    sourceLayers.add(source.ecosystemLayer);
    assert.ok(Number.isSafeInteger(source.sourceCount) && source.sourceCount >= 0, 'Source count must be nonnegative');
  }
  assert.ok(sourceLayers.has('all'), 'Calendar must include the global distinct source count');
  if (expectedTotal !== null) assert.equal(total, expectedTotal, 'Calendar must match the independently verified database total');
  return total;
}

async function readCalendar() {
  const started = performance.now();
  const response = await fetch(new URL(requestPath, base), {
    headers: {Host: 'songuu.top', 'Cache-Control': 'no-cache'},
    cache: 'no-store',
    signal: AbortSignal.timeout(maxMs),
  });
  assert.equal(response.status, 200, `${phase}: calendar HTTP status`);
  const calendar = await response.json();
  if (requestPath.startsWith('/data/')) {
    validateNewsCalendarSnapshot(calendar, {responseDate:response.headers.get('date'), elapsedMs:performance.now()-started});
  }
  const total = validateCalendar(calendar);
  const elapsedMs = Math.round(performance.now() - started);
  assert.ok(elapsedMs <= maxMs, `${phase}: calendar took ${elapsedMs}ms, limit ${maxMs}ms`);
  return {elapsedMs, total, calendar:{buckets:calendar.buckets,sourceCounts:calendar.sourceCounts}};
}

try {
  // All five can be cache misses: the server must coalesce concurrent readers.
  const reads = await Promise.all(Array.from({length: 5}, readCalendar));
  for (const read of reads) assert.deepEqual(read.calendar, reads[0].calendar, `${phase}: concurrent readers must see the same snapshot`);
  console.log(JSON.stringify({
    phase, requests: reads.length, totalArticles: reads[0].total,
    buckets: reads[0].calendar.buckets.length,
    maxMs: Math.max(...reads.map(read => read.elapsedMs)),
    timingsMs: reads.map(read => read.elapsedMs), limitMs: maxMs,
  }));
} catch (error) {
  console.error(`${phase} calendar verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
