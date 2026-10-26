import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import type { ContentPage, ContentReadRepository, ContentReadRequest } from "./contract.ts";
import { createContentApiServer, createNewsCalendarCache, createNewsResponseCache, startContentApiServer } from "./server.ts";

const allowedHosts = ["content.test"];
const allowedOrigins = ["https://site.test"];

async function withServer(
  repository: ContentReadRepository,
  run: (port: number, seen: ContentReadRequest[]) => Promise<void>,
  options: { allowMissingOrigin?: boolean } = {},
): Promise<void> {
  const seen: ContentReadRequest[] = [];
  const server = createContentApiServer({
    repository: {
      async read(request) {
        seen.push(request);
        return repository.read(request);
      },
      async readNewsCalendar() {
        return repository.readNewsCalendar();
      },
    },
    allowedHosts,
    allowedOrigins,
    allowMissingOrigin: options.allowMissingOrigin ?? false,
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(address.port, seen);
  } finally {
    await close(server);
  }
}

const successfulRepository: ContentReadRepository = {
  async read() {
    return { items: [{ external_id: "one", title: "One" }], totalCount: 1, hasMore: false };
  },
  async readNewsCalendar() {
    return {
      buckets: [{ date: "2026-07-30", ecosystemLayer: "model-platform", articleCount: 20 }],
      sourceCounts: [
        { ecosystemLayer: "all", sourceCount: 8 },
        { ecosystemLayer: "model-platform", sourceCount: 3 },
      ],
    };
  },
};

test("serves a validated public content page without database details", async () => {
  await withServer(successfulRepository, async (port, seen) => {
    const result = await request(port, "/api/content/v1/news?fields=external_id,title&filter=external_id:eq:one");
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.deepEqual(result.json, { items: [{ external_id: "one", title: "One" }], totalCount: 1, hasMore: false });
    assert.deepEqual(seen, [
      {
        resource: "news",
        fields: ["external_id", "title"],
        filters: [{ field: "external_id", operator: "eq", value: "one" }],
        sort: [],
        limit: 100,
        offset: 0,
        includeTotal: true,
      },
    ]);
  });
});

test("serves compact server-aggregated news calendar buckets", async () => {
  await withServer(successfulRepository, async (port) => {
    const result = await request(port, "/api/content/v1/news/calendar");
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, {
      buckets: [{ date: "2026-07-30", ecosystemLayer: "model-platform", articleCount: 20 }],
      sourceCounts: [
        { ecosystemLayer: "all", sourceCount: 8 },
        { ecosystemLayer: "model-platform", sourceCount: 3 },
      ],
    });
    assert.equal(result.headers["cache-control"], "no-cache");

    const invalid = await request(port, "/api/content/v1/news/calendar?limit=1");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, "unknown_parameter");
  });
});

