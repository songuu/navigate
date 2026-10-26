import assert from "node:assert/strict";
import test from "node:test";

import type { NewsItem } from "../src/types.ts";
import {
  createPostgresContentRepository,
  type PostgresExecutionResult,
  type PostgresExecutor,
} from "../src/data/postgres-content-repository.ts";

function sampleNewsItem(): NewsItem {
  return {
    externalId: "external-00000001",
    sourceKey: "test-source",
    sourceName: "Test Source",
    sourceKind: "release",
    title: "PostgreSQL test item",
    url: "https://example.com/postgres",
    summary: "summary",
    contentText: "content\u0000 with an unmatched surrogate \ud800",
    contentExcerpt: "content",
    contentStatus: "fetched",
    contentFetchedAt: "2026-07-24T01:02:03.456Z",
    titleZh: "PostgreSQL 测试条目",
    summaryZh: "中文摘要",
    contentTextZh: "中文正文",
    translationStatus: "translated",
    translatedAt: "2026-07-24T01:03:03.456Z",
    ecosystemLayer: "runtime",
    ecosystemLayerLabel: "Runtime",
    tags: ["agent", "postgres"],
    lang: "en",
    publishedAt: "2026-07-23T01:02:03.456Z",
    publishedDate: "2026-07-23",
    collectedAt: "2026-07-24T01:02:03.456Z",
    collectedDate: "2026-07-24",
    enriched: false,
    metadata: { sourceUrl: "https://example.com/feed", nested: { value: "ok\u0000" } },
  };
}

test("PostgreSQL repository uses bounded parameterized upserts and native PG values", async () => {
  const calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  const results: PostgresExecutionResult[] = [
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [{ table_count: "1" }] },
  ];
  const executor: PostgresExecutor = {
    async query(statement, values) {
      calls.push({ statement, values });
      return results.shift() ?? { rowCount: 0, rows: [] };
    },
  };
  const repository = createPostgresContentRepository({ executor });

  const result = await repository.upsertNewsItems([sampleNewsItem()]);

  assert.deepEqual(result, { attempted: 1, invalid: 0, pushed: 1, tableCount: "1" });
  assert.equal(repository.provider, "postgres");
  assert.match(calls[0]!.statement, /^INSERT INTO "news_items"/);
  assert.match(calls[0]!.statement, /VALUES \(\$1, \$2,/);
  assert.match(calls[0]!.statement, /ON CONFLICT \("external_id"\) DO UPDATE SET/);
  assert.match(calls[0]!.statement, /"title_zh" = CASE WHEN "news_items"\."translation_status" = 'translated' AND EXCLUDED\."translation_status" <> 'translated'/);
  assert.match(calls[0]!.statement, /"translated_at" = CASE WHEN .* ELSE EXCLUDED\."translated_at" END/);
  assert.doesNotMatch(calls[0]!.statement, /"collected_at" =/);
  assert.doesNotMatch(calls[0]!.statement, /"collected_date" =/);
  assert.match(calls[0]!.statement, /"content_text" = CASE WHEN "news_items"\."content_status" = 'fetched' AND EXCLUDED\."content_status" <> 'fetched' THEN "news_items"\."content_text" ELSE EXCLUDED\."content_text" END/);
  assert.match(calls[0]!.statement, /"content_status" = CASE WHEN "news_items"\."content_status" = 'fetched' AND EXCLUDED\."content_status" <> 'fetched' THEN "news_items"\."content_status" ELSE EXCLUDED\."content_status" END/);
  assert.match(calls[0]!.statement, /"published_at" = COALESCE\(EXCLUDED\."published_at", "news_items"\."published_at"\)/);
  assert.match(calls[0]!.statement, /"published_date" = CASE WHEN EXCLUDED\."published_at" IS NULL THEN "news_items"\."published_date" ELSE EXCLUDED\."published_date" END/);
  assert.equal(calls[0]!.values[7], "content with an unmatched surrogate ");
  assert.equal(calls[0]!.values[11], "PostgreSQL 测试条目");
  assert.equal(calls[0]!.values[15], "2026-07-24 01:03:03.456");
  assert.deepEqual(calls[0]!.values[18], ["agent", "postgres"]);
  assert.equal(calls[0]!.values[24], false);
  assert.deepEqual(calls[0]!.values[25], {
    sourceUrl: "https://example.com/feed",
    nested: { value: "ok" },
  });
  assert.match(calls[1]!.statement, /^SELECT COUNT\(\*\) AS "table_count" FROM "news_items"$/);
});

