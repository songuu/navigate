import assert from "node:assert/strict";
import test from "node:test";

import type { ContentReadRequest } from "./contract.ts";
import {
  createPostgresContentReadRepository,
  type PostgresQueryExecutor,
} from "./postgres-repository.ts";
import {
  loadContentBackendConfig,
  openContentReadRepository,
} from "./repository.ts";

const request: ContentReadRequest = {
  resource: "news",
  fields: ["external_id", "title", "tags"],
  filters: [{ field: "ecosystem_layer", operator: "eq", value: "framework" }],
  sort: [{ field: "published_date", direction: "desc" }],
  limit: 2,
  offset: 4,
  includeTotal: true,
};

test("PostgreSQL Content API uses positional parameters and native values", async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const executor: PostgresQueryExecutor = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT COUNT")) return [{ total_count: "9" }];
      return [{ external_id: "one", title: "One", tags: ["ai"] }];
    },
  };

  const page = await createPostgresContentReadRepository(executor).read(request);

  assert.match(
    calls[0]?.sql ?? "",
    /FROM "news_items" WHERE "ecosystem_layer" = \$1 ORDER BY "news_items"\."published_date" DESC LIMIT \$2 OFFSET \$3/,
  );
  assert.deepEqual(calls[0]?.values, ["framework", 2, 4]);
  assert.match(
    calls[1]?.sql ?? "",
    /^SELECT COUNT\(\*\) AS total_count FROM "news_items" WHERE "ecosystem_layer" = \$1$/,
  );
  assert.deepEqual(page.items, [{ external_id: "one", title: "One", tags: ["ai"] }]);
  assert.equal(page.totalCount, 9);
  assert.equal(page.hasMore, true);
});

test("PostgreSQL news calendar reads only persistent rollups in one consistent query", async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const repository = createPostgresContentReadRepository({
    async execute(sql, values) {
      calls.push({ sql, values });
      return [
        { kind: "bucket", date: "2026-07-30", ecosystem_layer: "model-platform", article_count: "20", source_count: null },
        { kind: "bucket", date: "2026-07-29", ecosystem_layer: "foundation", article_count: "2", source_count: null },
        { kind: "source", date: null, ecosystem_layer: "all", article_count: null, source_count: "3" },
        { kind: "source", date: null, ecosystem_layer: "foundation", article_count: null, source_count: "2" },
        { kind: "source", date: null, ecosystem_layer: "model-platform", article_count: null, source_count: "3" },
      ];
    },
  });

  assert.deepEqual(await repository.readNewsCalendar(), {
    buckets: [
      { date: "2026-07-30", ecosystemLayer: "model-platform", articleCount: 20 },
      { date: "2026-07-29", ecosystemLayer: "foundation", articleCount: 2 },
    ],
    sourceCounts: [
      { ecosystemLayer: "all", sourceCount: 3 },
      { ecosystemLayer: "foundation", sourceCount: 2 },
      { ecosystemLayer: "model-platform", sourceCount: 3 },
    ],
  });
  assert.equal(calls.length, 1, "calendar must not perform serial database reads");
  assert.match(calls[0]?.sql ?? "", /FROM public\."news_calendar_buckets"/);
  assert.match(calls[0]?.sql ?? "", /FROM public\."news_calendar_sources"/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /\bnews_items\b/);
  assert.match(calls[0]?.sql ?? "", /to_char\("collected_date", 'YYYY-MM-DD'\)/);
  assert.equal((calls[0]?.sql.match(/WHERE "article_count" > 0/g) ?? []).length, 3,
    "retained zero counters must be excluded from all three projections");
  assert.match(calls[0]?.sql ?? "", /COUNT\(DISTINCT "source_name"\)/,
    "global sources must be deduplicated across layers");
  assert.match(calls[0]?.sql ?? "", /ORDER BY "kind" ASC, "date" DESC NULLS LAST, "ecosystem_layer" ASC/);
  assert.deepEqual(calls[0]?.values, []);
});

test("PostgreSQL news calendar preserves the empty archive shape", async () => {
  const repository = createPostgresContentReadRepository({
    async execute() {
      return [{ kind: "source", date: null, ecosystem_layer: "all", article_count: null, source_count: "0" }];
    },
  });
  assert.deepEqual(await repository.readNewsCalendar(), {
    buckets: [], sourceCounts: [{ ecosystemLayer: "all", sourceCount: 0 }],
  });
});