test("calendar cache coalesces concurrent cold reads and returns refreshed data to the first expired request", async () => {
  let now = 0;
  let calls = 0;
  let releaseFirst: ((value: Awaited<ReturnType<ContentReadRepository["readNewsCalendar"]>>) => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const first = new Promise<Awaited<ReturnType<ContentReadRepository["readNewsCalendar"]>>>((resolve) => {
    releaseFirst = resolve;
  });
  const summary = await successfulRepository.readNewsCalendar();
  const cache = createNewsCalendarCache(
    {
      async readNewsCalendar() {
        calls += 1;
        if (calls === 1) {
          markFirstStarted?.();
          return first;
        }
        return { ...summary, buckets: [] };
      },
    },
    { ttlMs: 100, now: () => now },
  );

  const firstRead = cache.read();
  await started;
  const secondRead = cache.read();
  assert.equal(calls, 1);
  releaseFirst?.(summary);
  assert.deepEqual(await firstRead, summary);
  assert.deepEqual(await secondRead, summary);

  now = 101;
  const expiredReads = await Promise.all([cache.read(), cache.read()]);
  assert.deepEqual(expiredReads, [{ ...summary, buckets: [] }, { ...summary, buckets: [] }]);
  assert.equal(calls, 2);
});

const newsResponseRequest: ContentReadRequest = {
  resource: "news",
  fields: ["external_id"],
  filters: [],
  sort: [],
  limit: 10,
  offset: 0,
  includeTotal: true,
};
const newsResponseCacheKey = "/api/content/v1/news?fields=external_id&limit=10";

test("news response cache waits for one refresh and returns new data to the first expired visitors", async () => {
  let now = 0;
  let calls = 0;
  let markFirstStarted: (() => void) | undefined;
  let markRefreshStarted: (() => void) | undefined;
  let releaseFirst: ((value: ContentPage) => void) | undefined;
  let releaseRefresh: ((value: ContentPage) => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  const first = new Promise<ContentPage>((resolve) => { releaseFirst = resolve; });
  const refreshed = new Promise<ContentPage>((resolve) => { releaseRefresh = resolve; });
  const firstPage = { items: [{ external_id: "first" }], totalCount: 1, hasMore: false };
  const refreshedPage = { items: [{ external_id: "refreshed" }], totalCount: 1, hasMore: false };
  const cache = createNewsResponseCache(
    {
      async read() {
        calls += 1;
        if (calls === 1) {
          markFirstStarted?.();
          return first;
        }
        markRefreshStarted?.();
        return refreshed;
      },
    },
    { ttlMs: 100, maxEntries: 2, now: () => now },
  );

  const firstRead = cache.read(newsResponseCacheKey, newsResponseRequest);
  await firstStarted;
  const sameColdRead = cache.read(newsResponseCacheKey, newsResponseRequest);
  assert.equal(calls, 1);
  releaseFirst?.(firstPage);
  assert.deepEqual(await firstRead, firstPage);
  assert.deepEqual(await sameColdRead, firstPage);

  now = 99;
  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), firstPage);
  assert.equal(calls, 1);

  now = 101;
  let returnedExpiredValue = false;
  const expiredRead = cache.read(newsResponseCacheKey, newsResponseRequest).then((value) => {
    returnedExpiredValue = true;
    return value;
  });
  const sameExpiredRead = cache.read(newsResponseCacheKey, newsResponseRequest);
  await refreshStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(returnedExpiredValue, false, "expired callers must wait instead of receiving the previous collection");
  assert.equal(calls, 2);
  releaseRefresh?.(refreshedPage);
  assert.deepEqual(await expiredRead, refreshedPage);
  assert.deepEqual(await sameExpiredRead, refreshedPage);
  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), refreshedPage);
  assert.equal(calls, 2);
});

test("news response cache falls back only after refresh failure and retries on the next request", async () => {
  let now = 0;
  let calls = 0;
  const errors: unknown[] = [];
  const cachedPage = { items: [{ external_id: "cached" }], totalCount: 1, hasMore: false };
  const recoveredPage = { items: [{ external_id: "new-collection" }], totalCount: 2, hasMore: false };
  const cache = createNewsResponseCache(
    {
      async read() {
        calls += 1;
        if (calls === 1) return cachedPage;
        if (calls === 2) throw new Error("temporary database error");
        return recoveredPage;
      },
    },
    { ttlMs: 100, now: () => now, onError: (error) => errors.push(error) },
  );

  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), cachedPage);
  now = 101;
  const failedReads = await Promise.all([
    cache.read(newsResponseCacheKey, newsResponseRequest),
    cache.read(newsResponseCacheKey, newsResponseRequest),
  ]);
  assert.deepEqual(failedReads, [cachedPage, cachedPage]);
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);

  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), recoveredPage);
  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), recoveredPage);
  assert.equal(calls, 3);
});

test("calendar refresh failure shares the last success without caching the error or renewing its TTL", async () => {
  let now = 0;
  let calls = 0;
  const errors: unknown[] = [];
  const oldSummary = { buckets: [{ date: "2026-10-25", ecosystemLayer: "runtime", articleCount: 20_850 }], sourceCounts: [] };
  const newSummary = { buckets: [{ date: "2026-10-25", ecosystemLayer: "runtime", articleCount: 20_923 }], sourceCounts: [] };
  const cache = createNewsCalendarCache({
    async readNewsCalendar() {
      calls += 1;
      if (calls === 1) return oldSummary;
      if (calls === 2) throw new Error("temporary calendar failure");
      return newSummary;
    },
  }, { ttlMs: 100, now: () => now, onError: (error) => errors.push(error) });
  assert.deepEqual(await cache.read(), oldSummary);
  now = 101;
  assert.deepEqual(await Promise.all([cache.read(), cache.read()]), [oldSummary, oldSummary]);
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(await cache.read(), newSummary);
  assert.deepEqual(await cache.read(), newSummary);
  assert.equal(calls, 3);
});