test("PostgreSQL repository keeps Notion cursor and manifest reads parameterized", async () => {
  const calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  const executor: PostgresExecutor = {
    async query(statement, values) {
      calls.push({ statement, values });
      if (statement.includes("MAX")) {
        return { rowCount: 1, rows: [{ notion_last_edited_time: new Date("2026-07-24T02:03:04.567Z") }] };
      }
      return {
        rowCount: 1,
        rows: [{
          metadata: {
            assets: {
              block: {
                blockId: "block",
                storageKey: "p/a.png",
                publicUrl: "https://assets.example/p/a.png",
                srcHash: "abc",
              },
            },
          },
        }],
      };
    },
  };
  const repository = createPostgresContentRepository({ executor });

  const cursor = await repository.fetchNotionCursor("notion-folder");
  const manifest = await repository.fetchNotionAssetManifest("page-1");

  assert.equal(cursor, "2026-07-24T02:03:04.567Z");
  assert.equal(manifest.block?.publicUrl, "https://assets.example/p/a.png");
  assert.match(calls[0]!.statement, /WHERE "source_key" = \$1$/);
  assert.deepEqual(calls[0]!.values, ["notion-folder"]);
  assert.match(calls[1]!.statement, /WHERE "notion_page_id" = \$1 LIMIT 1$/);
});

test("existing news lookup returns only requested known IDs in stable input order", async () => {
  const calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  const repository = createPostgresContentRepository({
    executor: {
      async query(statement, values) {
        calls.push({ statement, values });
        return { rowCount: 5, rows: [
          { external_id: "known-two" }, { external_id: "not-requested" },
          { external_id: "known-one" }, { external_id: "known-one" }, { external_id: 42 },
        ] };
      },
    },
  });
  assert.ok(repository.findExistingNewsIds, "PostgreSQL must support cross-run identity lookup");
  const found = await repository.findExistingNewsIds(["known-one", "unknown-one", "known-two", "known-one"]);
  assert.deepEqual(found, ["known-one", "known-two"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.statement, 'SELECT "external_id" FROM "news_items" WHERE "external_id" = ANY($1::text[])');
  assert.deepEqual(calls[0]!.values, [["known-one", "unknown-one", "known-two"]]);
});

test("existing news lookup bounds each parameter array to 500 unique IDs", async () => {
  const calls: unknown[][] = [];
  const repository = createPostgresContentRepository({
    executor: {
      async query(_statement, values) {
        const ids = values[0] as string[];
        calls.push([...ids]);
        return { rowCount: 1, rows: [{ external_id: ids[0] }] };
      },
    },
  });
  const ids = Array.from({ length: 1001 }, (_, index) => `existing-${index}`);
  assert.ok(repository.findExistingNewsIds);
  assert.deepEqual(await repository.findExistingNewsIds([...ids, ids[0]!]), [ids[0], ids[500], ids[1000]]);
  assert.deepEqual(calls.map((batch) => batch.length), [500, 500, 1]);
  assert.deepEqual(calls.flat(), ids);
});

test("SQL-like external IDs remain bound values rather than executable query text", async () => {
  const hostileId = "news-'); DROP TABLE news_items; --";
  const repository = createPostgresContentRepository({
    executor: {
      async query(statement, values) {
        assert.equal(statement, 'SELECT "external_id" FROM "news_items" WHERE "external_id" = ANY($1::text[])');
        assert.doesNotMatch(statement, /DROP TABLE/);
        assert.deepEqual(values, [[hostileId]]);
        return { rowCount: 1, rows: [{ external_id: hostileId }] };
      },
    },
  });
  assert.ok(repository.findExistingNewsIds);
  assert.deepEqual(await repository.findExistingNewsIds([hostileId]), [hostileId]);
});

test("empty and invalid identity inputs never issue a database query", async () => {
  let calls = 0;
  const repository = createPostgresContentRepository({
    executor: { async query() { calls += 1; throw new Error("must not query"); } },
  });
  assert.ok(repository.findExistingNewsIds);
  assert.deepEqual(await repository.findExistingNewsIds([]), []);
  assert.deepEqual(await repository.findExistingNewsIds(["", "   ", null, undefined, 42, "bad\u0000id", "x".repeat(1025)] as unknown as string[]), []);
  await assert.rejects(repository.findExistingNewsIds(null as unknown as string[]), /externalIds must be an array/);
  assert.equal(calls, 0);
});

test("existing news lookup propagates database failure instead of reporting unknown IDs", async () => {
  const failure = new Error("news identity lookup connection failed");
  const repository = createPostgresContentRepository({
    executor: { async query() { throw failure; } },
  });
  assert.ok(repository.findExistingNewsIds);
  await assert.rejects(repository.findExistingNewsIds(["known-one"]), (error) => error === failure);
});