test("PostgreSQL news calendar rejects malformed rollup data instead of serving an empty archive", async () => {
  const all = { kind: "source", date: null, ecosystem_layer: "all", article_count: null, source_count: "0" };
  const bucket = { kind: "bucket", date: "2026-07-30", ecosystem_layer: "foundation", article_count: "1", source_count: null };
  const invalidRows = [
    [],
    [all, all],
    [all, { ...bucket, kind: "unknown" }],
    [all, { ...bucket, date: "2026-02-30" }],
    [all, { ...bucket, date: new Date("2026-07-30T00:00:00Z") }],
    [all, { ...bucket, ecosystem_layer: "" }],
    ...[null, undefined, "", " ", true, -1, "-1", "1.5", "9007199254740992"].map(
      (article_count) => [all, { ...bucket, article_count }],
    ),
    [{ ...all, source_count: null }],
    [{ ...all, source_count: "NaN" }],
  ];
  for (const rows of invalidRows) {
    const repository = createPostgresContentReadRepository({ async execute() { return rows; } });
    await assert.rejects(repository.readNewsCalendar(), /PostgreSQL calendar/);
  }
});

test("PostgreSQL news calendar propagates missing migrations without scanning article rows", async () => {
  const failure = new Error('relation "public.news_calendar_buckets" does not exist');
  let calls = 0;
  const repository = createPostgresContentReadRepository({
    async execute() { calls++; throw failure; },
  });
  await assert.rejects(repository.readNewsCalendar(), (error) => error === failure);
  assert.equal(calls, 1, "a failed summary read must not fall back to a full archive aggregate");
});

test("news DATE projections stay textual while timestamps and date predicates remain native", async () => {
  let query = "";
  const row = {
    external_id: "timezone-boundary",
    published_date: "2026-10-08",
    collected_date: "2026-10-08",
    published_at: new Date("2026-10-07T16:30:00.000Z"),
    collected_at: new Date("2026-10-07T17:00:00.000Z"),
  };
  const repository = createPostgresContentReadRepository({
    async execute(sql, values) {
      query = sql;
      assert.deepEqual(values, ["2026-10-08", 1, 0]);
      return [row];
    },
  });
  const page = await repository.read({
    ...request,
    fields: ["external_id", "published_date", "collected_date", "published_at", "collected_at"],
    filters: [{ field: "collected_date", operator: "eq", value: "2026-10-08" }],
    sort: [{ field: "collected_date", direction: "desc" }],
    limit: 1,
    offset: 0,
    includeTotal: false,
  });

  assert.match(query, /^SELECT "external_id", to_char\("published_date", 'YYYY-MM-DD'\) AS "published_date", to_char\("collected_date", 'YYYY-MM-DD'\) AS "collected_date", "published_at", "collected_at" FROM/);
  assert.match(query, /WHERE "collected_date" = \$1 ORDER BY "news_items"\."collected_date" DESC/);
  assert.deepEqual(page.items, [row]);
});

test("text DATE output cannot drift to the previous UTC day in an Asia/Shanghai process", async () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    // This reproduces the driver DATE -> local-midnight Date -> JSON failure.
    assert.equal(new Date(2026, 9, 8).toISOString(), "2026-10-07T16:00:00.000Z");
    const repository = createPostgresContentReadRepository({
      async execute(sql) {
        assert.match(sql, /to_char\("collected_date", 'YYYY-MM-DD'\) AS "collected_date"/);
        return [{ external_id: "one", collected_date: "2026-10-08" }];
      },
    });
    const page = await repository.read({
      ...request,
      fields: ["external_id", "collected_date"],
      includeTotal: false,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(page.items)), [{ external_id: "one", collected_date: "2026-10-08" }]);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
test("Content API uses PostgreSQL read credentials and accepts an injected executor", async () => {
  const config = loadContentBackendConfig({
    CONTENT_REPOSITORY_DRIVER: "postgres",
    CONTENT_POSTGRES_READ_URL: "postgresql://reader:private-password@127.0.0.1:5432/agent_build",
    CONTENT_POSTGRES_WRITE_URL: "postgresql://writer:different-password@127.0.0.1:5432/agent_build",
  });
  assert.deepEqual(config, {
    driver: "postgres",
    postgres: {
      url: "postgresql://reader:private-password@127.0.0.1:5432/agent_build",
      ssl: false,
    },
  });
  assert.ok(config);

  const executor: PostgresQueryExecutor = { async execute() { return []; } };
  const handle = await openContentReadRepository(config, { postgresExecutor: executor });
  const page = await handle.repository.read({ ...request, includeTotal: false });
  assert.deepEqual(page.items, []);
  await handle.close();
});