function manualCalendarRefresh() {
  const callbacks = new Set<() => void>();
  return {
    schedule(callback: () => void, intervalMs: number) {
      assert.ok(intervalMs > 0 && intervalMs <= 30_000);
      callbacks.add(callback);
      return () => { callbacks.delete(callback); };
    },
    tick() { for (const callback of callbacks) callback(); },
    get size() { return callbacks.size; },
  };
}

const flushRefresh = () => new Promise<void>((resolve) => setImmediate(resolve));

test("invalidating news responses expires every key before its normal sixty-second TTL", async () => {
  let generation = 1;
  let calls = 0;
  const cache = createNewsResponseCache({ async read() {
    calls++;
    return { items: [{ external_id: String(generation) }], totalCount: generation, hasMore: false };
  } }, { now: () => 0 });
  const secondKey = `${newsResponseCacheKey}&offset=10`;
  await cache.read(newsResponseCacheKey, newsResponseRequest);
  await cache.read(secondKey, { ...newsResponseRequest, offset: 10 });
  assert.equal(calls, 2);
  generation = 2;
  cache.invalidate();
  assert.equal((await cache.read(newsResponseCacheKey, newsResponseRequest)).items[0]?.external_id, "2");
  assert.equal((await cache.read(secondKey, { ...newsResponseRequest, offset: 10 })).items[0]?.external_id, "2");
  assert.equal(calls, 4);
});

test("an invalidated in-flight news read cannot repopulate or replace the current entry", async () => {
  let calls = 0;
  let releaseOld: ((value: ContentPage) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  const old = new Promise<ContentPage>((resolveOld) => { releaseOld = resolveOld; });
  const oldPage = { items: [{ external_id: "old" }], totalCount: 1, hasMore: false };
  const newPage = { items: [{ external_id: "new" }], totalCount: 2, hasMore: false };
  const cache = createNewsResponseCache({ async read() {
    calls++;
    if (calls === 1) { markStarted?.(); return old; }
    return newPage;
  } });
  const oldRead = cache.read(newsResponseCacheKey, newsResponseRequest);
  await started;
  cache.invalidate();
  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), newPage);
  releaseOld?.(oldPage);
  assert.deepEqual(await oldRead, oldPage);
  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), newPage);
  assert.equal(calls, 2);
});

test("changed calendar statistics invalidate list entries before their new asset is published", async () => {
  let now = 0;
  let count = 1;
  let reads = 0;
  let releasePublication: (() => void) | undefined;
  let markPublishing: (() => void) | undefined;
  const publishing = new Promise<void>((resolvePublishing) => { markPublishing = resolvePublishing; });
  const pendingPublication = new Promise<void>((resolvePublication) => { releasePublication = resolvePublication; });
  const timer = manualCalendarRefresh();
  const server = await startContentApiServer({
    repository: {
      async read() { reads++; return { items: [{ external_id: String(count) }], totalCount: count, hasMore: false }; },
      async readNewsCalendar() { return { buckets: [{ date: "2026-10-26", ecosystemLayer: "runtime", articleCount: count }], sourceCounts: [] }; },
    },
    host: "127.0.0.1", port: 0, allowedHosts, allowedOrigins, now: () => now,
    newsCalendarRefreshIntervalMs: 30_000, newsCalendarScheduleRefresh: timer.schedule,
    async newsCalendarSnapshotPublisher() {
      if (count === 2) { markPublishing?.(); await pendingPublication; }
    },
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const path = "/api/content/v1/news?fields=external_id&count=none";
  try {
    const initial = await request(address.port, path);
    assert.deepEqual(initial.json.items, [{ external_id: "1" }]);
    assert.equal(reads, 1);
    now = 30_000;
    timer.tick(); await flushRefresh();
    await request(address.port, path);
    assert.equal(reads, 1, "unchanged statistics must not clear the list just because asset metadata advances");
    count = 2;
    now = 31_000;
    timer.tick();
    await publishing;
    const changed = await request(address.port, path);
    assert.deepEqual(changed.json.items, [{ external_id: "2" }]);
    assert.equal(reads, 2, "the old list entry must already be invalid before publication completes");
    releasePublication?.(); await flushRefresh();
  } finally { releasePublication?.(); await close(server); }
});

test("proactive calendar primes once then serves memory while background refreshes are single flight", async () => {
  let now = 0;
  let calls = 0;
  let releaseRefresh: ((value: Awaited<ReturnType<ContentReadRepository["readNewsCalendar"]>>) => void) | undefined;
  const initial = { buckets: [{ date: "2026-10-26", ecosystemLayer: "runtime", articleCount: 1 }], sourceCounts: [] };
  const updated = { ...initial, buckets: [{ ...initial.buckets[0]!, articleCount: 2 }] };
  const pendingRefresh = new Promise<typeof updated>((resolve) => { releaseRefresh = resolve; });
  const timer = manualCalendarRefresh();
  const cache = createNewsCalendarCache({
    async readNewsCalendar() { calls++; return calls === 1 ? initial : pendingRefresh; },
  }, {
    ttlMs: 1, now: () => now, refreshIntervalMs: 30_000, maxStaleMs: 120_000,
    scheduleRefresh: timer.schedule,
  });
  assert.equal(cache.isReady(), false);
  await assert.rejects(cache.read(), /snapshot.*unavailable/i);
  assert.equal(calls, 0, "foreground must not start a cold database read");
  await Promise.all([cache.prime(), cache.prime()]);
  assert.equal(calls, 1);
  assert.equal(timer.size, 1);
  assert.equal(cache.isReady(), true);

  now = 30_000;
  timer.tick(); timer.tick();
  await flushRefresh();
  assert.equal(calls, 2, "timer ticks must share the ongoing database read");
  assert.deepEqual(await cache.read(), initial, "a foreground read must not await the background query");
  releaseRefresh?.(updated);
  await flushRefresh();
  assert.deepEqual(await cache.read(), updated, "successful refresh is visible without a second TTL");
  assert.equal(calls, 2);
  cache.close();
  assert.equal(timer.size, 0);
  timer.tick();
  await flushRefresh();
  assert.equal(calls, 2);
});

test("proactive calendar failures do not extend freshness and later background success recovers", async () => {
  let now = 0;
  let failed = false;
  const errors: unknown[] = [];
  const timer = manualCalendarRefresh();
  const summary = { buckets: [], sourceCounts: [{ ecosystemLayer: "all", sourceCount: 0 }] };
  const cache = createNewsCalendarCache({
    async readNewsCalendar() { if (failed) throw new Error("calendar database offline"); return summary; },
  }, { now: () => now, refreshIntervalMs: 30_000, maxStaleMs: 120_000, scheduleRefresh: timer.schedule, onError: (error) => errors.push(error) });
  await cache.prime();
  failed = true;
  now = 30_000;
  timer.tick(); await flushRefresh();
  assert.deepEqual(await cache.read(), summary);
  assert.equal(errors.length, 1);
  now = 120_000;
  timer.tick(); await flushRefresh();
  assert.equal(cache.isReady(), false);
  await assert.rejects(cache.read(), /snapshot.*unavailable/i);
  failed = false;
  timer.tick(); await flushRefresh();
  assert.equal(cache.isReady(), true);
  assert.deepEqual(await cache.read(), summary);
  cache.close();
});

test("active server waits for successful calendar prime before listening and closes its refresh timer", async () => {
  const timer = manualCalendarRefresh();
  let releasePrime: ((value: Awaited<ReturnType<ContentReadRepository["readNewsCalendar"]>>) => void) | undefined;
  let primeStarted = false;
  const prime = new Promise<Awaited<ReturnType<ContentReadRepository["readNewsCalendar"]>>>((resolve) => { releasePrime = resolve; });
  const reservation = http.createServer();
  await listen(reservation);
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved === "object");
  const port = reserved.port;
  await close(reservation);
  const starting = startContentApiServer({
    repository: { ...successfulRepository, async readNewsCalendar() { primeStarted = true; return prime; } },
    host: "127.0.0.1", port, allowedHosts, allowedOrigins,
    newsCalendarRefreshIntervalMs: 30_000,
    newsCalendarScheduleRefresh: timer.schedule,
  });
  try {
    await flushRefresh();
    assert.equal(primeStarted, true, "startup must request its snapshot before listening");
    await assert.rejects(request(port, "/healthz"), /ECONNREFUSED/);
    releasePrime?.(await successfulRepository.readNewsCalendar());
    await starting;
    assert.equal((await request(port, "/healthz")).status, 200);
    assert.equal((await request(port, "/api/content/v1/news/calendar")).status, 200);
    assert.equal(timer.size, 1);
  } finally {
    releasePrime?.(await successfulRepository.readNewsCalendar());
    const server = await starting;
    if (server.listening) await close(server);
  }
  assert.equal(timer.size, 0);
});

test("active server refuses startup when calendar prime fails", async () => {
  const timer = manualCalendarRefresh();
  await assert.rejects(startContentApiServer({
    repository: { ...successfulRepository, async readNewsCalendar() { throw new Error("missing calendar migration"); } },
    host: "127.0.0.1", port: 0, allowedHosts, allowedOrigins,
    newsCalendarRefreshIntervalMs: 30_000,
    newsCalendarScheduleRefresh: timer.schedule,
  }), /missing calendar migration/);
  assert.equal(timer.size, 0);
});

test("active health and calendar fail promptly on an aged snapshot then recover on background refresh", async () => {
  let now = 0;
  let failed = false;
  let calls = 0;
  const timer = manualCalendarRefresh();
  const server = await startContentApiServer({
    repository: { ...successfulRepository, async readNewsCalendar() { calls++; if (failed) throw new Error("offline"); return successfulRepository.readNewsCalendar(); } },
    host: "127.0.0.1", port: 0, allowedHosts, allowedOrigins, now: () => now,
    newsCalendarRefreshIntervalMs: 30_000,
    newsCalendarMaxStaleMs: 120_000,
    newsCalendarScheduleRefresh: timer.schedule,
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    now = 120_000;
    failed = true;
    timer.tick(); await flushRefresh();
    const before = calls;
    assert.equal((await request(address.port, "/healthz")).status, 503);
    assert.equal((await request(address.port, "/api/content/v1/news/calendar")).status, 503);
    assert.equal(calls, before, "health and foreground reads must not query the database");
    failed = false;
    timer.tick(); await flushRefresh();
    assert.equal((await request(address.port, "/healthz")).status, 200);
    assert.equal((await request(address.port, "/api/content/v1/news/calendar")).status, 200);
  } finally { await close(server); }
  assert.equal(timer.size, 0);
});

test("active calendar encodes each successful snapshot once and reuses it for concurrent HTTP reads", async () => {
  let now = 0;
  let generation = 1;
  let encodings = 0;
  let failed = false;
  const timer = manualCalendarRefresh();
  const errors: unknown[] = [];
  const body = (count: number) => ({
    buckets: [{ date: "2026-10-26", ecosystemLayer: "runtime", articleCount: count }],
    sourceCounts: [{ ecosystemLayer: "all", sourceCount: 1 }],
  });
  const server = await startContentApiServer({
    repository: {
      ...successfulRepository,
      async readNewsCalendar() {
        if (failed) throw new Error("calendar refresh offline");
        const value = body(generation);
        return { ...value, toJSON() { encodings++; return value; } };
      },
    },
    host: "127.0.0.1", port: 0, allowedHosts, allowedOrigins, now: () => now,
    newsCalendarRefreshIntervalMs: 30_000, newsCalendarMaxStaleMs: 120_000,
    newsCalendarScheduleRefresh: timer.schedule, onError: (error) => errors.push(error),
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal(encodings, 1, "prime must encode before the first foreground request");
    const initialReads = await Promise.all(Array.from({ length: 5 }, () => request(address.port, "/api/content/v1/news/calendar")));
    for (const result of initialReads) {
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, body(1));
      assert.equal(result.raw, `${JSON.stringify(body(1))}\n`);
      assert.equal(result.headers["cache-control"], "no-cache");
      assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(result.headers["x-content-type-options"], "nosniff");
      assert.equal(result.headers["access-control-allow-origin"], "https://site.test");
    }
    assert.equal(encodings, 1, "parallel foreground requests must reuse the encoded snapshot");

    now = 30_000;
    generation = 2;
    timer.tick(); await flushRefresh();
    assert.equal(encodings, 2, "a successful background refresh encodes exactly once");
    assert.deepEqual((await request(address.port, "/api/content/v1/news/calendar")).json, body(2));
    assert.equal(encodings, 2);

    now = 60_000;
    failed = true;
    timer.tick(); await flushRefresh();
    assert.equal(encodings, 2);
    assert.deepEqual((await request(address.port, "/api/content/v1/news/calendar")).json, body(2));
    assert.equal(errors.length, 1);

    now = 150_000;
    const expired = await request(address.port, "/api/content/v1/news/calendar");
    assert.equal(expired.status, 503, "cached bytes must not bypass the maximum snapshot age");
    assert.equal(expired.json.error, "content_backend_unavailable");
    assert.equal(encodings, 2);

    failed = false;
    generation = 3;
    timer.tick(); await flushRefresh();
    assert.equal(encodings, 3);
    assert.deepEqual((await request(address.port, "/api/content/v1/news/calendar")).json, body(3));
    assert.equal(encodings, 3);
  } finally { await close(server); }
});

test("calendar serialization failure cannot replace the last complete snapshot or renew its age", async () => {
  let now = 0;
  let badEncoding = false;
  const timer = manualCalendarRefresh();
  const errors: unknown[] = [];
  const good = { buckets: [], sourceCounts: [{ ecosystemLayer: "all", sourceCount: 0 }] };
  const cache = createNewsCalendarCache({
    async readNewsCalendar() {
      return badEncoding ? { ...good, toJSON() { throw new Error("calendar encoding failed"); } } : good;
    },
  }, { now: () => now, refreshIntervalMs: 30_000, maxStaleMs: 120_000, scheduleRefresh: timer.schedule, onError: (error) => errors.push(error) });
  await cache.prime();
  badEncoding = true;
  now = 30_000;
  timer.tick(); await flushRefresh();
  assert.strictEqual(await cache.read(), good);
  assert.equal(errors.length, 1);
  now = 120_000;
  assert.equal(cache.isReady(), false);
  await assert.rejects(cache.read(), /snapshot.*unavailable/i);
  cache.close();
});

test("calendar publication gates readiness and uses the same success time and maximum age", async () => {
  let now = 10_000;
  let release: (() => void) | undefined;
  let publicationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolveStarted) => { publicationStarted = resolveStarted; });
  const pending = new Promise<void>((resolvePending) => { release = resolvePending; });
  const timer = manualCalendarRefresh();
  const value = { buckets: [], sourceCounts: [{ ecosystemLayer: "all", sourceCount: 0 }] };
  const cache = createNewsCalendarCache({ async readNewsCalendar() { return value; } }, {
    now: () => now, refreshIntervalMs: 30_000, maxStaleMs: 120_000, scheduleRefresh: timer.schedule,
    async publishSnapshot(publication) {
      assert.equal(publication.generatedAtMs, 10_000);
      assert.equal(publication.expiresAtMs, 130_000);
      assert.deepEqual(JSON.parse(Buffer.from(publication.bytes).toString("utf8")), value);
      publicationStarted?.();
      await pending;
    },
  });
  let primed = false;
  const priming = cache.prime().then(() => { primed = true; });
  try {
    await Promise.race([started, priming.then(() => { throw new Error("prime completed before publishing its asset"); })]);
    assert.equal(primed, false);
    assert.equal(cache.isReady(), false);
    assert.equal(timer.size, 0);
    release?.();
    await priming;
    assert.equal(cache.isReady(), true);
    assert.strictEqual(await cache.read(), value);
    now = 130_000;
    assert.equal(cache.isReady(), false);
  } finally { release?.(); await priming; cache.close(); }
});

test("publication failure cannot renew an old snapshot and startup refuses a failed first publication", async () => {
  let now = 0;
  let publishFails = false;
  let count = 1;
  const timer = manualCalendarRefresh();
  const errors: unknown[] = [];
  const cache = createNewsCalendarCache({ async readNewsCalendar() {
    return { buckets: [{ date: "2026-10-26", ecosystemLayer: "runtime", articleCount: count }], sourceCounts: [] };
  } }, {
    now: () => now, refreshIntervalMs: 30_000, maxStaleMs: 120_000, scheduleRefresh: timer.schedule,
    async publishSnapshot() { if (publishFails) throw new Error("asset publication failed"); },
    onError: (error) => errors.push(error),
  });
  await cache.prime();
  publishFails = true;
  count = 2;
  now = 30_000;
  timer.tick(); await flushRefresh();
  assert.equal((await cache.read()).buckets[0]?.articleCount, 1);
  assert.equal(errors.length, 1);
  now = 120_000;
  assert.equal(cache.isReady(), false);
  await assert.rejects(cache.read(), /snapshot.*unavailable/i);
  cache.close();

  await assert.rejects(startContentApiServer({
    repository: successfulRepository, host: "127.0.0.1", port: 0,
    newsCalendarRefreshIntervalMs: 30_000,
    async newsCalendarSnapshotPublisher() { throw new Error("initial asset publication failed"); },
  }), /initial asset publication failed/);
});

test("closing during a publication stops scheduling while allowing only its complete snapshot publication", async () => {
  let release: (() => void) | undefined;
  let markPublishing: (() => void) | undefined;
  const started = new Promise<void>((resolveStarted) => { markPublishing = resolveStarted; });
  const pending = new Promise<void>((resolvePending) => { release = resolvePending; });
  const timer = manualCalendarRefresh();
  const cache = createNewsCalendarCache(successfulRepository, {
    refreshIntervalMs: 30_000, scheduleRefresh: timer.schedule,
    async publishSnapshot() { markPublishing?.(); await pending; },
  });
  const priming = cache.prime();
  try {
    await Promise.race([started, priming.then(() => { throw new Error("publication was not awaited"); })]);
    cache.close();
    release?.();
    await priming;
    assert.equal(timer.size, 0);
    assert.equal(cache.isReady(), false);
    await assert.rejects(cache.read(), /closed/);
  } finally { release?.(); await priming; cache.close(); }
});

test("news response cache bounds retained query keys", async () => {
  let calls = 0;
  const cache = createNewsResponseCache(
    {
      async read() {
        calls += 1;
        return { items: [{ external_id: String(calls) }], totalCount: 1, hasMore: false };
      },
    },
    { maxEntries: 1 },
  );

  await cache.read("/api/content/v1/news?fields=external_id&limit=1", newsResponseRequest);
  await cache.read("/api/content/v1/news?fields=external_id&limit=2", newsResponseRequest);
  await cache.read("/api/content/v1/news?fields=external_id&limit=1", newsResponseRequest);
  assert.equal(calls, 3);
});

test("default news freshness expires at sixty seconds and merges the refresh", async () => {
  let now = 0;
  let calls = 0;
  const cache = createNewsResponseCache({
    async read() {
      calls += 1;
      return { items: [{ external_id: String(calls) }], totalCount: 1, hasMore: false };
    },
  }, { now: () => now });
  await cache.read(newsResponseCacheKey, newsResponseRequest);
  now = 59_999;
  await cache.read(newsResponseCacheKey, newsResponseRequest);
  assert.equal(calls, 1);
  now = 60_000;
  await Promise.all([
    cache.read(newsResponseCacheKey, newsResponseRequest),
    cache.read(newsResponseCacheKey, newsResponseRequest),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test("default calendar freshness expires at sixty seconds", async () => {
  let now = 0;
  let calls = 0;
  const cache = createNewsCalendarCache({
    async readNewsCalendar() { calls += 1; return { buckets: [], sourceCounts: [] }; },
  }, { now: () => now });
  await cache.read();
  now = 59_999;
  await cache.read();
  assert.equal(calls, 1);
  now = 60_000;
  await cache.read();
  assert.equal(calls, 2);
});

test("default news cache retains 128 query entries and evicts the least recently used", async () => {
  let calls = 0;
  const cache = createNewsResponseCache({
    async read() { calls += 1; return { items: [], totalCount: 0, hasMore: false }; },
  });
  const key = (offset: number) => `/api/content/v1/news?fields=external_id&offset=${offset}`;
  for (let offset = 0; offset < 128; offset += 1) await cache.read(key(offset), { ...newsResponseRequest, offset });
  await cache.read(key(0), newsResponseRequest);
  assert.equal(calls, 128);
  await cache.read(key(128), { ...newsResponseRequest, offset: 128 });
  await cache.read(key(1), { ...newsResponseRequest, offset: 1 });
  assert.equal(calls, 130);
});

test("a cold news failure is shared but never cached, so the next request retries", async () => {
  let calls = 0;
  const page = { items: [{ external_id: "recovered" }], totalCount: 1, hasMore: false };
  const cache = createNewsResponseCache({
    async read() {
      calls += 1;
      if (calls === 1) throw new Error("temporary database failure");
      return page;
    },
  });
  const failed = await Promise.allSettled([
    cache.read(newsResponseCacheKey, newsResponseRequest),
    cache.read(newsResponseCacheKey, newsResponseRequest),
  ]);
  assert.ok(failed.every((result) => result.status === "rejected"));
  assert.equal(calls, 1);
  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), page);
  assert.deepEqual(await cache.read(newsResponseCacheKey, newsResponseRequest), page);
  assert.equal(calls, 2);
});

test("a cold calendar failure is not cached and concurrent retry shares one read", async () => {
  let calls = 0;
  const cache = createNewsCalendarCache({
    async readNewsCalendar() {
      calls += 1;
      if (calls === 1) throw new Error("temporary database failure");
      return { buckets: [], sourceCounts: [] };
    },
  });
  await assert.rejects(cache.read(), /temporary database failure/);
  await Promise.all([cache.read(), cache.read()]);
  await cache.read();
  assert.equal(calls, 2);
});

test("HTTP caches news only while other content resources remain uncached", async () => {
  await withServer(successfulRepository, async (port, seen) => {
    for (let round = 0; round < 2; round += 1) {
      assert.equal((await request(port, "/api/content/v1/news?fields=external_id")).status, 200);
      assert.equal((await request(port, "/api/content/v1/frontier?fields=title")).status, 200);
    }
    assert.equal(seen.filter((read) => read.resource === "news").length, 1);
    assert.equal(seen.filter((read) => read.resource === "frontier").length, 2);
  });
});

test("rejects unsupported methods before reaching the repository", async () => {
  await withServer(successfulRepository, async (port, seen) => {
    const result = await request(port, "/api/content/v1/news?fields=external_id", { method: "POST" });
    assert.equal(result.status, 405);
    assert.equal(result.json.error, "method_not_allowed");
    assert.deepEqual(seen, []);
  });
});

test("rejects a missing Origin when the deployment requires same-origin browser reads", async () => {
  await withServer(successfulRepository, async (port) => {
    const result = await request(port, "/api/content/v1/news?fields=external_id", { origin: undefined });
    assert.equal(result.status, 403);
    assert.equal(result.json.error, "missing_origin");
  });
});

test("rejects a foreign Origin and an unexpected Host", async () => {
  await withServer(successfulRepository, async (port) => {
    const foreignOrigin = await request(port, "/api/content/v1/news?fields=external_id", { origin: "https://evil.test" });
    assert.equal(foreignOrigin.status, 403);
    assert.equal(foreignOrigin.json.error, "forbidden_origin");

    const foreignHost = await request(port, "/api/content/v1/news?fields=external_id", { host: "evil.test" });
    assert.equal(foreignHost.status, 403);
    assert.equal(foreignHost.json.error, "forbidden_host");
  });
});

test("accepts a valid CORS preflight only for the allowlisted origin", async () => {
  await withServer(successfulRepository, async (port) => {
    const result = await request(port, "/api/content/v1/news?fields=external_id", { method: "OPTIONS" });
    assert.equal(result.status, 204);
    assert.equal(result.headers["access-control-allow-origin"], "https://site.test");
  });
});

test("reports invalid client input as a 400 without invoking the repository", async () => {
  await withServer(successfulRepository, async (port, seen) => {
    const result = await request(port, "/api/content/v1/news?fields=password_hash");
    assert.equal(result.status, 400);
    assert.equal(result.json.error, "unsupported_field");
    assert.deepEqual(seen, []);
  });
});

test("returns an opaque availability error for backend failures", async () => {
  await withServer(
    { async read() { throw new Error("mysql://user:secret@db.test was unavailable"); }, async readNewsCalendar() { throw new Error("mysql://user:secret@db.test was unavailable"); } },
    async (port) => {
      const result = await request(port, "/api/content/v1/news?fields=external_id");
      assert.equal(result.status, 503);
      assert.deepEqual(result.json, { ok: false, error: "content_backend_unavailable" });
      assert.doesNotMatch(result.raw, /secret|mysql/);
    },
  );
});

test("health check is host-gated but does not require an Origin", async () => {
  await withServer(successfulRepository, async (port) => {
    const result = await request(port, "/healthz", { origin: undefined });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });
  });
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(
  port: number,
  path: string,
  options: { method?: string; host?: string; origin?: string | undefined } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; raw: string; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: options.host ?? "content.test" };
    if (options.origin !== undefined) headers.Origin = options.origin ?? "https://site.test";
    else if (!("origin" in options)) headers.Origin = "https://site.test";
    const request = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, raw, json: (raw ? JSON.parse(raw) : {}) as Record<string, unknown> });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    request.end();
  });
}
